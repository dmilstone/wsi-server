# WSI Viewer Release Cheat Sheet

**Canonical flow:** Development -> Staging -> Production rehearsal -> Production -> Tag

## Environments

| Environment | Port | Runtime | Identity | Images | Annotations |
|---|---:|---|---|---|---|
| Development | 8081 | Live Maven source | Red development banner | Deidentified development set | Development-only |
| Staging | 8082 | Candidate JAR | Yellow staging banner | Deidentified staging set | Staging-only |
| Rehearsal | 8083 | Exact staging JAR | Production mode, no banner | Deidentified production-marked set | Rehearsal-only |
| Production | 8080 | Frozen validated JAR | Production mode, no banner | Authorized clinical set | Production-only |

Rehearsal binds to `127.0.0.1`; it is not a user-accessible service. Its image
root contains `.wsi-environment-production`, but contains only verified
deidentified slides.

## Normal release

### 1. Development gate

```bash
cd /Users/dm026/Downloads/wsi-server_works
git status --short
./mvnw clean test
node --test src/test/js/*.test.js
git push origin feature/multichannel-viewer
```

Stop if Git is dirty or any test fails.

### 2. Build and install staging

```bash
wsi-release stage --step
wsi-release verify staging
```

Type `STAGE` only after reviewing commit, build, checksum, and backup path.

**Browser gate - 8082:** staging banner; expected deidentified slides; open,
pan, zoom, channels, annotations, exports; no CSRF/403 errors; no production
annotations or images.

### 3. Install exact candidate in production rehearsal

```bash
wsi-release rehearse --step
wsi-release verify rehearsal
```

Type `REHEARSE` after confirming the rehearsal checksum equals staging.

**Browser gate - 8083:** no environment banner; production grid/layout; exact
staging features; deidentified rehearsal slides only; separate annotations;
8080 remains available throughout.

### 4. Promote the exact rehearsed candidate

```bash
wsi-release promote --step
wsi-release verify production
```

Promotion refuses unless Git HEAD, staging, and rehearsal agree. Type `PROMOTE`
only after all preflight checks and the verified rollback backup succeed.

**Browser gate - 8080:** normal production layout; authorized slides; pan,
zoom, channels, annotations, exports; no CSRF/403 errors; 8081/8082/8083 remain
isolated.

### 5. Tag only after production validation

```bash
wsi-release tag production-YYYY-MM-DD-description
```

Type `TAG`, then verify the tag commit matches production `BUILD_COMMIT.txt`.

---

## Status and verification

```bash
wsi production status
wsi staging status
wsi rehearsal status
wsi development status
wsi-release status
wsi-release verify staging
wsi-release verify rehearsal
wsi-release verify production
```

## Logs

```bash
wsi production logs
wsi staging logs
wsi rehearsal logs
wsi development logs
```

Press `Control-C` to stop following a log.

## Troubleshooting modes

```bash
wsi-release stage --dry-run
wsi-release stage --step --verbose
wsi-release rehearse --dry-run
wsi-release promote --dry-run
wsi-release history
```

- `--dry-run`: show the plan without modifying files or services.
- `--step`: pause before each operational action; Enter runs, `p` repeats, `q`
  exits safely.
- `--verbose`: print actions during ordinary execution.
- Never bypass `PROMOTE` or `ROLLBACK` confirmation.

## Stop conditions

Stop immediately if any of these occur:

- Git worktree is not clean.
- Git HEAD differs from staging `BUILD_COMMIT.txt`.
- Recorded and calculated SHA-256 values differ.
- Staging and rehearsal commits or JAR checksums differ.
- Environment marker, configured environment, image root, or port disagrees.
- A server fails to bind its expected port.
- Browser validation reveals layout, security, image, annotation, or export
  regression.

Do not “fix” a mismatch by editing build metadata or checksum files.

## Rollback

```bash
wsi-release history
wsi-release rollback --step
```

Review the rollback build, commit, checksum, and directory. Type `ROLLBACK` only
when correct.

Rollback restores the previous production JAR, build metadata, checksum, and
configuration. It **does not restore, replace, or overwrite annotations**. The
failed release is preserved for investigation.

After rollback:

```bash
wsi-release verify production
wsi production logs
```

Complete the 8080 browser gate again.

## Environment-marker rule

| Configured identity | Required image-root marker |
|---|---|
| `development` | `.wsi-environment-development` |
| `staging` | `.wsi-environment-staging` |
| `production` or rehearsal | `.wsi-environment-production` |

Exactly one marker must exist. A missing, multiple, or cross-environment marker
prevents startup before the server accepts requests.

## Safety reminders

- Never copy production slides into development, staging, or rehearsal.
- Verify deidentification includes filenames, metadata, embedded labels,
  thumbnails, macro images, and associated files.
- Never place credentials, PHI, internal addresses, or clinical filenames in
  release notes or Git documentation.
- Production runs a frozen JAR; source edits do not affect users until explicit
  promotion.
