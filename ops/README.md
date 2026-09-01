# WSI operations commands

This directory contains the version-controlled process and release commands for
the WSI viewer.

Reference documents:

- [`RELEASE-CHEATSHEET.md`](RELEASE-CHEATSHEET.md) is the canonical online
  quick reference rendered directly by GitHub.
- [`RELEASE-CHEATSHEET.html`](RELEASE-CHEATSHEET.html) is a standalone browser
  and print view.
- `WSI-Release-Cheat-Sheet.pdf` is the verified two-page Letter print edition.
- `render_cheatsheet.py` regenerates the PDF from the version-controlled
  operational content.

The renderer's only required Python package is
[`ReportLab`](https://pypi.org/project/reportlab/). It uses ReportLab's bundled
Vera fonts when present and safely falls back to its built-in Helvetica,
Helvetica-Bold, and Courier fonts, so no operating-system font path is needed.
For an isolated local setup:

```bash
python3 -m venv .venv-release-docs
source .venv-release-docs/bin/activate
python -m pip install ReportLab
python ops/tests/test_renderer.py
python ops/render_cheatsheet.py
```

The final command always writes `ops/WSI-Release-Cheat-Sheet.pdf`. Visually
inspect both pages before committing a regenerated PDF.

## Commands

`wsi` controls a running environment:

```bash
wsi production status
wsi staging start
wsi rehearsal status
wsi development logs
```

`wsi-release` manages immutable artifacts:

```bash
wsi-release cycle --step
wsi-release cycle
wsi-release cycle --dry-run
wsi-release cycle --resume
wsi-release status
wsi-release verify staging
wsi-release stage
wsi-release rehearse
wsi-release verify rehearsal
wsi-release promote
wsi-release verify production
wsi-release tag production-YYYY-MM-DD-description
wsi-release history
wsi-release rollback
```

## Normal monitored release

The normal workflow is one command with explicit browser and promotion gates:

```bash
./ops/wsi-release cycle --step
```

Step mode shows every material command and accepts Enter to execute, `p` to
repeat the action, or `q` to stop safely. `cycle` is the faster monitored mode,
`--verbose` exposes underlying output, and `--dry-run` prints the entire plan
without creating state/log files or changing Git, files, processes, backups,
remotes, or tags. After an interruption, `cycle --resume` verifies every saved
repository, artifact, configuration, marker, annotation, runtime, production,
and backup assumption before continuing from the first safe incomplete phase.

The cycle runs:

1. Repository, remote, disk, environment and healthy-production preflight.
2. Maven, JavaScript, operations, whitespace and tracked-status tests; restart
   and verify development; require `DEVELOPMENT-PASS`.
3. Publish and verify the tested feature commit (never before that gate).
4. Build/install/verify staging; require `STAGING-PASS`.
5. Copy the exact staging artifact to isolated production-mode rehearsal;
   require `REHEARSAL-PASS`.
6. Reverify all candidate/production assumptions and require `PROMOTE`.
7. Verify a complete production backup before stopping only production, install
   the exact rehearsed artifact, and perform automated production verification.
8. Require `PRODUCTION-PASS`, then accept a tag name or `SKIP`; tagging retains
   the exact `TAG` authorization and refuses existing tags.

Human browser confirmations are never inferred. If production startup or
verification fails, the cycle stops and prints the exact rollback command and
backup path; it does not roll back automatically.

Cycle state and non-sensitive detailed logs are git-ignored:

```text
.runtime/run/release-cycle.state
.runtime/log/cycle-<timestamp-and-id>.log
```

The individual commands remain the diagnosis, partial-rerun, and manual
workflow:

1. `wsi-release stage`
2. Manual staging browser validation
3. `wsi-release rehearse`
4. Manual production-mode rehearsal validation at `http://localhost:8083`
5. `wsi-release promote`
6. Manual production browser validation
7. `wsi-release tag TAG_NAME`

Production promotion refuses to proceed unless the running rehearsal artifact
has the same commit and SHA-256 as staging.

## Troubleshooting modes

Every mutating release command supports:

- `--step`: show each operational action and require Enter before it runs;
- `--dry-run`: print the plan without modifying files or services;
- `--verbose`: print actions during ordinary execution;
- `--yes`: bypass the `STAGE` or `TAG` token only. It intentionally does not
  bypass `PROMOTE` or `ROLLBACK`.

Examples:

```bash
wsi-release stage --dry-run
wsi-release stage --step --verbose
wsi-release rehearse --step
wsi-release promote --step
wsi-release cycle --resume --step
wsi-release cycle --step --verbose
```

In step mode, press Enter to run the displayed action, `p` to display it again,
or `q` to exit before running it. Required steps cannot be skipped.

## Installation

From the repository root:

```bash
chmod +x ops/wsi ops/wsi-release ops/tests/run.sh
cp -p /Users/dm026/bin/wsi /Users/dm026/bin/wsi.before-versioned-operations
cp -p /Users/dm026/bin/wsi-promote-production /Users/dm026/bin/wsi-promote-production.before-versioned-operations
cp -p /Users/dm026/bin/wsi-rollback-production /Users/dm026/bin/wsi-rollback-production.before-versioned-operations
ln -sfn /Users/dm026/Downloads/wsi-server_works/ops/wsi /Users/dm026/bin/wsi
ln -sfn /Users/dm026/Downloads/wsi-server_works/ops/wsi-release /Users/dm026/bin/wsi-release
```

Before first rehearsal use:

```bash
mkdir -p /Users/dm026/wsi-production-rehearsal/{app,config,data/annotations,logs,run,releases}
mkdir -p /Users/dm026/wsi-images/production-rehearsal
touch /Users/dm026/wsi-images/production-rehearsal/.wsi-environment-production
cp -p ops/templates/rehearsal-application.properties /Users/dm026/wsi-production-rehearsal/config/application.properties
```

Populate the rehearsal image root only with verified deidentified validation
slides. The configuration binds port 8083 to `127.0.0.1`, uses separate
annotations, and deliberately reports `production` so the no-banner production
layout is exercised.

Do not replace the installed commands until `ops/tests/run.sh`, shell syntax
checks, and `wsi-release stage --dry-run` pass locally.

## Safety behavior retained

- A dirty Git worktree blocks builds and promotions.
- Staging must contain the exact Git `HEAD` before promotion.
- Recorded and calculated JAR checksums must match.
- Environment, port, image directory, and marker are checked before service
  replacement.
- Staging and production are backed up and checksummed before replacement.
- Production is not stopped until all preflight work and candidate copying pass.
- Production promotion still requires the literal token `PROMOTE`.
- Rollback still requires `ROLLBACK` and never restores annotations.
- Failed releases are preserved before rollback.
- Production tagging occurs only after deployment and manual validation.

## Configuration overrides

The scripts use the existing absolute paths by default. Tests and future hosts
can override them with:

```text
WSI_REPO
WSI_STAGING_ROOT
WSI_REHEARSAL_ROOT
WSI_PRODUCTION_ROOT
WSI_DEVELOPMENT_ROOT
WSI_PRODUCTION_ANNOTATIONS
WSI_CONTROL
WSI_JAR_NAME
WSI_RELEASE_AUDIT_LOG
```

Credentials are not stored in these scripts.

## Local ingestion dashboard

The dashboard is a separate, deliberately launched Python service. It always
binds `127.0.0.1:8084`; neither its launcher nor its implementation accepts a
bind address or port. From the repository root:

```bash
set -a
source ops/wsi-ingest.conf
set +a
export WSI_OPS_DASHBOARD_PASSWORD='enter a local password interactively'
./ops/wsi-ops-dashboard
```

Then open `http://127.0.0.1:8084/` in a browser running on the image-server
host. Stop it with Ctrl-C.

The dashboard also has an "Environment configuration (development)" section to
change the ingestion staging root (`WSI_INGEST_STAGING_ROOT`, takes effect
immediately, no restart), the network drop root (`WSI_INGEST_NETWORK_DROP_ROOT`,
also takes effect immediately -- the running ingestion daemon picks it up on
its next poll, no restart of anything), and the development viewer's own image
directory (`wsi.image-directory`, requires typing `RESTART` and stops/starts
development via `ops/wsi` -- see `docs/LOCAL-OPS-DASHBOARD-VALIDATION.md`).
Staging, rehearsal, and production directories are not yet editable from here.
Each of those three fields also has a "Browse…" link that pops a real native
macOS folder-picker window (not anything drawn by the page itself), plus a
smaller "list view" link to a click-through, no-typing fallback picker inside
the page -- either way as an alternative to the plain text input. See the same
doc's "Browse... dialog" section.

## Unattended ingestion daemon

`ops/wsi-ingest-daemon` is an optional, separate long-running process that
automates the manual `ops/wsi_ingest.py` workflow above. It never re-implements
manifest hashing, atomic rename, locking, or journal/receipt logic -- every
mutating step (seal, observe, promote, recover) is the literal, unmodified
`wsi_ingest.py` CLI, invoked in a subprocess with the same typed confirmation a
human would type, exactly like `ops/wsi_ops_dashboard.py` already does for its
own buttons. Manual `wsi_ingest.py` and `wsi_ops_dashboard.py` use remain fully
independent fallbacks whether or not this daemon is running.

```bash
set -a
source ops/wsi-ingest.conf
set +a
./ops/wsi-ingest-daemon               # loop forever, polling every 30s by default
./ops/wsi-ingest-daemon --once        # run a single pass and exit (useful for cron)
```

What each pass does, per dataset directory found directly under staging:

1. Not yet sealed -> seal it (skips silently if nothing recognizable has
   arrived yet; logs anything else).
2. Sealed and its manifest changed since sealing -> reseal (self-healing retry;
   `wsi_ingest.py`'s own recheck already detects and flags this).
3. Left mid-promotion by a previous crash (`moved` phase) -> recover.
4. Otherwise -> observe (a no-op log entry if the observation interval hasn't
   elapsed yet), then, once a promotion dry-run reports readiness, run a
   best-effort structural integrity probe (TIFF byte-order magic and in-bounds
   IFD offset for `.svs`/`.ndpi`/`.tif(f)`/`.ome.tif(f)`; a full unobstructed
   read for `.vsi`/`.czi`/`.lif`) before promoting. This is a safety net on top
   of -- not a replacement for -- `wsi_ingest.py`'s own size/mtime/inode
   quiescence check, which by itself cannot detect a file that stopped
   changing while still truncated. It is not a full decode; the viewer's own
   Bio-Formats/OpenSlide reader remains the authoritative check. A dataset
   that keeps failing this probe is retried up to
   `WSI_INGEST_DAEMON_INTEGRITY_RETRY_LIMIT` times (default 5, tracked
   entirely separately from `wsi_ingest.py`'s own state files), then skipped
   every pass until a human investigates and clears
   `.wsi-ingest-control/daemon/integrity-failures.json`.

After a successful promotion, if `WSI_INGEST_DAEMON_REFRESH_URL` is set, the
daemon makes a best-effort `POST /api/images/refresh` call so the slide
appears immediately; the running viewer already discovers new files on its own
within its configured stability window and refresh interval even without this
call, and does not need a restart either way.

Controlled stop/pause (modeled on the old BWH consult-workflow kill switch:
checked once per pass, never mid-transaction):

```bash
touch "$WSI_INGEST_STAGING_ROOT/.wsi-ingest-control/daemon/pause"   # finish nothing new; keep running and logging
rm "$WSI_INGEST_STAGING_ROOT/.wsi-ingest-control/daemon/pause"      # resume
touch "$WSI_INGEST_STAGING_ROOT/.wsi-ingest-control/daemon/stop"    # exit after the current pass; requires removing the file to restart
```

Every log line (`.wsi-ingest-control/daemon/daemon.log.jsonl` by default) is
JSON and identifies a dataset only by a truncated SHA-256 hash, matching the
convention `wsi_ingest.py inspect` already uses -- never a raw dataset name or
file path.

Windows 11 note: `wsi_ingest.py`'s locking and atomic-rename-without-replace
now have Windows branches (`msvcrt`/`MoveFileExW`) alongside the existing
Linux/Darwin ones, as preparation for eventually running this on a Windows
workstation. These are covered by mocked unit tests but have not yet been
exercised on a real Windows host -- verify there before relying on them in
production.

## Ingest-time `if.epitope` sidecar update

The listing paints `clinicalMarker` from `<stem>.metadata.json` under each
filename. After OCR or a later label correction, restamp those sidecars:

```bash
python3 ops/retro_build_metadata.py --slides-dir /Users/dm026/wsi-slides
```

Existing real `if.<epitope>` tokens are kept. `if.Pending` is treated as empty.
Pass `--force` to re-OCR. The script form-logs into the running viewer
(`http://127.0.0.1:8080` by default) and OCRs `/api/images/{id}/label.png` with
the `tesseract` CLI (90° first). Browser Scan remains only for rows still empty
after this sweep. Refresh the catalog after the sweep. Do not put the password
in the repository, shell history, process arguments, or logs. Use `WSI_PASSWORD`
if the local annotator password is not the default. `WSI_OPS_AUDIT_FILE` may select an ignored
local audit file, but cannot change image roots or the listener.

The session cookie is HttpOnly and SameSite=Strict. It intentionally lacks the
`Secure` attribute because browsers do not send Secure cookies over this
loopback HTTP endpoint. Secure cookies and HTTPS are mandatory before any
future remote-administration phase. This local phase must not be exposed using
a proxy, port forward, alternate bind address, or CORS.
