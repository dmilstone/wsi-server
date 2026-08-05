# Manual atomic WSI ingestion

`./ops/wsi-ingest` is a scanner-agnostic operator command for promoting one complete top-level staged WSI dataset directory into the production image root. It never contacts viewer APIs, never reads annotations, never opens images with Bio-Formats, and never treats a single `.vsi` file separately from its companion data directory and associated files.

## Configuration

Set these environment variables in local shell state or in an untracked local file such as `ops/wsi-ingest.conf`:

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
