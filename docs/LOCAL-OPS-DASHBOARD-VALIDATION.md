# Local WSI operations dashboard validation

## Boundary and design

`ops/wsi_ops_dashboard.py` is independent of the Spring viewer and constructs
its HTTP server with the literal address `127.0.0.1:8084`. There is no listener
configuration. Startup raises an error if that bind cannot be established.
Every request independently requires an IP-loopback peer and an exact
`localhost:8084` or `127.0.0.1:8084` Host header. Proxy forwarding headers are
ignored. CORS is not enabled, and the restrictive CSP permits no script.

Startup requires `WSI_OPS_DASHBOARD_PASSWORD`. Login uses constant-time
comparison. Successful login creates random in-memory session and CSRF values;
sessions expire after 15 minutes. Every mutation is POST-only and must supply
the session CSRF value. Logout deletes the session. The loopback HTTP cookie is
HttpOnly, SameSite=Strict, and path `/`. It cannot safely be marked Secure in
this HTTP-only phase; a remote phase would require HTTPS and Secure cookies.
Session access and audit appends are independently locked for the threaded
server. The audit file and a dashboard-created parent use modes 0600 and 0700.

## Ingestion integration

The dashboard invokes only `python3 ops/wsi_ingest.py` with a fixed list of
known subcommands/options, `shell=False`, captured output, and an explicit
filtered environment. It
validates a selected direct-child directory first; `wsi_ingest.py` validates it
again. Therefore scanner independence, seal/readiness observations, quiet
time, manifest checks, lock, journal, receipt, recovery, collision refusal,
and the native atomic no-replace rename remain in the existing implementation.
There is no background worker, retry, copy/delete fallback, terminal, arbitrary
option, or root override.

Only the bounded `status` and `history` metadata commands have a timeout.
Inspect, seal, observe, dry-run, and promotion are allowed to finish under the
ingester's locking, journal, and recovery rules and are never retried. The
explicit child environment removes `WSI_OPS_DASHBOARD_PASSWORD`.

The authenticated page provides privacy-safe status/history, eligible direct
children, inspect aggregates, typed `SEAL`, observe, promotion dry-run, typed
`PROMOTE`, logout, and links to the existing generated release cheat-sheet
HTML/PDF. Errors provide stop conditions without paths. Audit JSONL contains
only timestamp, action, outcome, and an opaque transaction ID when available.

## Environment configuration (development only)

The authenticated page also exposes two directory-location controls, scoped to
the development environment only; staging, rehearsal, and production are not
yet editable from here. Both controls require the same session and CSRF as
every other action.

- **Ingestion staging root** (`WSI_INGEST_STAGING_ROOT`): a plain CSRF-protected
  save. The new value must already exist as a readable, absolute directory
  path. It is written into `ops/wsi-ingest.conf` (replacing only that one
  `export` line; every other line is preserved) and applied to this
  already-running dashboard process's own environment immediately, so the
  next `inspect`/`seal`/`observe`/`promote` call uses it without restarting the
  dashboard. This does not touch the viewer and is not gated behind a typed
  confirmation: it only changes where the next ingestion command looks, and is
  trivially reversible.
- **Development image directory** (`wsi.image-directory`): requires typing
  `RESTART`, since it stops and restarts a running server. On confirmation,
  the new path is validated the same way, then written into
  `.runtime/config/application.properties` (replacing only that property
  line), then `ops/wsi development stop` followed by `ops/wsi development
  start` are run -- the existing, already-tested control script, never
  reimplemented. `WSI_REPO` is always passed explicitly to that subprocess:
  `ops/wsi`'s own hardcoded fallback default points at a stale sibling
  checkout on this machine, not necessarily the running repository, so relying
  on it here would be fragile. The property write and the restart are
  deliberately two steps: if the path is invalid the file is never touched; if
  the path is valid but the restart itself fails (port busy, stale JAR, etc.)
  the configuration change still stands and the failing command's own output is
  shown, exactly as `ops/wsi development start` already prints it.

The property/shell-export rewrites are line-level and in place: every other
line in either file, including comments and ordering, is left untouched. Both
inputs are rejected outright (before anything is written) if they are not
already an existing, readable, absolute directory, or if they contain a
double quote, backtick, or backslash -- characters that could otherwise break
out of the quoted shell `export KEY="..."` line a later `source
ops/wsi-ingest.conf` would interpret. A dollar sign is rejected too, *unless*
it is immediately followed by `/` or is the last character of the path (see
`valid_directory_path()`/`_dollar_signs_are_safe()`) -- narrowly carved out so
a real SMB share's local mount point, which routinely looks like macOS's own
`/Volumes/SHARE$` (a trailing `$` is an ordinary Windows-style
hidden/administrative-share convention, not an attack), is not wrongly
rejected here the same way it originally was on the network drop root field
below before that regression was caught and fixed. As with every other
mutation, the audit log records only the action name and outcome, never the
configured path itself.

### Known limitation: the installed (launchd) copy cannot recycle development

This script is also deployed as a standalone copy outside the repository (see
"Installed, always-on copy" below), specifically so it is not affected by the
repository's own churn or location. Restarting development inherently needs
read/write access to files *inside* the repository and must `cd` into it to
run Maven -- and the repository lives under `~/Downloads`, which macOS blocks
unattended background agents (no Terminal, no interactive TCC grant) from
reading or writing at all. Confirmed empirically with a throwaway `launchd`
job: `Path.exists()` on a repository file succeeds, but `Path.read_text()` on
that same path raises `PermissionError: Operation not permitted`. No amount of
path indirection works around this -- it is enforced by the OS against that
process's identity, not by anything this script controls.

Practically: the development image-directory control fails cleanly (visible
`400`, not a crash) when used from the installed copy, and only actually
works when this script runs directly from the repository, e.g. via the
"Local startup" section below. The staging-root control is unaffected, since
`WSI_INGEST_STAGING_ROOT` and the datasets it points at live outside
`~/Downloads`.

## Network drop root (live, no restart -- not development-scoped)

Unlike the two controls above, **Network drop root** (`WSI_INGEST_NETWORK_DROP_ROOT`,
see `ops/wsi_ingest_network_drop.py`) is not specific to the development
environment -- it configures the one ingestion daemon's single "network
landing zone" front end, wherever that daemon happens to be pointed. It is
also the only configuration control on this page that takes effect on an
*already-running, separate daemon process* without restarting anything,
which needed a different mechanism than the plain "update this dashboard
process's own environment variable" trick `set_staging_root()` uses:

- Saving writes a small file, `<staging>/.wsi-ingest-control/daemon/network-drop-root.txt`,
  via `network_drop.write_live_override()`. Nothing about the daemon process
  itself is touched.
- The daemon calls `network_drop.poll_and_relocate()` every pass (every
  `WSI_INGEST_DAEMON_POLL_SECONDS`, default 30s) regardless of how it was
  configured at startup, and that function resolves its *effective*
  enabled/root state completely fresh each time via `effective_config()`,
  which checks the override file first. A save made through the dashboard is
  therefore visible to the daemon on its very next pass -- typically well
  under a minute, never requiring a restart, a `kill`, or a new
  `WSI_INGEST_NETWORK_DROP_ROOT` export anywhere.
- Precedence, checked in this order: no override file yet -> the
  `WSI_INGEST_NETWORK_DROP_ROOT` environment variable the daemon started
  with (today's original, still fully supported, behavior); override file
  present with a path -> that path, enabled, regardless of the environment
  variable; override file present but blank -> explicitly disabled,
  regardless of the environment variable. Leaving the dashboard's text field
  blank and saving writes that explicit-disable (blank) form.
- The override file is durable, not tied to whichever process wrote or last
  read it -- it also wins across a full daemon restart, so using this
  dashboard field even once makes it the permanent source of truth going
  forward, until a human edits or deletes that one file directly. There is
  deliberately no separate "revert to environment variable" control.

This field's input validation (`valid_network_drop_path()`) intentionally
differs from `valid_directory_path()`'s: it still requires an existing,
readable, absolute directory, but it does **not** reject `$`, backtick, or
double/single quote characters, because this value is only ever written to
its own plain text file and read back as a `Path` -- never interpolated into
a shell-sourced `export KEY="..."` line the way `WSI_INGEST_STAGING_ROOT` is.
That distinction is not academic: a real SMB share's local mount point on
macOS routinely looks like `/Volumes/SHARE$` (trailing `$` is an ordinary
Windows-style hidden/administrative-share convention, not an attack), and an
earlier version of this field rejected exactly that shape of path outright
before this was noticed and fixed against a real network share.

Validated end-to-end against a real network share on 2026-08-31: a dataset
placed under `smb://Cifs2/DIGPATH_VS200$/renal_path_development/if/target_test/`
(mounted locally at `/Volumes/DIGPATH_VS200$/...`) was discovered, tracked for
stability, copied into local staging, verified byte-for-byte, sealed,
observed, and promoted into production -- and the network original was moved
(not deleted) into `target_test/processed/20260831/...`, preserving its
dated subdirectory. The dashboard field itself was then exercised against
the same real path from the installed `launchd` copy (see below), confirmed
to save, and confirmed to be readable back as "live" (override-file-backed)
rather than merely reflecting the environment variable.

## Browse... dialog: a real folder picker, no typing required

All three directory-location fields above (staging root, network drop root,
development image directory) have a **Browse&hellip;** link next to them.
This exists because copying/pasting a real path by hand is exactly how the
network-drop-root dollar-sign bug above was originally found: it is easy to
introduce a subtle typo, or a URL-style `smb://...` prefix a filesystem path
was never meant to have.

**Browse&hellip; itself (`/browse-native?target=<field>`) pops a real, native
macOS folder-picker window** -- `osascript`'s Standard Additions `choose
folder`, i.e. an actual `NSOpenPanel`, not anything drawn by this page or a
browser. It can go anywhere Finder can (typing an exact path with
Cmd+Shift+G, the favorites sidebar, other mounted volumes), which matters
because the point of this control is choosing a *new* directory, not just
re-confirming whichever one is already configured. Deliberately implemented
via a separate `osascript` process rather than `tkinter` (present in this
Python, and tempting, since it is what one would normally reach for): Cocoa
GUI calls are only safe from a process's own main thread, and this server's
`ThreadingHTTPServer` hands every request to a new worker thread, never the
main one, making `tkinter` a real hang/crash risk here specifically.
`native_choose_folder()` blocks for as long as the human takes to decide --
that is correct, not a bug, and does not stall any other concurrent request,
since only the one worker thread handling that one click waits.

Three outcomes, all handled server-side before anything is saved:

- **Picked** -- hands the chosen absolute path to the exact same
  breadcrumbs-and-Select confirmation screen described below (as if that
  path had been reached by clicking through the list view), so the
  field-appropriate validator on the real `/staging-root`,
  `/network-drop-root`, or `/image-directory` route still has the only
  actual final say, and the image directory's typed-`RESTART` confirmation
  is still asked for right there. Nothing is saved by the native pick alone.
- **Cancelled** -- AppleScript error `-128`; shows a neutral "Selection
  cancelled -- nothing changed" message and does nothing else.
- **Anything else** (`osascript` itself unavailable, or blocked for a reason
  not yet seen in practice) -- shown plainly, with a link to the list-view
  picker below as a fallback, never a dead end.

*Open question, not yet resolved empirically*: whether the native panel's
own directory listing is subject to the same launchd/TCC "cannot enumerate a
mounted network share" restriction documented just below for this server's
own `os.listdir()` calls, or whether `NSOpenPanel` (a system-owned UI
component) gets to enumerate such shares where our own Python code cannot.
If you can browse *into* `/Volumes/DIGPATH_VS200$/...` inside the native
panel itself and it shows real contents, that restriction turns out not to
apply here; if it also comes up empty/blocked inside the native panel, it
does. Worth a firsthand look next time this comes up against a real share.

### List view: the original click-through fallback

Each field's Browse&hellip; link is followed by a small **list view** link
(`/browse?target=<field>&path=<directory>`) to the original, plainer
picker -- useful if the native panel above cannot run for some reason, or if
a same-page, no-popup-window picker is simply preferred. This is also
exactly what the native panel's own confirmation screen reuses once a
directory has been picked, so everything below applies to both.

The list-view dialog itself is plain, script-free, server-rendered HTML,
consistent with the rest of the page (this page has no client-side
JavaScript at all -- the CSP's `script-src 'none'` is deliberate and is not
relaxed for this feature):

- Breadcrumbs across the top link back up to any ancestor directory, down to
  `/`. Clicking a subdirectory's own link lower on the page descends into it
  -- both are ordinary GET navigations, not JavaScript.
- A **Select this directory** button always refers to whichever directory is
  currently displayed, and posts that absolute path straight into the same
  real route (`/staging-root`, `/network-drop-root`, or `/image-directory`)
  the field's own plain text input already posts to -- checked by that
  route's own real validator, with the exact same consequences as typing the
  same path by hand. The dialog is only a friendlier way to arrive at a path;
  it is not a separate, more-trusted input, and it does not skip the
  development image directory's typed-`RESTART` confirmation, which is asked
  for right there on the same Select form for that one field.
- Missing, relative, or no-longer-real `path` query values fall back
  silently: first to that field's own current configured value if that is
  still a real directory, then to `/Volumes`, then to `/` -- so a stale or
  hand-edited link never hard-errors, it just starts somewhere sensible.
- Dotfiles/dot-directories (`.git`, `.wsi-ingest-control`, `.DS_Store`, ...)
  and plain files are hidden from the listing; only real subdirectories (or
  symlinks to one) are shown, since a file is never a valid selection for any
  of these three fields anyway. An unreadable subdirectory is still shown, so
  its existence isn't hidden, but is not a link.
- Reading directory listings while browsing is not itself an audited action
  (consistent with `/` and the cheat-sheet links, which also are not) --
  only an actual Save/Select still writes the same one audit line either
  route already would have.

### Known limitation: the installed (launchd) copy cannot list network-volume contents

Discovered while validating this dialog against the real network share used
above: from the installed, `launchd`-managed copy, browsing into a directory
that is itself inside a mounted SMB share (e.g. anything under
`/Volumes/DIGPATH_VS200$/...`) shows "Could not list this directory's
contents (Operation not permitted)" instead of that directory's real
subdirectories, even though the exact same directory is already known to
exist and be readable (that is how `/browse` got there in the first place).

This is the same class of restriction as the development-recycle "Known
limitation" above -- macOS TCC blocking an unattended `launchd` agent from a
protected location -- but a different, narrower category of it ("Network
Volumes" rather than `~/Downloads`/`~/Desktop`/`~/Documents`), and with a
sharper edge: `Path.is_dir()` and `os.access(path, os.R_OK | os.X_OK)` on a
specific, already-known network path all report success, but actually
enumerating that same directory's children (`Path.iterdir()`/`os.listdir()`)
still raises `PermissionError: [Errno 1] Operation not permitted`. Confirmed
empirically with the same throwaway-`launchd`-job technique used for the
development-recycle limitation:

| Path probed from a throwaway `launchd` agent | `os.listdir()` |
|---|---|
| `/Volumes` (top level -- which shares are mounted) | OK |
| `/Volumes/DIGPATH_VS200$/renal_path_development/if` (inside the share) | `PermissionError: Operation not permitted` |
| `/Users/dm026/wsi-ingest-staging`, `/Users/dm026`, `/tmp` (all local) | OK |

Practically: from the installed copy, Browse&hellip; still works normally for
every local directory (staging root's own tree, home, `/tmp`, etc.) and can
show `/Volumes`'s own top level (which shares are currently mounted), but
cannot descend into a mounted share's contents at all. `list_subdirectories()`
surfaces this as an explicit, honest error (see above) rather than the
directory merely appearing empty. None of this affects the plain text
field on any of the three fields, nor a `path` query value that is already
exactly the directory wanted (breadcrumbs and Select both still work, since
those only ever `stat()`/`access()` an already-known path, never enumerate
one) -- only clicking down into an as-yet-unknown child of a network share is
affected. Running this script directly from the repository ("Local startup"
below) is not affected at all, matching the development-recycle limitation's
own workaround: Terminal.app's own long-since-granted TCC access extends to
its child processes, which an unattended `launchd` agent has no equivalent
of and cannot be given non-interactively.

A real fix exists but is a separate, larger undertaking, not done here:
wrapping the installed copy's launcher in a proper, stably-signed `.app`
bundle (e.g. via `osacompile`), then granting *that* bundle Full Disk Access
once in System Settings -- TCC grants attach to a signed app identity, not to
`/bin/bash` or `/usr/bin/python3` themselves, so neither of those can be
granted this access directly no matter what is toggled on in System Settings.
That bundle's identity/signature must also stay stable across redeploys (a
naive rebuild can silently invalidate the grant), which is real, ongoing
complexity to own -- worth doing only if network-volume browsing from the
installed copy specifically becomes a recurring need, not preemptively.

## Local startup

```bash
set -a
source ops/wsi-ingest.conf
set +a
export WSI_OPS_DASHBOARD_PASSWORD='choose a local password'
./ops/wsi-ops-dashboard
```

Browse locally to `http://127.0.0.1:8084/`. Do not proxy this service or use it
against real roots while validating. It is not part of production startup,
deployment, or release automation.

## Installed, always-on copy

Separately from the manual startup above, this dashboard can also run as a
persistent local service via `launchd` (`~/Library/LaunchAgents/com.wsi.ops-dashboard.plist`,
`RunAtLoad` + `KeepAlive`), from a standalone copy installed at
`~/Library/Application Support/com.wsi.ops-dashboard/`. That copy, not the
repository, is what a browser hitting `127.0.0.1:8084` reaches day to day.

This split is deliberate, not incidental: `launchd` agents run unattended,
with no Terminal and no interactive TCC grant, and macOS blocks that kind of
process from reading or writing anything under `~/Downloads`, `~/Desktop`, or
`~/Documents` at all -- so a repository checked out under `~/Downloads` (as
this one is) cannot be run directly by a `launchd` agent. Installing a copy of
just the files this script needs (`wsi_ops_dashboard.py`, `wsi_ingest.py`, the
release cheat sheets, `.env.local`, a `run.sh` wrapper) to an unprotected
location sidesteps that, and additionally decouples the always-on service from
the repository's own churn (branch switches, deletions, or the repository
simply being renamed or moved, as has already happened once).

The tradeoff is exactly the "known limitation" above: this installed copy has
no access back into the repository, so it cannot be used to recycle
development. It also does not update itself -- there is no automatic sync
between the repository and the installed copy. After changing this script (or
`wsi_ingest.py`, `wsi_ingest_network_drop.py`, or the cheat sheets), redeploy
manually:

```bash
SUPPORT="/Users/dm026/Library/Application Support/com.wsi.ops-dashboard"
cp ops/wsi_ops_dashboard.py ops/wsi_ingest.py ops/wsi_ingest_network_drop.py "$SUPPORT/runtime/"
cp ops/RELEASE-CHEATSHEET.html ops/WSI-Release-Cheat-Sheet.pdf "$SUPPORT/runtime/"
launchctl kickstart -k "gui/$(id -u)/com.wsi.ops-dashboard"
```

`wsi_ops_dashboard.py` loads `wsi_ingest_network_drop.py` dynamically from
its own directory (the same `importlib.util.spec_from_file_location` pattern
`wsi_ingest_daemon.py` already uses for the same reason) specifically so this
works: the installed copy only ever needs its sibling files kept in sync,
never a package-relative import that would not resolve outside the
repository at all.

`launchctl kickstart -k` restarts the running instance immediately rather than
waiting on `KeepAlive` to notice; there is no separate "reload config" step.
`.env.local` at `$SUPPORT/.env.local` is a separate, already-in-sync copy of
the repository's `ops/.env.local` -- confirm the two still agree (`diff
"$SUPPORT/.env.local" ops/.env.local`) rather than overwriting either
automatically, since the installed copy is the one actually in effect if
they ever disagree.

## Automated validation

Run only against temporary test roots:

```bash
python3 -m unittest discover -s ops/tests -p 'test_wsi_ingest*.py'
python3 -m unittest discover -s ops/tests -p 'test_wsi_ops_dashboard*.py'
bash -n ops/wsi-ops-dashboard
./ops/tests/run.sh
node --test src/test/js/*.test.js
./mvnw clean test
git diff --check
```

Automated results do not justify remote access. The local-only manual browser
gate was completed as follows:

| Browser on image-server host | Login/logout | Status and safe candidates | Inspect/seal/observe/dry-run | Typed promotion fixture | Cheat sheets | Result |
|---|---|---|---|---|---|---|
| Chrome | Pass | Pass | Pass | Pass | Pass | **Pass** |
| Safari | Pass | Pass | Pass | Pass | Pass | **Pass** |

Manual browser validation completed on 2026-08-06 using isolated temporary
staging and production roots and two synthetic two-file datasets. Chrome and
Safari both passed login/logout, protected cheat-sheet access, status,
candidate selection, inspection, sealing, repeated observation, dry-run,
typed atomic promotion, verified history, and privacy checks. No real image
root was accessed. Safari uses Option-Tab for full-control keyboard navigation
under its default macOS preference; enabled buttons displayed the expected
focus styling.

Request-level tests separately verified the CSP, cookie attributes, absence of
external resources, and absence of cross-origin access. The dashboard remains
loopback-only; this validation does not approve proxying or remote access.
