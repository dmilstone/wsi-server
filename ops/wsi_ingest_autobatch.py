#!/usr/bin/env python3
"""Opt-in front end that lets a staging directory be a continuously-fed hot
folder instead of a manually-named, one-shot batch.

Problem this solves: wsi_ingest.py's transaction is the whole directory --
one manifest digest, one quiescence clock, one atomic move. That is exactly
right for a human-curated batch, but it means a directory a scanner writes
into all day never finishes (every new file resets the clock for everything
already sitting there quietly), and reusing a directory name after it has
been promoted is a hard, permanent trap (see docs/WSI-INGESTION.md).

This module never re-implements wsi_ingest.py's manifest hashing, atomic
rename, locking, or journal/receipt logic, and it never mutates that engine.
Instead, for any staging directory explicitly marked with AUTOBATCH_SENTINEL
(any name -- dated or not; opt-in is a marker file, not a naming
convention), it:

  1. groups loose top-level entries into per-slide units (one WSI container
     file, plus a companion folder for formats that need one, e.g. VSI's
     "_<stem>_" tile-data sibling);
  2. tracks each entry's own (size, mtime) stability independently, using
     the same required-observations / interval / min-quiet-seconds knobs as
     wsi_ingest.py itself, so the timing story is one thing to reason about;
  3. once a unit is genuinely stable, relocates it (a same-filesystem,
     already-atomic-per-item rename) into its own brand-new, top-level
     staging directory named after the anchor file's own stem -- which,
     because scanner output already carries a unique timestamp per file,
     needs no extra uniquing. That directory then looks exactly like a
     manually-created batch to the unmodified wsi_ingest.py / daemon
     seal-observe-promote loop, which picks it up and processes it exactly
     as it already does today. This module's only other daemon-side hook is
     recording, in AutobatchMergeLedger, which origin folder that temp
     wrapper's contents should be merged back into once promoted (see
     merge_promoted_dataset in wsi_ingest_daemon.py).
  4. quarantines anything that stays stable without ever resolving into a
     complete unit (an unrecognized extension, or a companion-shaped folder
     whose anchor never appears) to <staging>/-unrecognized/<origin>/<name>
     -- a name starting with "-" is already invisible to both the daemon's
     and the dashboard's directory listings, so this requires no new
     exclusion logic anywhere else, and nothing is ever deleted.

Filesystem noise (.DS_Store, Thumbs.db, desktop.ini) is ignored outright,
never tracked or quarantined.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path

AUTOBATCH_SENTINEL = ".wsi-autobatch"
QUARANTINE_DIRNAME = "-unrecognized"
TRACKING_LEDGER_FILENAME = "autobatch-tracking.json"
MERGE_LEDGER_FILENAME = "autobatch-merge-pending.json"
IGNORED_NOISE_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini", ".localized", AUTOBATCH_SENTINEL}
# An anchor whose companion never shows up at all must not wait forever,
# silently invisible -- but the ordinary per-item quiet window is
# deliberately short enough to tolerate a companion arriving noticeably
# later than its anchor (real scanners often finalize a small metadata/
# anchor file before a large tile-data folder finishes writing -- see
# test_vsi_waits_for_companion_regardless_of_arrival_order). A missing
# companion is therefore only treated as abandoned after a materially
# longer grace period than a normal stability check, not the same window
# used for an already-complete unit or a definitely-orphaned companion.
ORPHAN_ANCHOR_GRACE_MULTIPLIER = 6

# Companion folder name template per anchor extension. None means the format
# is self-contained (single file = one complete slide). Every extension here
# must also appear in engine.WSI_EXTS. MRXS's companion folder is the bare
# stem itself (no delimiter) -- e.g. "CMU-1.mrxs" + a sibling "CMU-1/" folder
# holding Data0000.dat/Index.dat/Slidedat.ini -- which is why finding a
# unit's companion always looks it up directly by expected name (see
# find_companion) rather than by recognizing a companion's shape in
# isolation; only VSI's "_stem_" wrapping is distinctive enough on its own
# to double as an orphan-detection signal (see companion_stem).
_COMPANION_TEMPLATES = {".vsi": "_{stem}_", ".mrxs": "{stem}"}


def enabled():
    return os.environ.get("WSI_INGEST_AUTOBATCH_ENABLED", "").strip().lower() in ("1", "true", "yes", "on")


def sorted_wsi_exts(engine):
    return sorted(engine.WSI_EXTS, key=len, reverse=True)


def split_known_extension(name, engine):
    lower = name.lower()
    for ext in sorted_wsi_exts(engine):
        if lower.endswith(ext):
            return name[: -len(ext)], ext
    return None, None


def expected_companion_name(anchor_name, engine):
    stem, ext = split_known_extension(anchor_name, engine)
    if not stem:
        # A bare extension with no stem (e.g. a literal ".mrxs" or ".vsi"
        # file) would otherwise format to an empty companion name, and
        # `folder / ""` resolves to `folder` itself in pathlib -- silently
        # treating the enclosing hot folder as this anchor's "companion".
        # Falling through to None here routes it into the existing
        # invalid-stem quarantine path (engine.dataset_name rejects an
        # empty name) instead.
        return None
    template = _COMPANION_TEMPLATES.get(ext)
    if not template:
        return None
    return template.format(stem=stem)


def companion_stem(entry_name):
    """If entry_name matches the generic "_<stem>_" companion-folder shape,
    return <stem> -- purely a naming-shape check; the caller still has to
    confirm a real anchor with that stem actually exists before treating it
    as a match, since this shape alone is ambiguous about which extension
    (if any) the anchor should have. This intentionally only covers
    delimited shapes like VSI's: a bare-stem companion (MRXS) is never
    distinctive enough on its own to guess at from the folder name alone --
    see find_companion for how those are actually matched to their anchor."""
    if len(entry_name) > 2 and entry_name.startswith("_") and entry_name.endswith("_"):
        return entry_name[1:-1]
    return None


def find_companion(folder, anchor_name, engine):
    """The companion this anchor needs, found by directly checking for its
    expected name rather than by recognizing any dict of pre-classified
    companion-shaped entries -- the only approach that works uniformly for
    both a delimited shape (VSI's "_stem_") and a bare-stem one (MRXS's own
    plain stem), without the two ever being confused for each other."""
    expected_name = expected_companion_name(anchor_name, engine)
    if expected_name is None:
        return None
    candidate = folder / expected_name
    return candidate if candidate.is_dir() else None


def discover_marked_folders(staging_root):
    """Top-level staging directories that opted in via AUTOBATCH_SENTINEL.
    Deliberately name-agnostic (dated or not) -- opt-in is the marker file,
    not a naming convention, so folders used for other purposes (including
    the traditional whole-directory flow) are left completely alone unless
    explicitly marked."""
    marked = []
    try:
        entries = list(staging_root.iterdir())
    except OSError:
        return marked
    for item in entries:
        if item.name.startswith("-") or item.name.startswith("."):
            continue
        try:
            if item.is_dir() and not item.is_symlink() and (item / AUTOBATCH_SENTINEL).is_file():
                marked.append(item)
        except OSError:
            continue
    return sorted(marked, key=lambda p: p.name)


class TrackingLedger:
    """Per-entry (size, mtime) stability tracking for loose top-level items
    inside marked folders. Entirely separate from wsi_ingest.py's own
    manifest/observation state -- this is only a heuristic front-end gate
    deciding *when* to hand a unit to that already-rigorous, unmodified
    engine, not a replacement for its own re-validation."""

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

    def observe(self, folder_key, entry_name, fingerprint, now):
        """Records one observation of entry_name's current fingerprint under
        folder_key, resetting the stability clock if it changed since the
        last pass. Returns (stable_since, observations)."""
        data = self._load()
        bucket = data.setdefault(folder_key, {})
        record = bucket.get(entry_name)
        if record is None or record.get("fingerprint") != fingerprint:
            record = {"fingerprint": fingerprint, "stable_since": now, "observations": 1}
        else:
            record["observations"] = int(record.get("observations", 0)) + 1
        record["last_seen"] = now
        bucket[entry_name] = record
        self._save(data)
        return record["stable_since"], record["observations"]

    def forget(self, folder_key, entry_name):
        data = self._load()
        bucket = data.get(folder_key)
        if bucket and entry_name in bucket:
            del bucket[entry_name]
            if not bucket:
                del data[folder_key]
            self._save(data)

    def sweep_stale(self, folder_key, present_names):
        """Drops tracked entries that are no longer present (already
        relocated/quarantined by a prior pass, or removed by a human)."""
        data = self._load()
        bucket = data.get(folder_key)
        if not bucket:
            return
        stale = [n for n in bucket if n not in present_names]
        if not stale:
            return
        for n in stale:
            del bucket[n]
        if not bucket:
            del data[folder_key]
        self._save(data)


class AutobatchMergeLedger:
    """Maps a temp-wrapper dataset name (as it will be promoted by the
    unmodified wsi_ingest.py engine) to the origin marked-folder name its
    contents should be merged back into in production. An entry is removed
    only once the merge is fully complete, so re-attempting a merge whose
    prior attempt was interrupted mid-way is just the normal code path
    running again on the next pass -- not a separate recovery branch."""

    def __init__(self, path):
        self.path = path

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

    def record(self, temp_name, origin_name):
        data = self._load()
        data[temp_name] = origin_name
        self._save(data)

    def pending(self):
        return dict(self._load())

    def clear(self, temp_name):
        data = self._load()
        if temp_name in data:
            del data[temp_name]
            self._save(data)


def _fingerprint(path):
    try:
        st = path.lstat()
    except OSError:
        return None
    if path.is_dir():
        # Deliberately NOT seeded from st.st_mtime_ns of the folder itself:
        # a directory's own mtime advances whenever any entry is added or
        # removed from its listing -- including an ignored noise file --
        # which would silently defeat the filter just below.
        newest = 0
        total = 0
        try:
            for child in path.rglob("*"):
                # A `.DS_Store` dropped inside a companion folder by a
                # technician Finder-browsing the hot folder must not reset
                # this folder's stability clock -- it would never look
                # quiet on a share anyone occasionally looks at. The noise
                # file still travels along with the folder on relocation
                # (nothing here deletes it); this only keeps it from
                # counting toward the fingerprint used for stability.
                if child.name in IGNORED_NOISE_NAMES:
                    continue
                try:
                    cst = child.lstat()
                except OSError:
                    continue
                if child.is_file():
                    total += cst.st_size
                    newest = max(newest, cst.st_mtime_ns)
        except OSError:
            pass
        return ["dir", total, newest]
    return ["file", st.st_size, st.st_mtime_ns]


def _is_ready(stable_since, observations, c, now):
    if observations < c["obs"]:
        return False
    if now - stable_since < c["quiet"]:
        return False
    return True


def scan_and_relocate(c, engine, tracking, merge_ledger, log=None):
    """One pass over every marked folder: update stability tracking for
    loose entries, relocate any unit that has fully matured into its own
    top-level staging directory (handing off to the unmodified engine from
    there), and quarantine anything that has been stable long enough without
    ever resolving into a complete, recognized unit."""
    log = log or (lambda event, **fields: None)
    now = time.time()
    for folder in discover_marked_folders(c["staging"]):
        folder_key = folder.name
        try:
            loose = [p for p in folder.iterdir() if p.name not in IGNORED_NOISE_NAMES]
        except OSError:
            continue
        present_names = {p.name for p in loose}
        tracking.sweep_stale(folder_key, present_names)

        anchor_candidates = {}     # stem -> list[Path] (anchor file candidates)
        # Delimited-shape-only, e.g. VSI's "_stem_" -- used purely to flag an
        # unpaired companion as an orphan (see below), never to find a real
        # unit's companion (find_companion does that directly by name).
        shaped_companions = {}
        unrecognized = []
        for entry in loose:
            stem, ext = (None, None)
            if entry.is_file():
                stem, ext = split_known_extension(entry.name, engine)
            if stem is not None:
                anchor_candidates.setdefault(stem, []).append(entry)
                continue
            comp_stem = companion_stem(entry.name) if entry.is_dir() else None
            if comp_stem is not None:
                shaped_companions[comp_stem] = entry
                continue
            unrecognized.append(entry)

        anchors = {}     # stem -> Path, only for unambiguous stems
        for stem, candidates in anchor_candidates.items():
            if len(candidates) > 1:
                # Ambiguous: two different recognized extensions share a
                # stem (e.g. slide.svs and slide.ndpi dropped in the same
                # hot folder). Never guess which one is "the" anchor --
                # track both as unrecognized so a human resolves the
                # naming collision instead of one silently, invisibly
                # vanishing (the losing entry in a plain dict overwrite).
                unrecognized.extend(candidates)
                continue
            anchors[stem] = candidates[0]

        handled = set()

        for stem, anchor in anchors.items():
            needs_companion = expected_companion_name(anchor.name, engine) is not None
            companion = find_companion(folder, anchor.name, engine)
            unit_paths = [anchor] + ([companion] if companion else [])
            fingerprints = {}
            ready = True
            for p in unit_paths:
                fp = _fingerprint(p)
                if fp is None:
                    ready = False
                    continue
                stable_since, observations = tracking.observe(folder_key, p.name, fp, now)
                fingerprints[p.name] = (stable_since, observations)
                if not _is_ready(stable_since, observations, c, now):
                    ready = False
            handled.add(anchor.name)
            if companion is not None:
                handled.add(companion.name)
            if needs_companion and companion is None:
                # Anchor alone isn't a complete slide yet -- but if it has
                # sat untouched with no companion at all for well beyond the
                # ordinary stability window, stop waiting silently forever
                # and surface it instead (see ORPHAN_ANCHOR_GRACE_MULTIPLIER).
                anchor_since, _anchor_obs = fingerprints.get(anchor.name, (now, 0))
                if now - anchor_since >= c["quiet"] * ORPHAN_ANCHOR_GRACE_MULTIPLIER:
                    log("autobatch_anchor_companion_never_arrived", origin=folder.name)
                    _quarantine(c, folder, anchor, log)
                    tracking.forget(folder_key, anchor.name)
                continue
            if not ready:
                continue
            if _relocate_unit(c, engine, merge_ledger, folder, stem, unit_paths, log):
                for p in unit_paths:
                    tracking.forget(folder_key, p.name)

        # Companion-shaped folders with no matching anchor, and anything
        # unrecognized, are orphan candidates: tracked the same way, and
        # quarantined once stable long enough that this isn't just a
        # companion that arrived slightly ahead of its own anchor file. A
        # bare-stem (MRXS-style) companion with no anchor yet has no
        # distinctive shape to flag it early, so it only shows up here once
        # it is unclaimed at scan time -- it still falls through to
        # `unrecognized` above and gets the same eventual grace-then-
        # quarantine treatment, just without a companion-specific reason.
        orphan_candidates = [p for stem, p in shaped_companions.items() if stem not in anchors] + unrecognized
        for entry in orphan_candidates:
            if entry.name in handled:
                continue
            fp = _fingerprint(entry)
            if fp is None:
                continue
            stable_since, observations = tracking.observe(folder_key, entry.name, fp, now)
            if not _is_ready(stable_since, observations, c, now):
                continue
            _quarantine(c, folder, entry, log)
            tracking.forget(folder_key, entry.name)


def _relocate_unit(c, engine, merge_ledger, folder, stem, unit_paths, log):
    """Best-effort atomic-or-nothing relocation of unit_paths into a brand
    new c['staging']/<name> directory, handing that whole directory off to
    the unmodified engine from there. Returns True only when the unit was
    fully handled (relocated, or quarantined for an invalid stem) -- the
    caller should only drop its stability tracking in that case. On any
    failure this leaves unit_paths exactly as they were in `folder` (rolling
    back anything already moved) so the whole unit is retried together next
    pass instead of ever reaching production half-moved."""
    try:
        name = engine.dataset_name(stem)
    except engine.Fail:
        log("autobatch_invalid_stem", origin=folder.name)
        for p in unit_paths:
            _quarantine(c, folder, p, log)
        return True
    dest_dir = c["staging"] / name
    try:
        dest_dir.mkdir(mode=0o700)
    except FileExistsError:
        # Two different hot folders producing the same derived name (e.g.
        # each containing a "slide.svs"), or a same-named batch a human
        # created independently in staging. Never guess which one wins:
        # leave this unit in place and retry next pass.
        log("autobatch_relocate_name_collision", origin=folder.name)
        return False
    except OSError as error:
        log("autobatch_relocate_failed", origin=folder.name, detail=str(error))
        return False
    moved = []
    try:
        for p in unit_paths:
            dest = dest_dir / p.name
            os.rename(str(p), str(dest))
            moved.append((p, dest))
    except OSError as error:
        for original, relocated in reversed(moved):
            try:
                os.rename(str(relocated), str(original))
            except OSError:
                log("autobatch_relocate_rollback_failed", origin=folder.name,
                    detail=f"could not restore {relocated.name}")
        try:
            dest_dir.rmdir()
        except OSError:
            pass
        log("autobatch_relocate_failed", origin=folder.name, detail=str(error))
        return False
    merge_ledger.record(name, folder.name)
    log("autobatch_relocated", origin=folder.name)
    return True


def _quarantine(c, folder, entry, log):
    dest_root = c["staging"] / QUARANTINE_DIRNAME / folder.name
    dest_root.mkdir(parents=True, mode=0o700, exist_ok=True)
    dest = dest_root / entry.name
    if dest.exists():
        dest = dest_root / f"{entry.name}.{int(time.time())}"
    try:
        os.rename(str(entry), str(dest))
        log("autobatch_quarantined", origin=folder.name)
    except OSError as error:
        log("autobatch_quarantine_failed", origin=folder.name, detail=str(error))
