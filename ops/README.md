# WSI operations commands

This directory contains the version-controlled process and release commands for
the WSI viewer.

## Commands

`wsi` controls a running environment:

```bash
wsi production status
wsi staging start
wsi development logs
```

`wsi-release` manages immutable artifacts:

```bash
wsi-release status
wsi-release verify staging
wsi-release stage
wsi-release promote
wsi-release verify production
wsi-release tag production-YYYY-MM-DD-description
wsi-release history
wsi-release rollback
```

Production is never automatically advanced from source to deployment. The
required workflow remains:

1. `wsi-release stage`
2. Manual staging browser validation
3. `wsi-release promote`
4. Manual production browser validation
5. `wsi-release tag TAG_NAME`

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
wsi-release promote --step
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
WSI_PRODUCTION_ROOT
WSI_DEVELOPMENT_ROOT
WSI_PRODUCTION_ANNOTATIONS
WSI_CONTROL
WSI_JAR_NAME
WSI_RELEASE_AUDIT_LOG
```

Credentials are not stored in these scripts.
