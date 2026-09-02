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
from urllib.parse import parse_qs, urlencode, urlsplit

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
        self.assertIn("http://127.0.0.1:8084/", viewer)
        self.assertIn("Available only in a browser running on the image server", viewer)
        self.assertNotIn("WSI_OPS_DASHBOARD_PASSWORD", viewer)

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
            self.assertEqual(403, request(self.app, headers={"Host": host})[0])
        for proxy_headers in ({}, {"X-Forwarded-For": "127.0.0.1"}, {"Forwarded": "for=127.0.0.1;host=localhost:8084"}):
            self.assertEqual(403, request(self.app, headers=proxy_headers, peer="192.0.2.5")[0])
        status, headers, _ = request(self.app)
        self.assertEqual(401, status)
        self.assertEqual(dashboard.CSP, headers["content-security-policy"])
        self.assertEqual("no-store", headers["cache-control"])
        self.assertEqual("nosniff", headers["x-content-type-options"])
        self.assertEqual("no-referrer", headers["referrer-policy"])
        self.assertNotIn("access-control-allow-origin", headers)

    def test_typed_confirmations_block_subprocess(self):
        _, _, cookie, csrf = login(self.app); self.runner.reset_mock()
        for path, wrong in (("/seal", "seal"), ("/promote", "promote")):
            status, _, _ = request(self.app, "POST", path, {"csrf": csrf, "dataset": "sample", "confirmation": wrong}, {"Cookie": cookie})
            self.assertEqual(400, status)
        self.runner.assert_not_called()

    def test_all_allowlisted_dashboard_argv_and_no_durable_timeout(self):
        _, _, cookie, csrf = login(self.app); self.runner.reset_mock()
        expected = {"/inspect": ["inspect"], "/seal": ["seal"], "/observe": ["observe"],
                    "/dry-run": ["promote", "--dry-run"], "/promote": ["promote", "--step"]}
        for path, command in expected.items():
            form = {"csrf": csrf, "dataset": "sample"}
            if path == "/seal": form["confirmation"] = "SEAL"
            if path == "/promote": form["confirmation"] = "PROMOTE"
            self.assertEqual(200, request(self.app, "POST", path, form, {"Cookie": cookie})[0])
            args, kwargs = self.runner.call_args
            self.assertEqual([os.sys.executable, str(OPS / "wsi_ingest.py"), *command, "sample"], args[0])
            self.assertFalse(kwargs["shell"]); self.assertNotIn("timeout", kwargs)
            self.assertNotIn("WSI_OPS_DASHBOARD_PASSWORD", kwargs["env"])
        self.assertEqual(5, self.runner.call_count)

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
            status, _, body = request(self.app, path="/ingest-tools", headers={"Cookie": cookie})
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
        status, _, tools = request(self.app, path="/ingest-tools", headers={"Cookie": cookie})
        self.assertEqual(200, status)
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

    def post(self, path, name, confirmation=None):
        form = {"csrf": self.csrf, "dataset": name}
        if confirmation is not None: form["confirmation"] = confirmation
        return request(self.app, "POST", path, form, {"Cookie": self.cookie})

    def ready(self, name):
        self.assertEqual(200, self.post("/seal", name, "SEAL")[0])
        state = self.root / dashboard.CONTROL / f"{name}.json"
        data = json.loads(state.read_text()); data["observations"][0]["time"] -= 2
        state.write_text(json.dumps(data))
        self.assertEqual(200, self.post("/observe", name)[0])
        data = json.loads(state.read_text()); data["seal_time"] -= 2
        state.write_text(json.dumps(data))

    def test_inspect_seal_observe_dry_run_and_verified_promotion(self):
        self.dataset("promotable")
        status, _, body = self.post("/inspect", "promotable")
        self.assertEqual(200, status); self.assertIn(b"regular_files: 1", body)
        self.ready("promotable")
        self.assertEqual(200, self.post("/dry-run", "promotable")[0])
        self.assertTrue((self.root / "promotable").exists())
        self.assertEqual(200, self.post("/promote", "promotable", "PROMOTE")[0])
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

    def test_collision_is_fail_closed_and_not_retried(self):
        source = self.dataset("collision")
        self.ready("collision")
        destination = self.prod / "collision"; destination.mkdir(); (destination / "existing.svs").write_bytes(b"existing")
        before = len(self.calls)
        status, _, _ = self.post("/promote", "collision", "PROMOTE")
        self.assertEqual(409, status); self.assertEqual(before + 1, len(self.calls))
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


class ConfigurationHelperTests(unittest.TestCase):
    """Pure-function tests for the .properties / shell-export rewrite helpers."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.props = Path(self.tmp.name) / "application.properties"
        self.props.write_text(
            "# Root directory containing image files.\n"
            "wsi.image-directory=/Users/dm026/wsi-images/development\n"
            "wsi.scan-recursive=true\n"
            "server.port=8081\n"
        )
        self.conf = Path(self.tmp.name) / "wsi-ingest.conf"
        self.conf.write_text(
            'export WSI_INGEST_STAGING_ROOT="/Users/dm026/wsi-ingest-staging"\n'
            'export WSI_INGEST_PRODUCTION_ROOT="/Users/dm026/wsi-slides"\n'
        )

    def tearDown(self): self.tmp.cleanup()

    def test_valid_directory_path_accepts_real_absolute_directories_only(self):
        self.assertTrue(dashboard.valid_directory_path(self.tmp.name))
        for bad in ("", "relative/path", str(self.props), str(Path(self.tmp.name) / "missing"),
                    self.tmp.name + '"; rm -rf ~; echo "', self.tmp.name + "$(whoami)", self.tmp.name + "`id`"):
            self.assertFalse(dashboard.valid_directory_path(bad), bad)

    def test_valid_directory_path_accepts_trailing_dollar_sign_but_rejects_expansion_shapes(self):
        # Regression guard for a real deployment bug: a real SMB mount point
        # routinely looks like /Volumes/SHARE$ (trailing "$" is an ordinary
        # Windows-style hidden/administrative-share convention, not an
        # attack). This must now be accepted here too, not just by
        # valid_network_drop_path() -- the staging-root and image-directory
        # fields hit the exact same real-world share names.
        trailing_dollar_dir = Path(self.tmp.name) / "SHARE$"
        trailing_dollar_dir.mkdir()
        self.assertTrue(dashboard.valid_directory_path(str(trailing_dollar_dir)))
        nested_dollar_dir = Path(self.tmp.name) / "SHARE$" / "sub$" / "leaf"
        nested_dollar_dir.mkdir(parents=True)
        self.assertTrue(dashboard.valid_directory_path(str(nested_dollar_dir)))
        # But any "$" that could actually start/chain a bash expansion inside
        # the double-quoted export line this value is written into must
        # still be rejected, including the merely-mid-segment case (not
        # dangerous in practice here, but deliberately not the one narrow
        # shape this carve-out allows, to keep the rule simple and exact).
        mid_segment_dir = Path(self.tmp.name) / "SHARE$mount"
        mid_segment_dir.mkdir()
        self.assertFalse(dashboard.valid_directory_path(str(mid_segment_dir)))
        for bad in (self.tmp.name + "$(whoami)", self.tmp.name + "${HOME}", self.tmp.name + "$HOME",
                    self.tmp.name + "$1", self.tmp.name + "$$", self.tmp.name + "`id`"):
            self.assertFalse(dashboard.valid_directory_path(bad), bad)

    def test_dollar_signs_are_safe_helper_directly(self):
        self.assertTrue(dashboard._dollar_signs_are_safe("/Volumes/SHARE$"))
        self.assertTrue(dashboard._dollar_signs_are_safe("/Volumes/SHARE$/sub$/leaf"))
        self.assertTrue(dashboard._dollar_signs_are_safe("no dollar signs at all"))
        self.assertTrue(dashboard._dollar_signs_are_safe(""))
        for unsafe in ("$(cmd)", "${VAR}", "$VAR", "$1", "$$", "a$b", "/x/SHARE$mount"):
            self.assertFalse(dashboard._dollar_signs_are_safe(unsafe), unsafe)

    def test_valid_network_drop_path_accepts_dollar_sign_but_still_requires_a_real_directory(self):
        # Regression guard: a real SMB mount point routinely looks like
        # /Volumes/SHARE$ (a Windows-style hidden/administrative share is a
        # completely ordinary, common thing -- not an attack), which
        # valid_directory_path()'s stricter, shell-injection-oriented
        # UNSAFE_PATH_CHARACTERS check would wrongly reject outright.
        dollar_dir = Path(self.tmp.name) / "SHARE$mount"
        dollar_dir.mkdir()
        self.assertTrue(dashboard.valid_network_drop_path(str(dollar_dir)))
        self.assertFalse(dashboard.valid_directory_path(str(dollar_dir)))  # confirms the two differ as intended
        for bad in ("", "relative/path", str(self.props), str(Path(self.tmp.name) / "missing"),
                    str(dollar_dir) + "\nSecond-Line-Injection"):
            self.assertFalse(dashboard.valid_network_drop_path(bad), bad)

    def test_read_and_write_property_preserve_surrounding_lines(self):
        self.assertEqual("/Users/dm026/wsi-images/development", dashboard.read_property(self.props, dashboard.IMAGE_DIRECTORY_KEY))
        dashboard.write_property(self.props, dashboard.IMAGE_DIRECTORY_KEY, "/tmp/new-images")
        self.assertEqual("/tmp/new-images", dashboard.read_property(self.props, dashboard.IMAGE_DIRECTORY_KEY))
        remaining = self.props.read_text()
        self.assertIn("# Root directory containing image files.", remaining)
        self.assertIn("wsi.scan-recursive=true", remaining)
        self.assertIn("server.port=8081", remaining)

    def test_write_property_fails_closed_when_key_is_absent(self):
        with self.assertRaises(ValueError):
            dashboard.write_property(self.props, "no.such.key", "x")

    def test_read_and_write_shell_export_preserve_surrounding_lines(self):
        self.assertEqual("/Users/dm026/wsi-ingest-staging", dashboard.read_shell_export(self.conf, "WSI_INGEST_STAGING_ROOT"))
        dashboard.write_shell_export(self.conf, "WSI_INGEST_STAGING_ROOT", "/tmp/new-staging")
        self.assertEqual("/tmp/new-staging", dashboard.read_shell_export(self.conf, "WSI_INGEST_STAGING_ROOT"))
        self.assertIn('export WSI_INGEST_PRODUCTION_ROOT="/Users/dm026/wsi-slides"', self.conf.read_text())

    def test_write_shell_export_fails_closed_when_key_is_absent(self):
        with self.assertRaises(ValueError):
            dashboard.write_shell_export(self.conf, "NO_SUCH_KEY", "x")

    def test_shell_export_also_reads_bare_unquoted_form(self):
        # The installed copy's .env.local (see docs/LOCAL-OPS-DASHBOARD-VALIDATION.md)
        # uses bare "KEY=value" lines relying on the caller's own `set -a`,
        # unlike ops/wsi-ingest.conf's quoted "export KEY=\"value\"" -- both must work.
        bare = Path(self.tmp.name) / ".env.local"
        bare.write_text("WSI_INGEST_STAGING_ROOT=/Users/dm026/wsi-ingest-staging\n"
                         "WSI_OPS_DASHBOARD_PASSWORD=Dashboard\n")
        self.assertEqual("/Users/dm026/wsi-ingest-staging", dashboard.read_shell_export(bare, "WSI_INGEST_STAGING_ROOT"))
        dashboard.write_shell_export(bare, "WSI_INGEST_STAGING_ROOT", "/tmp/new-staging")
        self.assertIn('export WSI_INGEST_STAGING_ROOT="/tmp/new-staging"', bare.read_text())
        self.assertIn("WSI_OPS_DASHBOARD_PASSWORD=Dashboard", bare.read_text())

    def test_ingest_conf_path_honors_override_env_var_at_import(self):
        # The installed, launchd-managed copy of this script (see
        # docs/LOCAL-OPS-DASHBOARD-VALIDATION.md) lives outside the repository,
        # where a plain sibling "wsi-ingest.conf" no longer resolves to the file
        # that deployment's own launcher actually sources -- this must be
        # overridable, exactly like the existing WSI_OPS_AUDIT_FILE default.
        fresh_spec = importlib.util.spec_from_file_location("wsi_ops_dashboard_reimport", OPS / "wsi_ops_dashboard.py")
        fresh_module = importlib.util.module_from_spec(fresh_spec)
        with mock.patch.dict(os.environ, {"WSI_OPS_INGEST_CONF_FILE": str(self.conf)}, clear=False):
            fresh_spec.loader.exec_module(fresh_module)
        self.assertEqual(self.conf, fresh_module.WSI_INGEST_CONF)


class BrowseHelperTests(unittest.TestCase):
    """Pure-function tests for the /browse directory picker's building
    blocks, independent of the HTTP route itself (see EnvironmentConfigurationTests
    for the end-to-end route tests)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "alpha").mkdir()
        (self.root / "Beta").mkdir()
        (self.root / ".hidden").mkdir()
        (self.root / "not-a-dir.txt").write_text("x")
        os.symlink(self.root / "alpha", self.root / "linked")

    def tearDown(self): self.tmp.cleanup()

    def test_list_subdirectories_includes_symlinked_dirs_excludes_files_and_hidden(self):
        entries, error = dashboard.list_subdirectories(self.root)
        self.assertIsNone(error)
        self.assertEqual(["Beta", "alpha", "linked"], sorted(name for name, _ in entries))

    def test_list_subdirectories_show_hidden_includes_dotdirs(self):
        entries, error = dashboard.list_subdirectories(self.root, show_hidden=True)
        self.assertIsNone(error)
        self.assertIn(".hidden", [name for name, _ in entries])

    def test_list_subdirectories_sorted_case_insensitively(self):
        entries, _ = dashboard.list_subdirectories(self.root)
        names = [name for name, _ in entries]
        self.assertEqual(names, sorted(names, key=str.lower))

    def test_list_subdirectories_of_missing_or_unlistable_directory_reports_an_error_not_silently_empty(self):
        # Distinguishing "empty" from "could not list" matters in practice --
        # see the docstring on list_subdirectories() and the "Network volumes
        # and the installed background copy" limitation in
        # docs/LOCAL-OPS-DASHBOARD-VALIDATION.md, where is_dir()/os.access()
        # can succeed on a real network path while enumerating it still fails.
        entries, error = dashboard.list_subdirectories(self.root / "does-not-exist")
        self.assertEqual([], entries)
        self.assertIsNotNone(error)
        entries, error = dashboard.list_subdirectories(self.root / "not-a-dir.txt")
        self.assertEqual([], entries)
        self.assertIsNotNone(error)

    def test_existing_readable_directory_accepts_real_dirs_rejects_the_rest(self):
        self.assertEqual(self.root, dashboard._existing_readable_directory(str(self.root)))
        for bad in ("", None, "relative", str(self.root / "missing"), str(self.root / "not-a-dir.txt")):
            self.assertIsNone(dashboard._existing_readable_directory(bad), bad)

    def test_browse_breadcrumbs_cover_every_ancestor_down_to_root(self):
        crumbs = dashboard.browse_breadcrumbs(self.root / "alpha")
        self.assertEqual(("/", "/"), crumbs[0])
        self.assertEqual(str(self.root / "alpha"), crumbs[-1][1])
        self.assertEqual("alpha", crumbs[-1][0])
        for _, path in crumbs:
            self.assertTrue(str(self.root / "alpha").startswith(path))

    def test_browse_href_round_trips_target_and_path_through_the_query_string(self):
        href = dashboard.browse_href("network-drop-root", "/Volumes/SHARE$/sub")
        self.assertTrue(href.startswith("/browse?"))
        parsed = parse_qs(urlsplit(href).query)
        self.assertEqual(["network-drop-root"], parsed["target"])
        self.assertEqual(["/Volumes/SHARE$/sub"], parsed["path"])

    def test_browse_href_omits_path_param_when_no_current_value(self):
        self.assertEqual("/browse?target=staging-root", dashboard.browse_href("staging-root", ""))
        self.assertEqual("/browse?target=staging-root", dashboard.browse_href("staging-root", None))

    def test_browse_native_href_round_trips_target_through_the_query_string(self):
        href = dashboard.browse_native_href("network-drop-root")
        self.assertTrue(href.startswith("/browse-native?"))
        self.assertEqual(["network-drop-root"], parse_qs(urlsplit(href).query)["target"])


class AppleScriptQuotingTests(unittest.TestCase):
    """_applescript_string_literal() -- embedding arbitrary paths into an
    osascript -e argument safely."""

    def test_escapes_backslash_and_double_quote(self):
        self.assertEqual('"plain"', dashboard._applescript_string_literal("plain"))
        self.assertEqual('"a \\"quoted\\" thing"', dashboard._applescript_string_literal('a "quoted" thing'))
        self.assertEqual('"back\\\\slash"', dashboard._applescript_string_literal("back\\slash"))

    def test_dollar_sign_and_other_shell_metacharacters_pass_through_unescaped(self):
        # Unlike the shell-sourced .conf file, AppleScript string literals
        # have no special meaning for $, so a real SMB share's mount point
        # (e.g. /Volumes/SHARE$/sub) round-trips completely unchanged.
        literal = dashboard._applescript_string_literal("/Volumes/SHARE$/sub $HOME `cmd`")
        self.assertEqual('"/Volumes/SHARE$/sub $HOME `cmd`"', literal)


class NativeChooseFolderTests(unittest.TestCase):
    """native_choose_folder() -- the osascript subprocess wrapper, with
    subprocess.run mocked so these never pop a real dialog."""

    def test_successful_pick_returns_chosen_and_the_stripped_stdout_path(self):
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout="/Volumes/SHARE$/sub\n", stderr="")
        with mock.patch.object(dashboard.subprocess, "run", return_value=completed) as run:
            status, value = dashboard.native_choose_folder("Choose it", Path("/Volumes"))
        self.assertEqual(("chosen", "/Volumes/SHARE$/sub"), (status, value))
        args = run.call_args[0][0]
        self.assertEqual(["osascript", "-e"], args[:2])
        self.assertIn("choose folder", args[2])
        self.assertIn("Choose it", args[2])
        self.assertIn("/Volumes", args[2])

    def test_cancel_is_recognized_by_applescript_error_number_128(self):
        completed = subprocess.CompletedProcess(args=[], returncode=1, stdout="",
                                                  stderr="execution error: User canceled. (-128)")
        with mock.patch.object(dashboard.subprocess, "run", return_value=completed):
            status, value = dashboard.native_choose_folder("Choose it", None)
        self.assertEqual(("cancelled", None), (status, value))

    def test_other_failure_is_reported_as_error_with_stderr_detail(self):
        completed = subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="some other AppleScript error")
        with mock.patch.object(dashboard.subprocess, "run", return_value=completed):
            status, value = dashboard.native_choose_folder("Choose it", None)
        self.assertEqual("error", status)
        self.assertIn("some other AppleScript error", value)

    def test_osascript_missing_entirely_is_reported_as_error_not_raised(self):
        with mock.patch.object(dashboard.subprocess, "run", side_effect=OSError("no such file")):
            status, value = dashboard.native_choose_folder("Choose it", None)
        self.assertEqual("error", status)
        self.assertIn("no such file", value)

    def test_no_default_location_clause_when_start_dir_is_none(self):
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout="/x\n", stderr="")
        with mock.patch.object(dashboard.subprocess, "run", return_value=completed) as run:
            dashboard.native_choose_folder("Choose it", None)
        self.assertNotIn("default location", run.call_args[0][0][2])


class EnvironmentConfigurationTests(unittest.TestCase):
    """Directory-location editing and development recycle (see docs/LOCAL-OPS-DASHBOARD-VALIDATION.md)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "staging"; self.prod = Path(self.tmp.name) / "production"
        self.root.mkdir(); self.prod.mkdir(); (self.prod / ".wsi-environment-production").touch()
        self.new_image_dir = Path(self.tmp.name) / "new-images"; self.new_image_dir.mkdir()
        self.new_staging_dir = Path(self.tmp.name) / "new-staging"; self.new_staging_dir.mkdir()
        self.env = mock.patch.dict(os.environ, {
            "WSI_INGEST_STAGING_ROOT": str(self.root), "WSI_INGEST_PRODUCTION_ROOT": str(self.prod),
            "WSI_OPS_DASHBOARD_PASSWORD": "secret",
        }, clear=False); self.env.start()

        self.dev_config = Path(self.tmp.name) / "application.properties"
        self.dev_config.write_text("wsi.image-directory=/Users/dm026/wsi-images/development\nserver.port=8081\n")
        self.ingest_conf = Path(self.tmp.name) / "wsi-ingest.conf"
        self.ingest_conf.write_text(f'export WSI_INGEST_STAGING_ROOT="{self.root}"\n'
                                     f'export WSI_INGEST_PRODUCTION_ROOT="{self.prod}"\n')
        self.control_script = Path(self.tmp.name) / "wsi"
        self.control_script.write_text("#!/bin/sh\necho fake\n"); self.control_script.chmod(0o755)

        self.calls = []
        def runner(argv, **kwargs):
            self.calls.append((list(argv), dict(kwargs)))
            return subprocess.CompletedProcess(argv, 0, "ok\n", "")
        self.runner = runner
        self.audit = Path(self.tmp.name) / "audit.jsonl"
        self.app = dashboard.Dashboard(b"secret", self.audit, runner=self.runner,
                                        development_config_path=self.dev_config,
                                        control_script_path=self.control_script,
                                        ingest_conf_path=self.ingest_conf)
        _, _, self.cookie, self.csrf = login(self.app)

    def tearDown(self): self.env.stop(); self.tmp.cleanup()

    def post(self, path, form):
        return request(self.app, "POST", path, form, {"Cookie": self.cookie})

    def test_get_shows_current_staging_root_and_image_directory(self):
        status, _, body = request(self.app, headers={"Cookie": self.cookie})
        page = body.decode()
        self.assertEqual(200, status)
        self.assertIn(str(self.root), page)
        self.assertIn("/Users/dm026/wsi-images/development", page)
        self.assertIn('action="/staging-root"', page)
        self.assertIn('action="/image-directory"', page)
        self.assertIn("Type RESTART", page)
        self.assertNotIn('action="/seal"', page)
        drop_at = page.find("Network drop root")
        staging_at = page.find("Ingestion staging root")
        image_at = page.find("Development image directory")
        self.assertTrue(0 <= drop_at < staging_at < image_at)
        self.assertIn("Not part of the usual workflow", page)
        self.assertIn('href="/ingest-tools"', page)

    def test_get_shows_network_drop_root_field_not_set_by_default(self):
        status, _, body = request(self.app, headers={"Cookie": self.cookie})
        page = body.decode()
        self.assertEqual(200, status)
        self.assertIn('action="/network-drop-root"', page)
        self.assertIn("Network drop root", page)
        self.assertIn("(not set)", page)

    def test_ingest_tools_page_keeps_seal_observe_promote_and_env_fields(self):
        status, _, body = request(self.app, path="/ingest-tools", headers={"Cookie": self.cookie})
        page = body.decode()
        self.assertEqual(200, status)
        self.assertIn('action="/seal"', page)
        self.assertIn('action="/observe"', page)
        self.assertIn('action="/promote"', page)
        self.assertIn("/cheatsheet.html", page)
        self.assertIn("Network drop root", page)
        self.assertIn("Ingestion staging root", page)
        self.assertIn("Not part of the usual workflow", page)
        self.assertIn('href="/"', page)

    def test_homepage_does_not_invoke_ingest_status(self):
        status, _, body = request(self.app, headers={"Cookie": self.cookie})
        self.assertEqual(200, status)
        self.assertNotIn(b"Inspect", body)
        self.assertNotIn(b'action="/seal"', body)
        self.assertEqual([], self.calls)

    def test_new_routes_require_csrf_and_reject_get(self):
        for path in ("/staging-root", "/image-directory"):
            self.assertEqual(404, request(self.app, "GET", path, headers={"Cookie": self.cookie})[0])
            for token in (None, "incorrect"):
                form = {"path": str(self.new_image_dir)}
                if token is not None: form["csrf"] = token
                status, _, _ = request(self.app, "POST", path, form, {"Cookie": self.cookie})
                self.assertEqual(403, status, (path, token))
        self.assertEqual([], self.calls)

    def test_staging_root_updates_conf_file_and_live_environment_immediately(self):
        status, _, body = self.post("/staging-root", {"csrf": self.csrf, "path": str(self.new_staging_dir)})
        self.assertEqual(200, status, body)
        self.assertEqual(str(self.new_staging_dir), os.environ["WSI_INGEST_STAGING_ROOT"])
        self.assertEqual(str(self.new_staging_dir), dashboard.read_shell_export(self.ingest_conf, "WSI_INGEST_STAGING_ROOT"))
        self.assertEqual(self.new_staging_dir.resolve(), self.app.root())
        self.assertEqual([], self.calls, "changing the staging root must never touch ops/wsi")

    def test_staging_root_rejects_invalid_path_without_side_effects(self):
        for bad in ("relative", str(Path(self.tmp.name) / "does-not-exist"), ""):
            status, _, _ = self.post("/staging-root", {"csrf": self.csrf, "path": bad})
            self.assertEqual(400, status, bad)
        self.assertEqual(str(self.root), os.environ["WSI_INGEST_STAGING_ROOT"])
        self.assertEqual(str(self.root), dashboard.read_shell_export(self.ingest_conf, "WSI_INGEST_STAGING_ROOT"))

    def test_network_drop_root_route_requires_csrf_and_rejects_get(self):
        self.assertEqual(404, request(self.app, "GET", "/network-drop-root", headers={"Cookie": self.cookie})[0])
        for token in (None, "incorrect"):
            form = {"path": "/tmp"}
            if token is not None: form["csrf"] = token
            status, _, _ = request(self.app, "POST", "/network-drop-root", form, {"Cookie": self.cookie})
            self.assertEqual(403, status, token)

    def test_network_drop_root_save_writes_live_override_readable_independently_of_this_process(self):
        new_root = Path(self.tmp.name) / "network-drop"; new_root.mkdir()
        status, _, body = self.post("/network-drop-root", {"csrf": self.csrf, "path": str(new_root)})
        self.assertEqual(200, status, body)
        self.assertIn(b"no restart needed", body)
        value, is_live = self.app.network_drop_root_state()
        self.assertEqual(str(new_root), value)
        self.assertTrue(is_live)
        # Independent of self.app / this process entirely -- a real daemon
        # process only ever calls effective_config(); it must see the exact
        # same thing purely by reading the same file back from disk.
        is_enabled, root = dashboard.network_drop.effective_config({"staging": self.root})
        self.assertTrue(is_enabled)
        self.assertEqual(root, new_root)

    def test_network_drop_root_accepts_path_containing_dollar_sign(self):
        # Regression test for a real deployment bug: an actual SMB mount
        # point (e.g. /Volumes/DIGPATH_VS200$/...) contains "$" as an
        # ordinary part of a Windows-style hidden-share name, which must not
        # be rejected here the way it correctly is for /staging-root (see
        # valid_network_drop_path's docstring for why the threat model
        # differs between the two fields).
        share_style_dir = Path(self.tmp.name) / "SHARE$mount"; share_style_dir.mkdir()
        status, _, body = self.post("/network-drop-root", {"csrf": self.csrf, "path": str(share_style_dir)})
        self.assertEqual(200, status, body)
        value, is_live = self.app.network_drop_root_state()
        self.assertEqual(str(share_style_dir), value)
        self.assertTrue(is_live)

    def test_network_drop_root_rejects_invalid_path_without_side_effects(self):
        for bad in ("relative", str(Path(self.tmp.name) / "does-not-exist")):
            status, _, _ = self.post("/network-drop-root", {"csrf": self.csrf, "path": bad})
            self.assertEqual(400, status, bad)
        value, is_live = self.app.network_drop_root_state()
        self.assertEqual("", value)
        self.assertFalse(is_live)

    def test_network_drop_root_blank_explicitly_disables_even_if_previously_set(self):
        new_root = Path(self.tmp.name) / "network-drop"; new_root.mkdir()
        self.post("/network-drop-root", {"csrf": self.csrf, "path": str(new_root)})
        status, _, body = self.post("/network-drop-root", {"csrf": self.csrf, "path": ""})
        self.assertEqual(200, status, body)
        self.assertIn(b"disabled", body)
        value, is_live = self.app.network_drop_root_state()
        self.assertEqual("", value)
        self.assertTrue(is_live)  # explicitly disabled -- distinct from "never configured"
        is_enabled, _ = dashboard.network_drop.effective_config({"staging": self.root})
        self.assertFalse(is_enabled)

    def test_network_drop_root_falls_back_to_environment_variable_when_never_saved(self):
        env_root = Path(self.tmp.name) / "env-drop-root"; env_root.mkdir()
        with mock.patch.dict(os.environ, {"WSI_INGEST_NETWORK_DROP_ROOT": str(env_root)}):
            value, is_live = self.app.network_drop_root_state()
        self.assertEqual(str(env_root), value)
        self.assertFalse(is_live)

    def test_image_directory_without_typed_confirmation_is_rejected_and_never_recycles(self):
        for confirmation in (None, "restart", "RESTARTS", ""):
            form = {"csrf": self.csrf, "path": str(self.new_image_dir)}
            if confirmation is not None: form["confirmation"] = confirmation
            status, _, _ = self.post("/image-directory", form)
            self.assertEqual(400, status, confirmation)
        self.assertEqual("/Users/dm026/wsi-images/development", dashboard.read_property(self.dev_config, dashboard.IMAGE_DIRECTORY_KEY))
        self.assertEqual([], self.calls)

    def test_image_directory_invalid_path_is_rejected_even_with_confirmation_and_never_recycles(self):
        status, _, _ = self.post("/image-directory", {"csrf": self.csrf, "confirmation": "RESTART", "path": "relative/path"})
        self.assertEqual(400, status)
        self.assertEqual("/Users/dm026/wsi-images/development", dashboard.read_property(self.dev_config, dashboard.IMAGE_DIRECTORY_KEY))
        self.assertEqual([], self.calls)

    def test_image_directory_success_persists_config_and_recycles_via_ops_wsi_with_explicit_repo(self):
        status, _, body = self.post("/image-directory", {"csrf": self.csrf, "confirmation": "RESTART", "path": str(self.new_image_dir)})
        self.assertEqual(200, status, body)
        self.assertEqual(str(self.new_image_dir), dashboard.read_property(self.dev_config, dashboard.IMAGE_DIRECTORY_KEY))
        self.assertEqual(2, len(self.calls))
        (stop_argv, stop_kwargs), (start_argv, start_kwargs) = self.calls
        self.assertEqual([str(self.control_script), "development", "stop"], stop_argv)
        self.assertEqual([str(self.control_script), "development", "start"], start_argv)
        for kwargs in (stop_kwargs, start_kwargs):
            self.assertIs(kwargs["shell"], False)
            self.assertEqual(dashboard.RECYCLE_TIMEOUT_SECONDS, kwargs["timeout"])
            self.assertEqual(str(dashboard.REPO_ROOT), kwargs["env"]["WSI_REPO"])
            self.assertNotIn("WSI_OPS_DASHBOARD_PASSWORD", kwargs["env"])

    def test_image_directory_recycle_failure_surfaces_502_with_output(self):
        def failing_runner(argv, **kwargs):
            self.calls.append((list(argv), dict(kwargs)))
            if argv[1:] == ["development", "start"]:
                return subprocess.CompletedProcess(argv, 1, "", "Development did not begin listening on port 8081.")
            return subprocess.CompletedProcess(argv, 0, "Development stopped.\n", "")
        self.app.runner = failing_runner
        status, _, body = self.post("/image-directory", {"csrf": self.csrf, "confirmation": "RESTART", "path": str(self.new_image_dir)})
        self.assertEqual(502, status)
        self.assertIn(b"did not begin listening", body)
        # The config write still happened -- the new path itself was valid; only the restart failed.
        self.assertEqual(str(self.new_image_dir), dashboard.read_property(self.dev_config, dashboard.IMAGE_DIRECTORY_KEY))

    def test_image_directory_recycle_timeout_returns_504(self):
        def hanging_runner(argv, **kwargs):
            raise subprocess.TimeoutExpired(argv, kwargs.get("timeout"))
        self.app.runner = hanging_runner
        status, _, body = self.post("/image-directory", {"csrf": self.csrf, "confirmation": "RESTART", "path": str(self.new_image_dir)})
        self.assertEqual(504, status)
        self.assertIn(b"Check its status manually", body)

    def test_browse_requires_session(self):
        status, _, _ = request(self.app, "GET", "/browse?target=staging-root")
        self.assertEqual(401, status)

    def test_browse_unknown_or_missing_target_is_not_found(self):
        for query in ("/browse", "/browse?target=bogus", "/browse?target="):
            status, _, _ = request(self.app, "GET", query, headers={"Cookie": self.cookie})
            self.assertEqual(404, status, query)

    def test_browse_lists_subdirectories_with_breadcrumbs_and_select_form(self):
        parent = Path(self.tmp.name) / "browse-parent"; parent.mkdir()
        (parent / "child-one").mkdir()
        (parent / "child-two").mkdir()
        status, _, body = request(self.app, "GET", f"/browse?target=staging-root&path={parent}",
                                   headers={"Cookie": self.cookie})
        page = body.decode()
        self.assertEqual(200, status)
        self.assertIn("child-one", page)
        self.assertIn("child-two", page)
        self.assertIn("browse-parent", page)  # breadcrumb for the currently-displayed directory
        self.assertIn('action="/staging-root"', page)
        self.assertIn(f'value="{parent}"', page)

    def test_browse_falls_back_to_configured_root_when_requested_path_invalid(self):
        status, _, body = request(self.app, "GET", "/browse?target=staging-root&path=/does/not/exist",
                                   headers={"Cookie": self.cookie})
        page = body.decode()
        self.assertEqual(200, status)
        self.assertIn(f'value="{self.root}"', page)  # falls back to the configured, still-real staging root

    def test_browse_hides_dotfiles_and_files_by_default(self):
        (self.root / ".hidden-dir").mkdir()
        (self.root / "plain-file.txt").write_text("x")
        (self.root / "visible-subdir").mkdir()
        status, _, body = request(self.app, "GET", f"/browse?target=staging-root&path={self.root}",
                                   headers={"Cookie": self.cookie})
        page = body.decode()
        self.assertEqual(200, status)
        self.assertIn("visible-subdir", page)
        self.assertNotIn(".hidden-dir", page)
        self.assertNotIn("plain-file.txt", page)

    def test_browse_link_appears_next_to_all_three_fields_on_homepage(self):
        status, _, body = request(self.app, headers={"Cookie": self.cookie})
        page = body.decode()
        self.assertEqual(200, status)
        self.assertIn("target=staging-root", page)
        self.assertIn("target=network-drop-root", page)
        self.assertIn("target=image-directory", page)

    def test_browse_select_button_for_network_drop_root_round_trips_dollar_sign_path(self):
        # End-to-end regression for the exact real-world path shape that
        # originally broke this feature: a Windows-style hidden SMB share
        # mount point, e.g. /Volumes/DIGPATH_VS200$/....
        share_style_dir = Path(self.tmp.name) / "DIGPATH_VS200$" / "target_test_2"
        share_style_dir.mkdir(parents=True)
        status, _, body = request(self.app, "GET", f"/browse?target=network-drop-root&path={share_style_dir}",
                                   headers={"Cookie": self.cookie})
        page = body.decode()
        self.assertEqual(200, status)
        self.assertIn(f'value="{share_style_dir}"', page)
        self.assertIn('action="/network-drop-root"', page)
        # Simulate clicking "Select this directory": the exact same absolute
        # path shown in that hidden field, posted straight to the real route.
        status, _, body = self.post("/network-drop-root", {"csrf": self.csrf, "path": str(share_style_dir)})
        self.assertEqual(200, status, body)
        value, is_live = self.app.network_drop_root_state()
        self.assertEqual(str(share_style_dir), value)
        self.assertTrue(is_live)

    def test_browse_select_button_for_staging_root_round_trips_dollar_sign_path(self):
        share_style_dir = Path(self.tmp.name) / "SHARE$"
        share_style_dir.mkdir()
        status, _, body = request(self.app, "GET", f"/browse?target=staging-root&path={share_style_dir}",
                                   headers={"Cookie": self.cookie})
        self.assertIn(f'value="{share_style_dir}"', body.decode())
        status, _, body = self.post("/staging-root", {"csrf": self.csrf, "path": str(share_style_dir)})
        self.assertEqual(200, status, body)
        self.assertEqual(str(share_style_dir), os.environ["WSI_INGEST_STAGING_ROOT"])

    def test_browse_image_directory_select_form_still_requires_typed_restart(self):
        status, _, body = request(self.app, "GET", f"/browse?target=image-directory&path={self.new_image_dir}",
                                   headers={"Cookie": self.cookie})
        page = body.decode()
        self.assertEqual(200, status)
        self.assertIn("Type RESTART", page)
        self.assertIn('action="/image-directory"', page)
        # Selecting without the typed confirmation must still be rejected --
        # the dialog is only a friendlier way to reach a path, never a
        # bypass of the restart safety gate the plain text field also has.
        status, _, _ = self.post("/image-directory", {"csrf": self.csrf, "path": str(self.new_image_dir)})
        self.assertEqual(400, status)
        self.assertEqual([], self.calls)

    def test_browse_shows_honest_error_instead_of_claiming_a_directory_is_empty(self):
        # Regression test for a real deployment bug found while validating
        # this feature: macOS can let is_dir()/os.access() succeed on a
        # specific network-share path while still refusing to enumerate that
        # same directory's contents (PermissionError) from the installed
        # background copy -- see "Network volumes and the installed
        # background copy" in docs/LOCAL-OPS-DASHBOARD-VALIDATION.md. Silently
        # showing "No subdirectories here." in that case would be a lie.
        real_dir = Path(self.tmp.name) / "looks-fine-but-cannot-be-listed"; real_dir.mkdir()
        with mock.patch.object(dashboard, "list_subdirectories", return_value=([], "Operation not permitted")):
            status, _, body = request(self.app, "GET", f"/browse?target=staging-root&path={real_dir}",
                                       headers={"Cookie": self.cookie})
        page = body.decode()
        self.assertEqual(200, status)
        self.assertNotIn("No subdirectories here.", page)
        self.assertIn("Could not list this directory", page)
        self.assertIn("Operation not permitted", page)
        self.assertIn("Select this directory", page)  # still selectable regardless

    def test_browsing_never_writes_to_the_audit_log(self):
        # setUp's own login() already wrote one "login" entry -- capture that
        # baseline rather than asserting the file is absent, then confirm
        # browsing (unlike every POST action) adds nothing further at all.
        before = self.audit.read_text()
        share_style_dir = Path(self.tmp.name) / "AUDIT_SHARE$"; share_style_dir.mkdir()
        for query in ("/browse?target=staging-root", "/browse?target=network-drop-root",
                      f"/browse?target=image-directory&path={share_style_dir}", "/browse?target=bogus"):
            request(self.app, "GET", query, headers={"Cookie": self.cookie})
        self.assertEqual(before, self.audit.read_text())

    def test_browse_native_requires_session(self):
        status, _, _ = request(self.app, "GET", "/browse-native?target=staging-root")
        self.assertEqual(401, status)

    def test_browse_native_unknown_or_missing_target_is_not_found(self):
        for query in ("/browse-native", "/browse-native?target=bogus", "/browse-native?target="):
            status, _, _ = request(self.app, "GET", query, headers={"Cookie": self.cookie})
            self.assertEqual(404, status, query)

    def test_browse_native_starts_from_the_fields_current_value(self):
        with mock.patch.object(dashboard, "native_choose_folder",
                                return_value=("cancelled", None)) as choose:
            request(self.app, "GET", "/browse-native?target=staging-root", headers={"Cookie": self.cookie})
        start_dir = choose.call_args[0][1]
        self.assertEqual(self.root, start_dir)

    def test_browse_native_chosen_path_delegates_to_the_same_confirmation_screen_as_the_list_picker(self):
        picked = Path(self.tmp.name) / "picked-via-native-dialog"; picked.mkdir()
        with mock.patch.object(dashboard, "native_choose_folder", return_value=("chosen", str(picked))):
            status, _, body = request(self.app, "GET", "/browse-native?target=staging-root",
                                       headers={"Cookie": self.cookie})
        page = body.decode()
        self.assertEqual(200, status)
        self.assertIn(f'value="{picked}"', page)
        self.assertIn('action="/staging-root"', page)
        self.assertIn("Select this directory", page)
        # Nothing is saved yet -- picking in the native panel only fills in
        # the confirmation screen, exactly like clicking through the list
        # picker does; the real /staging-root POST route still has the only
        # actual final say.
        self.assertEqual(str(self.root), os.environ["WSI_INGEST_STAGING_ROOT"])

    def test_browse_native_cancelled_shows_a_neutral_message_and_changes_nothing(self):
        with mock.patch.object(dashboard, "native_choose_folder", return_value=("cancelled", None)):
            status, _, body = request(self.app, "GET", "/browse-native?target=network-drop-root",
                                       headers={"Cookie": self.cookie})
        page = body.decode()
        self.assertEqual(200, status)
        self.assertIn("cancelled", page.lower())
        value, is_live = self.app.network_drop_root_state()
        self.assertEqual("", value); self.assertFalse(is_live)

    def test_browse_native_error_shows_fallback_link_to_the_list_picker(self):
        with mock.patch.object(dashboard, "native_choose_folder",
                                return_value=("error", "some AppleScript failure")):
            status, _, body = request(self.app, "GET", "/browse-native?target=image-directory",
                                       headers={"Cookie": self.cookie})
        page = body.decode()
        self.assertEqual(200, status)
        self.assertIn("some AppleScript failure", page)
        self.assertIn("/browse?target=image-directory", page)

    def test_browse_native_link_and_list_view_fallback_link_both_appear_on_homepage(self):
        status, _, body = request(self.app, headers={"Cookie": self.cookie})
        page = body.decode()
        self.assertEqual(200, status)
        for target in ("staging-root", "network-drop-root", "image-directory"):
            self.assertIn(f"/browse-native?target={target}", page)
            self.assertIn(f"/browse?target={target}", page)

    def test_browse_native_never_writes_to_the_audit_log(self):
        before = self.audit.read_text()
        with mock.patch.object(dashboard, "native_choose_folder", return_value=("cancelled", None)):
            for query in ("/browse-native?target=staging-root", "/browse-native?target=network-drop-root",
                          "/browse-native?target=image-directory", "/browse-native?target=bogus"):
                request(self.app, "GET", query, headers={"Cookie": self.cookie})
        self.assertEqual(before, self.audit.read_text())

    def test_audit_entries_never_contain_configured_directory_paths(self):
        new_drop_dir = Path(self.tmp.name) / "new-network-drop"; new_drop_dir.mkdir()
        self.post("/staging-root", {"csrf": self.csrf, "path": str(self.new_staging_dir)})
        self.post("/network-drop-root", {"csrf": self.csrf, "path": str(new_drop_dir)})
        self.post("/image-directory", {"csrf": self.csrf, "confirmation": "RESTART", "path": str(self.new_image_dir)})
        text = self.audit.read_text()
        for forbidden in (str(self.new_staging_dir), str(new_drop_dir), str(self.new_image_dir), str(self.root),
                          "/Users/dm026/wsi-images/development", "secret", self.cookie, self.csrf):
            self.assertNotIn(forbidden, text)
        for expected_action in ("staging-root change result", "network-drop-root change result",
                                 "image-directory change result", "development recycle result"):
            self.assertIn(expected_action, text)


if __name__ == "__main__": unittest.main()
