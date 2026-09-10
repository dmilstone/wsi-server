#!/usr/bin/env python3
"""Launch, quit, and relaunch the image server and ingestion daemon.

This is the single process-control module used by:

- the ops dashboard page at /services (always local to the dashboard host)
- the standalone WSI Control app (macOS and Windows), including remote mode
- ops/wsi-control on the command line

Remote mode talks to the dashboard JSON API; it does not start processes on
the client machine. The dashboard itself always calls run_action() locally.

It does not reimplement ingest hashing or promotion. The daemon is started as
the existing ops/wsi_ingest_daemon.py process. wsi_ingest.py is never modified
or imported for side effects.

Image-server default is this repository's Maven viewer on port 8080 (the
workstation workflow). Set WSI_CONTROL_VIEWER_MODE=jar to start the production
JAR instead. Windows uses the same Python entry points; there is no zsh
dependency.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
try:
    from wsi_paths import default_production_server_root
except ImportError:
    def default_production_server_root():
        configured = os.environ.get("WSI_PRODUCTION_ROOT")
        if configured:
            return Path(os.path.expandvars(configured)).expanduser()
        home = os.environ.get("WSI_HOME") or os.environ.get("USERPROFILE") or os.environ.get("HOME")
        base = Path(home).expanduser() if home else Path.home()
        return base / "wsi" / "wsi-server-production"

REPO_ROOT = Path(os.environ.get("WSI_REPO", str(HERE.parent))).resolve()
VIEWER_PORT = int(os.environ.get("WSI_CONTROL_VIEWER_PORT", "8080"))
VIEWER_HOST = os.environ.get("WSI_CONTROL_VIEWER_HOST", "127.0.0.1")
VIEWER_MODE = os.environ.get("WSI_CONTROL_VIEWER_MODE", "maven").strip().lower()
VIEWER_WAIT_SECONDS = int(os.environ.get("WSI_CONTROL_VIEWER_WAIT_SECONDS", "75"))
INGEST_STOP_WAIT_SECONDS = int(os.environ.get("WSI_CONTROL_INGEST_STOP_WAIT_SECONDS", "20"))
RUNTIME = Path(os.environ.get("WSI_CONTROL_RUNTIME", str(REPO_ROOT / ".runtime" / "control")))
VIEWER_LOG = RUNTIME / "viewer.log"
VIEWER_PID = RUNTIME / "viewer.pid"
INGEST_PID = RUNTIME / "ingest-daemon.pid"
TARGETS = ("viewer", "ingest", "both")
ACTIONS = ("status", "start", "stop", "relaunch")


class ServiceError(RuntimeError):
    pass


def load_ingest_environment(env=None):
    """Apply ops/wsi-ingest.conf then ops/.env.local into a copy of env."""
    merged = dict(os.environ if env is None else env)
    conf = Path(os.environ.get("WSI_OPS_INGEST_CONF_FILE", str(HERE / "wsi-ingest.conf")))
    local_env = Path(os.environ.get("WSI_OPS_ENV_LOCAL", str(HERE / ".env.local")))
    for path in (conf, local_env):
        if not path.is_file():
            continue
        for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[7:].strip()
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip("'").strip('"')
            if key:
                merged[key] = value
    return merged


def port_is_open(host, port, timeout=0.35):
    try:
        with socket.create_connection((host, int(port)), timeout=timeout):
            return True
    except OSError:
        return False


def listener_pids(port):
    port = int(port)
    if os.name == "nt":
        return _windows_listen_pids(port)
    try:
        output = subprocess.check_output(
            ["lsof", f"-tiTCP:{port}", "-sTCP:LISTEN"],
            text=True,
            stderr=subprocess.DEVNULL,
            shell=False,
        )
    except (OSError, subprocess.CalledProcessError):
        return []
    pids = []
    for line in output.splitlines():
        line = line.strip()
        if line.isdigit():
            pids.append(int(line))
    return pids


def _windows_listen_pids(port):
    try:
        output = subprocess.check_output(
            ["netstat", "-ano", "-p", "tcp"],
            text=True,
            stderr=subprocess.DEVNULL,
            shell=False,
        )
    except (OSError, subprocess.CalledProcessError):
        return []
    pids = []
    needle = f":{port}"
    for line in output.splitlines():
        if "LISTENING" not in line.upper():
            continue
        parts = line.split()
        if len(parts) < 4 or not parts[-1].isdigit():
            continue
        local = parts[1] if len(parts) > 1 else ""
        if local.endswith(needle) or local.endswith(f"]:{port}"):
            pid = int(parts[-1])
            if pid not in pids:
                pids.append(pid)
    return pids


def process_running(pid):
    if not pid:
        return False
    if os.name == "nt":
        try:
            output = subprocess.check_output(
                ["tasklist", "/FI", f"PID eq {int(pid)}"],
                text=True,
                stderr=subprocess.DEVNULL,
                shell=False,
            )
        except (OSError, subprocess.CalledProcessError):
            return False
        return str(pid) in output
    try:
        os.kill(int(pid), 0)
        return True
    except OSError:
        return False


def read_pid_file(path):
    try:
        raw = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return int(raw) if raw.isdigit() else None


def write_pid_file(path, pid):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(str(int(pid)) + "\n", encoding="utf-8")


def terminate_pids(pids, wait_seconds=15):
    messages = []
    remaining = [int(pid) for pid in pids if int(pid) > 0]
    if not remaining:
        return messages
    if os.name == "nt":
        for pid in remaining:
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T"],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                shell=False,
            )
        deadline = time.time() + wait_seconds
        while time.time() < deadline and any(process_running(pid) for pid in remaining):
            time.sleep(0.4)
        still = [pid for pid in remaining if process_running(pid)]
        for pid in still:
            subprocess.run(
                ["taskkill", "/F", "/PID", str(pid), "/T"],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                shell=False,
            )
            messages.append(f"forced stop of PID {pid}")
        return messages
    for pid in remaining:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            continue
    deadline = time.time() + wait_seconds
    while time.time() < deadline and any(process_running(pid) for pid in remaining):
        time.sleep(0.4)
    for pid in remaining:
        if not process_running(pid):
            continue
        try:
            os.kill(pid, signal.SIGKILL)
            messages.append(f"forced stop of PID {pid}")
        except OSError:
            pass
    return messages


def spawn_detached(command, cwd, env, log_path):
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log = open(log_path, "ab", buffering=0)
    kwargs = {
        "cwd": str(cwd),
        "env": env,
        "stdout": log,
        "stderr": subprocess.STDOUT,
        "stdin": subprocess.DEVNULL,
        "shell": False,
    }
    if os.name == "nt":
        flags = 0
        if hasattr(subprocess, "DETACHED_PROCESS"):
            flags |= subprocess.DETACHED_PROCESS
        if hasattr(subprocess, "CREATE_NEW_PROCESS_GROUP"):
            flags |= subprocess.CREATE_NEW_PROCESS_GROUP
        if flags:
            kwargs["creationflags"] = flags
    else:
        kwargs["start_new_session"] = True
    process = subprocess.Popen(command, **kwargs)
    log.close()
    return process.pid


def wait_for_port(host, port, seconds):
    deadline = time.time() + max(1, int(seconds))
    while time.time() < deadline:
        if port_is_open(host, port):
            return True
        time.sleep(0.5)
    return port_is_open(host, port)


def viewer_command(mode=None):
    chosen = (mode or VIEWER_MODE or "maven").lower()
    if chosen == "jar":
        root = default_production_server_root()
        jar = Path(os.environ.get("WSI_CONTROL_JAR", str(root / "app" / "wsi-server.jar")))
        config = Path(os.environ.get("WSI_CONTROL_VIEWER_CONFIG", str(root / "config")))
        if not jar.is_file():
            raise ServiceError(f"viewer JAR not found: {jar}")
        java = os.environ.get("WSI_CONTROL_JAVA", "java")
        args = [java, "-jar", str(jar)]
        if (config / "application.properties").is_file():
            args.append("--spring.config.additional-location=file:" + config.as_posix().rstrip("/") + "/")
        return args, str(root)
    wrapper = REPO_ROOT / ("mvnw.cmd" if os.name == "nt" else "mvnw")
    if not wrapper.is_file():
        raise ServiceError(f"Maven wrapper not found: {wrapper}")
    return [str(wrapper), "spring-boot:run"], str(REPO_ROOT)


def viewer_status():
    pids = listener_pids(VIEWER_PORT)
    recorded = read_pid_file(VIEWER_PID)
    running = port_is_open(VIEWER_HOST, VIEWER_PORT)
    return {
        "name": "Image server",
        "target": "viewer",
        "running": running,
        "port": VIEWER_PORT,
        "pids": pids,
        "pid": (pids[0] if pids else recorded),
        "detail": (
            f"listening on {VIEWER_HOST}:{VIEWER_PORT}"
            if running
            else f"stopped ({VIEWER_HOST}:{VIEWER_PORT})"
        ),
    }


def start_viewer(mode=None, wait_seconds=None):
    status = viewer_status()
    if status["running"]:
        return {**status, "changed": False, "message": "Image server is already running."}
    command, cwd = viewer_command(mode)
    env = dict(os.environ)
    env.pop("WSI_OPS_DASHBOARD_PASSWORD", None)
    pid = spawn_detached(command, cwd, env, VIEWER_LOG)
    write_pid_file(VIEWER_PID, pid)
    timeout = VIEWER_WAIT_SECONDS if wait_seconds is None else wait_seconds
    if timeout and not wait_for_port(VIEWER_HOST, VIEWER_PORT, timeout):
        raise ServiceError(
            f"Image server started (PID {pid}) but did not listen on {VIEWER_PORT} within {timeout}s. "
            f"See {VIEWER_LOG}"
        )
    return {**viewer_status(), "changed": True, "message": f"Image server started (launcher PID {pid})."}


def stop_viewer():
    status = viewer_status()
    pids = list(status["pids"] or [])
    recorded = read_pid_file(VIEWER_PID)
    if recorded and recorded not in pids:
        pids.append(recorded)
    if not pids and not status["running"]:
        VIEWER_PID.unlink(missing_ok=True)
        return {**viewer_status(), "changed": False, "message": "Image server is already stopped."}
    notes = terminate_pids(pids)
    VIEWER_PID.unlink(missing_ok=True)
    if port_is_open(VIEWER_HOST, VIEWER_PORT):
        raise ServiceError("Image server is still listening after stop.")
    extra = (" " + "; ".join(notes)) if notes else ""
    return {**viewer_status(), "changed": True, "message": "Image server stopped." + extra}


def ingest_control_dir(env=None):
    merged = load_ingest_environment(env)
    staging = Path(merged.get("WSI_INGEST_STAGING_ROOT", "")).expanduser()
    if str(staging):
        return staging / ".wsi-ingest-control" / "daemon"
    return RUNTIME / "ingest-control" / "daemon"


def ingest_pids():
    found = []
    recorded = read_pid_file(INGEST_PID)
    if recorded and process_running(recorded):
        found.append(recorded)
    if os.name == "nt":
        try:
            output = subprocess.check_output(
                ["wmic", "process", "where", "CommandLine like '%wsi_ingest_daemon.py%'", "get", "ProcessId"],
                text=True,
                stderr=subprocess.DEVNULL,
                shell=False,
            )
            for line in output.splitlines():
                line = line.strip()
                if line.isdigit():
                    pid = int(line)
                    if pid not in found:
                        found.append(pid)
        except (OSError, subprocess.CalledProcessError):
            pass
        return found
    try:
        output = subprocess.check_output(
            ["pgrep", "-f", "wsi_ingest_daemon.py"],
            text=True,
            stderr=subprocess.DEVNULL,
            shell=False,
        )
        for line in output.splitlines():
            if line.strip().isdigit():
                pid = int(line.strip())
                if pid not in found:
                    found.append(pid)
    except (OSError, subprocess.CalledProcessError):
        pass
    return found


def ingest_status():
    pids = ingest_pids()
    control = ingest_control_dir()
    paused = (control / "pause").is_file()
    stop_requested = (control / "stop").is_file()
    running = bool(pids)
    detail = "running" if running else "stopped"
    if running and paused:
        detail = "running (paused)"
    if running and stop_requested:
        detail = "running (stop requested)"
    return {
        "name": "Ingestion engine",
        "target": "ingest",
        "running": running,
        "pids": pids,
        "pid": (pids[0] if pids else None),
        "paused": paused,
        "detail": detail,
    }


def start_ingest():
    status = ingest_status()
    if status["running"]:
        return {**status, "changed": False, "message": "Ingestion engine is already running."}
    script = None
    repo = os.environ.get("WSI_REPO", "").strip()
    candidates = [HERE / "wsi_ingest_daemon.py", REPO_ROOT / "ops" / "wsi_ingest_daemon.py"]
    if repo:
        candidates.append(Path(repo) / "ops" / "wsi_ingest_daemon.py")
    for candidate in candidates:
        try:
            if candidate.is_file():
                script = candidate
                break
        except OSError:
            continue
    if script is None:
        raise ServiceError("ingest daemon script not found (wsi_ingest_daemon.py)")
    env = load_ingest_environment()
    env.pop("WSI_OPS_DASHBOARD_PASSWORD", None)
    if "WSI_INGEST_DAEMON_REFRESH_URL" not in env:
        env["WSI_INGEST_DAEMON_REFRESH_URL"] = f"https://{VIEWER_HOST}:{VIEWER_PORT}"
    control = ingest_control_dir(env)
    control.mkdir(parents=True, exist_ok=True)
    (control / "stop").unlink(missing_ok=True)
    log = Path(env.get("WSI_INGEST_DAEMON_LOG") or str(control / "daemon.log.jsonl"))
    python = env.get("WSI_CONTROL_PYTHON") or sys.executable
    pid = spawn_detached([python, "-u", str(script)], HERE, env, log)
    write_pid_file(INGEST_PID, pid)
    time.sleep(0.4)
    if not process_running(pid):
        raise ServiceError(f"Ingestion engine exited immediately. See {log}")
    return {**ingest_status(), "changed": True, "message": f"Ingestion engine started (PID {pid})."}


def stop_ingest():
    status = ingest_status()
    env = load_ingest_environment()
    control = ingest_control_dir(env)
    control.mkdir(parents=True, exist_ok=True)
    if not status["running"]:
        (control / "stop").unlink(missing_ok=True)
        INGEST_PID.unlink(missing_ok=True)
        return {**ingest_status(), "changed": False, "message": "Ingestion engine is already stopped."}
    (control / "stop").write_text("", encoding="utf-8")
    deadline = time.time() + INGEST_STOP_WAIT_SECONDS
    while time.time() < deadline and ingest_pids():
        time.sleep(0.4)
    leftover = ingest_pids()
    notes = terminate_pids(leftover) if leftover else []
    (control / "stop").unlink(missing_ok=True)
    INGEST_PID.unlink(missing_ok=True)
    extra = (" " + "; ".join(notes)) if notes else ""
    return {**ingest_status(), "changed": True, "message": "Ingestion engine stopped." + extra}


def combined_status():
    return {"viewer": viewer_status(), "ingest": ingest_status()}


def run_action(target, action, mode=None, wait_seconds=None):
    if target not in TARGETS:
        raise ServiceError(f"unknown target: {target}")
    if action not in ACTIONS:
        raise ServiceError(f"unknown action: {action}")
    if action == "status":
        if target == "both":
            return combined_status()
        return viewer_status() if target == "viewer" else ingest_status()

    results = []
    if action == "relaunch":
        if target in ("both", "ingest"):
            results.append(stop_ingest())
        if target in ("both", "viewer"):
            results.append(stop_viewer())
        if target in ("both", "viewer"):
            results.append(start_viewer(mode=mode, wait_seconds=wait_seconds))
        if target in ("both", "ingest"):
            results.append(start_ingest())
        return results

    if action == "start":
        if target in ("both", "viewer"):
            results.append(start_viewer(mode=mode, wait_seconds=wait_seconds))
        if target in ("both", "ingest"):
            results.append(start_ingest())
        return results[0] if target != "both" else results

    if target in ("both", "ingest"):
        results.append(stop_ingest())
    if target in ("both", "viewer"):
        results.append(stop_viewer())
    return results[0] if target != "both" else results


def format_status(data):
    if isinstance(data, list):
        return "\n".join(item.get("message") or item.get("detail") or str(item) for item in data)
    if "viewer" in data and "ingest" in data:
        lines = []
        for key in ("viewer", "ingest"):
            item = data[key]
            mark = "running" if item.get("running") else "stopped"
            lines.append(f"{item['name']}: {mark} — {item.get('detail', '')}")
        return "\n".join(lines)
    mark = "running" if data.get("running") else "stopped"
    return f"{data.get('name', data.get('target'))}: {mark} — {data.get('detail', data.get('message', ''))}"


REMOTE_CONFIRM = {"start": "START", "stop": "QUIT", "relaunch": "RELAUNCH"}


def default_config_path():
    override = os.environ.get("WSI_CONTROL_CONFIG")
    if override:
        return Path(override)
    if os.name == "nt":
        base = os.environ.get("APPDATA") or str(Path.home())
        return Path(base) / "com.wsi.control" / "config.json"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "com.wsi.control" / "config.json"
    xdg = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(xdg) / "com.wsi.control" / "config.json"


def load_control_config(path=None):
    cfg = {}
    config_path = Path(path) if path else default_config_path()
    if config_path.is_file():
        try:
            loaded = json.loads(config_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            loaded = {}
        if isinstance(loaded, dict):
            cfg.update(loaded)
    remote = (os.environ.get("WSI_CONTROL_REMOTE") or "").strip()
    if remote:
        cfg["remote_url"] = remote
    token = (os.environ.get("WSI_CONTROL_TOKEN") or os.environ.get("WSI_OPS_CONTROL_TOKEN") or "").strip()
    if token:
        cfg["token"] = token
    password = os.environ.get("WSI_CONTROL_PASSWORD")
    if password:
        cfg["password"] = password
    viewer = (os.environ.get("WSI_CONTROL_VIEWER_URL") or "").strip()
    if viewer:
        cfg["viewer_url"] = viewer
    return cfg


def save_control_config(cfg, path=None):
    config_path = Path(path) if path else default_config_path()
    config_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "remote_url": (cfg.get("remote_url") or "").strip(),
        "token": (cfg.get("token") or "").strip(),
        "viewer_url": (cfg.get("viewer_url") or "").strip(),
    }
    config_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    try:
        os.chmod(config_path, 0o600)
        os.chmod(config_path.parent, 0o700)
    except OSError:
        pass
    return config_path


def normalize_remote_url(url):
    url = (url or "").strip().rstrip("/")
    if not url:
        return ""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ServiceError("remote dashboard URL must be http or https with a host")
    return url


def dashboard_page_url(cfg=None):
    cfg = cfg or load_control_config()
    remote = (cfg.get("remote_url") or "").strip()
    if remote:
        return normalize_remote_url(remote) + "/services"
    return os.environ.get("WSI_OPS_DASHBOARD_URL", "https://127.0.0.1:8084/services")


def viewer_open_url(cfg=None):
    cfg = cfg or load_control_config()
    if cfg.get("viewer_url"):
        return cfg["viewer_url"].rstrip("/") + "/"
    remote = (cfg.get("remote_url") or "").strip()
    if remote:
        parsed = urllib.parse.urlparse(normalize_remote_url(remote))
        host = parsed.hostname or VIEWER_HOST
        return f"https://{host}:{VIEWER_PORT}/"
    return f"https://{VIEWER_HOST}:{VIEWER_PORT}/"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _remote_ssl_context():
    ca = (os.environ.get("WSI_CONTROL_CA_FILE") or "").strip()
    context = ssl.create_default_context()
    if ca:
        context.load_verify_locations(cafile=ca)
    return context


def _remote_opener(url):
    parsed = urllib.parse.urlparse(url)
    https = urllib.request.HTTPSHandler(context=_remote_ssl_context()) if parsed.scheme == "https" else None
    handlers = [_NoRedirect()]
    if https:
        handlers.append(https)
    return urllib.request.build_opener(*handlers)


def remote_call(cfg, method, path, payload=None, opener=None, timeout=90):
    base = normalize_remote_url(cfg.get("remote_url") or "")
    if not base:
        raise ServiceError("remote dashboard URL is not set")
    url = base + path
    headers = {"Accept": "application/json", "User-Agent": "wsi-control"}
    token = (cfg.get("token") or "").strip()
    if token:
        headers["X-WSI-Control-Token"] = token
    cookie = (cfg.get("_cookie") or "").strip()
    if cookie:
        headers["Cookie"] = cookie
    data = None
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    opener = opener or _remote_opener(base)
    try:
        with opener.open(request, timeout=timeout) as response:
            raw = response.read()
            status = getattr(response, "status", 200)
            set_cookie = response.headers.get("Set-Cookie", "") if response.headers else ""
    except urllib.error.HTTPError as error:
        raw = error.read() if error.fp else b""
        status = error.code
        set_cookie = error.headers.get("Set-Cookie", "") if error.headers else ""
    except urllib.error.URLError as error:
        raise ServiceError(f"could not reach remote dashboard: {error.reason}") from error
    if set_cookie and "wsi_ops_session=" in set_cookie:
        cfg["_cookie"] = set_cookie.split(";", 1)[0]
    try:
        parsed = json.loads(raw.decode() if raw else "null")
    except ValueError:
        parsed = None
    if status >= 400:
        detail = ""
        if isinstance(parsed, dict) and parsed.get("error"):
            detail = str(parsed["error"])
        raise ServiceError(detail or f"remote dashboard returned HTTP {status}")
    return parsed


def remote_login(cfg, opener=None):
    if (cfg.get("token") or "").strip():
        return cfg
    password = cfg.get("password") or ""
    if not password:
        raise ServiceError("remote mode needs WSI_CONTROL_TOKEN or WSI_CONTROL_PASSWORD")
    result = remote_call(cfg, "POST", "/api/login", {"password": password}, opener=opener, timeout=20)
    if isinstance(result, dict) and result.get("csrf"):
        cfg["_csrf"] = result["csrf"]
    return cfg


def remote_run_action(cfg, target, action, opener=None):
    cfg = dict(cfg)
    if not (cfg.get("token") or "").strip():
        remote_login(cfg, opener=opener)
    if action == "status":
        data = remote_call(cfg, "GET", "/api/services", opener=opener, timeout=20)
        if not isinstance(data, dict):
            raise ServiceError("remote status was not JSON")
        if target == "both":
            return data
        if target not in data:
            raise ServiceError("remote status did not include that service")
        return data[target]
    payload = {
        "target": target,
        "action": action,
        "confirmation": REMOTE_CONFIRM[action],
    }
    if cfg.get("_csrf"):
        payload["csrf"] = cfg["_csrf"]
    data = remote_call(cfg, "POST", "/api/services", payload, opener=opener)
    if isinstance(data, dict) and "result" in data:
        return data["result"]
    return data


def dispatch_action(target, action, mode=None, wait_seconds=None, cfg=None, local=False, opener=None):
    if local:
        return run_action(target, action, mode=mode, wait_seconds=wait_seconds)
    cfg = dict(cfg or load_control_config())
    if cfg.get("remote_url"):
        return remote_run_action(cfg, target, action, opener=opener)
    return run_action(target, action, mode=mode, wait_seconds=wait_seconds)


def build_parser():
    parser = argparse.ArgumentParser(
        description="Launch, quit, or relaunch the image server and ingestion engine."
    )
    parser.add_argument("action", choices=ACTIONS)
    parser.add_argument("target", nargs="?", default="both", choices=TARGETS)
    parser.add_argument("--mode", choices=("maven", "jar"), default=None)
    parser.add_argument("--wait", type=int, default=None)
    parser.add_argument("--local", action="store_true", help="control processes on this computer even if remote is configured")
    parser.add_argument("--remote", default=None, help="dashboard URL, for example http://192.168.1.10:8084")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    cfg = load_control_config()
    if args.remote:
        cfg["remote_url"] = args.remote
    try:
        result = dispatch_action(
            args.target,
            args.action,
            mode=args.mode,
            wait_seconds=args.wait,
            cfg=cfg,
            local=args.local,
        )
    except ServiceError as error:
        sys.stderr.write(str(error) + "\n")
        return 1
    sys.stdout.write(format_status(result) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
