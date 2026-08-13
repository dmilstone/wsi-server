import importlib.util
import io
import json
import os
import stat
import subprocess
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from http import HTTPStatus
from pathlib import Path
from unittest import mock
from urllib.parse import urlencode

OPS = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("wsi_ops_dashboard", OPS / "wsi_ops_dashboard.py")
dashboard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dashboard)


class FakeSocket:
    def __init__(self, request):
        self.input = io.BytesIO(request)
        self.output = io.BytesIO()

    def makefile(self, mode, buffering=None):
        return self.input if "r" in mode else self.output

    def sendall(self, data): self.output.write(data)
    def close(self): pass


class FakeServer:
    def __init__(self, app): self.dashboard = app


def request(app, method="GET", path="/", form=None, headers=None, peer="127.0.0.1"):
    body = urlencode(form or {}).encode()
    values = {"Host": "127.0.0.1:8084", **(headers or {})}
    if body:
        values.update({"Content-Type": "application/x-www-form-urlencoded", "Content-Length": str(len(body))})
    raw = f"{method} {path} HTTP/1.1\r\n".encode()
    raw += b"".join(f"{key}: {value}\r\n".encode() for key, value in values.items()) + b"\r\n" + body
    sock = FakeSocket(raw)
    dashboard.Handler(sock, (peer, 54321), FakeServer(app))
    head, content = sock.output.getvalue().split(b"\r\n\r\n", 1)
    lines = head.decode().split("\r\n")
    response_headers = {}
    for line in lines[1:]:
        key, value = line.split(":", 1); response_headers[key.lower()] = value.strip()
    return int(lines[0].split()[1]), response_headers, content


def login(app, password="secret"):
    status, headers, _ = request(app, "POST", "/login", {"password": password})
    cookie = headers.get("set-cookie", "").split(";", 1)[0]
    sid = cookie.split("=", 1)[1] if cookie else ""
    item = app.sessions.get(sid)
    return status, headers, cookie, (item[1] if item else None)


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
        self.dataset("--help")
        (self.root / dashboard.CONTROL).mkdir()
        (self.root / "file").touch()
        os.symlink(self.root / "good", self.root / "linked")
        (self.root / "good" / "nested").mkdir()
        self.assertEqual(["good"], dashboard.safe_candidates(self.root))

    def test_traversal_and_symlinks_are_invalid(self):
        self.dataset()
        os.symlink(self.root / "sample", self.root / "alias")
        for value in ("", ".", "..", "../sample", "a/b", "a\\b", "alias", "--help", "-sample"):
            self.assertFalse(dashboard.valid_selection(value, self.root), value)

    def test_fixed_vector_never_uses_a_shell_or_arbitrary_option(self):
        self.dataset()
        runner = mock.Mock(return_value=subprocess.CompletedProcess([], 0, "validation: ok\n", ""))
        app = dashboard.Dashboard(b"secret", Path(self.tmp.name) / "audit", runner=runner)
        with mock.patch.dict(os.environ, {"WSI_OPS_DASHBOARD_PASSWORD": "must-not-leak"}):
            app.invoke("inspect", "sample")
        args, kwargs = runner.call_args
        self.assertEqual([os.sys.executable, str(OPS / "wsi_ingest.py"), "inspect", "sample"], args[0])
        self.assertIs(kwargs["shell"], False)
        self.assertNotIn("timeout", kwargs)
        self.assertNotIn("WSI_OPS_DASHBOARD_PASSWORD", kwargs["env"])
        self.assertNotIn(";", "".join(args[0]))
        with self.assertRaises(ValueError): app.invoke("recover")

    def test_only_bounded_metadata_commands_have_timeout(self):
        runner = mock.Mock(return_value=subprocess.CompletedProcess([], 0, "", ""))
        app = dashboard.Dashboard(b"secret", Path(self.tmp.name) / "audit", runner=runner)
        for action in ("status", "history"):
            app.invoke(action); self.assertEqual(10, runner.call_args.kwargs["timeout"])

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

    def test_cheatsheets_are_existing_files_not_copies(self):
        self.assertTrue((OPS / "RELEASE-CHEATSHEET.html").is_file())
        self.assertTrue((OPS / "WSI-Release-Cheat-Sheet.pdf").is_file())
        self.assertFalse((OPS / "dashboard-cheatsheet.html").exists())

    def test_viewer_link_is_local_only_and_no_credentials(self):
        viewer = (OPS.parent / "src/main/resources/static/index.html").read_text()
        gate = (OPS.parent / "src/main/resources/static/local-operations/index.html").read_text()
        self.assertIn('href="/local-operations/"', viewer)
        self.assertIn("Local operations", viewer)
        self.assertIn("http://127.0.0.1:8084/", gate)
        self.assertIn("Local operations unavailable on this computer", gate)
        self.assertIn("Recovery:", gate)
        self.assertIn("./ops/start-wsi-ops-dashboard", gate)
        self.assertIn("--daemon", gate)
        self.assertIn('target="_blank"', gate)
        self.assertNotIn("WSI_OPS_DASHBOARD_PASSWORD=", viewer)
        # Recovery may name the env var, but must not embed a quoted secret assignment.
        self.assertNotIn("WSI_OPS_DASHBOARD_PASSWORD='", gate)
        self.assertNotIn('WSI_OPS_DASHBOARD_PASSWORD="', gate)
        helper = OPS / "start-wsi-ops-dashboard"
        self.assertTrue(helper.is_file(), "expected ops/start-wsi-ops-dashboard helper")
        helper_text = helper.read_text()
        self.assertIn("WSI_OPS_DASHBOARD_PASSWORD", helper_text)
        self.assertIn("127.0.0.1:8084", helper_text)
        self.assertIn("--source-conf", helper_text)
        self.assertIn("--daemon", helper_text)
        self.assertIn("--status", helper_text)
        self.assertIn("--stop", helper_text)
        self.assertIn("nohup", helper_text)
        # Helper must not embed a password assignment.
        self.assertNotIn("WSI_OPS_DASHBOARD_PASSWORD='", helper_text)
        self.assertNotIn('WSI_OPS_DASHBOARD_PASSWORD="', helper_text)

    def test_audit_concurrency_permissions_and_private_owned_parent(self):
        audit = Path(self.tmp.name) / "private" / "nested" / "audit.jsonl"
        app = dashboard.Dashboard(b"secret", audit)
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda n: app.audit("inspect", "success", f"tx{n}"), range(80)))
        lines = audit.read_text().splitlines()
        self.assertEqual(80, len(lines))
        self.assertTrue(all(json.loads(line)["action"] == "inspect" for line in lines))
        self.assertEqual(0o600, stat.S_IMODE(audit.stat().st_mode))
        self.assertEqual(0o700, stat.S_IMODE(audit.parent.stat().st_mode))
        self.assertEqual(0o700, stat.S_IMODE(audit.parent.parent.stat().st_mode))

    def test_session_collection_is_safe_under_concurrency(self):
        sessions = dashboard.Sessions()
        def cycle(_):
            sid, _ = sessions.create(); self.assertIsNotNone(sessions.get(sid)); sessions.remove(sid)
        with ThreadPoolExecutor(max_workers=8) as pool: list(pool.map(cycle, range(100)))
        self.assertEqual({}, sessions.items)


class HTTPBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "staging"; self.prod = Path(self.tmp.name) / "production"
        self.root.mkdir(); self.prod.mkdir(); (self.prod / ".wsi-environment-production").touch()
        self.env = mock.patch.dict(os.environ, {
            "WSI_INGEST_STAGING_ROOT": str(self.root), "WSI_INGEST_PRODUCTION_ROOT": str(self.prod),
            "WSI_INGEST_MIN_QUIET_SECONDS": "1", "WSI_INGEST_REQUIRED_OBSERVATIONS": "2",
            "WSI_INGEST_OBSERVATION_INTERVAL_SECONDS": "1", "WSI_OPS_DASHBOARD_PASSWORD": "secret",
        }, clear=False); self.env.start()
        self.dataset()
        self.runner = mock.Mock(return_value=subprocess.CompletedProcess([], 0, "roots_exist: true\n", ""))
        self.app = dashboard.Dashboard(b"secret", Path(self.tmp.name) / "audit", runner=self.runner)

    def tearDown(self): self.env.stop(); self.tmp.cleanup()

    def dataset(self, name="sample"):
        path = self.root / name; path.mkdir(); (path / "slide.svs").write_bytes(b"fixture")
        old = dashboard.time.time() - 5; os.utime(path / "slide.svs", (old, old)); return path

    def test_unauthenticated_login_authenticated_get_and_logout(self):
        status, headers, body = request(self.app)
        self.assertEqual(401, status); self.assertIn(b"password", body.lower())
        bad, bad_headers, _ = request(self.app, "POST", "/login", {"password": "wrong"})
        self.assertEqual(401, bad); self.assertNotIn("set-cookie", bad_headers); self.assertEqual({}, self.app.sessions.items)
        good, headers, cookie, csrf = login(self.app)
        self.assertEqual(303, good); self.assertIn("HttpOnly", headers["set-cookie"]); self.assertIsNotNone(csrf)
        status, _, _ = request(self.app, headers={"Cookie": cookie}); self.assertEqual(200, status)
        status, _, _ = request(self.app, "POST", "/logout", {"csrf": csrf}, {"Cookie": cookie}); self.assertEqual(303, status)
        status, _, _ = request(self.app, headers={"Cookie": cookie}); self.assertEqual(401, status)

    def test_expired_session_is_rejected(self):
        now = [1]
        self.app.sessions = dashboard.Sessions(lifetime=1, clock=lambda: now[0])
        _, _, cookie, _ = login(self.app); now[0] = 2
        self.assertEqual(401, request(self.app, headers={"Cookie": cookie})[0])

    def test_every_mutation_requires_correct_csrf_and_get_never_invokes(self):
        _, _, cookie, csrf = login(self.app)
        self.runner.reset_mock()
        for path in ("/inspect", "/seal", "/observe", "/dry-run", "/promote", "/logout"):
            for token in (None, "incorrect"):
                form = {"dataset": "sample"}
                if token is not None: form["csrf"] = token
                self.assertEqual(403, request(self.app, "POST", path, form, {"Cookie": cookie})[0], path)
        self.runner.assert_not_called()
        for path in ("/seal", "/observe", "/dry-run", "/promote"):
            self.assertEqual(404, request(self.app, "GET", path, headers={"Cookie": cookie})[0])
        self.runner.assert_not_called()

    def test_cheatsheets_require_authentication_and_serve_after_login(self):
        for path, content_type in (("/cheatsheet.html", "text/html"), ("/cheatsheet.pdf", "application/pdf")):
            self.assertEqual(401, request(self.app, path=path)[0])
            _, _, cookie, _ = login(self.app)
            status, headers, body = request(self.app, path=path, headers={"Cookie": cookie})
            self.assertEqual(200, status); self.assertIn(content_type, headers["content-type"]); self.assertTrue(body)

    def test_host_peer_proxy_and_response_security_headers(self):
        for host in ("evil.example:8084", "localhost", "127.0.0.1:80", "[::1]:8084"):
            status, headers, body = request(self.app, headers={"Host": host})
            self.assertEqual(403, status)
            text = body.decode() if isinstance(body, (bytes, bytearray)) else body
            self.assertIn("Access to Local WSI operations was denied", text)
            self.assertIn("Recovery:", text)
            self.assertIn("text/html", headers["content-type"])
        for proxy_headers in ({}, {"X-Forwarded-For": "127.0.0.1"}, {"Forwarded": "for=127.0.0.1;host=localhost:8084"}):
            status, headers, body = request(self.app, headers=proxy_headers, peer="192.0.2.5")
            self.assertEqual(403, status)
            text = body.decode() if isinstance(body, (bytes, bytearray)) else body
            self.assertIn("Access to Local WSI operations was denied", text)
        status, headers, _ = request(self.app)
        self.assertEqual(401, status)
        self.assertEqual(dashboard.CSP, headers["content-security-policy"])
        self.assertEqual("no-store", headers["cache-control"])
        self.assertEqual("nosniff", headers["x-content-type-options"])
        self.assertEqual("no-referrer", headers["referrer-policy"])
        self.assertNotIn("access-control-allow-origin", headers)

    def test_typed_confirmations_block_subprocess(self):
        _, _, cookie, csrf = login(self.app); self.runner.reset_mock()
        status, _, _ = request(self.app, "POST", "/seal", {"csrf": csrf, "dataset": "sample", "approve": "no"}, {"Cookie": cookie})
        self.assertEqual(400, status)
        status, _, _ = request(self.app, "POST", "/promote", {"csrf": csrf, "dataset": "sample", "confirmation": "promote"}, {"Cookie": cookie})
        self.assertEqual(400, status)
        self.runner.assert_not_called()

    def test_all_allowlisted_dashboard_argv_and_no_durable_timeout(self):
        _, _, cookie, csrf = login(self.app); self.runner.reset_mock()
        expected = {"/inspect": ["inspect"], "/observe": ["observe"],
                    "/dry-run": ["promote", "--dry-run"], "/promote": ["promote", "--step"]}
        for path, command in expected.items():
            form = {"csrf": csrf, "dataset": "sample"}
            if path == "/promote": form["confirmation"] = "PROMOTE"
            self.assertEqual(200, request(self.app, "POST", path, form, {"Cookie": cookie})[0])
            args, kwargs = self.runner.call_args
            self.assertEqual([os.sys.executable, str(OPS / "wsi_ingest.py"), *command, "sample"], args[0])
            self.assertFalse(kwargs["shell"]); self.assertNotIn("timeout", kwargs)
            self.assertNotIn("WSI_OPS_DASHBOARD_PASSWORD", kwargs["env"])
        self.assertEqual(4, self.runner.call_count)

    def test_approved_seal_runs_automated_ingestion_pipeline(self):
        _, _, cookie, csrf = login(self.app); self.runner.reset_mock()
        status, _, body = request(
            self.app, "POST", "/seal",
            {"csrf": csrf, "dataset": "sample", "approve": "yes"},
            {"Cookie": cookie},
        )
        self.assertEqual(200, status)
        argv_list = [call.args[0] for call in self.runner.call_args_list]
        self.assertEqual([os.sys.executable, str(OPS / "wsi_ingest.py"), "seal", "sample"], argv_list[0])
        self.assertIn([os.sys.executable, str(OPS / "wsi_ingest.py"), "observe", "sample"], argv_list)
        self.assertIn([os.sys.executable, str(OPS / "wsi_ingest.py"), "promote", "--dry-run", "sample"], argv_list)
        self.assertEqual([os.sys.executable, str(OPS / "wsi_ingest.py"), "promote", "--step", "sample"], argv_list[-1])
        self.assertIn(b"## seal", body)
        self.assertIn(b"Approve and Seal this Ingestion?", request(self.app, headers={"Cookie": cookie})[2])

    def test_invalid_selections_and_actions_never_reach_subprocess(self):
        os.symlink(self.root / "sample", self.root / "alias")
        _, _, cookie, csrf = login(self.app); self.runner.reset_mock()
        for selected in ("../sample", "alias", "sample --unsafe", "missing"):
            self.assertEqual(400, request(self.app, "POST", "/inspect", {"csrf": csrf, "dataset": selected}, {"Cookie": cookie})[0])
        self.assertEqual(404, request(self.app, "POST", "/recover", {"csrf": csrf}, {"Cookie": cookie})[0])
        self.runner.assert_not_called()

    def test_option_like_real_directory_is_rejected_before_runner(self):
        option_directory = self.dataset("--help")
        _, _, cookie, csrf = login(self.app); self.runner.reset_mock()
        status, _, _ = request(self.app, "POST", "/inspect",
                               {"csrf": csrf, "dataset": "--help"}, {"Cookie": cookie})
        self.assertEqual(400, status)
        self.runner.assert_not_called()
        self.assertTrue(option_directory.is_dir())
        self.assertTrue((option_directory / "slide.svs").is_file())
        self.assertFalse((self.root / dashboard.CONTROL).exists())

    def test_status_or_history_timeout_returns_safe_stop_message(self):
        _, _, cookie, _ = login(self.app)
        for timed_out_command in ("status", "history"):
            def bounded_runner(argv, **kwargs):
                if timed_out_command in argv:
                    raise subprocess.TimeoutExpired(argv, kwargs.get("timeout", 10))
                return subprocess.CompletedProcess(argv, 0, "ok\n", "")
            self.app.runner = bounded_runner
            status, _, body = request(self.app, headers={"Cookie": cookie})
            self.assertEqual(200, status)
            self.assertIn(b"Status unavailable (stop and inspect configuration).", body)

    def test_dashboard_button_css_is_explicit_self_contained_and_behavior_neutral(self):
        _, _, cookie, _ = login(self.app); self.runner.reset_mock()
        status, headers, body = request(self.app, headers={"Cookie": cookie})
        page = body.decode()
        self.assertEqual(200, status)
        for contract in ("button {", "-webkit-appearance: none", "appearance: none",
                         "background: #1769aa", "color: #fff", "border: 2px solid",
                         "cursor: pointer", "button:not(:disabled):hover",
                         "button:not(:disabled):active", "button:focus-visible",
                         "button:disabled", "cursor: not-allowed", "form + form"):
            self.assertIn(contract, page)
        for external in ("<link", "<script", "@import", "url(", "http://", "https://"):
            self.assertNotIn(external, page.lower())
        self.assertEqual(dashboard.CSP, headers["content-security-policy"])
        self.assertEqual([[os.sys.executable, str(OPS / "wsi_ingest.py"), "status"],
                          [os.sys.executable, str(OPS / "wsi_ingest.py"), "history"]],
                         [call.args[0] for call in self.runner.call_args_list])


class DashboardIngestionHTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "staging"; self.prod = Path(self.tmp.name) / "production"
        self.root.mkdir(); self.prod.mkdir(); (self.prod / ".wsi-environment-production").touch()
        self.env = mock.patch.dict(os.environ, {
            "WSI_INGEST_STAGING_ROOT": str(self.root), "WSI_INGEST_PRODUCTION_ROOT": str(self.prod),
            "WSI_INGEST_MIN_QUIET_SECONDS": "1", "WSI_INGEST_REQUIRED_OBSERVATIONS": "2",
            "WSI_INGEST_OBSERVATION_INTERVAL_SECONDS": "1", "WSI_OPS_DASHBOARD_PASSWORD": "never-child",
        }, clear=False); self.env.start()
        self.calls = []
        def runner(argv, **kwargs):
            self.calls.append((list(argv), dict(kwargs)))
            return subprocess.run(argv, **kwargs)
        self.audit = Path(self.tmp.name) / "audit.jsonl"
        self.app = dashboard.Dashboard(b"secret", self.audit, runner=runner)
        _, _, self.cookie, self.csrf = login(self.app)

    def tearDown(self): self.env.stop(); self.tmp.cleanup()

    def dataset(self, name):
        path = self.root / name; path.mkdir(); (path / "slide.svs").write_bytes(b"fixture")
        old = dashboard.time.time() - 5; os.utime(path / "slide.svs", (old, old)); return path

    def post(self, path, name, confirmation=None, approve=None):
        form = {"csrf": self.csrf, "dataset": name}
        if confirmation is not None: form["confirmation"] = confirmation
        if approve is not None: form["approve"] = approve
        return request(self.app, "POST", path, form, {"Cookie": self.cookie})

    def test_inspect_and_approved_automated_ingestion(self):
        self.dataset("promotable")
        status, _, body = self.post("/inspect", "promotable")
        self.assertEqual(200, status); self.assertIn(b"regular_files: 1", body)
        status, _, body = self.post("/seal", "promotable", approve="yes")
        self.assertEqual(200, status, body)
        self.assertIn(b"## seal", body)
        self.assertIn(b"## promote", body)
        self.assertFalse((self.root / "promotable").exists()); self.assertTrue((self.prod / "promotable").is_dir())
        receipt = self.root / dashboard.CONTROL / "promotable.receipt.json"
        self.assertEqual("verified", json.loads(receipt.read_text())["phase"])
        history = subprocess.run([os.sys.executable, str(OPS / "wsi_ingest.py"), "history"],
                                 text=True, capture_output=True, env={k:v for k,v in os.environ.items() if k != "WSI_OPS_DASHBOARD_PASSWORD"})
        self.assertEqual(0, history.returncode); self.assertIn("verified observations 2", history.stdout)
        for argv, kwargs in self.calls:
            self.assertFalse(kwargs["shell"]); self.assertNotIn("timeout", kwargs)
            self.assertNotIn("WSI_OPS_DASHBOARD_PASSWORD", kwargs["env"])
            self.assertEqual(str(OPS / "wsi_ingest.py"), argv[1])

    def test_collision_is_fail_closed_during_automated_ingest(self):
        source = self.dataset("collision")
        destination = self.prod / "collision"; destination.mkdir(); (destination / "existing.svs").write_bytes(b"existing")
        before = len(self.calls)
        status, _, _ = self.post("/seal", "collision", approve="yes")
        self.assertEqual(409, status)
        self.assertGreater(len(self.calls), before)
        self.assertTrue(source.is_dir()); self.assertEqual(b"fixture", (source / "slide.svs").read_bytes())
        self.assertEqual(b"existing", (destination / "existing.svs").read_bytes())
        self.assertFalse((self.root / dashboard.CONTROL / "collision.receipt.json").exists())

    def test_audit_from_http_excludes_all_sensitive_values(self):
        self.dataset("private-dataset")
        self.post("/inspect", "private-dataset")
        text = self.audit.read_text()
        for forbidden in ("secret", "never-child", "private-dataset", str(self.root), str(self.prod),
                          "slide.svs", self.cookie, self.csrf, "wsi_ops_session"):
            self.assertNotIn(forbidden, text)



if __name__ == "__main__": unittest.main()
