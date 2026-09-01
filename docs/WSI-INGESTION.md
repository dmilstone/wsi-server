# Manual atomic WSI ingestion

`./ops/wsi-ingest` is a scanner-agnostic operator command for promoting one complete top-level staged WSI dataset directory into the production image root. It never contacts viewer APIs, never reads annotations, never opens images with Bio-Formats, and never treats a single `.vsi` file separately from its companion data directory and associated files.

## Configuration

Set these environment variables in local shell state or in an untracked local file such as `ops/wsi-ingest.conf`, then run `source ops/wsi-ingest.conf`. The tool reads environment variables; it does not automatically load that file:

```sh
export WSI_INGEST_STAGING_ROOT="/path/to/staging-outside-production"
export WSI_INGEST_PRODUCTION_ROOT="/path/to/production"
export WSI_INGEST_REQUIRED_OBSERVATIONS=3
export WSI_INGEST_OBSERVATION_INTERVAL_SECONDS=60
export WSI_INGEST_MIN_QUIET_SECONDS=120
```

Intended local values are staging `/Users/dm026/wsi-ingest-staging`, production `/Users/dm026/wsi-slides`, and quiet time `120` seconds. Do not commit those as active configuration. Staging must be outside production, production must be outside staging, and both roots must be on the same filesystem so a native no-replace directory rename can atomically move the dataset directory without overwrite or copy/delete fallback. The implementation uses Linux `renameat2(..., RENAME_NOREPLACE)` or macOS `renamex_np(..., RENAME_EXCL)` and fails closed where neither primitive is available.

Production must contain exactly `.wsi-environment-production` and no other `.wsi-environment-*` marker.

## Operator protocol

1. Confirm by scanner/vendor UI, lab process, or other operational evidence that acquisition appears complete. No scanner marker is required or parsed.
2. Put one acquisition as one top-level directory under staging.
3. Run `./ops/wsi-ingest inspect DATASET`.
4. Run `./ops/wsi-ingest seal DATASET` and type exactly `SEAL` when prompted. This records the first deterministic whole-tree manifest and the operator readiness assertion.
5. Run `./ops/wsi-ingest observe DATASET` after each configured interval until the qualifying observation count is met. The default is three observations, spaced by 60 seconds.
6. After the minimum quiet period, run `./ops/wsi-ingest promote --dry-run DATASET`.
7. Run `./ops/wsi-ingest promote --step DATASET` and type exactly `PROMOTE`.

Filesystem quiescence reduces risk but cannot prove that acquisition has completed. The operator must confirm the scanner/acquisition workflow appears complete before `SEAL`. Atomic promotion guarantees that production receives the selected directory as one rename operation; it cannot establish semantic completeness of scanner output.

## Commands

- `status`: read-only root, marker, filesystem, lock, and pending-state summary without image listings.
- `inspect DATASET`: read-only validation with aggregate file count, byte count, newest modification age, and opaque dataset identifier.
- `seal DATASET`: mutating control-state operation only; writes restricted state under staging `.wsi-ingest-control`.
- `observe DATASET`: mutating control-state operation only; records a qualifying unchanged whole-tree observation.
- `promote --dry-run DATASET`: read-only preflight; it never adds an observation.
- `promote --step DATASET`: locks, revalidates, confirms, journals, uses a native atomic no-replace directory rename, fsyncs parents, verifies, and writes a restricted receipt.
- `history`: prints transaction IDs and phases without contained filenames.
- `recover`: conservative idempotent recovery.

There is intentionally no `--force`, `--ignore-stability`, or equivalent bypass.

## Seal, observation, and stability model

The manifest records every entry's normalized path relative to the dataset, type, regular-file size, nanosecond mtime, mode, device, and inode. File contents are not hashed. Any addition, removal, replacement, mtime/size/type change, symlink, or canonical root escape invalidates the seal and observations; the operator must inspect and seal again.

## Crash/recovery table

| State | Recovery action |
| --- | --- |
| Source exists, destination absent | Report promotion did not occur; preserve source for explicit retry. |
| Source absent, destination exists and matches manifest | Complete verification/receipt without moving data again. |
| Source and destination both exist | Stop for manual investigation. |
| Neither source nor destination exists | Stop for manual investigation. |
| Destination exists but differs from manifest | Stop for manual investigation. |

Recovery never deletes, overwrites, copies, or automatically moves production data.

## Troubleshooting

- `configuration`: set all required environment variables and ensure observation settings are valid.
- `environment`: fix production environment markers before retrying.
- `filesystem`: place staging and production on the same filesystem.
- `stability`: wait for the next observation interval or quiet period.
- `manifest`: the dataset changed; preserve evidence, inspect, and reseal only after confirming acquisition is complete.
- `manual_investigation`: do not clean up automatically; inspect restricted journal state and the two roots.

## Future optional readiness adapters

A future optional vendor-specific readiness adapter or scanner-generated marker may strengthen the manual workflow. The core ingestion tool must remain scanner-independent and must never depend on a marker, vendor log, API, filename convention, open-file signal, or Bio-Formats opening result.

## Unattended ingestion daemon (`ops/wsi_ingest_daemon.py`)

`ops/wsi-ingest-daemon` wraps the manual tool above in an unattended loop for someone who does not want to run `seal`/`observe`/`promote` by hand. It never re-implements the manual tool's manifest hashing, locking, or atomic rename; it only calls `ops/wsi_ingest.py` as a subprocess with the confirmation tokens supplied automatically, on a timer. The manual workflow above remains a fully independent fallback at all times -- stop or never start the daemon and nothing changes about how `./ops/wsi-ingest` behaves.

Each pass:

1. seals any new top-level staging directory that isn't already tracked;
2. records an observation for anything already sealed;
3. runs a structural integrity probe (TIFF/BigTIFF header, or generic readability check for non-TIFF containers, `probe_integrity`) immediately before promotion, retried up to `--integrity-retry-limit` passes before a dataset is skipped and left for manual investigation. Any large `.svs`/`.ndpi` (routinely several GB) is normally written as BigTIFF rather than classic TIFF -- the probe recognizes both;
4. promotes anything that has met the quiet/observation requirements and passed the integrity probe, then calls `POST /api/images/refresh` on the running server;
5. queues the newly promoted dataset for a clinical-marker sidecar OCR pass (`ops/retro_build_metadata.py --only-dir`), retried up to `--sidecar-retry-limit` passes -- this runs after, not during, promotion, because the server's `ImageRegistry` snapshot (and therefore the `label.png` route the OCR step needs) only updates asynchronously.

Key environment variables (in addition to the ones above, which it reuses): `WSI_INGEST_DAEMON_INTEGRITY_RETRY_LIMIT`, `WSI_INGEST_DAEMON_SIDECAR_RETRY_LIMIT`, `WSI_INGEST_DAEMON_REFRESH_URL`, `WSI_INGEST_DAEMON_LOG`. A pause or stop sentinel file under `<staging>/.wsi-ingest-control/daemon/` lets an operator halt new work without killing the process.

### Never reuse a staging directory name

The manual tool's `validate()` permanently blocks promotion once `production/<name>` already exists (a `collision` failure), and the daemon's own tracking is keyed by name and never expires -- so silently reusing a name (even after the first copy was promoted) is either a hard failure or an invisible no-op, not a way to add a second batch under the same label. Each distinct acquisition/session should get its own uniquely-named staging directory (a timestamp suffix is enough, e.g. `20260828-0900`, `20260828-1400`).

### Opt-in "hot folder" front end (`ops/wsi_ingest_autobatch.py`)

The constraint above exists because the manual tool's unit of atomicity is the *entire staging directory*: one manifest digest, one quiescence clock. A directory a scanner writes into continuously all day never looks quiet, because every new file resets the clock for everything already sitting there. `wsi_ingest_autobatch.py` is an opt-in layer in front of that, shrinking the unit of atomicity down to one slide at a time, without changing `wsi_ingest.py` itself at all:

- **Opt-in is a marker file, not a naming convention.** Any staging directory -- dated or not -- that contains a `.wsi-autobatch` file is treated as a continuously-written hot folder. Everything else keeps working exactly as documented above, untouched.
- Loose files dropped into a marked folder are grouped into per-slide units: a single WSI container file for self-contained formats (`.svs`, `.ndpi`, `.tif(f)`, `.czi`, `.lif`), or an anchor file plus its companion folder for formats that need one -- `.vsi` (its `_<stem>_` tile-data sibling) or `.mrxs` (a bare `<stem>/` sibling holding `Data0000.dat`/`Index.dat`/`Slidedat.ini`). A unit's companion is always located by its exact expected name, never guessed at from folder-name shape alone, so a bare `.mrxs`-style companion is never confused with an unrelated folder that happens to sit in the same hot folder.
- Each unit's own files are watched for (size, mtime) stability using the same `WSI_INGEST_REQUIRED_OBSERVATIONS` / `WSI_INGEST_OBSERVATION_INTERVAL_SECONDS` / `WSI_INGEST_MIN_QUIET_SECONDS` knobs as the manual tool, so there is one timing story to reason about. This is a lighter heuristic gate deciding *when* to hand a unit off -- the manual tool's own, already-rigorous manifest/lock/atomic-rename logic still runs, unmodified, on whatever gets handed to it.
- Once a unit is stable, it is relocated (an ordinary same-filesystem rename) into its own brand-new top-level staging directory named after the anchor file's own stem. Scanner output filenames already carry a unique timestamp, so this needs no extra uniquing. From that point on it is indistinguishable from a directory a human created by hand, and the existing seal/observe/promote loop picks it up exactly as documented above.
- After promotion, the daemon merges that temp directory's contents back into `production/<origin-folder-name>/` (the name of the marked hot folder in staging), so the dated/organized production layout is preserved and the temp wrapper disappears. Origin travels inside the wrapper as a `.wsi-merge-origin` file through `wsi_ingest.py`'s atomic promote; a sidecar ledger is only a fallback for wrappers that predate the marker. A crash partway through a merge needs no special recovery: the daemon retries the same merge on its next pass, and already-moved items are simply skipped. Finder/Windows noise (`.DS_Store`, and similar) is never merged into the dated folder.
- Anything that stays stable without ever resolving into a complete unit -- an unrecognized extension, or a companion-shaped folder whose anchor never shows up -- is quarantined to `<staging>/-unrecognized/<origin-folder-name>/<name>` rather than promoted or silently left in place. A name starting with `-` is already invisible to both the daemon's and the dashboard's directory listings, so quarantined items cannot be mistaken for a pending dataset. Nothing is ever deleted. Common OS filesystem noise (`.DS_Store`, `Thumbs.db`, `desktop.ini`) is ignored outright and never quarantined.

Enable it with `WSI_INGEST_AUTOBATCH_ENABLED=1` (off by default). This is deliberately an additive, parallel path: unmarked staging directories are completely unaffected, so it can be tried on one real hot folder while everything else keeps running exactly as it does today.
