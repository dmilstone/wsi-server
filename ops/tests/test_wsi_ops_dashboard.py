import importlib.util
import json
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

OPS = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("wsi_ops_dashboard", OPS / "wsi_ops_dashboard.py")
dashboard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dashboard)


class DashboardSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "staging"
        self.prod = Path(self.tmp.name) / "production"
        self.root.mkdir(); self.prod.mkdir()
        (self.prod / ".wsi-environment-production").touch()
        self.env = mock.patch.dict(os.environ, {
            "WSI_INGEST_STAGING_ROOT": str(self.root),
            "WSI_INGEST_PRODUCTION_ROOT": str(self.prod),
            "WSI_INGEST_MIN_QUIET_SECONDS": "1",
            "WSI_INGEST_REQUIRED_OBSERVATIONS": "2",
            "WSI_INGEST_OBSERVATION_INTERVAL_SECONDS": "1",
        }, clear=False)
        self.env.start()

    def tearDown(self):
        self.env.stop(); self.tmp.cleanup()

    def dataset(self, name="sample"):
        path = self.root / name; path.mkdir(); (path / "slide.svs").write_bytes(b"fixture")
        old = dashboard.time.time() - 5
        os.utime(path / "slide.svs", (old, old))
        return path

    def test_listener_is_compile_time_loopback_only(self):
        self.assertEqual("127.0.0.1", dashboard.BIND_ADDRESS)
        self.assertEqual(8084, dashboard.PORT)
        source = (OPS / "wsi_ops_dashboard.py").read_text()
        self.assertIn("super().__init__((BIND_ADDRESS, PORT)", source)
        self.assertNotIn("0.0.0.0", source)

    def test_no_listener_environment_or_cli_option(self):
        source = (OPS / "wsi_ops_dashboard.py").read_text()
        self.assertNotIn("argparse", source)
        self.assertNotIn("WSI_OPS_HOST", source)
        self.assertNotIn("WSI_OPS_PORT", source)

    def test_missing_and_empty_password_fail_closed(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError): dashboard.password_from_environment()
        with mock.patch.dict(os.environ, {"WSI_OPS_DASHBOARD_PASSWORD": ""}, clear=True):
            with self.assertRaises(RuntimeError): dashboard.password_from_environment()

    def test_session_expiration_and_logout(self):
        now = [10]
        sessions = dashboard.Sessions(lifetime=2, clock=lambda: now[0])
        sid, token = sessions.create(); self.assertEqual(token, sessions.get(sid)[1])
        now[0] = 12; self.assertIsNone(sessions.get(sid))
        sid, _ = sessions.create(); sessions.remove(sid); self.assertIsNone(sessions.get(sid))

    def test_candidates_are_direct_real_directories_only(self):
        self.dataset("good")
        (self.root / dashboard.CONTROL).mkdir()
        (self.root / "file").touch()
        os.symlink(self.root / "good", self.root / "linked")
        (self.root / "good" / "nested").mkdir()
        self.assertEqual(["good"], dashboard.safe_candidates(self.root))

    def test_traversal_and_symlinks_are_invalid(self):
        self.dataset()
        os.symlink(self.root / "sample", self.root / "alias")
        for value in ("", ".", "..", "../sample", "a/b", "a\\b", "alias"):
            self.assertFalse(dashboard.valid_selection(value, self.root), value)

    def test_fixed_vector_never_uses_a_shell_or_arbitrary_option(self):
        self.dataset()
        runner = mock.Mock(return_value=subprocess.CompletedProcess([], 0, "validation: ok\n", ""))
        app = dashboard.Dashboard(b"secret", Path(self.tmp.name) / "audit", runner=runner)
        app.invoke("inspect", "sample")
        args, kwargs = runner.call_args
        self.assertEqual([os.sys.executable, str(OPS / "wsi_ingest.py"), "inspect", "sample"], args[0])
        self.assertIs(kwargs["shell"], False)
        self.assertNotIn(";", "".join(args[0]))
        with self.assertRaises(ValueError): app.invoke("recover")

    def test_inspect_uses_existing_ingester_on_fixture(self):
        self.dataset()
        app = dashboard.Dashboard(b"secret", Path(self.tmp.name) / "audit")
        result = app.invoke("inspect", "sample")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("regular_files: 1", result.stdout)
        self.assertIn("total_bytes: 7", result.stdout)
        self.assertNotIn(str(self.root), result.stdout)
        self.assertNotIn("slide.svs", result.stdout)

    def test_seal_observe_dry_run_and_confirmation_use_existing_ingester(self):
        self.dataset()
        app = dashboard.Dashboard(b"secret", Path(self.tmp.name) / "audit")
        self.assertEqual(0, app.invoke("seal", "sample", "SEAL").returncode)
        state = self.root / dashboard.CONTROL / "sample.json"
        data = json.loads(state.read_text()); data["observations"][0]["time"] -= 2
        state.write_text(json.dumps(data))
        self.assertEqual(0, app.invoke("observe", "sample").returncode)
        data = json.loads(state.read_text()); data["seal_time"] -= 2
        state.write_text(json.dumps(data))
        dry = app.invoke("promote-dry-run", "sample")
        self.assertEqual(0, dry.returncode, dry.stderr)
        self.assertTrue((self.root / "sample").exists())

    def test_promotion_uses_native_no_replace_and_collision_fails_closed(self):
        source = (OPS / "wsi_ingest.py").read_text()
        self.assertIn("atomic_rename_noreplace(ds,dest)", source)
        self.assertIn("RENAME_NOREPLACE", source)
        self.assertNotIn("shutil.move", source)

    def test_no_automatic_retry_or_background_worker(self):
        source = (OPS / "wsi_ops_dashboard.py").read_text()
        self.assertNotIn("retry", source.lower())
        self.assertNotIn("Popen", source)
        self.assertNotIn("serve_forever()", source.replace("server.serve_forever()", ""))

    def test_audit_is_privacy_safe(self):
        audit = Path(self.tmp.name) / "audit.jsonl"
        app = dashboard.Dashboard(b"supersecret", audit)
        app.audit("promotion result", "success", "opaque123")
        text = audit.read_text()
        self.assertEqual({"action", "outcome", "timestamp", "transaction_id"}, set(json.loads(text)))
        for forbidden in ("supersecret", "sample", str(self.root), "slide.svs", "csrf", "session"):
            self.assertNotIn(forbidden, text)

    def test_security_policy_cookie_and_boundary_are_explicit(self):
        source = (OPS / "wsi_ops_dashboard.py").read_text()
        self.assertIn("ipaddress.ip_address(self.client_address[0]).is_loopback", source)
        self.assertIn("ALLOWED_HOSTS", source)
        self.assertNotIn("X-Forwarded-For", source)
        self.assertNotIn("Access-Control-Allow-Origin", source)
        self.assertIn("HttpOnly; SameSite=Strict", source)
        self.assertIn("form-action 'self'", dashboard.CSP)

    def test_get_routes_contain_no_mutations(self):
        source = (OPS / "wsi_ops_dashboard.py").read_text()
        get_body = source.split("def do_GET(self):", 1)[1].split("def do_POST(self):", 1)[0]
        for mutation in ('invoke("seal"', 'invoke("observe"', 'invoke("promote"', "sessions.remove"):
            self.assertNotIn(mutation, get_body)

    def test_cheatsheets_are_existing_files_not_copies(self):
        self.assertTrue((OPS / "RELEASE-CHEATSHEET.html").is_file())
        self.assertTrue((OPS / "WSI-Release-Cheat-Sheet.pdf").is_file())
        self.assertFalse((OPS / "dashboard-cheatsheet.html").exists())
        source = (OPS / "wsi_ops_dashboard.py").read_text()
        self.assertGreater(source.index("auth = self.require_session()"), source.index("def do_GET"))

    def test_viewer_link_is_local_only_and_no_credentials(self):
        viewer = (OPS.parent / "src/main/resources/static/index.html").read_text()
        self.assertIn("http://127.0.0.1:8084/", viewer)
        self.assertIn("Available only in a browser running on the image server", viewer)
        self.assertNotIn("WSI_OPS_DASHBOARD_PASSWORD", viewer)


if __name__ == "__main__": unittest.main()
