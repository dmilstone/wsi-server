#!/usr/bin/env python3
"""Opt-in front end that lets a network share (subject to real transfer
latency and stalls, unlike a same-machine copy) be a source for staging,
without touching wsi_ingest.py's own promotion mechanism at all.

Why this is a separate front end rather than pointing WSI_INGEST_STAGING_ROOT
directly at a network mount: promotion in wsi_ingest.py is one atomic
same-filesystem rename (atomic_rename_noreplace), and roots_ok() enforces
staging and production being on the same filesystem specifically so that
promotion can never half-complete. A network share holding staging while
production stays on local disk would make every promotion attempt fail
closed forever (different filesystems) -- and moving production onto the
network share too would mean the running viewer serving tiles over the
network at read time, a separate and likely much bigger performance cost
than anything ingestion-side. Neither is what this module does. Instead, it
treats the network path purely as an inbox of *slides*, not of dated
directories. A VS200 (and similar) scanner writes into the same dated folder
all day; treating that folder as one dataset would ingest it the first time
it went quiet and then refuse every later slide that day (production already
has that folder name). So this module groups the same way
wsi_ingest_autobatch.py already does on a local hot folder:

  one WSI container file, plus its companion folder when the format needs
  one (VSI's "_<stem>_" tile-data sibling, MRXS's bare-stem sibling).

Each complete, size-stable slide is copied (verified byte-for-byte by size)
into its own local staging directory named after the container's stem -- a
one-slide dataset as far as the unmodified wsi_ingest.py
seal/observe/promote engine is concerned. The wrapper carries a
.wsi-merge-origin marker naming the immediate parent (e.g. 20260831) so
that after atomic promote the daemon can fold the slide into
production/<that parent>/ without depending on the sidecar merge ledger
surviving. Same-day VS200 slides therefore land in wsi-slides/20260831/
rather than one folder per slide. wsi_ingest.py's atomic
promote-of-one-directory rule is unchanged and still used: the temp
wrapper is the directory being promoted; the merge is a separate, later
step.

Stability signal is deliberately size-only (per-file relative path + byte
size), not wsi_ingest.py's own richer size+mtime+dev+ino manifest digest.
A cross-filesystem copy cannot be expected to reproduce a network
filesystem's mtime precision exactly (resolution and rounding vary by
protocol/server), so comparing on that basis would produce false
instability, and later a false verification-mismatch, for reasons that have
nothing to do with whether the bytes actually match. A format that needs a
companion is not complete -- and is never copied -- until that companion
directory is present; its arrival (or growth) changes the size fingerprint
and resets the quiet clock, which is the whole point of waiting.

Discovery walks from the configured root. Loose files sitting directly in
`root` are left alone (not swept into a dataset) and logged once. Under any
subdirectory, every recognized WSI container file is a slide unit of that
subdirectory (the immediate parent name is the merge origin, e.g.
20260831). Companion folders are not themselves datasets and are not
descended into. Other subdirectories are walked, so both a flat dated
layout and a nested one keep working. The dated folder itself is never
moved; only the files of a completed slide are.

The network original of a completed slide is never deleted. Once a verified
local copy exists, those items are moved (not copied -- source and
destination are both under the same configured root, so this is a
same-filesystem rename, fast and effectively atomic) into
processed/<same relative path each item had under the root>, preserving
whatever organizational structure the site uses. A second arrival at the
same relative processed/ location is timestamp-suffixed, not overwritten.
If this housekeeping move itself fails after a successful, already-verified
local copy, that failure is logged and left for a human -- the slide has
already safely reached local staging by that point, so nothing about
ingestion correctness depends on this step succeeding.

Copies off a network share are slow, so one pass relocates at most one
ready slide and then returns, letting the rest of the daemon pass
seal/observe/promote whatever is already in local staging instead of
blocking on the next multi-gigabyte copy. Other slides keep accumulating
stability observations in the same pass; they copy on later passes.

Never logs a raw dataset name or file path -- only a truncated SHA-256,
matching the convention wsi_ingest.py inspect and wsi_ingest_daemon.py
already use.

Configuration is a single new variable, read directly from the environment
like every other WSI_INGEST_* setting:

  WSI_INGEST_NETWORK_DROP_ROOT   unset (default) disables this module entirely

Stability thresholds are deliberately not separately configurable: this
reuses the exact same WSI_INGEST_REQUIRED_OBSERVATIONS /
WSI_INGEST_OBSERVATION_INTERVAL_SECONDS / WSI_INGEST_MIN_QUIET_SECONDS knobs
(via cfg()'s 'obs' / 'interval' / 'quiet') that already gate the rest of the
system, so there is one timing story to reason about, not two.

The environment variable above is only what the daemon happens to start
with. This module also supports a *live* override -- a small file under
<staging>/.wsi-ingest-control/daemon/network-drop-root.txt -- that always
takes precedence over the environment variable and is read fresh on every
single poll (nothing in this module caches anything anywhere), which is
exactly what lets ops/wsi_ops_dashboard.py's "Network drop root" field take
effect on an already-running daemon's very next pass, with no restart of
anything. effective_config() checks, in order:

  no override file           defer entirely to the environment variable
                              (unchanged from before this file existed)
  override file, non-empty   use that path, enabled -- regardless of
                              whatever the environment variable says
  override file, empty       explicitly disabled -- regardless of
                              whatever the environment variable says

The override file is durable, not process-scoped -- it also wins across a
full daemon restart, since effective_config() checks it unconditionally
every time regardless of how long the calling process has been running. So
using the dashboard field even once makes it the permanent source of truth
going forward, until a human edits or deletes that one file directly.
"""
import hashlib
import importlib.util
import json
import os
import secrets
import shutil
import sys
import time
from pathlib import Path

NETWORK_DROP_ROOT_ENV = "WSI_INGEST_NETWORK_DROP_ROOT"
TRACKING_LEDGER_FILENAME = "network-drop-tracking.json"
PROCESSED_DIRNAME = "processed"
TEMP_PREFIX = "-network-drop-incoming-"
# Used in three places, and all three must agree: discover_units() (skip
# these when walking), _unit_size_fingerprint() (don't let one of these flap
# the stability signal), and relocate_unit()'s copy ignore= (don't even try
# to copy one -- Thumbs.db arriving from a Windows-side SMB write has been
# observed in practice to fail shutil.copy2's copystat with PermissionError,
# which previously discarded the entire, otherwise-fine copy and retried
# forever).
IGNORED_NOISE_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini", ".localized"}

# Deliberately redeclared here rather than imported from wsi_ingest_daemon.py
# (which owns the actual directory its own pause/stop sentinels and ledgers
# already live in) -- this keeps the live-override file locatable by
# anything that only knows the staging root, in particular
# ops/wsi_ops_dashboard.py, which never imports wsi_ingest_daemon.py at all.
CONTROL_DIRNAME = ".wsi-ingest-control"
DAEMON_SUBDIR = "daemon"
LIVE_OVERRIDE_FILENAME = "network-drop-root.txt"


def _load_autobatch():
    """Sibling import of wsi_ingest_autobatch.py. Reuses the module the
    daemon already loaded when present, so companion-folder grouping is the
    exact same code both front ends run, not a second copy of those rules."""
    existing = sys.modules.get("wsi_ingest_autobatch")
    if existing is not None:
        return existing
    path = Path(__file__).resolve().parent / "wsi_ingest_autobatch.py"
    spec = importlib.util.spec_from_file_location("wsi_ingest_autobatch", str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules["wsi_ingest_autobatch"] = module
    spec.loader.exec_module(module)
    return module


def enabled():
    return bool(os.environ.get(NETWORK_DROP_ROOT_ENV, "").strip())


def drop_root():
    value = os.environ.get(NETWORK_DROP_ROOT_ENV, "").strip()
    return Path(value).expanduser() if value else None


def control_dir_for(staging_root):
    return Path(staging_root) / CONTROL_DIRNAME / DAEMON_SUBDIR


def live_override_path(staging_root):
    return control_dir_for(staging_root) / LIVE_OVERRIDE_FILENAME


def read_live_override(staging_root):
    """(is_set, root) reflecting the live override file alone, ignoring the
    environment variable entirely -- see effective_config() for the actual
    precedence a caller should use. is_set is True the moment the file
    exists at all, even empty (empty means explicitly disabled); False only
    when there is no file yet, i.e. the dashboard has never been used."""
    try:
        raw = live_override_path(staging_root).read_text().strip()
    except OSError:
        return False, None
    return True, (Path(raw).expanduser() if raw else None)


def write_live_override(staging_root, new_value):
    """Persists the dashboard's chosen value so the already-running daemon's
    very next poll picks it up -- see module docstring. An empty/blank
    new_value explicitly disables the module (distinct from deleting the
    file, which would instead defer back to the environment variable)."""
    directory = control_dir_for(staging_root)
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    os.chmod(directory, 0o700)
    path = directory / LIVE_OVERRIDE_FILENAME
    tmp = path.with_suffix(".tmp")
    tmp.write_text((new_value or "").strip())
    os.chmod(tmp, 0o600)
    tmp.replace(path)
    os.chmod(path, 0o600)


def effective_config(c):
    """(is_enabled, root) the daemon will actually act on right now -- the
    live override file if one exists at all (see read_live_override), else
    the environment variable it started with. Always resolved fresh; never
    caches anything, in this call or across calls."""
    is_set, root = read_live_override(c["staging"])
    if is_set:
        return root is not None, root
    return enabled(), drop_root()


def _short(value):
    return hashlib.sha256(str(value).encode()).hexdigest()[:16]


def _unit_size_fingerprint(unit_paths):
    """Sorted [relative_path, size] pairs for every regular file in a slide
    unit (the container file plus an optional companion directory). Paths
    are relative to the unit's parent directory so a copy into a staging
    temp dir that uses the same basenames compares equal. Size-only, and
    IGNORED_NOISE_NAMES excluded -- see module docstring. Returns None if
    the unit cannot be fingerprinted (symlink, vanished mid-walk)."""
    if not unit_paths:
        return None
    parent = unit_paths[0].parent
    out = []
    try:
        for path in unit_paths:
            if path.is_symlink():
                return None
            if path.is_file():
                if path.name in IGNORED_NOISE_NAMES:
                    continue
                out.append([path.relative_to(parent).as_posix(), path.stat().st_size])
                continue
            if not path.is_dir():
                return None
            for root, dirs, files in os.walk(path, topdown=True, followlinks=False):
                dirs[:] = sorted(d for d in dirs if d not in IGNORED_NOISE_NAMES)
                rootp = Path(root)
                if rootp.is_symlink():
                    return None
                for name in sorted(files):
                    if name in IGNORED_NOISE_NAMES:
                        continue
                    child = rootp / name
                    if child.is_symlink() or not child.is_file():
                        return None
                    out.append([child.relative_to(parent).as_posix(), child.stat().st_size])
    except (OSError, ValueError):
        return None
    return sorted(out)


def _is_ready(stable_since, observations, c, now):
    if observations < c["obs"]:
        return False
    if now - stable_since < c["quiet"]:
        return False
    return True


def _units_in_folder(directory, relative, files, engine):
    """Per-slide units whose container file sits directly in `directory`.
    Companion folders are looked up by autobatch's expected name so VSI's
    `_stem_` and MRXS's bare-stem sibling both attach to the right slide
    and are never themselves treated as datasets. Returns (units, companion
    directory names to skip when recursing)."""
    autobatch = _load_autobatch()
    units = []
    companion_names = set()
    anchors_by_stem = {}
    for path in files:
        stem, _ext = autobatch.split_known_extension(path.name, engine)
        if stem:
            anchors_by_stem.setdefault(stem, []).append(path)
    for stem, candidates in anchors_by_stem.items():
        if len(candidates) > 1:
            continue  # never guess which of two same-stem extensions wins
        anchor = candidates[0]
        needs_companion = autobatch.expected_companion_name(anchor.name, engine) is not None
        companion = autobatch.find_companion(directory, anchor.name, engine)
        if companion is not None:
            companion_names.add(companion.name)
        unit_paths = [anchor] + ([companion] if companion is not None else [])
        rel_anchor = Path(anchor.name) if relative == Path(".") else relative / anchor.name
        units.append({
            "key": rel_anchor.as_posix(),
            "origin": directory.name,
            "relative_parent": relative,
            "stem": stem,
            "anchor": anchor,
            "companion": companion,
            "unit_paths": unit_paths,
            "complete": (not needs_companion) or (companion is not None),
        })
    return units, companion_names


def discover_units(root, engine, log=None):
    """Walk from `root` for per-slide units -- see module docstring.
    Never treats `root` itself as a parent of units; loose files sitting
    directly in `root` are left alone and logged once."""
    log = log or (lambda event, **fields: None)
    found = []

    def walk(directory, relative):
        try:
            children = sorted(directory.iterdir(), key=lambda p: p.name)
        except OSError:
            return
        files, subdirs = [], []
        for child in children:
            if child.name in IGNORED_NOISE_NAMES:
                continue
            if relative == Path(".") and child.name == PROCESSED_DIRNAME:
                continue
            try:
                if child.is_symlink():
                    continue
                if child.is_dir():
                    subdirs.append(child)
                elif child.is_file():
                    files.append(child)
            except OSError:
                continue
        if directory == root:
            if files:
                log("network_drop_loose_file_at_root", count=len(files))
            for child in subdirs:
                walk(child, relative / child.name)
            return
        units, companion_names = _units_in_folder(directory, relative, files, engine)
        found.extend(units)
        for child in subdirs:
            if child.name in companion_names:
                continue
            walk(child, relative / child.name)

    walk(root, Path("."))
    return found


class TrackingLedger:
    """Per-slide-unit size-fingerprint stability tracking, keyed by the
    anchor file's path relative to the drop root. Entirely separate from
    wsi_ingest.py's own manifest/observation state -- this is only a
    heuristic front-end gate deciding *when* to hand a copy to that
    already-rigorous, unmodified engine, not a replacement for it."""

    def __init__(self, path):
        self.path = path

    def _load(self):
        try:
            return json.loads(self.path.read_text())
        except (OSError, json.JSONDecodeError):
            return {}

    def _save(self, data):
        self.path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        os.chmod(self.path.parent, 0o700)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, sort_keys=True))
        os.chmod(tmp, 0o600)
        tmp.replace(self.path)
        os.chmod(self.path, 0o600)

    def observe(self, key, fingerprint, now):
        data = self._load()
        record = data.get(key)
        if record is None or record.get("fingerprint") != fingerprint:
            record = {"fingerprint": fingerprint, "stable_since": now, "observations": 1}
        else:
            record["observations"] = int(record.get("observations", 0)) + 1
        record["last_seen"] = now
        data[key] = record
        self._save(data)
        return record["stable_since"], record["observations"]

    def forget(self, key):
        data = self._load()
        if key in data:
            del data[key]
            self._save(data)

    def sweep_stale(self, present_keys):
        data = self._load()
        stale = [k for k in data if k not in present_keys]
        if not stale:
            return
        for k in stale:
            del data[k]
        self._save(data)


def _cleanup_orphaned_temp_dirs(staging_root, log):
    """Removes any leftover incoming-copy temp directory from a pass that
    crashed mid-copy. Always safe: a temp directory is only ever renamed to
    its final name after the copy has already been verified byte-for-byte
    against the network source (see relocate_unit), and the network
    source itself is never touched before that rename succeeds -- so an
    orphaned temp directory is always a strict, disposable subset of data
    that still safely exists at the network drop root, never the only copy
    of anything."""
    try:
        leftovers = list(staging_root.glob(TEMP_PREFIX + "*"))
    except OSError:
        return
    for item in leftovers:
        shutil.rmtree(item, ignore_errors=True)
    if leftovers:
        log("network_drop_cleaned_orphaned_temp_dirs", count=len(leftovers))


def _move_to_processed(root, relative_path, log):
    """Moves the network original into processed/<relative_path>, mirroring
    whatever subdirectory structure it had under `root`. Same filesystem on
    both sides (both under `root`), so this is a fast, near-atomic rename,
    not a slow cross-device copy. Never overwrites an existing entry at the
    destination; never deletes anything."""
    source = root / relative_path
    dest = root / PROCESSED_DIRNAME / relative_path
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            dest = dest.parent / f"{dest.name}.{int(time.time())}"
        shutil.move(str(source), str(dest))
    except OSError as error:
        log("network_drop_move_to_processed_failed", dataset=_short(str(relative_path)),
            detail=str(error))


def relocate_unit(c, engine, root, unit, fingerprint, log, merge_ledger):
    """Copies one complete slide unit into a fresh, verified local staging
    directory named after the container stem, records the merge origin so
    the daemon can fold it into production/<parent>/ after promote, then
    moves the network originals of *only those items* into processed/
    (never deletes them; never moves the dated parent folder). Returns True
    once fully handled -- the caller should only drop stability tracking in
    that case -- or False to leave everything untouched and retry next pass."""
    try:
        dataset_name = engine.dataset_name(unit["stem"])
    except engine.Fail:
        log("network_drop_invalid_name", dataset=_short(unit["key"]))
        return False

    dest_dir = c["staging"] / dataset_name
    if dest_dir.exists():
        log("network_drop_relocate_name_collision", dataset=_short(dataset_name))
        return False

    temp_dir = c["staging"] / f"{TEMP_PREFIX}{secrets.token_hex(8)}"
    try:
        temp_dir.mkdir(mode=0o700)
        for path in unit["unit_paths"]:
            dest = temp_dir / path.name
            if path.is_file():
                shutil.copy2(str(path), str(dest))
            else:
                # ignore=... skips IGNORED_NOISE_NAMES at every level, matching
                # _unit_size_fingerprint()'s own exclusion -- both are required
                # together. Without this, Thumbs.db specifically has been
                # observed in practice to fail shutil.copy2's copystat with
                # PermissionError when the source arrived from a Windows-side
                # SMB write, which discards this entire (otherwise-fine) copy
                # and retries forever.
                shutil.copytree(str(path), str(dest), copy_function=shutil.copy2,
                                symlinks=False, ignore=shutil.ignore_patterns(*IGNORED_NOISE_NAMES))
    except OSError as error:
        shutil.rmtree(temp_dir, ignore_errors=True)
        log("network_drop_copy_failed", dataset=_short(dataset_name), detail=str(error))
        return False

    copied_paths = [temp_dir / path.name for path in unit["unit_paths"]]
    copied_fingerprint = _unit_size_fingerprint(copied_paths)
    if copied_fingerprint is None:
        shutil.rmtree(temp_dir, ignore_errors=True)
        log("network_drop_copy_verify_failed", dataset=_short(dataset_name))
        return False
    if copied_fingerprint != fingerprint:
        shutil.rmtree(temp_dir, ignore_errors=True)
        log("network_drop_copy_mismatch", dataset=_short(dataset_name))
        return False

    try:
        engine.atomic_rename_noreplace(temp_dir, dest_dir)
    except engine.Fail as error:
        shutil.rmtree(temp_dir, ignore_errors=True)
        log("network_drop_relocate_failed", dataset=_short(dataset_name), detail=error.cat)
        return False

    try:
        _load_autobatch().write_merge_origin(dest_dir, unit["origin"])
    except (OSError, ValueError) as error:
        log("network_drop_merge_origin_write_failed", dataset=_short(dataset_name), detail=str(error))
        shutil.rmtree(dest_dir, ignore_errors=True)
        return False  # source still on the share; retry together next pass
    if merge_ledger is not None:
        merge_ledger.record(dataset_name, unit["origin"])
    for path in unit["unit_paths"]:
        _move_to_processed(root, path.relative_to(root), log)
    log("network_drop_relocated", dataset=_short(dataset_name))
    return True


def poll_and_relocate(c, engine, tracking, log=None, merge_ledger=None):
    """One pass: clean up crash leftovers, discover per-slide units, advance
    each one's stability tracking, and copy at most one ready complete slide
    into staging. Copies off a network share are slow, so returning after
    one relocate lets the rest of the daemon pass seal/observe/promote
    whatever is already local instead of blocking on the next slide.
    Incomplete units (container present, companion still missing) are
    tracked but never copied. Safe to call unconditionally on every daemon
    pass -- returns immediately if disabled or the configured root is not
    currently reachable, neither of which is logged as an error."""
    log = log or (lambda event, **fields: None)
    is_enabled, root = effective_config(c)
    if not is_enabled or root is None or not root.is_dir():
        return
    _cleanup_orphaned_temp_dirs(c["staging"], log)

    now = time.time()
    units = discover_units(root, engine, log)
    tracking.sweep_stale({unit["key"] for unit in units})

    relocated = False
    for unit in units:
        fingerprint = _unit_size_fingerprint(unit["unit_paths"])
        if fingerprint is None:
            log("network_drop_candidate_invalid", dataset=_short(unit["key"]))
            continue
        stable_since, observations = tracking.observe(unit["key"], fingerprint, now)
        if relocated or not unit["complete"] or merge_ledger is None:
            continue
        if not _is_ready(stable_since, observations, c, now):
            continue
        if relocate_unit(c, engine, root, unit, fingerprint, log, merge_ledger):
            tracking.forget(unit["key"])
            relocated = True
