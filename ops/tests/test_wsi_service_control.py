import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

OPS = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("wsi_service_control", OPS / "wsi_service_control.py")
control = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(control)


class ServiceControlTests(unittest.TestCase):
    def test_cli_rejects_unknown_target(self):
        with self.assertRaises(SystemExit):
            control.build_parser().parse_args(["status", "database"])

    def test_run_action_rejects_unknown_target(self):
        with self.assertRaises(control.ServiceError):
            control.run_action("database", "status")

    def test_format_combined_status(self):
        text = control.format_status({
            "viewer": {"name": "Image server", "running": True, "detail": "listening on 127.0.0.1:8080"},
            "ingest": {"name": "Ingestion engine", "running": False, "detail": "stopped"},
        })
        self.assertIn("Image server: running", text)
        self.assertIn("Ingestion engine: stopped", text)

    def test_load_ingest_environment_reads_conf(self):
        with tempfile.TemporaryDirectory() as tmp:
            conf = Path(tmp) / "wsi-ingest.conf"
            conf.write_text('export WSI_INGEST_STAGING_ROOT="/tmp/staging-fixture"\n', encoding="utf-8")
            with mock.patch.dict(os.environ, {
                "WSI_OPS_INGEST_CONF_FILE": str(conf),
                "WSI_OPS_ENV_LOCAL": str(Path(tmp) / "missing.env"),
            }, clear=False):
                env = control.load_ingest_environment({"KEEP": "1"})
            self.assertEqual(env["WSI_INGEST_STAGING_ROOT"], "/tmp/staging-fixture")
            self.assertEqual(env["KEEP"], "1")

    def test_start_viewer_skips_when_already_listening(self):
        with mock.patch.object(control, "viewer_status", return_value={
            "name": "Image server",
            "target": "viewer",
            "running": True,
            "port": 8080,
            "pids": [11],
            "pid": 11,
            "detail": "listening",
        }):
            result = control.start_viewer()
        self.assertFalse(result["changed"])
        self.assertIn("already running", result["message"])

    def test_stop_ingest_writes_nothing_when_already_stopped(self):
        with tempfile.TemporaryDirectory() as tmp:
            control_dir = Path(tmp) / "daemon"
            control_dir.mkdir()
            with mock.patch.object(control, "ingest_status", return_value={
                "name": "Ingestion engine",
                "target": "ingest",
                "running": False,
                "pids": [],
                "pid": None,
                "paused": False,
                "detail": "stopped",
            }), mock.patch.object(control, "ingest_control_dir", return_value=control_dir), \
                    mock.patch.object(control, "load_ingest_environment", return_value={}):
                result = control.stop_ingest()
        self.assertFalse(result["changed"])
        self.assertFalse((control_dir / "stop").exists())

    def test_relaunch_both_order(self):
        calls = []

        def record(name):
            def inner(*_args, **_kwargs):
                calls.append(name)
                return {"name": name, "message": name, "changed": True}

            return inner

        with mock.patch.object(control, "stop_ingest", record("stop_ingest")), \
                mock.patch.object(control, "stop_viewer", record("stop_viewer")), \
                mock.patch.object(control, "start_viewer", record("start_viewer")), \
                mock.patch.object(control, "start_ingest", record("start_ingest")):
            control.run_action("both", "relaunch")
        self.assertEqual(calls, ["stop_ingest", "stop_viewer", "start_viewer", "start_ingest"])

    def test_dispatch_uses_remote_when_configured(self):
        cfg = {"remote_url": "http://192.0.2.10:8084", "token": "lab-token"}
        snapshot = {
            "viewer": {"name": "Image server", "running": True, "detail": "listening"},
            "ingest": {"name": "Ingestion engine", "running": False, "detail": "stopped"},
        }
        with mock.patch.object(control, "remote_run_action", return_value=snapshot) as remote, \
                mock.patch.object(control, "run_action") as local:
            result = control.dispatch_action("both", "status", cfg=cfg)
        self.assertEqual(result, snapshot)
        remote.assert_called_once()
        local.assert_not_called()

    def test_dispatch_local_flag_skips_remote(self):
        cfg = {"remote_url": "http://192.0.2.10:8084", "token": "lab-token"}
        with mock.patch.object(control, "run_action", return_value={"ok": True}) as local, \
                mock.patch.object(control, "remote_run_action") as remote:
            control.dispatch_action("viewer", "status", cfg=cfg, local=True)
        local.assert_called_once()
        remote.assert_not_called()

    def test_save_and_load_config_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "com.wsi.control" / "config.json"
            saved = control.save_control_config(
                {"remote_url": "http://192.0.2.10:8084", "token": "lab-token", "password": "ignore-me"},
                path=path,
            )
            self.assertEqual(saved, path)
            text = path.read_text(encoding="utf-8")
            self.assertIn("lab-token", text)
            self.assertNotIn("ignore-me", text)
            with mock.patch.dict(os.environ, {
                "WSI_CONTROL_CONFIG": str(path),
                "WSI_CONTROL_REMOTE": "",
                "WSI_CONTROL_TOKEN": "",
                "WSI_OPS_CONTROL_TOKEN": "",
                "WSI_CONTROL_PASSWORD": "",
            }, clear=False):
                loaded = control.load_control_config()
            self.assertEqual(loaded["remote_url"], "http://192.0.2.10:8084")
            self.assertEqual(loaded["token"], "lab-token")
            self.assertNotIn("password", loaded)

    def test_viewer_open_url_uses_remote_host(self):
        url = control.viewer_open_url({"remote_url": "http://192.0.2.10:8084"})
        self.assertEqual(url, "http://192.0.2.10:8080/")

    def test_remote_call_sends_token_and_parses_json(self):
        class FakeResponse:
            def __init__(self):
                self.status = 200
                self.headers = {}

            def read(self):
                return json.dumps({"viewer": {"name": "Image server", "running": True}}).encode()

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        class FakeOpener:
            def __init__(self):
                self.request = None

            def open(self, request, timeout=None):
                self.request = request
                return FakeResponse()

        opener = FakeOpener()
        cfg = {"remote_url": "http://192.0.2.10:8084", "token": "lab-token"}
        data = control.remote_call(cfg, "GET", "/api/services", opener=opener)
        self.assertEqual("Image server", data["viewer"]["name"])
        sent = {key.lower(): value for key, value in opener.request.header_items()}
        self.assertEqual("lab-token", sent.get("x-wsi-control-token"))

    def test_normalize_remote_url_rejects_non_http(self):
        with self.assertRaises(control.ServiceError):
            control.normalize_remote_url("file:///etc/passwd")


if __name__ == "__main__":
    unittest.main()
