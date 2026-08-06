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
