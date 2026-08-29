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
    appear without a server restart (see ImageRegistry's own live discovery);
  - a best-effort clinical-marker sidecar OCR pass, via the pre-existing,
    unmodified ops/retro_build_metadata.py, scoped to just the one dataset
    that was promoted (--only-dir) rather than a full-tree retro-sweep. This
    is deliberately NOT run inline immediately after promotion: the server's
    /api/images/{id}/label.png route requires the image to already be in
    ImageRegistry's published snapshot (it throws "Unknown image id"
    otherwise), and that snapshot only updates asynchronously, some time
    after the /api/images/refresh notification above returns. Running OCR
    inline would just race that and fail on the very first attempt. Instead
    a promoted dataset is queued in a small on-disk ledger and retried on
    each subsequent pass (bounded by --sidecar-retry-limit) until either a
    sidecar with a resolved status is written, or the retry budget is spent
    -- at which point ops/retro_build_metadata.py's own full manual sweep
    (or the sidebar's per-row Force Scan button) remains the fallback;
  - an opt-in (WSI_INGEST_AUTOBATCH_ENABLED) "hot folder" front end, see
    ops/wsi_ingest_autobatch.py, for a staging directory a scanner writes
    into continuously all day instead of one manually-named, one-shot
    batch. Any staging directory carrying a ".wsi-autobatch" marker file is
    treated as such: loose files are grouped into per-slide units, each
    unit is auto-relocated into its own temp staging directory once stable,
    and that temp directory is handed to the exact same, unmodified seal/
    observe/promote loop below as if a human had created it. After
    promotion, this daemon merges the temp wrapper's contents back into
    production/<origin-folder-name>/ (mirroring the origin's own name from
    staging), so the dated/organized layout survives promotion. Directories
    without the marker are completely untouched by this and keep working
    exactly as they do today.

ops/wsi_ingest.py, ops/wsi_ops_dashboard.py, and ops/retro_build_metadata.py
are all left completely unmodified in their own control flow by this script
(retro_build_metadata.py only gained a new, purely additive --only-dir flag
so this daemon can scope it to one dataset). Any of the three remains a fully
independent manual fallback if this daemon is stopped, paused, or never
started at all.

Configuration is via the same WSI_INGEST_* environment variables as
wsi_ingest.py, plus:

  WSI_INGEST_DAEMON_POLL_SECONDS           default 30
  WSI_INGEST_DAEMON_INTEGRITY_RETRY_LIMIT  default 5
  WSI_INGEST_DAEMON_SIDECAR_RETRY_LIMIT    default 6 (passes, not seconds)
  WSI_INGEST_DAEMON_REFRESH_URL            e.g. http://127.0.0.1:8080 (optional)
  WSI_INGEST_DAEMON_LOG                    default <staging>/.wsi-ingest-control/daemon/daemon.log.jsonl
  WSI_INGEST_AUTOBATCH_ENABLED             default off (0/false); see above

The sidecar OCR step reuses --refresh-url as retro_build_metadata.py's
--server-url (same running viewer), and otherwise inherits this process's
environment unchanged -- so WSI_USER / WSI_PASSWORD / WSI_ANNOTATOR_PASSWORD
set for the daemon are picked up by retro_build_metadata.py exactly as they
would be for a manual invocation. If --refresh-url is not configured, the
sidecar step is skipped entirely (no server to fetch label.png from).

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
DEFAULT_SIDECAR_RETRY_LIMIT = 6
SIDECAR_UNRESOLVED_STATUSES = ("pending_epitope", "synchronized_via_retro_sweep")
TIFF_LIKE_SUFFIXES = (".svs", ".ndpi", ".tif", ".tiff", ".ome.tif", ".ome.tiff")
OTHER_WSI_SUFFIXES = (".vsi", ".czi", ".lif", ".mrxs")
TIFF_LE_MAGIC = b"II*\x00"
TIFF_BE_MAGIC = b"MM\x00*"
# Classic TIFF's IFD offset is a 4-byte field, which cannot address past 4GiB
# -- so any modern, large .svs/.ndpi (routinely several GB) is written as
# BigTIFF instead: same byte-order marker but magic number 43 (+) rather than
# 42 (*), an 8-byte offset-size field, and an 8-byte (not 4-byte) first IFD
# offset. A probe that only recognizes classic TIFF magic misreads every
# such file as corrupt ("missing TIFF byte-order magic") and permanently
# escalates it after retry_limit passes, even though it is a perfectly valid
# slide the server's own Bio-Formats/OpenSlide reader opens without issue.
BIGTIFF_LE_MAGIC = b"II+\x00"
BIGTIFF_BE_MAGIC = b"MM\x00+"


def _load_engine():
    spec = importlib.util.spec_from_file_location("wsi_ingest_engine", str(HERE / "wsi_ingest.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_retro_metadata():
    spec = importlib.util.spec_from_file_location("wsi_retro_metadata", str(HERE / "retro_build_metadata.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_autobatch():
    spec = importlib.util.spec_from_file_location("wsi_ingest_autobatch", str(HERE / "wsi_ingest_autobatch.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


engine = _load_engine()
retro_metadata = _load_retro_metadata()
autobatch = _load_autobatch()


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
            header = f.read(16)
            if len(header) < 8:
                return False, "file shorter than a TIFF header"
            if header[:4] == TIFF_LE_MAGIC:
                ifd_offset = int.from_bytes(header[4:8], "little")
            elif header[:4] == TIFF_BE_MAGIC:
                ifd_offset = int.from_bytes(header[4:8], "big")
            elif header[:4] == BIGTIFF_LE_MAGIC:
                if len(header) < 16:
                    return False, "file shorter than a BigTIFF header"
                ifd_offset = int.from_bytes(header[8:16], "little")
            elif header[:4] == BIGTIFF_BE_MAGIC:
                if len(header) < 16:
                    return False, "file shorter than a BigTIFF header"
                ifd_offset = int.from_bytes(header[8:16], "big")
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


class SidecarLedger:
    """Worklist of promoted datasets whose clinical-marker sidecar OCR has not
    yet resolved, plus a per-dataset attempt counter. Unlike IntegrityLedger
    (keyed by a hash, used only within the pass that already has `name` in
    scope), this ledger has to reconstruct a real filesystem path on a later
    pass, so it is keyed by the actual dataset name -- not a hash of it. That
    is consistent with wsi_ingest.py's own state/journal files, which already
    store real names on disk in this same control directory (chmod 0600);
    only *logged* events stay hash-only, via short_hash() at each call site."""

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

    def add(self, name):
        data = self._load()
        if name not in data:
            data[name] = {"attempts": 0}
            self._save(data)

    def pending_names(self):
        return sorted(self._load().keys())

    def record_attempt(self, name):
        data = self._load()
        entry = data.get(name) or {"attempts": 0}
        entry["attempts"] = entry.get("attempts", 0) + 1
        data[name] = entry
        self._save(data)
        return entry["attempts"]

    def is_escalated(self, name):
        return self._load().get(name, {}).get("attempts", 0) >= self.retry_limit

    def clear(self, name):
        data = self._load()
        if name in data:
            del data[name]
            self._save(data)


def dataset_sidecar_resolved(dataset_dir):
    """True once every slide container under dataset_dir has a sidecar whose
    status shows an OCR attempt actually reached a resolution (a real marker,
    or a fetch that genuinely completed and found nothing) -- False if any
    slide is missing a sidecar entirely, or still carries one of the two
    "never actually resolved" placeholder statuses retro_build_metadata.py
    itself writes while it could not reach the server yet."""
    resolved_any = False
    for slide_path in retro_metadata.iter_slides(dataset_dir):
        meta_path = retro_metadata.metadata_path_for_slide(slide_path)
        if not meta_path.is_file():
            return False
        try:
            payload = json.loads(meta_path.read_text())
        except (OSError, json.JSONDecodeError):
            return False
        if not isinstance(payload, dict):
            return False
        if str(payload.get("status") or "") in SIDECAR_UNRESOLVED_STATUSES:
            return False
        resolved_any = True
    return resolved_any


def run_sidecar_ocr(c, name, server_url, timeout=120):
    """Best-effort, out-of-process call into the unmodified
    ops/retro_build_metadata.py, scoped to just this one promoted dataset
    directory via --only-dir. Returns a subprocess.CompletedProcess, or None
    if the script could not even be started."""
    script = HERE / "retro_build_metadata.py"
    if not script.is_file():
        return None
    cmd = [
        sys.executable, str(script),
        "--slides-dir", str(c["production"]),
        "--only-dir", str(c["production"] / name),
    ]
    if server_url:
        cmd += ["--server-url", server_url]
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return None


def run_pending_sidecar_ocr(c, sidecar_ledger, server_url):
    """Retries the sidecar OCR step for every dataset still queued from a
    prior pass's promotion, dropping each one once its sidecar resolves or
    its retry budget (--sidecar-retry-limit) is spent."""
    if not server_url:
        return
    for name in sidecar_ledger.pending_names():
        key = short_hash(name)
        dataset_dir = c["production"] / name
        if not dataset_dir.is_dir():
            # Promoted directory renamed/removed out from under us by
            # something else -- nothing left here to retry.
            sidecar_ledger.clear(name)
            continue
        if dataset_sidecar_resolved(dataset_dir):
            log_event(c, "sidecar_resolved", dataset=key)
            sidecar_ledger.clear(name)
            continue
        if sidecar_ledger.is_escalated(name):
            log_event(c, "sidecar_escalated_skip", dataset=key)
            sidecar_ledger.clear(name)
            continue
        result = run_sidecar_ocr(c, name, server_url)
        attempt = sidecar_ledger.record_attempt(name)
        if result is None:
            log_event(c, "sidecar_ocr_not_run", dataset=key, attempt=attempt)
            continue
        if result.returncode != 0:
            log_event(c, "sidecar_ocr_failed", dataset=key, attempt=attempt,
                       detail=(result.stderr or "").strip()[-300:])
            continue
        if dataset_sidecar_resolved(dataset_dir):
            log_event(c, "sidecar_resolved", dataset=key, attempt=attempt)
            sidecar_ledger.clear(name)
        else:
            log_event(c, "sidecar_pending", dataset=key, attempt=attempt)


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


def merge_promoted_autobatch_dataset(c, merge_ledger, name):
    """If `name` was promoted from an autobatch temp wrapper (see
    wsi_ingest_autobatch.py), merge its contents into
    production/<origin-folder-name>/ -- creating that shared folder on its
    first arrival -- and return the origin name for everything downstream
    (sidecar OCR, refresh) to use instead. Returns `name` unchanged for an
    ordinary, manually-named batch that autobatch never touched.

    A crash between individual item moves needs no separate recovery branch:
    the ledger entry is only cleared once the temp wrapper is fully drained,
    so a resumed pass just moves whatever items are still left in it."""
    origin = merge_ledger.pending().get(name)
    if origin is None:
        return name
    key = short_hash(name)
    src_dir = c["production"] / name
    dest_dir = c["production"] / origin
    if src_dir.is_dir():
        dest_dir.mkdir(mode=0o700, exist_ok=True)
        os.chmod(dest_dir, 0o700)
        blocked = False
        for item in sorted(src_dir.iterdir()):
            target = dest_dir / item.name
            if target.exists():
                blocked = True
                log_event(c, "autobatch_merge_collision", dataset=key, origin=short_hash(origin))
                continue
            engine.atomic_rename_noreplace(item, target)
        if blocked:
            return name  # leave the ledger entry + remaining item(s) for the next pass / a human
        try:
            src_dir.rmdir()
        except OSError:
            pass
    merge_ledger.clear(name)
    log_event(c, "autobatch_merged", dataset=key, origin=short_hash(origin))
    return origin


def run_pass(c, ledger, refresh_url, sidecar_ledger=None, autobatch_tracking=None, autobatch_merge_ledger=None):
    if autobatch.enabled() and autobatch_tracking is not None and autobatch_merge_ledger is not None:
        autobatch.scan_and_relocate(
            c, engine, autobatch_tracking, autobatch_merge_ledger,
            log=lambda event, **fields: log_event(c, event, **fields),
        )

    # A folder carrying the autobatch marker is never a single one-shot
    # batch -- its loose contents are per-slide units autobatch itself
    # relocates out individually. Excluding it here is unconditional (not
    # gated on autobatch.enabled()) so that: (a) the ordinary loop can never
    # seal the hot folder itself as a ghost dataset while units are still
    # arriving inside it, which would collide with the real per-unit
    # dataset(s) autobatch relocates out and/or with the merged production
    # directory later, and (b) toggling autobatch off mid-cycle does not
    # suddenly expose the marked folder to whole-directory sealing either.
    autobatch_marked_names = {p.name for p in autobatch.discover_marked_folders(c["staging"])}

    for name in list_candidate_datasets(c["staging"]):
        if name in autobatch_marked_names:
            continue
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
            sidecar_name = name
            if autobatch_merge_ledger is not None:
                sidecar_name = merge_promoted_autobatch_dataset(c, autobatch_merge_ledger, name)
            if sidecar_ledger is not None:
                sidecar_ledger.add(sidecar_name)
            error = notify_server_refresh(refresh_url)
            if error:
                log_event(c, "refresh_notify_failed", dataset=key, detail=error)
        else:
            category = failure_category(promoted.stderr)
            if category not in ("stability", "lock"):
                log_event(c, "promote_failed", dataset=key, category=category)

    if sidecar_ledger is not None:
        run_pending_sidecar_ocr(c, sidecar_ledger, refresh_url)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--once", action="store_true", help="run a single pass and exit, instead of looping")
    parser.add_argument("--interval", type=int,
                         default=int(os.environ.get("WSI_INGEST_DAEMON_POLL_SECONDS", DEFAULT_POLL_SECONDS)))
    parser.add_argument("--integrity-retry-limit", type=int,
                         default=int(os.environ.get("WSI_INGEST_DAEMON_INTEGRITY_RETRY_LIMIT", DEFAULT_INTEGRITY_RETRY_LIMIT)))
    parser.add_argument("--sidecar-retry-limit", type=int,
                         default=int(os.environ.get("WSI_INGEST_DAEMON_SIDECAR_RETRY_LIMIT", DEFAULT_SIDECAR_RETRY_LIMIT)))
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
    sidecar_ledger = SidecarLedger(daemon_control_dir(c) / "sidecar-pending.json", args.sidecar_retry_limit)
    autobatch_tracking = autobatch.TrackingLedger(daemon_control_dir(c) / autobatch.TRACKING_LEDGER_FILENAME)
    autobatch_merge_ledger = autobatch.AutobatchMergeLedger(daemon_control_dir(c) / autobatch.MERGE_LEDGER_FILENAME)
    log_event(c, "daemon_start", interval_seconds=args.interval, autobatch_enabled=autobatch.enabled())
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
                    run_pass(c, ledger, args.refresh_url, sidecar_ledger,
                             autobatch_tracking, autobatch_merge_ledger)
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
