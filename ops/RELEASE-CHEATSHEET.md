# WSI Viewer Release Cheat Sheet

**Canonical flow:** Development -> Staging -> Production rehearsal -> Production -> Tag

## Environments

| Environment | Port | Runtime and identity | Data boundary |
|---|---:|---|---|
| Development | 8081 | Live Maven source; red banner | Deidentified development images and annotations |
| Staging | 8082 | Candidate JAR; yellow banner | Deidentified staging images and annotations |
| Rehearsal | 8083 | Exact staging JAR; production mode; loopback only | Deidentified production-marked images; rehearsal annotations |
| Production | 8080 | Frozen validated JAR; no banner | Authorized clinical images and production annotations |

Rehearsal binds to `127.0.0.1` and is not user accessible. Production source
edits do not affect users until an explicitly rehearsed artifact is promoted.

## Normal monitored release

```bash
./ops/wsi-release cycle --step   # recommended: inspect every material action
./ops/wsi-release cycle          # faster concise monitored mode
./ops/wsi-release cycle --dry-run
./ops/wsi-release cycle --resume [--step|--verbose]
```

One initial command runs repository/environment preflight, all development
tests, candidate publication, staging, exact-artifact rehearsal, promotion
preflight, verified production backup/promotion, and optional tagging. It pauses
for the exact tokens `DEVELOPMENT-PASS`, `STAGING-PASS`, `REHEARSAL-PASS`,
`PROMOTE`, `PRODUCTION-PASS`, and `TAG` (or `SKIP`). Browser success is never
inferred. State is `.runtime/run/release-cycle.state`; detailed non-sensitive
logs are `.runtime/log/cycle-*.log`.

## Manual / troubleshooting workflow

### 1. Development gate

```bash
cd /Users/dm026/Downloads/wsi-server_works
git status --short
./mvnw clean test
node --test src/test/js/*.test.js
./ops/tests/run.sh
git push origin feature/multichannel-viewer
```

Stop if Git is dirty or any required test fails.

### 2. Build and install staging

```bash
./ops/wsi-release stage --dry-run
./ops/wsi-release stage --step
./ops/wsi-release verify staging
wsi staging status
```

Type `STAGE` only after reviewing the commit, build, SHA-256, paths and backup.

**Browser gate - 8082:** yellow staging banner; correct deidentified slides;
open, pan, zoom and change channels; test annotations and exports; no CSRF `403`,
HTTP `500` or unhandled JavaScript errors. Close/reopen the browser and verify
existing annotations appear, can be edited, and persist after switching.

Confirm new files appear only beneath staging annotation storage.

### 3. Install the exact candidate in production rehearsal

```bash
./ops/wsi-release rehearse --dry-run
./ops/wsi-release rehearse --step
./ops/wsi-release verify rehearsal
wsi rehearsal status
```

Type `REHEARSE` only after confirming rehearsal will receive the exact staging
commit and SHA-256.

**Browser gate - 8083:** no environment banner; production grid and title;
exact staging features; deidentified rehearsal slides only; annotations remain
under rehearsal storage; production `8080` remains available throughout.

### 4. Final identity check and production promotion

```bash
./ops/wsi-release verify staging
./ops/wsi-release verify rehearsal
wsi production status
wsi staging status
wsi rehearsal status
./ops/wsi-release promote --dry-run
./ops/wsi-release promote --step
./ops/wsi-release verify production
```

Promotion must report the same commit and SHA-256 for staging and rehearsal.
Type `PROMOTE` only after preflight succeeds and the rollback backup verifies.

**Browser gate - 8080:** normal production layout and title; authorized slides;
pan, zoom, channels, annotations and exports; no CSRF `403`, HTTP `500`, layout
or persistence regression. Confirm `8081`, `8082` and `8083` remain isolated.

### 5. Tag only after production validation

```bash
./ops/wsi-release tag production-YYYY-MM-DD-description
```

Type `TAG`, then confirm the tag commit equals production `BUILD_COMMIT.txt`.

---

## Status and logs

```bash
wsi production status       # ports: production 8080, development 8081
wsi staging status          # staging 8082, rehearsal 8083
wsi rehearsal status
wsi development status
./ops/wsi-release status
./ops/wsi-release verify staging
./ops/wsi-release verify rehearsal
./ops/wsi-release verify production
```

```bash
wsi production logs
wsi staging logs
wsi rehearsal logs
wsi development logs
```

Press `Control-C` to stop following a log; it does not stop the server.

## Troubleshooting modes

```bash
./ops/wsi-release stage --dry-run
./ops/wsi-release stage --step --verbose
./ops/wsi-release rehearse --dry-run
./ops/wsi-release promote --dry-run
./ops/wsi-release history
```

- `--dry-run`: show the plan without modifying files or services.
- `--step`: Enter runs; `p` repeats; `q` exits safely before the next action.
- `--verbose`: print actions during ordinary execution.
- Use `./ops/wsi-release` if the installed `wsi-release` command is not found.
- Never bypass `PROMOTE` or `ROLLBACK` confirmation.

## Stop conditions

Stop immediately if any of these occur:

- Git worktree is dirty or a required test fails.
- Git HEAD differs from staging `BUILD_COMMIT.txt`.
- Recorded and calculated SHA-256 values differ.
- Staging and rehearsal commits or JAR checksums differ.
- Environment identity, image root, marker or port disagrees.
- A server fails to bind its expected port.
- Browser validation reveals a new security, layout, image, annotation,
  persistence or export regression.
- Production backup or metadata validation fails before port `8080` is stopped.

Do not repair a mismatch by editing build metadata or checksum files.

## Performance observations

The image-switch `total` timer ends at the OpenSeadragon open event; it may not
include completion of all visible tiles. Investigate repeatable delays using
both browser Network timing and the appropriate server log. A first cold
Bio-Formats reader initialization may be slower than warm access, but a new or
routine delay, blank image, timeout, `403`, `500` or lost annotation is a stop
condition.

## Rollback

```bash
./ops/wsi-release history
./ops/wsi-release rollback --step
./ops/wsi-release verify production
wsi production logs
```

Review the rollback directory, build, commit and SHA-256. Type `ROLLBACK` only
when correct. Rollback restores the previous JAR, build metadata, checksum and
configuration. It **never restores, replaces or overwrites annotations**. The
failed release is preserved for investigation. Repeat the `8080` browser gate.

## Environment-marker rule

| Configured identity | Required image-root marker |
|---|---|
| `development` | `.wsi-environment-development` |
| `staging` | `.wsi-environment-staging` |
| `production` or rehearsal | `.wsi-environment-production` |

Exactly one marker must exist. A missing, multiple or cross-environment marker
prevents startup before the server accepts requests.

---

## Manual WSI ingestion

Start every ingestion session with the local environment loaded and a safety
status check:

```bash
cd /Users/dm026/Downloads/wsi-server_works
source ops/wsi-ingest.conf
./ops/wsi-ingest status
```

Place one complete top-level dataset directory beneath
`/Users/dm026/wsi-ingest-staging`. The directory is one indivisible batch: it
must contain every `.vsi` file, companion data directory and associated file
intended for that batch. **Never move a single `.vsi` without its companion
data.** Never reuse a promoted dataset directory name; for multiple batches on
one date, use unique names such as `2026-08-05_batch-01` and
`2026-08-05_batch-02`.

### Seal and observe

Confirm manually that the scanner or copy process appears finished, then:

```bash
./ops/wsi-ingest inspect DATASET
./ops/wsi-ingest seal DATASET       # type exactly SEAL
```

Do not modify the directory after sealing. The seal is observation 1. With the
validated defaults, wait at least 60 seconds, run the first observation, wait
at least another 60 seconds, and run the second observation:

```bash
./ops/wsi-ingest observe DATASET
# wait at least another 60 seconds
./ops/wsi-ingest observe DATASET
./ops/wsi-ingest history            # confirm observations 3
```

### Preflight, promote and verify

```bash
./ops/wsi-ingest promote --dry-run DATASET
./ops/wsi-ingest promote --step DATASET  # type exactly PROMOTE
./ops/wsi-ingest history
./ops/wsi-ingest status
```

Before `--step`, confirm the transaction ID, file count, byte count and absent
production destination. Expected completed state is `verified observations 3`
and `sealed_pending_transactions: 0`. In the production viewer, allow live
discovery to complete or use **Refresh images**, then confirm every expected
image appears with the expected channels.

### Ingestion stop conditions

Stop if scanner/copy activity may continue; a `.vsi` companion or associated
file may be missing; the dataset changes after seal; the destination exists;
file count or byte count differs from sealed/dry-run values; roots are missing,
nested, on different filesystems, or have wrong markers; a lock is held or a
transaction is ambiguous; or any command reports `FAIL`.

Never manually copy or merge the sealed batch into production. Never use
`--force` or bypass stability. The command is scanner-independent and therefore
requires manual readiness confirmation. See `docs/WSI-INGESTION.md` for the
complete safety, atomicity and recovery design.

## Safety reminders

- Never copy production slides into development, staging or rehearsal.
- Verify deidentification of filenames, metadata, embedded labels, thumbnails,
  macro images and associated files.
- Never place credentials, PHI, internal addresses or clinical filenames in
  release notes, Git documentation or screenshots.
- Never synthesize a missing embedded label or thumbnail from diagnostic slide
  pixels; report it as absent.
