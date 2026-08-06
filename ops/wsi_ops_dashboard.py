#!/usr/bin/env python3
"""Loopback-only, deliberately started web UI for the manual WSI ingester."""
import hashlib
import hmac
import html
import ipaddress
import json
import os
import secrets
import stat
import subprocess
import sys
import threading
import time
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs

HERE = Path(__file__).resolve().parent
BIND_ADDRESS = "127.0.0.1"
PORT = 8084
COOKIE = "wsi_ops_session"
COOKIE_PATH = "/"
SESSION_SECONDS = 15 * 60
MAX_BODY = 8192
CONTROL = ".wsi-ingest-control"
ALLOWED_HOSTS = {f"localhost:{PORT}", f"127.0.0.1:{PORT}"}
CSP = "default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"


class Sessions:
    def __init__(self, lifetime=SESSION_SECONDS, clock=time.time):
        self.lifetime, self.clock, self.items = lifetime, clock, {}
        self.lock = threading.Lock()

    def create(self):
        sid, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        with self.lock:
            self.items[sid] = (self.clock() + self.lifetime, csrf)
        return sid, csrf

    def get(self, sid):
        with self.lock:
            item = self.items.get(sid)
            if not item or item[0] <= self.clock():
                self.items.pop(sid, None)
                return None
            return item

    def remove(self, sid):
        with self.lock:
            self.items.pop(sid, None)


def password_from_environment():
    value = os.environ.get("WSI_OPS_DASHBOARD_PASSWORD", "")
    if not value:
        raise RuntimeError("WSI_OPS_DASHBOARD_PASSWORD must be non-empty")
    return value.encode()


def safe_candidates(root):
    result = []
    for item in root.iterdir():
        try:
            mode = item.lstat().st_mode
        except OSError:
            continue
        if not item.name.startswith("-") and item.name != CONTROL and stat.S_ISDIR(mode) and not stat.S_ISLNK(mode):
            result.append(item.name)
    return sorted(result)


def valid_selection(name, root):
    if not name or name.startswith("-") or name in (".", "..") or "/" in name or "\\" in name or Path(name).name != name:
        return False
    try:
        st = (root / name).lstat()
        return stat.S_ISDIR(st.st_mode) and not stat.S_ISLNK(st.st_mode)
    except OSError:
        return False


class Dashboard:
    def __init__(self, password, audit_path=None, runner=subprocess.run, clock=time.time):
        self.password = password
        self.sessions = Sessions(clock=clock)
        self.runner = runner
        self.clock = clock
        self.audit_path = Path(audit_path or os.environ.get("WSI_OPS_AUDIT_FILE", str(HERE / ".wsi-ops-audit.jsonl")))
        self.audit_lock = threading.Lock()

    def audit(self, action, outcome, transaction_id=None):
        event = {"timestamp": self.clock(), "action": action, "outcome": outcome}
        if transaction_id:
            event["transaction_id"] = transaction_id
        line = json.dumps(event, sort_keys=True) + "\n"
        with self.audit_lock:
            if not self.audit_path.parent.exists():
                missing = []
                parent = self.audit_path.parent
                while not parent.exists():
                    missing.append(parent); parent = parent.parent
                for directory in reversed(missing):
                    directory.mkdir(mode=0o700); os.chmod(directory, 0o700)
            fd = os.open(self.audit_path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            try:
                os.fchmod(fd, 0o600)
                data = line.encode()
                while data:
                    data = data[os.write(fd, data):]
                os.fsync(fd)
            finally:
                os.close(fd)

    def root(self):
        return Path(os.environ["WSI_INGEST_STAGING_ROOT"]).expanduser().resolve()

    def invoke(self, action, dataset=None, confirmation=None):
        commands = {
            "status": ["status"], "history": ["history"], "inspect": ["inspect"],
            "seal": ["seal"], "observe": ["observe"],
            "promote-dry-run": ["promote", "--dry-run"],
            "promote": ["promote", "--step"],
        }
        if action not in commands:
            raise ValueError("operation is not allowed")
        args = [sys.executable, str(HERE / "wsi_ingest.py"), *commands[action]]
        if dataset is not None:
            if not valid_selection(dataset, self.root()):
                raise ValueError("invalid dataset selection")
            args.append(dataset)
        # The executable and every option are selected above; dataset validation is repeated by wsi_ingest.py.
        child_env = dict(os.environ)
        child_env.pop("WSI_OPS_DASHBOARD_PASSWORD", None)
        kwargs = {"shell": False, "input": (confirmation + "\n") if confirmation else None,
                  "text": True, "capture_output": True, "env": child_env}
        # Only status/history are bounded metadata reads. Whole-tree and durable
        # operations must finish under the ingester's lock/journal/recovery rules.
        if action in ("status", "history"):
            kwargs["timeout"] = 10
        return self.runner(args, **kwargs)


class OpsHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = False

    def __init__(self, dashboard, handler_class=None):
        self.dashboard = dashboard
        # Deliberately no address parameter: this service can only request IPv4 loopback.
        super().__init__((BIND_ADDRESS, PORT), handler_class or Handler, bind_and_activate=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "WSIOps/1"

    def log_message(self, fmt, *args):
        # Do not log URLs, cookies, form bodies, dataset names, or credentials.
        sys.stderr.write("wsi-ops request completed\n")

    def reject_boundary(self):
        try:
            local = ipaddress.ip_address(self.client_address[0]).is_loopback
        except ValueError:
            local = False
        return not local or self.headers.get("Host", "").lower() not in ALLOWED_HOSTS

    def security_headers(self):
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")

    def respond(self, status, body, content_type="text/html; charset=utf-8", cookie=None, location=None):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(status); self.security_headers()
        self.send_header("Content-Type", content_type); self.send_header("Content-Length", str(len(data)))
        if cookie: self.send_header("Set-Cookie", cookie)
        if location: self.send_header("Location", location)
        self.end_headers(); self.wfile.write(data)

    def session(self):
        raw = self.headers.get("Cookie", "")
        jar = SimpleCookie(); jar.load(raw)
        sid = jar[COOKIE].value if COOKIE in jar else ""
        return sid, self.server.dashboard.sessions.get(sid)

    def page(self, content, csrf=None):
        logout = (f'<form method="post" action="/logout"><input type="hidden" name="csrf" value="{html.escape(csrf)}"><button>Logout</button></form>' if csrf else "")
        return '<!doctype html><html><head><meta charset="utf-8"><title>Local WSI operations</title></head><body><h1>Local WSI operations</h1>' + logout + content + '</body></html>'

    def require_session(self):
        sid, item = self.session()
        if not item:
            self.respond(HTTPStatus.UNAUTHORIZED, self.page('<form method="post" action="/login"><label>Password <input type="password" name="password"></label><button>Login</button></form>'))
            return None
        return sid, item[1]

    def read_form(self):
        try: length = int(self.headers.get("Content-Length", "0"))
        except ValueError: length = MAX_BODY + 1
        if length > MAX_BODY: raise ValueError("request too large")
        return {k: v[-1] for k, v in parse_qs(self.rfile.read(length).decode(), keep_blank_values=True).items()}

    def do_GET(self):
        if self.reject_boundary(): return self.respond(HTTPStatus.FORBIDDEN, "Forbidden", "text/plain")
        auth = self.require_session()
        if not auth: return
        sid, csrf = auth
        if self.path == "/":
            try: names = safe_candidates(self.server.dashboard.root())
            except OSError: names = []
            options = ''.join(f'<option value="{html.escape(n)}">{html.escape(n)}</option>' for n in names)
            forms = []
            for action, label, confirm in [("inspect","Inspect",None),("seal","Seal","SEAL"),("observe","Observe",None),("dry-run","Promotion dry-run",None),("promote","Promote","PROMOTE")]:
                extra = f'<label>Type {confirm} <input name="confirmation"></label>' if confirm else ''
                forms.append(f'<form method="post" action="/{action}"><input type="hidden" name="csrf" value="{html.escape(csrf)}"><select name="dataset">{options}</select>{extra}<button>{label}</button></form>')
            links = '<p><a href="/cheatsheet.html">Release cheat sheet HTML</a> · <a href="/cheatsheet.pdf">PDF</a></p>'
            try:
                status = self.server.dashboard.invoke("status")
                history = self.server.dashboard.invoke("history")
                safe = html.escape(status.stdout + "\n" + history.stdout) if status.returncode == history.returncode == 0 else "Status unavailable (stop and inspect configuration)."
            except subprocess.TimeoutExpired:
                safe = "Status unavailable (stop and inspect configuration)."
            return self.respond(200, self.page('<pre>'+safe+'</pre>'+''.join(forms)+links, csrf))
        if self.path in ("/cheatsheet.html", "/cheatsheet.pdf"):
            source = HERE / ("RELEASE-CHEATSHEET.html" if self.path.endswith("html") else "WSI-Release-Cheat-Sheet.pdf")
            mime = "text/html; charset=utf-8" if self.path.endswith("html") else "application/pdf"
            return self.respond(200, source.read_bytes(), mime)
        self.respond(404, "Not found", "text/plain")

    def do_POST(self):
        if self.reject_boundary(): return self.respond(HTTPStatus.FORBIDDEN, "Forbidden", "text/plain")
        try: form = self.read_form()
        except (ValueError, UnicodeDecodeError): return self.respond(400, "Bad request", "text/plain")
        app = self.server.dashboard
        if self.path == "/login":
            ok = hmac.compare_digest(form.get("password", "").encode(), app.password)
            app.audit("login", "success" if ok else "failure")
            if not ok: return self.respond(HTTPStatus.UNAUTHORIZED, self.page("Login failed"))
            sid, csrf = app.sessions.create()
            cookie = f"{COOKIE}={sid}; Path={COOKIE_PATH}; HttpOnly; SameSite=Strict"
            return self.respond(303, "Logged in", "text/plain", cookie, "/")
        auth = self.require_session()
        if not auth: return
        sid, csrf = auth
        if not hmac.compare_digest(form.get("csrf", ""), csrf): return self.respond(HTTPStatus.FORBIDDEN, "CSRF rejected", "text/plain")
        if self.path == "/logout":
            app.sessions.remove(sid); app.audit("logout", "success")
            return self.respond(303, "Logged out", "text/plain", f"{COOKIE}=; Path={COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Strict", "/")
        actions = {"/inspect": ("inspect", None), "/seal": ("seal", "SEAL"), "/observe": ("observe", None), "/dry-run": ("promote-dry-run", None), "/promote": ("promote", "PROMOTE")}
        if self.path not in actions: return self.respond(404, "Not found", "text/plain")
        action, required = actions[self.path]; audit_action = "dry-run" if action == "promote-dry-run" else action
        app.audit(audit_action + " attempt", "started")
        if required and form.get("confirmation") != required:
            app.audit(audit_action + " result", "confirmation rejected")
            return self.respond(400, self.page("Required typed confirmation was not supplied.", csrf))
        try: result = app.invoke(action, form.get("dataset"), required)
        except (ValueError, subprocess.TimeoutExpired):
            app.audit(audit_action + " result", "failure"); return self.respond(400, self.page("Operation stopped: invalid selection or timeout.", csrf))
        output = result.stdout if result.returncode == 0 else result.stderr
        tx = None
        for line in output.splitlines():
            if line.startswith(("transaction:", "promoted transaction:", "sealed transaction:")): tx = line.split(":",1)[1].strip()
        app.audit(audit_action + " result", "success" if result.returncode == 0 else "failure", tx)
        # Ingestion messages contain no roots/names; suppress stderr details nonetheless.
        shown = output if result.returncode == 0 else "Operation stopped. Review the local ingestion configuration and readiness conditions."
        self.respond(200 if result.returncode == 0 else 409, self.page('<pre>'+html.escape(shown)+'</pre><p><a href="/">Back</a></p>', csrf))


def main():
    app = Dashboard(password_from_environment())
    server = OpsHTTPServer(app)
    try: server.serve_forever()
    finally: server.server_close()


if __name__ == "__main__":
    main()
