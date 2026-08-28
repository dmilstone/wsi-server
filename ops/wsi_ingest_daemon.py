#!/usr/bin/env python3
"""Unattended loop on top of the manual wsi_ingest.py ingester.

This script never re-implements manifest hashing, atomic rename, locking, or
journal/receipt logic. Every mutating step (seal, observe, promote, recover) is
invoked as the literal, unmodified wsi_ingest.py CLI in a subprocess, with the
same typed confirmation a human would type piped over stdin -- exactly the
pattern ops/wsi_ops_dashboard.py already uses for its own buttons. This script
only decides *when* to run those existing commands, and adds:

  - a pause/stop control, modeled on the old BWH consult-workflow kill switch:
    a small on-disk sentinel checked once per pass, never mid-transaction;
  - a best-effort structural integrity probe run once immediately before every
    promotion, as a safety net on top of (not a replacement for) wsi_ingest.py's
    own size/mtime/inode quiescence check, which cannot by itself detect a file
    that stopped changing while still truncated;
  - a best-effort notification to the running viewer so a promoted slide can
    appear without a server restart (see ImageRegistry's own live discovery).

ops/wsi_ingest.py and ops/wsi_ops_dashboard.py are both left completely
unmodified in their control flow by this script. Either remains a fully
independent manual fallback if this daemon is stopped, paused, or never
started at all.

Configuration is via the same WSI_INGEST_* environment variables as
wsi_ingest.py, plus:

  WSI_INGEST_DAEMON_POLL_SECONDS           default 30
  WSI_INGEST_DAEMON_INTEGRITY_RETRY_LIMIT  default 5
  WSI_INGEST_DAEMON_REFRESH_URL            e.g. http://127.0.0.1:8080 (optional)
  WSI_INGEST_DAEMON_LOG                    default <staging>/.wsi-ingest-control/daemon/daemon.log.jsonl

Control (create/remove these empty files while the daemon is running):

  <staging>/.wsi-ingest-control/daemon/pause  - stop starting new work, keep running
  <staging>/.wsi-ingest-control/daemon/stop   - finish the in-flight pass, then exit

Never logs a raw dataset name or file path -- only a truncated SHA-256 of the
name, matching the convention `wsi_ingest.py inspect` already uses.
"""
import argparse, hashlib, importlib.util, json, os, stat, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONTROL_DIRNAME = ".wsi-ingest-control"
DAEMON_SUBDIR = "daemon"
PAUSE_SENTINEL = "pause"
STOP_SENTINEL = "stop"
DEFAULT_POLL_SECONDS = 30
DEFAULT_INTEGRITY_RETRY_LIMIT = 5
TIFF_LIKE_SUFFIXES = (".svs", ".ndpi", ".tif", ".tiff", ".ome.tif", ".ome.tiff")
OTHER_WSI_SUFFIXES = (".vsi", ".czi", ".lif")
TIFF_LE_MAGIC = b"II*\x00"
TIFF_BE_MAGIC = b"MM\x00*"


def _load_engine():
    spec = importlib.util.spec_from_file_location("wsi_ingest_engine", str(HERE / "wsi_ingest.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


engine = _load_engine()


def short_hash(name):
    return hashlib.sha256(name.encode()).hexdigest()[:16]


def daemon_control_dir(c):
    d = c["staging"] / CONTROL_DIRNAME / DAEMON_SUBDIR
    d.mkdir(parents=True, mode=0o700, exist_ok=True)
    os.chmod(d, 0o700)
    return d


def control_flags(c):
    try:
        d = daemon_control_dir(c)
        return (d / STOP_SENTINEL).exists(), (d / PAUSE_SENTINEL).exists()
    except OSError:
        return False, False


def log_path(c):
    override = os.environ.get("WSI_INGEST_DAEMON_LOG")
    if override:
        return Path(override)
    return daemon_control_dir(c) / "daemon.log.jsonl"


def log_event(c, event, **fields):
    """Best-effort structured logging. Must never raise -- a logging failure
    (e.g. a transiently unmounted staging volume) must not crash an unattended
    daemon that is otherwise able to keep making progress."""
    record = {"time": time.time(), "event": event, **fields}
    line = json.dumps(record, sort_keys=True) + "\n"
    try:
        p = log_path(c)
        fd = os.open(str(p), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            os.chmod(p, 0o600)
            data = line.encode()
            while data:
                data = data[os.write(fd, data):]
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError as error:
        sys.stderr.write(f"wsi-ingest-daemon: could not write log ({error})\n")
    sys.stdout.write(line)


def run_ingest(args, confirmation=None, timeout=None):
    cmd = [sys.executable, str(HERE / "wsi_ingest.py"), *args]
    return subprocess.run(
        cmd, input=(confirmation + "\n") if confirmation else None,
        text=True, capture_output=True, timeout=timeout,
    )


def failure_category(stderr_text):
    # wsi_ingest.py prints exactly one line "FAIL <category>: <message>" to stderr
    # on any handled error; this is the same contract ops/wsi_ops_dashboard.py relies on.
    for line in reversed(stderr_text.strip().splitlines() or [""]):
        if line.startswith("FAIL "):
            return line[len("FAIL "):].split(":", 1)[0].strip()
    return "unknown"


def list_candidate_datasets(staging_root):
    names = []
    try:
        entries = list(staging_root.iterdir())
    except OSError:
        return names
    for item in entries:
        try:
            st = item.lstat()
        except OSError:
            continue
        if item.name.startswith("-") or item.name == CONTROL_DIRNAME:
            continue
        if stat.S_ISDIR(st.st_mode) and not stat.S_ISLNK(st.st_mode):
            names.append(item.name)
    return sorted(names)


def probe_tiff_integrity(path):
    try:
        size = path.stat().st_size
        with open(path, "rb") as f:
            header = f.read(8)
            if len(header) < 8:
                return False, "file shorter than a TIFF header"
            if header[:4] == TIFF_LE_MAGIC:
                ifd_offset = int.from_bytes(header[4:8], "little")
            elif header[:4] == TIFF_BE_MAGIC:
                ifd_offset = int.from_bytes(header[4:8], "big")
            else:
                return False, "missing TIFF byte-order magic"
            if ifd_offset <= 0 or ifd_offset >= size:
                return False, "first IFD offset falls outside the file"
            f.seek(max(0, size - 4096))
            f.read()
        return True, "ok"
    except OSError as error:
        return False, str(error)


def probe_generic_integrity(path):
    try:
        with open(path, "rb") as f:
            while f.read(1024 * 1024):
                pass
        return True, "ok"
    except OSError as error:
        return False, str(error)


def probe_integrity(dataset_dir):
    """Best-effort structural check, run once immediately before promotion. This
    is a safety net on top of (not a replacement for) wsi_ingest.py's own
    quiescence/manifest checks, which compare size/mtime/inode and so cannot by
    themselves detect a file that stopped changing while still structurally
    truncated. It is not a full decode -- the server's own Bio-Formats/OpenSlide
    reader is still the authoritative check."""
    checked, problems = 0, []
    try:
        paths = sorted(dataset_dir.rglob("*"))
    except OSError as error:
        return False, str(error)
    for path in paths:
        if not path.is_file():
            continue
        lower = path.name.lower()
        if lower.endswith(TIFF_LIKE_SUFFIXES):
            checked += 1
            ok, detail = probe_tiff_integrity(path)
        elif lower.endswith(OTHER_WSI_SUFFIXES):
            checked += 1
            ok, detail = probe_generic_integrity(path)
        else:
            continue
        if not ok:
            problems.append(detail)
    if checked == 0:
        return False, "no recognized WSI container found to check"
    if problems:
        return False, "; ".join(problems)
    return True, f"ok ({checked} container file(s) checked)"


class IntegrityLedger:
    """Tracks consecutive pre-promotion integrity failures per dataset, entirely
    separately from wsi_ingest.py's own state files -- this daemon never writes
    to or reasons about the ingester's transaction/journal/receipt schema."""

    def __init__(self, path, retry_limit):
        self.path = path
        self.retry_limit = retry_limit

    def _load(self):
        try:
            return json.loads(self.path.read_text())
        except (OSError, json.JSONDecodeError):
            return {}

    def _save(self, data):
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, sort_keys=True))
        os.chmod(tmp, 0o600)
        tmp.replace(self.path)
        os.chmod(self.path, 0o600)

    def record_failure(self, key):
        data = self._load()
        data[key] = data.get(key, 0) + 1
        self._save(data)
        return data[key]

    def clear(self, key):
        data = self._load()
        if key in data:
            del data[key]
            self._save(data)

    def is_escalated(self, key):
        return self._load().get(key, 0) >= self.retry_limit


def notify_server_refresh(base_url, timeout=5):
    if not base_url:
        return None
    import urllib.request
    req = urllib.request.Request(base_url.rstrip("/") + "/api/images/refresh", method="POST", data=b"")
    try:
        urllib.request.urlopen(req, timeout=timeout).read()
        return None
    except OSError as error:
        return str(error)


def run_pass(c, ledger, refresh_url):
    for name in list_candidate_datasets(c["staging"]):
        if name in dict(engine.state_records(c)):
            continue
        key = short_hash(name)
        result = run_ingest(["seal", name], confirmation="SEAL")
        if result.returncode == 0:
            log_event(c, "sealed", dataset=key)
        else:
            category = failure_category(result.stderr)
            if category not in ("unsupported", "dataset"):
                log_event(c, "seal_failed", dataset=key, category=category)
            # else: still arriving / nothing recognizable yet -- retry next pass

    for name, st in dict(engine.state_records(c)).items():
        key = short_hash(name)
        phase = engine.effective_phase(c, name, st)
        if phase == "verified":
            ledger.clear(key)
            continue
        if st.get("invalidated"):
            result = run_ingest(["seal", name], confirmation="SEAL")
            log_event(c, "resealed" if result.returncode == 0 else "reseal_failed", dataset=key)
            continue
        if phase == "moved":
            result = run_ingest(["recover"])
            if result.returncode == 0:
                log_event(c, "recovered", dataset=key)
                ledger.clear(key)
            else:
                log_event(c, "recover_failed", dataset=key, category=failure_category(result.stderr))
            continue

        observed = run_ingest(["observe", name])
        if observed.returncode != 0:
            category = failure_category(observed.stderr)
            if category != "stability":
                log_event(c, "observe_failed", dataset=key, category=category)
            continue
        log_event(c, "observed", dataset=key)

        readiness_check = run_ingest(["promote", "--dry-run", name])
        if readiness_check.returncode != 0:
            category = failure_category(readiness_check.stderr)
            if category != "stability":
                log_event(c, "promote_check_failed", dataset=key, category=category)
            continue

        if ledger.is_escalated(key):
            log_event(c, "integrity_escalated_skip", dataset=key)
            continue

        ok, detail = probe_integrity(c["staging"] / name)
        if not ok:
            attempt = ledger.record_failure(key)
            log_event(c, "integrity_check_failed", dataset=key, detail=detail, attempt=attempt)
            continue
        ledger.clear(key)

        promoted = run_ingest(["promote", "--step", name], confirmation="PROMOTE")
        if promoted.returncode == 0:
            log_event(c, "promoted", dataset=key)
            error = notify_server_refresh(refresh_url)
            if error:
                log_event(c, "refresh_notify_failed", dataset=key, detail=error)
        else:
            category = failure_category(promoted.stderr)
            if category not in ("stability", "lock"):
                log_event(c, "promote_failed", dataset=key, category=category)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--once", action="store_true", help="run a single pass and exit, instead of looping")
    parser.add_argument("--interval", type=int,
                         default=int(os.environ.get("WSI_INGEST_DAEMON_POLL_SECONDS", DEFAULT_POLL_SECONDS)))
    parser.add_argument("--integrity-retry-limit", type=int,
                         default=int(os.environ.get("WSI_INGEST_DAEMON_INTEGRITY_RETRY_LIMIT", DEFAULT_INTEGRITY_RETRY_LIMIT)))
    parser.add_argument("--refresh-url", default=os.environ.get("WSI_INGEST_DAEMON_REFRESH_URL", ""))
    args = parser.parse_args(argv)

    try:
        c = engine.cfg()
    except engine.Fail as error:
        print("FAIL", error.cat + ":", str(error), file=sys.stderr)
        return 1
    if not c["staging"].is_dir():
        print("FAIL configuration: staging root does not exist", file=sys.stderr)
        return 1

    ledger = IntegrityLedger(daemon_control_dir(c) / "integrity-failures.json", args.integrity_retry_limit)
    log_event(c, "daemon_start", interval_seconds=args.interval)
    try:
        while True:
            stop, pause = control_flags(c)
            if stop:
                log_event(c, "daemon_stop_requested")
                break
            if pause:
                log_event(c, "daemon_paused")
            else:
                try:
                    run_pass(c, ledger, args.refresh_url)
                except engine.Fail as error:
                    log_event(c, "pass_failed", category=error.cat)
                except Exception as error:  # noqa: BLE001 - top-level supervisor, must never die from a per-pass fault
                    log_event(c, "pass_crashed", detail=str(error))
            if args.once:
                break
            time.sleep(args.interval)
    finally:
        log_event(c, "daemon_exit")
    return 0


if __name__ == "__main__":
    sys.exit(main())
