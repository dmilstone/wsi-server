# Enterprise Environment Matrix

**Document:** Single Shared Codebase / Multi-Runtime Environment Profile Architecture  
**Audience:** Hospital Information Security (INFOSEC) evaluation  
**Classification:** Internal — infrastructure and data-handling controls  
**Codebase:** WSI Viewer (one Git repository; distinct runtime profiles)  
**Date:** 2026-09-11

This document describes how one shared application tree is operated as three
isolated runtime tracks. It is an objective control description for institutional
review. It is not a clinical validation report, not a medical-device claim, and
not a SOC 2 attestation.

---

## 1. Purpose and scope

The viewer, operations dashboard, and ingestion toolchain are maintained as a
**single shared codebase**. Separation of duty is enforced by **runtime
profile**, not by forking product logic. Each track binds its own ports, image
roots, annotation store, environment marker, and Git line. A workstation may
run at most one Line 1 or Line 2 listener pair (`8080` / `8084`). Academic
research uses a **port-split** pair (`9090` / `9094`) so it cannot collide with
the primary server when both must exist on the same host.

In-scope:

- Image server (Spring Boot, TLS 1.3, default viewer port `8080` or research `9090`)
- Local operations dashboard (Python, TLS 1.3, default `8084` or research `9094`)
- Manual and unattended WSI ingestion (`ops/wsi-ingest`, `ops/wsi_ingest_daemon.py`)
- Per-workstation annotation and detection documents (`X-WSI-User` / `wsi.workstation.id`)

Out of scope:

- Diagnostic interpretation, report signing, or LIS/EHR integration
- Public-internet exposure of viewer or dashboard endpoints
- Cross-track replication of identified clinical pixels or identifiers

Operators remain responsible for environment separation, de-identification of
non-production images, and applicable privacy requirements. The software is
provided for authorized research and image-server administration. It is not a
substitute for clinical judgment, a validated diagnostic system, or institutional
SOP.

---

## 2. Architectural principle

**Single Shared Codebase / Multi-Runtime Environment Profile**

| Layer | Shared | Isolated per track |
| --- | --- | --- |
| Source | One repository; same viewer, ingest, and dashboard modules | Git line (`main`, `develop`, `research`) and local clone directory |
| Process | Same Maven wrapper / JAR and Python daemons | Listen ports, PID files, refresh URLs |
| Data | Same on-disk formats (WSI containers, annotation JSON) | Image root, ingest staging, annotation directory, environment marker |
| Identity | Same login and workstation header contract | `wsi.workstation.id` documents; no shared “local” annotation bucket across machines |
| Transport | Same TLS 1.3 configuration surface | Certificate material and bind address remain host-local unless INFOSEC approves a LAN CIDR |

Engineering still uses the in-repo promotion stages (`development` `8081`,
`staging` `8082`, `rehearsal` `8083`, `production` `8080`) described in
`ops/README.md` and `ops/RELEASE-CHEATSHEET.md`. Those stages are **how a
candidate is tested**. The three lines below are **where a running instance is
allowed to sit** for hospital INFOSEC.

---

## 3. Three-line operating matrix

| | Line 1 — Pre-Clinical Bridge | Line 2 — Clinical Development | Line 3 — Academic Research Platform |
| --- | --- | --- | --- |
| **Git line** | `main` | `develop` | `research` |
| **Local clone** | Production / on-site server tree | Clinical-development working tree | Split clones: `$WSI_HOME/research-develop` and `$WSI_HOME/research-deploy` |
| **Viewer port** | `8080` | `8080` | `9090` |
| **Operations dashboard** | `8084` | `8084` | `9094` |
| **Concurrency on one host** | Exclusive owner of `8080`/`8084` | Exclusive owner of `8080`/`8084` (never with Line 1) | May coexist with Line 1 or Line 2 because ports differ |
| **Image content** | Real on-site cases, authorized clinical images only | De-identified datasets only | Local folder clones of de-identified research sets |
| **Case designation** | Site SOP; identifiers stay on-site | `IF-712_20260706…` (see §5) | Same `IF-712_20260706…` convention; no identified names |
| **`wsi.environment`** | `production` (no warning banner) | `development` (DEVELOPMENT banner) | `development` (DEVELOPMENT banner) |
| **Root marker** | `.wsi-environment-production` | `.wsi-environment-development` | `.wsi-environment-development` |
| **Launcher** | `ops/wsi production` / installed JAR | `ops/wsi` or Maven on `develop` | `ops/run-research-server.sh` |
| **Ingest refresh URL** | `https://127.0.0.1:8080` | `https://127.0.0.1:8080` | `https://127.0.0.1:9090` |

Line 1 and Line 2 share the primary port pair **by design**. They are not two
services on one machine. They are two **profiles** that occupy the same sockets
so a host cannot accidentally serve identified cases and development cases from
one listener. Line 3 is the only profile that is allowed to share a workstation
with a primary instance.

### 3.1 Line 1 — Pre-Clinical Bridge (`main`, `8080` / `8084`)

On-site runtime for authorized real cases. The frozen validated JAR listens on
`server.port=8080` with `server.ssl.enabled-protocols=TLSv1.3`. The operations
dashboard default is `https://127.0.0.1:8084/`. Image roots carry exactly
`.wsi-environment-production`. Production appearance has no environment warning
banner. Feature work is not performed here.

### 3.2 Line 2 — Clinical Development (`develop`, `8080` / `8084`)

Same sockets as Line 1 so this profile **replaces** Line 1 on a host; it does
not sit beside it. Data must be de-identified before it enters this tree.
Folder and catalog names follow the `IF-712_20260706…` designation. The UI
shows a DEVELOPMENT banner. Copying identified production pixels, MRNs, or
accession strings into this line is a control failure.

### 3.3 Line 3 — Academic Research Platform (`research`, `9090` / `9094`)

Academic work uses the `research` Git line and **two local folder clones**
under `WSI_HOME` (see §4):

| Clone | Role |
| --- | --- |
| `$WSI_HOME/research-develop` | Working tree for research features and experiments |
| `$WSI_HOME/research-deploy` | Isolated runtime tree used to start the research viewer |

`ops/run-research-server.sh` binds the Spring Boot container to `9090` and the
operations socket to `9094`, passing
`-Dspring-boot.run.arguments="--server.port=9090"` so the process cannot steal
Line 1/2 sockets. Image and ingest roots default under the selected clone, not
under the clinical `wsi-slides` tree.

---

## 4. Path profile (`WSI_HOME`)

All portable roots resolve from `WSI_HOME` (`ops/wsi_paths.py`):

1. `WSI_HOME` or `WSIHOME` if set
2. else `%USERPROFILE%\wsi` on Windows or `$HOME/wsi` on POSIX
3. never a hardcoded `/Users/<name>/…` path in shared tooling

| Variable | Line 1 / Line 2 default (when unset) | Line 3 default (when unset) |
| --- | --- | --- |
| `WSI_IMAGE_DIRECTORY` | `$WSI_HOME/wsi-slides` | `$WSI_HOME/<research-develop\|research-deploy>/slides` |
| `WSI_INGEST_STAGING_ROOT` | `$WSI_HOME/wsi-ingest-staging` | `$WSI_HOME/<clone>/ingest-staging` |
| `WSI_INGEST_PRODUCTION_ROOT` | `$WSI_HOME/wsi-slides` | `$WSI_HOME/<clone>/slides` |
| Annotation documents | `${user.home}/.wsi-server/annotations` partitioned by `X-WSI-User` | Same store contract; research clone may override `wsi.annotations.directory` |

Staging must remain outside the image root. Same-volume promotion uses a native
no-replace directory rename (`renameat2` / `renamex_np` / `MoveFileExW`).
Distinct network volume shares fall back to `shutil.move` / `shutil.copy2`.

---

## 5. De-identified case designation (`IF-712_20260706…`)

Non-production tracks (Line 2 and Line 3) name each acquisition directory with
the institutional de-identified designation:

```text
IF-<protocol>_<YYYYMMDD>[_<optional-token>]
```

Canonical example:

```text
IF-712_20260706
IF-712_20260706_A
IF-712_20260706_run2
```

| Field | Rule |
| --- | --- |
| `IF` | Fixed prefix: Institutional File / de-identified case family |
| `712` | Protocol or study number; not a medical-record number |
| `20260706` | UTC calendar date of the de-identified registration or scan batch (`YYYYMMDD`) |
| Optional token | Disambiguates a second run the same day; scanner timestamps may also appear in the WSI filename |

This string is the **tracking standard** for de-identified data. It is what
appears in staging directories, production-root folder names on Line 2/3, ingest
receipts (hashed where the tool already hashes names), and operator notes.

Prohibited in Line 2/3 names, logs, feedback forms, and dashboard fields:

- Patient name, MRN, accession, date of birth, or other direct identifiers
- Identified Line 1 folder names copied verbatim

Line 1 on-site names follow hospital SOP and do not leave the Pre-Clinical
Bridge host.

---

## 6. Transport, identity, and workstation isolation

| Control | Implementation |
| --- | --- |
| Viewer TLS | `server.ssl.enabled=true`, PKCS12 keystore, `server.ssl.enabled-protocols=TLSv1.3` (`application.properties`) |
| Dashboard TLS | `ssl.SSLContext` with `minimum_version = TLSv1.3` (`ops/wsi_ops_dashboard.py`); PEM env files or the same PKCS12 keystore |
| Session | Form login; CSRF on non-loopback routes; 12-hour servlet session |
| Image refresh | `POST /api/images/refresh` is permitted without a session **only** from a loopback peer |
| Dashboard bind | `127.0.0.1` unless `WSI_OPS_DASHBOARD_BIND` is set with `WSI_OPS_DASHBOARD_ALLOW_CIDR` and `WSI_OPS_DASHBOARD_HOSTS` |
| Proxy headers | Ignored (`server.forward-headers-strategy=none`; dashboard checks the TCP peer only) |
| Workstation objects | Browser `wsi.workstation.id` is sent as `X-WSI-User`; annotations and detections are stored per user and image; they do not fall back into a shared public bucket |

A hard refresh is required after identity or cache changes so the workstation
header is re-sent. Custom class catalogs remain in local browser storage
(`wsi.customClasses`) and are therefore already per workstation.

---

## 7. High-severity SOC 2-aligned controls

The following are **engineering controls that map to SOC 2 Trust Services
Criteria**. This section does not assert that the institution, vendor, or
deployment has completed a SOC 2 examination.

### 7.1 Logical access and encryption in transit (CC6)

**TLS 1.3 only on the viewer.** The Spring Boot container enables SSL and sets
`server.ssl.enabled-protocols=TLSv1.3`. Clients that cannot negotiate TLS 1.3
do not receive a weaker fallback from this property.

**TLS 1.3 on the operations socket.** The dashboard builds
`ssl.PROTOCOL_TLS_SERVER` and sets `TLSVersion.TLSv1.3` (with a TLS 1.2 floor
only if the interpreter cannot set 1.3). Password-bearing dashboard cookies are
`Secure` when TLS is active.

**Loopback-first administration.** Dashboard listen default is `127.0.0.1:8084`
(or `9094` on Line 3). Non-loopback bind is opt-in and requires an explicit
CIDR allowlist. Administration endpoints are not to be placed behind a
forwarding reverse proxy.

### 7.2 Injection-resistant process execution (CC6 / CC7)

All operational subprocesses that start the viewer, ingest CLI, integrity
helpers, or dashboard helpers pass an **argument vector** with
`shell=False` (Python default is already false; call sites set it explicitly).
Examples:

- `ops/wsi_service_control.py` — `lsof` / `pgrep` / process start
- `ops/wsi_ingest_daemon.py` — `wsi_ingest.py` seal / observe / promote
- `ops/wsi_ops_dashboard.py` — osascript and child ingest invocations
- `ops/tests/test_wsi_ingest.py` — CLI harness

No `eval` of operator-supplied paths. Dashboard path fields reject unsafe
characters. Child environments strip `WSI_OPS_DASHBOARD_PASSWORD` so ingest
workers do not inherit the operations secret.

### 7.3 Network-volume copy latency stabilizer (CC7)

External scanner shares and SMB/NFS copies often present a complete path while
bytes are still arriving. Touching those files for integrity, OCR, seal, or
promote produces truncated datasets.

`ops/wsi_ingest_daemon.py` implements `is_network_file_stable(file_path,
wait_interval=2)`:

1. Read size.
2. Sleep `WSI_INGEST_NETWORK_STABLE_SECONDS` (default **2 seconds**).
3. Accept only when size is unchanged and strictly greater than zero.

Incoming files are skipped until this check passes. The same two-second default
is documented in `docs/WSI-INGESTION.md` and covered by
`ops/tests/test_wsi_ingest_daemon.py`. This is independent of the longer
seal/observe quiet window (`WSI_INGEST_MIN_QUIET_SECONDS`, intended 120
seconds; three observations by default).

### 7.4 Change and environment integrity (CC8)

- Image roots must carry exactly one `.wsi-environment-*` marker matching
  `wsi.environment` (`ImageRootStartupValidator`).
- Release cycle (`./ops/wsi-release cycle --step`) requires explicit human
  gates (`DEVELOPMENT-PASS`, `STAGING-PASS`, `REHEARSAL-PASS`, `PROMOTE`,
  `PRODUCTION-PASS`). Dry-run does not mutate.
- Ingest promote requires the typed token `PROMOTE`. There is no `--force` or
  `--ignore-stability` bypass.
- Research startup is a distinct script with distinct ports so a `research`
  clone cannot bind `8080` by accident.

---

## 8. Ingestion control surface

| Mechanism | Behavior |
| --- | --- |
| `ops/wsi-ingest.conf` | Untracked local exports; sourced by operators and by `ops/run-research-server.sh` |
| Pause sentinel | `<staging>/.wsi-ingest-control/daemon/pause` — finish nothing new; process stays up |
| Stop sentinel | `<staging>/.wsi-ingest-control/daemon/stop` — exit after the current pass |
| Line 3 launcher | Removes stop/pause before spawn; on console exit writes stop and signals the background daemon |

The unattended daemon never re-implements manifest hashing, locking, or atomic
rename. It invokes `ops/wsi_ingest.py` as a subprocess. Logs hash dataset names
(truncated SHA-256); they do not print raw clinical paths.

---

## 9. Research launcher contract

`ops/run-research-server.sh` is the Line 3 utility. It:

1. Resolves `WSI_HOME` with the same fallbacks as `ops/wsi_paths.py`.
2. Selects `research-develop` or `research-deploy` (`WSI_RESEARCH_PROFILE`).
3. Sources `ops/wsi-ingest.conf` when present (and `ops/.env.local` when
   present), accepting only `WSI_*` and `SERVER_PORT` keys.
4. Forces `SERVER_PORT=9090` and `WSI_DASHBOARD_PORT=9094` (mapped to
   `WSI_OPS_DASHBOARD_LISTEN_PORT` and `WSI_CONTROL_VIEWER_PORT`). Refuses
   `8080`/`8084`. Image roots default to `$WSI_HOME/<clone>/slides` unless
   `WSI_RESEARCH_KEEP_CONF_ROOTS=1`.
5. Clears ingest pause/stop sentinels.
6. Starts `ops/wsi_ingest_daemon.py` as a background job.
7. Starts the viewer with
   `-Dspring-boot.run.arguments="--server.port=9090"` (plus environment and
   image-directory overrides).
8. Installs `EXIT` / `INT` / `TERM` / `HUP` traps so closing the console tab
   stops background daemons.

---

## 10. Operator responsibilities (INFOSEC)

1. Do not run Line 1 and Line 2 on the same host at the same time.
2. Do not point Line 2 or Line 3 image roots at identified Line 1 storage.
3. Use `IF-712_20260706…` for every de-identified case directory.
4. Keep dashboard bind on loopback unless a written CIDR exception exists.
5. Treat TLS material and `WSI_OPS_DASHBOARD_PASSWORD` as secrets; do not commit
   `ops/wsi-ingest.conf` or `ops/.env.local`.
6. After research sessions, confirm ports `9090` and `9094` are closed if the
   console was killed abnormally.
7. Never place PHI in AI Labs notes, feedback forms, or ingest logs.

---

## 11. Code and document index

| Topic | Location |
| --- | --- |
| Viewer TLS 1.3 and port `8080` | `src/main/resources/application.properties` |
| Environment markers | `src/main/java/wsi_server/WsiEnvironment.java`, `ImageRootStartupValidator.java` |
| Workstation annotation key | `AnnotationUserResolver.java` (`X-WSI-User`) |
| Detection persistence | `DetectionObject.java`, `AnnotationCollection.java` |
| `WSI_HOME` | `ops/wsi_paths.py` |
| `is_network_file_stable` | `ops/wsi_ingest_daemon.py` |
| `shell=False` process control | `ops/wsi_service_control.py`, ingest daemon, dashboard |
| Dashboard TLS 1.3 and port `8084` | `ops/wsi_ops_dashboard.py` |
| Research port split | `ops/run-research-server.sh` |
| Ingest operator protocol | `docs/WSI-INGESTION.md` |
| Release stages `8080`–`8083` | `ops/README.md`, `ops/RELEASE-CHEATSHEET.md` |
