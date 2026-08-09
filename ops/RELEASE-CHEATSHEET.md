# WSI Viewer Release Cheat Sheet

**Canonical flow:** Development -> Staging -> Production rehearsal -> Production -> Tag

Current production tag (post `production-2026-08-09-compact-viewer-toolbar`):
see `docs/ROADMAP.md` for commit and continuity priorities. Release cycles run
on the configured feature branch; ops docs do not prescribe merge-to-main.

## Environments

| Environment | Port | Runtime and identity | Data boundary |
|---|---:|---|---|
| Development | 8081 | Live Maven source; red banner | Deidentified development images and annotations |
| Staging | 8082 | Candidate JAR; yellow banner | Deidentified staging images and annotations |
| Rehearsal | 8083 | Exact staging JAR; production mode; loopback only | Deidentified production-marked images; rehearsal annotations |
| Production | 8080 | Frozen validated JAR; no banner | Authorized clinical images and production annotations |

Rehearsal binds to `127.0.0.1` and is not user accessible. Production source
edits do not affect users until an explicitly rehearsed artifact is promoted.

## Cursor development → release workflow

### After a Cursor task

Cursor finishing a task does **not** start a release cycle. Choose the path
from the change set:

**Application/runtime change**

```text
Cursor → wsi-review → wsi-commit → fresh release cycle
  → Development 8081 QC → Staging 8082 QC → Rehearsal 8083 QC
  → explicit PROMOTE → Production 8080 QC → production tag
```

`wsi-review` / `wsi-commit` do **not** deploy anything. Start
`./ops/wsi-release cycle` deliberately for application/runtime candidates.
The cycle automates mechanical validation/deployment steps but intentionally
stops at each human browser-QC gate; human `y`/`n` approval is never automatic.

**Documentation/developer-tooling-only change**

```text
Cursor → ./ops/wsi-doc-review → commit → push → done
```

Do **not** run Development/Staging/Rehearsal/Production merely for
documentation-only changes that cannot affect the running application.

If a tooling/configuration change can affect build, deployment, security,
runtime behavior, or release semantics, treat it as a code/runtime change
rather than assuming the docs-only path.

Bounded Cursor tasks only. Failed QC: enter `n`, stop safely, fix on the
feature branch, review/test/commit, start a **fresh** cycle from the new HEAD.
Changing HEAD after a cycle begins invalidates the recorded repository
fingerprint; do not force-resume that cycle as the same candidate.

### Local helpers: `wsi-review` / `wsi-commit` / `./ops/wsi-doc-review`

**When to use which review gate** (see paths above for whether a release
cycle follows)

| Change set | Review command |
|---|---|
| Application / Java / JavaScript / Maven / release semantics | `wsi-review` (full gate) |
| Documentation and workflow-configuration only | `./ops/wsi-doc-review` |

Use **`wsi-review`** for code and application changes. Use
**`./ops/wsi-doc-review`** when the working tree is documentation-only (for
example `docs/**`, Markdown, `.cursorignore`, `.cursor/rules/*.mdc`, ops
cheatsheets / README, and the doc-review helper or its tests). It refuses
`src/main/**`, `src/test/**`, `pom.xml` / `.mvn/` / `mvnw*`, and
`ops/wsi-release` / `ops/wsi-release-cycle.sh` changes. It does **not** run
Maven, JavaScript, or application suites.

`wsi-review` and `wsi-commit` are the developer's local zsh helpers (not yet
in `./ops`). `./ops/wsi-doc-review` is repository-level.

**`wsi-review`** (failure stops the chain):

```bash
git status &&
git diff --stat &&
git diff --check &&
./mvnw clean test &&
node --test src/test/js/*.test.js &&
./ops/tests/run.sh
```

**`./ops/wsi-doc-review`** (documentation-only; failure stops the chain):

```bash
./ops/wsi-doc-review
```

Runs `git status`, `git diff --stat`, `git diff --check`, path allowlisting
for docs/workflow-configuration changes, and lightweight Markdown sanity
checks. Prints `DOC REVIEW PASSED` on success.

**`wsi-commit`**: requires a message; runs the full `wsi-review` gate first;
stops on failure; refuses empty commits; stages with `git add -u` so
**untracked files are not auto-committed**; runs `git diff --cached --check`;
shows staged diff stat; commits only after checks pass; ends with `git status`.

If Cursor creates an intentional new file: inspect it, then stage that path
explicitly before `wsi-commit`. Do not weaken untracked-file safety by staging
everything automatically.

**Future (roadmap only):** consider `./ops/wsi-review` and `./ops/wsi-commit`
so other developers are not tied to one `~/.zshrc`. Not implemented yet.

### Browser QC gate display

Each human browser-QC gate prints a prominent banner with the environment name
and exact validation URL immediately before the checklist and `y`/`n` approval.
Do not weaken/bypass/automate `y`/`n`.

```text
============================================================
DEVELOPMENT BROWSER QC
VALIDATE: http://localhost:8081
============================================================
[existing QC checklist]

APPROVE DEVELOPMENT BROWSER QC?
Enter y to proceed or n to stop safely:
```

Equivalent banners:
- Staging → `http://localhost:8082`
- Rehearsal → `http://localhost:8083`
- Production → `http://localhost:8080`

### Production release tag prompt

After successful Production QC, when no tag was supplied via `--tag` or resume
state, the cycle shows the previous production tag and a suggested next tag
(`production-YYYY-MM-DD-description`, derived from commits since the previous
production tag when practical). Interaction:

```text
============================================================
PRODUCTION RELEASE TAG
============================================================
Previous tag: production-2026-08-09-compact-viewer-toolbar
Suggested:    production-2026-08-09-annotation-label-drag-fix

Press Enter to accept the suggested tag,
type another tag name to override,
or type SKIP to publish no tag:
```

Blank Enter accepts the displayed suggestion **only** at this tag-name prompt.
`SKIP` publishes no tag. Any selected tag still requires the existing explicit
publish confirmation (`y`/`n`). Passing Production QC never implies a tag will
be published. Tag conflicts are rejected safely; rollback behavior is unchanged.

## Normal monitored release

```bash
./ops/wsi-release cycle --tag NAME  # normal monitored release
./ops/wsi-release cycle --dry-run
./ops/wsi-release cycle --resume
```

One initial command runs repository/environment preflight, all development
tests, candidate publication, staging, exact-artifact rehearsal, promotion
preflight, verified production backup/promotion, and optional tagging. It pauses
for explicit `y`/`n` gates at development, staging, rehearsal, promotion,
production QC, and tag publication. Blank or invalid answers repeat the same
question; Return alone never advances those gates. At the optional tag-name
prompt only, blank Enter accepts the displayed suggestion. Browser success is
never inferred. State is `.runtime/run/release-cycle.state`; detailed non-sensitive
logs are `.runtime/log/cycle-*.log`.

Human gates shown by the cycle include `Development browser QC: y/n`,
`Staging browser QC: y/n`, `Rehearsal browser QC: y/n`, promotion `y/n`,
`Production browser QC: y/n`, and saved-tag publication `y/n`.

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

During `./ops/wsi-release cycle`, after Production QC, accept the suggested
`production-YYYY-MM-DD-description` tag with Enter, type an override, or `SKIP`.
Publish still requires an explicit `y`. Or tag later:

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
./ops/wsi-release cycle --step
./ops/wsi-release cycle --resume --step
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
