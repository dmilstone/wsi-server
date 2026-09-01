#!/usr/bin/env python3
"""Loopback-only, deliberately started web UI for the manual WSI ingester."""
import hashlib
import hmac
import html
import importlib.util
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
from urllib.parse import parse_qs, urlencode, urlsplit

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
BIND_ADDRESS = "127.0.0.1"
PORT = 8084
COOKIE = "wsi_ops_session"
COOKIE_PATH = "/"
SESSION_SECONDS = 15 * 60
MAX_BODY = 8192
CONTROL = ".wsi-ingest-control"
ALLOWED_HOSTS = {f"localhost:{PORT}", f"127.0.0.1:{PORT}"}

# Environment/configuration controls (development only for now -- see
# docs/LOCAL-OPS-DASHBOARD-VALIDATION.md before widening scope to other
# environments). Kept as plain module constants, overridable per-Dashboard-
# instance in __init__ so tests can point them at temporary fixtures, exactly
# like the existing audit_path parameter already does.
WSI_CONTROL_SCRIPT = HERE / "wsi"
# Overridable because this script is also deployed as a standalone copy (see
# docs/LOCAL-OPS-DASHBOARD-VALIDATION.md) outside the repository, where
# "sibling wsi-ingest.conf" no longer resolves to the file that deployment's
# own launcher actually sources. Mirrors the existing WSI_OPS_AUDIT_FILE
# override pattern below. Read at import time: correct because whichever
# shell wrapper starts this process (ops/wsi-ops-dashboard, or the installed
# run.sh) always exports/sources its configuration before launching Python.
WSI_INGEST_CONF = Path(os.environ.get("WSI_OPS_INGEST_CONF_FILE", str(HERE / "wsi-ingest.conf")))
# NOT similarly overridable: restarting development inherently needs read/write
# access to files inside this repository and must "cd" into it to run Maven.
# When this script runs as the launchd-managed copy outside the repository
# (installed under ~/Library/Application Support/, specifically so it is not
# subject to this same restriction), that repository lives under ~/Downloads,
# which macOS blocks unattended background agents from reading/writing at all
# -- confirmed empirically: Path.exists() succeeds but Path.read_text() raises
# PermissionError, even for a plain file read with no directory change
# involved. No path override fixes that; only running this script directly
# from the repository (its documented, reviewed startup path) does. Recycling
# development is therefore only usable that way, not from the installed copy.
DEVELOPMENT_CONFIG = REPO_ROOT / ".runtime" / "config" / "application.properties"
IMAGE_DIRECTORY_KEY = "wsi.image-directory"
STAGING_ROOT_KEY = "WSI_INGEST_STAGING_ROOT"
RECYCLE_TIMEOUT_SECONDS = 45


def _load_network_drop():
    # Dynamic file-based load, matching ops/wsi_ingest_daemon.py's own
    # _load_engine()/_load_autobatch() pattern, and for the same reason: this
    # script is also deployed as a standalone copy outside the repository
    # (see docs/LOCAL-OPS-DASHBOARD-VALIDATION.md), where a package-relative
    # "import ops.wsi_ingest_network_drop" would not resolve at all. Loading
    # HERE / "wsi_ingest_network_drop.py" (a plain sibling file, same as
    # WSI_CONTROL_SCRIPT/WSI_INGEST_CONF above) works identically in both
    # places, provided that sibling file is deployed alongside this one.
    spec = importlib.util.spec_from_file_location("wsi_ingest_network_drop", str(HERE / "wsi_ingest_network_drop.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


network_drop = _load_network_drop()
CSP = "default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
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
ul.browse-list { list-style: none; padding-left: 0; }
ul.browse-list li { padding: .2rem 0; }
nav.breadcrumbs a { margin-right: .15rem; }
nav.breadcrumbs strong { margin-right: .15rem; }
p.browse-help { color: #333; max-width: 42rem; }
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


# Rejects characters that would either break out of the quoted shell "export
# KEY=\"...\"" line in wsi-ingest.conf, or be misinterpreted by Java's
# .properties escaping (backslash) -- defense in depth for a value that ends
# up written into a file a shell later sources with `set -a; source ...`.
# "$" is deliberately not in this set -- see _dollar_signs_are_safe() below.
UNSAFE_PATH_CHARACTERS = set("\"'`\\\n\r")


def _dollar_signs_are_safe(raw):
    """True iff every ``$`` in raw is immediately followed by ``/`` or is the
    last character of the string -- the only two shapes bash can never
    expand inside a double-quoted ``export KEY="..."`` line, because a
    parameter name can't start with "/" and there's nothing left to expand at
    the end of the string. Confirmed empirically (`export X="a$/b"; echo
    $X` prints ``a$/b`` unchanged). Any other character right after "$" --
    a letter, digit, "_", "(", "{", or another "$" -- can start or chain a
    real expansion (``$VAR``, ``$(cmd)``, ``${VAR}``, positional/special
    parameters like ``$1``/``$$``) and must still be rejected. This exists
    because a real SMB share's local mount point routinely looks like
    macOS's own /Volumes/SHARE$ -- a trailing "$" is an ordinary Windows-
    style hidden/administrative-share convention, not an attack -- and that
    exact shape used to be, and otherwise still would be, wrongly rejected
    by the blanket UNSAFE_PATH_CHARACTERS check above."""
    for index, character in enumerate(raw):
        if character == "$" and (index + 1 < len(raw)) and raw[index + 1] != "/":
            return False
    return True


def valid_directory_path(raw):
    if not raw or any(character in UNSAFE_PATH_CHARACTERS for character in raw) or not _dollar_signs_are_safe(raw):
        return False
    candidate = Path(raw)
    if not candidate.is_absolute():
        return False
    try:
        return candidate.is_dir() and os.access(candidate, os.R_OK)
    except OSError:
        return False


def valid_network_drop_path(raw):
    """Deliberately lighter than valid_directory_path(): this value is only
    ever written to a plain text file (network_drop.write_live_override)
    and read back as a Path -- never interpolated into a shell-sourced
    ``export KEY="..."`` line the way WSI_INGEST_STAGING_ROOT is in
    wsi-ingest.conf -- so UNSAFE_PATH_CHARACTERS' shell-escaping concerns,
    and _dollar_signs_are_safe()'s narrower carve-out for it, do not apply
    here at all: every character valid_directory_path() still rejects
    outright (backtick, quotes, backslash, "$" followed by anything other
    than "/" or end-of-string) is fine in this field. Still requires an
    absolute, currently-existing, readable directory -- only the character
    set considered unsafe differs from valid_directory_path()."""
    if not raw or "\x00" in raw or "\n" in raw or "\r" in raw:
        return False
    candidate = Path(raw)
    if not candidate.is_absolute():
        return False
    try:
        return candidate.is_dir() and os.access(candidate, os.R_OK)
    except OSError:
        return False


# One entry per directory-location field that can be populated via /browse
# (see render_browse()) -- the POST path it should ultimately submit into,
# and the human-readable label shown while browsing. Deliberately the only
# three: these are exactly the fields valid_directory_path()/
# valid_network_drop_path() above already guard, so adding a fourth here
# without a matching real save route below would be a dead end, not a bug.
BROWSE_TARGETS = {
    "staging-root": ("/staging-root", "Ingestion staging root"),
    "network-drop-root": ("/network-drop-root", "Network drop root"),
    "image-directory": ("/image-directory", "Development image directory"),
}
# Plenty for any directory a human would ever want to browse into by hand;
# just a defensive cap against rendering a pathologically huge listing.
BROWSE_MAX_ENTRIES = 2000


def _applescript_string_literal(value):
    """value wrapped as a double-quoted AppleScript string literal, with
    backslash and double-quote escaped -- the only two characters that are
    special inside one. Used to embed arbitrary, untrusted-ish text (a
    filesystem path) into an -e script passed to osascript."""
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def native_choose_folder(prompt, start_dir):
    """Pop macOS's own native folder-picker panel (NSOpenPanel, via
    osascript's Standard Additions `choose folder`) and block until the
    human picks a folder or cancels. This is a real OS window, not anything
    rendered by this dashboard or a browser -- it can reach anywhere Finder
    can, including typing an exact path (Cmd+Shift+G) and other network
    volumes, which the HTML click-through picker in render_browse() cannot
    do for a share this process cannot itself enumerate (see
    "Network volumes and the installed background copy" in
    docs/LOCAL-OPS-DASHBOARD-VALIDATION.md) -- whether the *native* panel
    can enumerate such a share is a separate, so-far-untested question,
    since NSOpenPanel's own listing may or may not go through the same
    restriction our own os.listdir() calls hit.

    Deliberately implemented via a separate osascript process rather than
    tkinter (which the standard library does have here) or PyObjC: Cocoa/Tk
    GUI calls are only ever safe from a process's own main thread, and
    ThreadingHTTPServer hands every request to a new worker thread, never
    the main one -- calling tkinter from there is a known hang/crash risk
    on macOS. osascript sidesteps this entirely by running as its own
    process with its own main thread; only the (harmless, cheap) subprocess
    call itself happens on our request thread, and only that one thread
    blocks while the human decides -- every other concurrent request is
    still served normally by the other threads ThreadingHTTPServer already
    hands out.

    Returns ("chosen", absolute_path_str) on a real pick, ("cancelled",
    None) if the human dismissed the panel, or ("error", human_readable_
    reason) for anything else (e.g. osascript itself missing or blocked --
    plain `choose folder` needs no Automation/TCC permission since it is
    the calling process's own UI, not another app's, but this still guards
    against whatever we haven't seen yet)."""
    script_parts = ["POSIX path of (choose folder with prompt ", _applescript_string_literal(prompt)]
    if start_dir is not None:
        script_parts.append(" default location (POSIX file " + _applescript_string_literal(str(start_dir)) + ")")
    script_parts.append(")")
    script = "".join(script_parts)
    try:
        result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    except OSError as error:
        return "error", str(error)
    if result.returncode == 0:
        return "chosen", result.stdout.strip()
    if "-128" in result.stderr:  # AppleScript's standard "user canceled" error number
        return "cancelled", None
    return "error", (result.stderr.strip() or f"osascript exited {result.returncode}")


def _existing_readable_directory(raw):
    """The absolute Path raw names, if raw is one and it currently exists,
    is a directory, and is readable -- else None. Deliberately permissive
    about which characters raw may contain (unlike valid_directory_path()/
    valid_network_drop_path()): this is only ever used to decide where the
    read-only /browse dialog itself starts or moves to, never written to any
    file. The Select button rendered at the bottom of that dialog still POSTs
    through the field's own real route, which re-checks with the real,
    field-appropriate validator and has the only actual say."""
    if not raw:
        return None
    candidate = Path(raw)
    try:
        if candidate.is_absolute() and candidate.is_dir() and os.access(candidate, os.R_OK):
            return candidate
    except OSError:
        pass
    return None


def list_subdirectories(directory, show_hidden=False):
    """(entries, error) for directory's own direct children: entries is a
    sorted list of (name, is_readable) pairs; error is None on success, or a
    short, path-free os.strerror()-style description of why listing failed.
    Callers must show that error rather than silently treating it as "no
    subdirectories" -- see render_browse() and "Network volumes and the
    installed background copy" in docs/LOCAL-OPS-DASHBOARD-VALIDATION.md:
    macOS can let is_dir()/os.access() succeed on a specific, already-known
    network-share path while still refusing to enumerate that same
    directory's contents (PermissionError) for an unattended launchd agent,
    which is a materially different, and more confusing, situation than the
    directory genuinely having nothing in it. Symlinks to directories are
    included (unlike safe_candidates(), which excludes them for an
    unrelated, dataset-selection-specific reason) since this is just showing
    a person their own filesystem. Truncated to BROWSE_MAX_ENTRIES. A single
    entry that cannot be stat()'d is silently skipped -- only a failure to
    even start listing directory is surfaced as an error."""
    try:
        children = list(directory.iterdir())
    except OSError as error:
        return [], (error.strerror or "could not list this directory")
    result = []
    for item in children:
        if not show_hidden and item.name.startswith("."):
            continue
        try:
            if not item.is_dir():
                continue
            readable = os.access(item, os.R_OK)
        except OSError:
            continue
        result.append((item.name, readable))
        if len(result) >= BROWSE_MAX_ENTRIES:
            break
    result.sort(key=lambda pair: pair[0].lower())
    return result, None


def browse_breadcrumbs(directory):
    """[(label, absolute_path_str), ...] from the filesystem root down to and
    including directory itself, for rendering clickable path segments in the
    /browse dialog -- e.g. Path("/Volumes/SHARE") -> [("/", "/"),
    ("Volumes", "/Volumes"), ("SHARE", "/Volumes/SHARE")]."""
    parts = directory.parts
    return [(parts[index] if index else "/", str(Path(*parts[:index + 1]))) for index in range(len(parts))]


def browse_href(target, current_value):
    """The "Browse..." link's href for one directory-location field: /browse
    pointed at target, starting from current_value if given (render_browse()
    itself falls back sensibly when that value is missing, relative, or no
    longer a real directory -- nothing here needs to pre-validate it)."""
    query = {"target": target}
    if current_value:
        query["path"] = current_value
    return "/browse?" + urlencode(query)


def browse_native_href(target):
    """The primary "Browse..." link's href for one directory-location field:
    /browse-native, which pops the real native macOS folder picker (see
    native_choose_folder) rather than rendering our own HTML list. No
    current-value query param needed -- the route derives its own starting
    directory server-side via resolve_browse_start(target, "")."""
    return "/browse-native?" + urlencode({"target": target})


def read_property(path, key):
    """Read a Java ``key=value`` line from a .properties file, ignoring '#' comments."""
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return None
    prefix = key + "="
    for line in lines:
        if line.strip().startswith(prefix):
            return line.split("=", 1)[1].strip()
    return None


def write_property(path, key, value):
    """Replace an existing ``key=value`` line in place; never appends or reorders."""
    lines = path.read_text().splitlines()
    prefix = key + "="
    for index, line in enumerate(lines):
        if line.strip().startswith(prefix):
            lines[index] = f"{key}={value}"
            path.write_text("\n".join(lines) + "\n")
            return
    raise ValueError(f"{key} not found in {path}")


def _shell_export_value(line, key):
    """Return KEY's value from this line, or None if it does not set KEY.

    Accepts both conventions actually in use across the two files this
    dashboard reads (see docs/LOCAL-OPS-DASHBOARD-VALIDATION.md): the quoted
    ``export KEY="value"`` form in ops/wsi-ingest.conf, and the bare, unquoted
    ``KEY=value`` form (relying on the caller's own ``set -a``) in the
    installed copy's .env.local.
    """
    stripped = line.strip()
    if stripped.startswith("export "):
        stripped = stripped[len("export "):]
    prefix = key + "="
    if not stripped.startswith(prefix):
        return None
    value = stripped[len(prefix):]
    if len(value) >= 2 and value[0] == value[-1] == '"':
        value = value[1:-1]
    return value


def read_shell_export(path, key):
    """Read a shell variable assignment, in either convention -- see _shell_export_value."""
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return None
    for line in lines:
        value = _shell_export_value(line, key)
        if value is not None:
            return value
    return None


def write_shell_export(path, key, value):
    """Replace an existing assignment line in place, normalizing it to the
    safer quoted ``export KEY="value"`` form regardless of which convention
    it previously used (a bare, unquoted assignment breaks under `source` the
    moment the value ever contains a space; quoting never has that problem).
    """
    lines = path.read_text().splitlines()
    for index, line in enumerate(lines):
        if _shell_export_value(line, key) is not None:
            lines[index] = f'export {key}="{value}"'
            path.write_text("\n".join(lines) + "\n")
            return
    raise ValueError(f"{key} not found in {path}")


class Dashboard:
    def __init__(self, password, audit_path=None, runner=subprocess.run, clock=time.time,
                 development_config_path=None, control_script_path=None, ingest_conf_path=None):
        self.password = password
        self.sessions = Sessions(clock=clock)
        self.runner = runner
        self.clock = clock
        self.audit_path = Path(audit_path or os.environ.get("WSI_OPS_AUDIT_FILE", str(HERE / ".wsi-ops-audit.jsonl")))
        self.audit_lock = threading.Lock()
        self.development_config_path = Path(development_config_path or DEVELOPMENT_CONFIG)
        self.control_script_path = Path(control_script_path or WSI_CONTROL_SCRIPT)
        self.ingest_conf_path = Path(ingest_conf_path or WSI_INGEST_CONF)

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

    def staging_root_display(self):
        return os.environ.get(STAGING_ROOT_KEY, "")

    def set_staging_root(self, new_path):
        # Update the persisted configuration first (so a crash between the two
        # writes still leaves the durable file correct), then the in-memory
        # value this already-running process actually reads on every call.
        write_shell_export(self.ingest_conf_path, STAGING_ROOT_KEY, new_path)
        os.environ[STAGING_ROOT_KEY] = new_path

    def network_drop_root_state(self):
        """(display_value, is_live) exactly mirroring what the running
        daemon's network_drop.effective_config() will resolve to on its very
        next poll -- see that function's own docstring for the precedence
        between the live override file and the environment variable. Never
        raises: with no staging root configured yet there is nowhere to look
        for an override file, so this just falls back to the environment
        variable alone."""
        staging = self.staging_root_display()
        if staging:
            is_set, root = network_drop.read_live_override(staging)
            if is_set:
                return (str(root) if root else ""), True
        return (str(network_drop.drop_root() or "")), False

    def set_network_drop_root(self, new_path_or_empty):
        """Writes the live override file the already-running daemon re-reads
        every poll -- see network_drop.write_live_override(). Requires a
        staging root to be configured, since that determines where the
        override file itself lives; unlike set_staging_root() there is no
        wsi-ingest.conf line to keep in sync, because the override file wins
        over that file's WSI_INGEST_NETWORK_DROP_ROOT unconditionally anyway
        (see wsi_ingest_network_drop.py's module docstring)."""
        staging = self.staging_root_display()
        if not staging:
            raise ValueError("staging root is not configured")
        network_drop.write_live_override(staging, new_path_or_empty)

    def development_image_directory(self):
        return read_property(self.development_config_path, IMAGE_DIRECTORY_KEY)

    def set_development_image_directory(self, new_path):
        write_property(self.development_config_path, IMAGE_DIRECTORY_KEY, new_path)

    def recycle_development(self):
        """Stop then start the development environment via the existing, already-
        tested ops/wsi control script -- never reimplements process lifecycle.
        WSI_REPO is always passed explicitly: ops/wsi's own hardcoded fallback
        default points at a stale sibling checkout on this machine, not this repo.
        """
        child_env = dict(os.environ)
        child_env.pop("WSI_OPS_DASHBOARD_PASSWORD", None)
        child_env["WSI_REPO"] = str(REPO_ROOT)
        kwargs = {"shell": False, "text": True, "capture_output": True,
                  "env": child_env, "timeout": RECYCLE_TIMEOUT_SECONDS}
        stop = self.runner([str(self.control_script_path), "development", "stop"], **kwargs)
        start = self.runner([str(self.control_script_path), "development", "start"], **kwargs)
        return stop, start

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

    def current_target_value(self, target):
        """The directory-location field's own current value, exactly as
        shown on / -- used only to pick a sensible /browse starting point
        (see resolve_browse_start); never raises."""
        app = self.server.dashboard
        if target == "staging-root":
            return app.staging_root_display()
        if target == "network-drop-root":
            value, _ = app.network_drop_root_state()
            return value
        if target == "image-directory":
            try:
                return app.development_image_directory()
            except OSError:
                return None
        return None

    def resolve_browse_start(self, target, raw_path):
        """The directory /browse should actually display: raw_path (from the
        clicked link/query string) if it is currently real, else the target
        field's own current value if that is, else /Volumes or / -- always
        something, since / always exists."""
        for candidate in (raw_path, self.current_target_value(target)):
            found = _existing_readable_directory(candidate)
            if found is not None:
                return found
        for fallback in ("/Volumes", "/"):
            found = _existing_readable_directory(fallback)
            if found is not None:
                return found
        return Path("/")

    def render_browse(self, target, raw_path, csrf):
        """The click-through directory picker: breadcrumbs back up to /,
        this directory's own subdirectories to descend into, and a Select
        button that submits the currently-displayed directory straight into
        target's own real save route (the same one its plain text field on /
        already posts to, with the same field-appropriate validator having
        the only actual final say -- this dialog is purely a friendlier way
        to arrive at an absolute path, not a new, separately-trusted input)."""
        if target not in BROWSE_TARGETS:
            return self.respond(404, "Not found", "text/plain")
        action, label = BROWSE_TARGETS[target]
        current = self.resolve_browse_start(target, raw_path)
        # The last crumb (current itself) is deliberately plain text, not a
        # link -- clicking it would just reload the exact same page, and
        # bolding it instead answers "which folder am I about to select?" at
        # a glance, which a flat row of identical-looking links does not.
        crumbs = browse_breadcrumbs(current)
        crumb_html = " / ".join(
            [f'<a href="{html.escape(browse_href(target, path))}">{html.escape(name)}</a>'
             for name, path in crumbs[:-1]]
            + [f'<strong>{html.escape(crumbs[-1][0])}</strong>']
        )
        entries, listing_error = list_subdirectories(current)
        if listing_error:
            # Not "No subdirectories here": on macOS, an unattended launchd
            # agent can be denied enumeration of a network share's contents
            # even though the directory itself (already checked, above,
            # just to get here) is confirmed to exist and be readable -- see
            # this function's own docstring and "Network volumes and the
            # installed background copy" in docs/LOCAL-OPS-DASHBOARD-VALIDATION.md.
            # Saying so plainly matters: silently showing an empty list here
            # would look identical to the share genuinely being empty.
            listing = (
                f'<p><em>Could not list this directory\'s contents ({html.escape(listing_error)}).</em></p>'
                '<p>If this is inside a network share, the installed background copy of this dashboard '
                'cannot enumerate network-share contents at all -- a known macOS restriction on '
                'unattended background processes, not a bug in this directory. "Select this directory" '
                'above still works for exactly this path regardless. To go further in, either type/paste '
                'the full subdirectory path directly into the field on the main page, or run this '
                'dashboard via "Local startup" instead, which is not affected.</p>'
            )
        else:
            rows = []
            for name, readable in entries:
                if readable:
                    child_href = html.escape(browse_href(target, str(current / name)))
                    rows.append(f'<li><a href="{child_href}">{html.escape(name)}/</a></li>')
                else:
                    rows.append(f'<li>{html.escape(name)}/ <small>(no permission)</small></li>')
            listing = f'<ul class="browse-list">{"".join(rows)}</ul>' if rows else '<p><em>No subdirectories here.</em></p>'
        confirmation_field = '<label>Type RESTART <input name="confirmation"></label> ' if target == "image-directory" else ""
        select_form = (
            f'<form method="post" action="{action}">'
            f'<input type="hidden" name="csrf" value="{html.escape(csrf)}">'
            f'<input type="hidden" name="path" value="{html.escape(str(current))}">'
            f'{confirmation_field}<button>Select this directory</button></form>'
        )
        content = (
            f'<section><h2>Browse for: {html.escape(label)}</h2>'
            '<p class="browse-help">Click a folder name below to go into it, click an underlined name '
            'in the path above to go back up, and click <strong>Select this directory</strong> to use '
            f'whichever folder is shown in bold in the path above (currently <strong>{html.escape(crumbs[-1][0])}</strong>).</p>'
            f'<nav class="breadcrumbs">{crumb_html}</nav>'
            f'{select_form}{listing}'
            '<p><a href="/">Cancel, back to dashboard</a></p></section>'
        )
        return self.respond(200, self.page(content, csrf))

    def render_browse_native(self, target, csrf):
        """GET /browse-native: the primary entry point behind every "Browse..."
        link. Pops the real native macOS folder picker (native_choose_folder)
        and, on a successful pick, hands the chosen path straight to
        render_browse() for the same breadcrumb-and-Select confirmation
        screen the click-through picker already ends on -- one shared final
        step, and one shared place the field-appropriate validator still has
        the only actual final say, regardless of which picker reached it.
        Falls back to a link to the click-through picker (never a dead end)
        if osascript itself errors for any reason other than the human
        clicking Cancel."""
        if target not in BROWSE_TARGETS:
            return self.respond(404, "Not found", "text/plain")
        action, label = BROWSE_TARGETS[target]
        start = self.resolve_browse_start(target, "")
        status, value = native_choose_folder(f"Choose the {label}", start)
        if status == "chosen":
            return self.render_browse(target, value, csrf)
        if status == "cancelled":
            content = (
                f'<section><h2>Browse for: {html.escape(label)}</h2>'
                '<p>Selection cancelled -- nothing changed.</p>'
                '<p><a href="/">Back to dashboard</a></p></section>'
            )
            return self.respond(200, self.page(content, csrf))
        fallback_href = html.escape(browse_href(target, str(start)))
        content = (
            f'<section><h2>Browse for: {html.escape(label)}</h2>'
            f'<p>Could not open the native folder picker ({html.escape(value)}).</p>'
            f'<p><a href="{fallback_href}">Use the click-through picker instead</a> '
            '&middot; <a href="/">Cancel, back to dashboard</a></p></section>'
        )
        return self.respond(200, self.page(content, csrf))

    def do_GET(self):
        if self.reject_boundary(): return self.respond(HTTPStatus.FORBIDDEN, "Forbidden", "text/plain")
        auth = self.require_session()
        if not auth: return
        sid, csrf = auth
        split = urlsplit(self.path)
        if split.path == "/browse-native":
            params = parse_qs(split.query)
            target = (params.get("target") or [""])[0]
            return self.render_browse_native(target, csrf)
        if split.path == "/browse":
            params = parse_qs(split.query)
            target = (params.get("target") or [""])[0]
            raw_path = (params.get("path") or [""])[0]
            return self.render_browse(target, raw_path, csrf)
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
            staging_root_raw = self.server.dashboard.staging_root_display()
            staging_value = html.escape(staging_root_raw or "(not set)")
            drop_value, drop_is_live = self.server.dashboard.network_drop_root_state()
            drop_display = html.escape(drop_value or "(not set)")
            drop_note = ("live -- the running daemon already picks this up on its next poll, no restart" if drop_is_live
                         else "from environment variable at daemon startup; saving below switches this to live control")
            try:
                dev_image_dir_raw = self.server.dashboard.development_image_directory()
                dev_image_dir = html.escape(dev_image_dir_raw or "(not found in configuration)")
            except OSError:
                dev_image_dir_raw = None
                dev_image_dir = "(configuration unavailable)"
            config_section = (
                '<section><h2>Environment configuration (development)</h2>'
                f'<p>Ingestion staging root: <code>{staging_value}</code> '
                f'<a href="{html.escape(browse_native_href("staging-root"))}">Browse&hellip;</a> '
                f'<small>(<a href="{html.escape(browse_href("staging-root", staging_root_raw))}">list view</a>)</small></p>'
                f'<form method="post" action="/staging-root"><input type="hidden" name="csrf" value="{html.escape(csrf)}">'
                '<label>New staging root <input name="path" size="60"></label><button>Save</button></form>'
                f'<p>Network drop root: <code>{drop_display}</code> <small>({html.escape(drop_note)})</small> '
                f'<a href="{html.escape(browse_native_href("network-drop-root"))}">Browse&hellip;</a> '
                f'<small>(<a href="{html.escape(browse_href("network-drop-root", drop_value))}">list view</a>)</small></p>'
                f'<form method="post" action="/network-drop-root"><input type="hidden" name="csrf" value="{html.escape(csrf)}">'
                '<label>New network drop root, blank disables <input name="path" size="60"></label><button>Save</button></form>'
                f'<p>Development image directory: <code>{dev_image_dir}</code> '
                f'<a href="{html.escape(browse_native_href("image-directory"))}">Browse&hellip;</a> '
                f'<small>(<a href="{html.escape(browse_href("image-directory", dev_image_dir_raw))}">list view</a>)</small></p>'
                f'<form method="post" action="/image-directory"><input type="hidden" name="csrf" value="{html.escape(csrf)}">'
                '<label>New image directory <input name="path" size="60"></label> '
                '<label>Type RESTART <input name="confirmation"></label>'
                '<button>Save and restart development</button></form>'
                '<p>Restarting stops and starts the development server (port 8081) via the existing '
                '<code>ops/wsi</code> control script; anyone viewing slides there loses their session.</p>'
                '<p><small>Browse&hellip; opens a real native macOS folder-picker window (a genuine popup, '
                'not part of this page) and comes back here to confirm the pick; "list view" opens a '
                "click-through picker inside this page instead, mainly useful as a fallback if the native "
                'one cannot run.</small></p></section>'
            )
            return self.respond(200, self.page('<pre>'+safe+'</pre>'+''.join(forms)+links+config_section, csrf))
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
        if self.path == "/staging-root":
            app.audit("staging-root change attempt", "started")
            new_path = form.get("path", "")
            if not valid_directory_path(new_path):
                app.audit("staging-root change result", "invalid path")
                return self.respond(400, self.page('New staging root must be an existing, readable, absolute directory path.<p><a href="/">Back</a></p>', csrf))
            try:
                app.set_staging_root(new_path)
            except (OSError, ValueError):
                app.audit("staging-root change result", "failure")
                return self.respond(400, self.page('Unable to update the staging root configuration.<p><a href="/">Back</a></p>', csrf))
            app.audit("staging-root change result", "success")
            return self.respond(200, self.page('Staging root updated. New ingestion commands use it immediately.<p><a href="/">Back</a></p>', csrf))
        if self.path == "/network-drop-root":
            app.audit("network-drop-root change attempt", "started")
            new_path = form.get("path", "").strip()
            if new_path and not valid_network_drop_path(new_path):
                app.audit("network-drop-root change result", "invalid path")
                return self.respond(400, self.page('Network drop root must be blank (to disable) or an existing, readable, absolute directory path.<p><a href="/">Back</a></p>', csrf))
            try:
                app.set_network_drop_root(new_path)
            except (OSError, ValueError):
                app.audit("network-drop-root change result", "failure")
                return self.respond(400, self.page('Unable to update the network drop root configuration.<p><a href="/">Back</a></p>', csrf))
            app.audit("network-drop-root change result", "success")
            message = "Network drop root disabled." if not new_path else "Network drop root updated."
            return self.respond(200, self.page(f'{message} The running ingestion daemon picks this up on its next poll (no restart needed).<p><a href="/">Back</a></p>', csrf))
        if self.path == "/image-directory":
            app.audit("image-directory change attempt", "started")
            if form.get("confirmation") != "RESTART":
                app.audit("image-directory change result", "confirmation rejected")
                return self.respond(400, self.page('Required typed confirmation was not supplied.<p><a href="/">Back</a></p>', csrf))
            new_path = form.get("path", "")
            if not valid_directory_path(new_path):
                app.audit("image-directory change result", "invalid path")
                return self.respond(400, self.page('New image directory must be an existing, readable, absolute directory path.<p><a href="/">Back</a></p>', csrf))
            try:
                app.set_development_image_directory(new_path)
            except (OSError, ValueError):
                app.audit("image-directory change result", "failure")
                return self.respond(400, self.page('Unable to update the development configuration.<p><a href="/">Back</a></p>', csrf))
            app.audit("image-directory change result", "success")
            app.audit("development recycle attempt", "started")
            try:
                stop, start = app.recycle_development()
            except subprocess.TimeoutExpired:
                app.audit("development recycle result", "timeout")
                return self.respond(504, self.page('Development did not stop/start within the expected time. Check its status manually with "ops/wsi development status".<p><a href="/">Back</a></p>', csrf))
            success = stop.returncode == 0 and start.returncode == 0
            app.audit("development recycle result", "success" if success else "failure")
            combined = (stop.stdout or "") + (start.stdout or "")
            if not success:
                combined += (start.stderr or "")
            return self.respond(200 if success else 502, self.page('<pre>'+html.escape(combined)+'</pre><p><a href="/">Back</a></p>', csrf))
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
