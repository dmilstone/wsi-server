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
BOUNDARY_DENIED = (
    "<div class='panel' role='alert'>"
    "<p><strong>Error:</strong> Access to Local WSI operations was denied because this request "
    "did not come from a loopback browser session on the image-server host.</p>"
    "<p><strong>Why:</strong> The dashboard binds only to <code>127.0.0.1:8084</code> and accepts "
    "only Host values <code>127.0.0.1:8084</code> or <code>localhost:8084</code>. "
    "Remote computers, proxies, and non-loopback Host headers are rejected on purpose.</p>"
    "<p><strong>Recovery:</strong></p>"
    "<ol>"
    "<li>Use a browser that is running on the image-server machine itself.</li>"
    "<li>Start the dashboard on that machine if needed "
    "(<code>source ops/wsi-ingest.conf</code>, set <code>WSI_OPS_DASHBOARD_PASSWORD</code>, "
    "then <code>./ops/wsi-ops-dashboard</code>).</li>"
    "<li>Open <code>http://127.0.0.1:8084/</code> or use the viewer’s "
    "<strong>Local operations</strong> link while the viewer itself is opened via "
    "<code>http://127.0.0.1:&lt;port&gt;/</code> or <code>http://localhost:&lt;port&gt;/</code>.</li>"
    "</ol>"
    "</div>"
)
DASHBOARD_STYLE = """
body { font: 16px system-ui, sans-serif; margin: 2rem; }
form { margin: .75rem 0; }
form + form { margin-top: 1rem; }
button {
  -webkit-appearance: none;
  appearance: none;
  border: 2px solid #174b78;
  border-radius: .3rem;
  background: #1769aa;
  color: #fff;
  cursor: pointer;
  font: inherit;
  font-weight: 700;
  padding: .45rem .8rem;
}
button:not(:disabled):hover { background: #0e578f; border-color: #0a416d; }
button:not(:disabled):active { background: #093d65; border-color: #062c49; transform: translateY(1px); }
button:focus-visible { outline: 3px solid #f0a500; outline-offset: 3px; }
button:disabled {
  background: #d8dde2;
  border-color: #9aa3ab;
  color: #626b73;
  cursor: not-allowed;
  opacity: .75;
}
.panel { border: 1px solid #ccc; border-radius: .5rem; padding: .9rem 1rem; background: #f7f7f7; max-width: 42rem; }
.panel ol { margin: .4rem 0 0; padding-left: 1.25rem; }
fieldset.approve { border: 1px solid #9aa3ab; border-radius: .4rem; margin: .6rem 0; padding: .55rem .75rem; max-width: 28rem; }
fieldset.approve legend { padding: 0 .35rem; font-weight: 700; }
fieldset.approve label { margin-right: 1rem; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
"""


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

    def run_approved_ingestion(self, dataset, sleep_fn=None, clock=None):
        """Seal, wait/observe until ready, dry-run, then promote with PROMOTE."""
        sleep_fn = time.sleep if sleep_fn is None else sleep_fn
        clock = time.time if clock is None else clock
        quiet = max(1, int(os.environ.get("WSI_INGEST_MIN_QUIET_SECONDS", "30")))
        interval = max(1, int(os.environ.get("WSI_INGEST_OBSERVATION_INTERVAL_SECONDS", "10")))
        required = max(2, int(os.environ.get("WSI_INGEST_REQUIRED_OBSERVATIONS", "3")))
        steps = []

        seal = self.invoke("seal", dataset, "SEAL")
        steps.append(("seal", seal))
        if seal.returncode != 0:
            return False, steps, seal

        # Seal already records observation #1; gather the remaining observations.
        for _ in range(required - 1):
            deadline = clock() + quiet + interval + 5
            observed = None
            while clock() < deadline:
                sleep_fn(min(interval, 1))
                observed = self.invoke("observe", dataset)
                steps.append(("observe", observed))
                if observed.returncode == 0:
                    break
            if observed is None or observed.returncode != 0:
                return False, steps, observed

        dry = None
        deadline = clock() + quiet + interval + 5
        while clock() < deadline:
            dry = self.invoke("promote-dry-run", dataset)
            steps.append(("promote-dry-run", dry))
            if dry.returncode == 0:
                break
            sleep_fn(1)
        if dry is None or dry.returncode != 0:
            return False, steps, dry

        promote = self.invoke("promote", dataset, "PROMOTE")
        steps.append(("promote", promote))
        return promote.returncode == 0, steps, promote


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
        return '<!doctype html><html><head><meta charset="utf-8"><title>Local WSI operations</title><style>' + DASHBOARD_STYLE + '</style></head><body><h1>Local WSI operations</h1>' + logout + content + '</body></html>'

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
        if self.reject_boundary():
            return self.respond(HTTPStatus.FORBIDDEN, self.page(BOUNDARY_DENIED))
        auth = self.require_session()
        if not auth: return
        sid, csrf = auth
        if self.path == "/":
            try: names = safe_candidates(self.server.dashboard.root())
            except OSError: names = []
            options = ''.join(f'<option value="{html.escape(n)}">{html.escape(n)}</option>' for n in names)
            inspect = (
                f'<form method="post" action="/inspect">'
                f'<input type="hidden" name="csrf" value="{html.escape(csrf)}">'
                f'<select name="dataset">{options}</select>'
                f'<button>Inspect</button></form>'
            )
            seal = (
                f'<form method="post" action="/seal">'
                f'<input type="hidden" name="csrf" value="{html.escape(csrf)}">'
                f'<select name="dataset">{options}</select>'
                f'<fieldset class="approve">'
                f'<legend>Approve and Seal this Ingestion? (Yes / No)</legend>'
                f'<label><input type="radio" name="approve" value="yes" required> Yes</label> '
                f'<label><input type="radio" name="approve" value="no"> No</label>'
                f'</fieldset>'
                f'<button>Seal &amp; ingest</button></form>'
            )
            forms = inspect + seal
            links = '<p><a href="/cheatsheet.html">Release cheat sheet HTML</a> · <a href="/cheatsheet.pdf">PDF</a></p>'
            try:
                status = self.server.dashboard.invoke("status")
                history = self.server.dashboard.invoke("history")
                safe = html.escape(status.stdout + "\n" + history.stdout) if status.returncode == history.returncode == 0 else "Status unavailable (stop and inspect configuration)."
            except subprocess.TimeoutExpired:
                safe = "Status unavailable (stop and inspect configuration)."
            return self.respond(200, self.page('<pre>'+safe+'</pre>'+forms+links, csrf))
        if self.path in ("/cheatsheet.html", "/cheatsheet.pdf"):
            source = HERE / ("RELEASE-CHEATSHEET.html" if self.path.endswith("html") else "WSI-Release-Cheat-Sheet.pdf")
            mime = "text/html; charset=utf-8" if self.path.endswith("html") else "application/pdf"
            return self.respond(200, source.read_bytes(), mime)
        self.respond(404, "Not found", "text/plain")

    def do_POST(self):
        if self.reject_boundary():
            return self.respond(HTTPStatus.FORBIDDEN, self.page(BOUNDARY_DENIED))
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
        if self.path == "/seal":
            app.audit("seal attempt", "started")
            approve = (form.get("approve") or "").strip().lower()
            if approve != "yes":
                app.audit("seal result", "confirmation rejected")
                return self.respond(400, self.page("Ingestion was not approved. Choose Yes to seal and continue automatically.", csrf))
            try:
                ok, steps, final = app.run_approved_ingestion(form.get("dataset"))
            except (ValueError, subprocess.TimeoutExpired):
                app.audit("seal result", "failure")
                return self.respond(400, self.page("Operation stopped: invalid selection or timeout.", csrf))
            chunks = []
            tx = None
            for name, result in steps:
                text = result.stdout if result.returncode == 0 else (result.stderr or result.stdout or "")
                chunks.append(f"## {name}\n{text}".rstrip())
                for line in (result.stdout or "").splitlines():
                    if line.startswith(("transaction:", "promoted transaction:", "sealed transaction:")):
                        tx = line.split(":", 1)[1].strip()
            app.audit("seal result", "success" if ok else "failure", tx)
            shown = "\n\n".join(chunks) if ok else (
                "Operation stopped during automated ingestion. Review the local ingestion configuration and readiness conditions.\n\n"
                + "\n\n".join(chunks)
            )
            return self.respond(
                200 if ok else 409,
                self.page("<pre>" + html.escape(shown) + '</pre><p><a href="/">Back</a></p>', csrf),
            )

        actions = {
            "/inspect": ("inspect", None),
            "/observe": ("observe", None),
            "/dry-run": ("promote-dry-run", None),
            "/promote": ("promote", "PROMOTE"),
        }
        if self.path not in actions:
            return self.respond(404, "Not found", "text/plain")
        action, required = actions[self.path]
        audit_action = "dry-run" if action == "promote-dry-run" else action
        app.audit(audit_action + " attempt", "started")
        if required and form.get("confirmation") != required:
            app.audit(audit_action + " result", "confirmation rejected")
            return self.respond(400, self.page("Required typed confirmation was not supplied.", csrf))
        try:
            result = app.invoke(action, form.get("dataset"), required)
        except (ValueError, subprocess.TimeoutExpired):
            app.audit(audit_action + " result", "failure")
            return self.respond(400, self.page("Operation stopped: invalid selection or timeout.", csrf))
        output = result.stdout if result.returncode == 0 else result.stderr
        tx = None
        for line in output.splitlines():
            if line.startswith(("transaction:", "promoted transaction:", "sealed transaction:")):
                tx = line.split(":", 1)[1].strip()
        app.audit(audit_action + " result", "success" if result.returncode == 0 else "failure", tx)
        shown = output if result.returncode == 0 else "Operation stopped. Review the local ingestion configuration and readiness conditions."
        self.respond(200 if result.returncode == 0 else 409, self.page("<pre>" + html.escape(shown) + '</pre><p><a href="/">Back</a></p>', csrf))


def main():
    app = Dashboard(password_from_environment())
    server = OpsHTTPServer(app)
    try: server.serve_forever()
    finally: server.server_close()


if __name__ == "__main__":
    main()
