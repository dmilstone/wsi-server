# WSI Viewer Roadmap

## Current production state

Production release **`production-2026-08-09-compact-viewer-toolbar`** at commit
`c7b26921e0234e550d1bf194c1bb4c6a7fc1a4a1` was validated
Development → Staging → Production Rehearsal → Production and tagged.

| Environment | Port | Notes |
|---|---:|---|
| Development | 8081 | Live Maven source; red banner; deidentified data |
| Staging | 8082 | Candidate JAR; yellow banner; deidentified data |
| Production Rehearsal | 8083 | Exact staging JAR; production mode; loopback only |
| Production | 8080 | Frozen validated JAR; authorized clinical data |

Isolation rules, annotation-directory isolation, environment markers,
production-data protections, human QC gates, and explicit promotion controls
remain mandatory. The release cycle operates on the configured feature branch
(`WSI_CYCLE_BRANCH`; default historically `feature/multichannel-viewer`).
Existing ops docs do not prescribe a merge-to-main step; do not invent one.

Operational commands and gates: `ops/RELEASE-CHEATSHEET.md` and `ops/README.md`.

## Release operations

The established development-to-production validation is consolidated under
`./ops/wsi-release cycle --step`. Individual `stage`, `rehearse`, `promote`,
`verify`, `status`, `history`, `rollback`, and `tag` commands remain
available for diagnosis and controlled partial reruns.

Changing HEAD after a cycle has begun invalidates the cycle's recorded
repository fingerprint. That is intentional: do not force/resume a cycle whose
HEAD changed as though it were the same candidate. Correct on the feature
branch, review/test/commit, and start a **fresh** release cycle.

## Completed features and operations

- Global annotation visibility.
- Persistent user-editable annotation names.
- Optional on-slide annotation name labels.
- Compact, responsive viewer toolbar with separate viewer/export and annotation
  palettes.
- Authenticated in-viewer Help guide with a printable PDF.
- Safe live discovery of newly added images and directories without restarting
  the server.
- Scanner-independent, manually authorized, crash-safe atomic promotion of
  complete staged WSI dataset directories into production.
- Resumable release operations that preserve environment fingerprints and
  requested production tags across interrupted human gates.
- First Cursor-managed production release of the compact viewer toolbar
  (`production-2026-08-09-compact-viewer-toolbar`).

## Priority classification

### Immediate bugs

1. **Annotation-name label independent drag** — When an annotation is
   selected, dragging the on-slide name label can move the label independently
   of annotation geometry. Visual only (not persisted); image switch/reload
   restores alignment; dragging the annotation itself moves both correctly and
   persists. Desired: label not independently draggable; click/drag should
   start inline name edit or participate in selection/movement; never create a
   separately movable label; preserve movement/persistence; add focused
   regression tests; do not change storage/API unnecessarily.

### Near-term usability / workflow

1. Systematic UI inventory → proposed specification → human approval → bounded
   implementation (toolbar first; see below). No speculative redesign.
2. Header cleanup after inventory/approval (see Header guidance below).
3. More prominent uppercase terminal banners for the four browser-QC `y`/`n`
   prompts (ops UX only; do not weaken or automate gates). See
   `ops/RELEASE-CHEATSHEET.md`.
4. Consider repository-level `./ops/wsi-review` and `./ops/wsi-commit` so
   review/commit does not depend on one user's `~/.zshrc`. Documented locally
   today; **do not implement those scripts until scheduled**.

### Existing immediate product priorities (unchanged)

1. Improve cold Bio-Formats metadata and embedded label/thumbnail performance.
   Embedded metadata images must never be synthesized from diagnostic pixels.
2. Add Z-stack navigation and playback for supported images.

### Export scalability

Preserve the configured **`wsi.export.max-pixels`** default of **16,000,000**.
`ExportValidator` rejects oversize source/scaled output with
`EXPORT_TOO_LARGE` and an actionable user-facing warning. Successful smaller
native-resolution exports remain unchanged. Do **not** naively raise or remove
the limit without understanding memory, Bio-Formats, encoding, and concurrency.

1. **Reduced-resolution fallback** — When `scale=1.0` would exceed the limit,
   offer lower-resolution export (existing scale capability; useful choices
   such as 50%, 25%, or calculated maximum-safe scale) with clear
   native vs reduced-resolution choice.
2. **Export size information** — Show requested dimensions, megapixels, scale,
   configured limit, and maximum safe scale where calculable (before export
   and/or in the oversized response).
3. **Large native tiled/streaming export** — Incremental read/render/encode
   without one enormous in-memory `BufferedImage`; reuse Bio-Formats pipeline;
   preserve display/compositing semantics; design for memory and concurrency.
4. **Background export jobs** — Chunked server-side work, temp files on disk,
   later download, safe cleanup; especially relevant for eventual NAS
   deployment.

Also retain earlier export polish still unfinished: rename **Entire View** to
**Current view** / **Visible region**; surface server export errors (partially
addressed by `EXPORT_TOO_LARGE` UX); document browser download/save-location
behavior; reject unexpected HTML (or other) responses instead of saving them as
`.png`.

### Infrastructure / deployment

- Preserve Development / Staging / Rehearsal / Production architecture and
  markers.
- Retain NAS/deployment and HTTPS/TLS planning already listed under
  administration backlog.
- Retain scanner-agnostic ingestion atomicity constraints.

### Longer-term UI cleanup

After toolbar inventory/approval and any approved bounded toolbar work:

- Left panel, right panel, status/footer/auxiliary chrome, Presentation-mode
  clean-view behavior, and responsive narrowing — same
  inventory → proposal → approval process.
- Local ops stays outside the primary viewer toolbar.
- Existing layout backlog (red development banner vs yellow staging,
  narrow-screen layouts, movable panels, user layout preferences) remains.

## Deferred systematic UI / UX review

**Process (mandatory):** read-only inventory → proposed specification → human
approval → bounded implementation → automated tests → 8081 Development QC.
Do not change UI code until the inventory and exact proposed control list are
approved.

### Top toolbar (inventory first)

READ-ONLY inventory every control: icon → implementation/function → user value
→ tooltip → accessibility label → active/disabled behavior → position. Then
propose an exact final left-to-right list for approval **before** code changes.

Decisions already made (guidance for the future proposal; not implementation):

| Topic | Guidance |
|---|---|
| Home | Inspect vs Fit; if retained, leftmost |
| Open / Show image browser | Remove; keep a single image-browser toggle |
| Fit vs Home | Inspect; if equivalent keep only Home; if different keep both together with clear names |
| Pan | Remove unless essential beyond OSD drag |
| Select | Remove unless essential mode transition |
| Hide tools | Remove (does not reclaim viewer space) |
| Presentation | Retain; later define clean-view (hide lower-right overview, etc.); Escape exits |
| Visible-region export | Retain |
| Selected-annotation export | Retain (annotation-name filenames) |
| Annotation visibility / names | Retain; systematic icon/terms/tooltip/state/position review |
| Settings | Retain near far right; unless better grouping, immediately precede Help |
| Help | Final / rightmost |
| Other | Remove nonfunctional / placeholder / redundant controls |

Ordering principle for the **proposal** (do not implement blindly):
Home/nav → zoom/view → annotation → visibility → export → utilities →
Settings → Help.

### Header (after inventory/approval)

- Remove “Whole-slide fluorescence imaging”.
- Put current-image info under “WSI Viewer”.
- Show **CURRENT IMAGE** then the filename; no horizontal competition with the
  title; no overlap with the toolbar.

### Left panel / right panel / status-footer / responsive

Same inventory → proposal → approval process. Desktop/laptop remains primary;
narrower widths must not obscure the slide.

## Annotation editor investigation

The current production behavior is the stable baseline: Annotorious commits a
moved annotation when editing is finalized by clicking away. Attempts to force
a commit directly on pointer release caused geometry, label, selection, or
persistence regressions and must not be restored without real-browser evidence.

The custom Fabric 5 overlay and maintained Fabric 7 overlay experiments were
failed feasibility spikes. Annotation-editor replacement is deferred; the
stable Annotorious click-away lifecycle remains unchanged.

- Pin the exact Annotorious and OpenSeadragon integration versions instead of
  loading an unversioned `latest` build.
- Add real-browser tests for pointer release, click-away commit, selection,
  persistence, image switching, and label synchronization.
- Evaluate an explicit **Done editing** or **Save position** action as the
  lowest-risk Annotorious workflow.
- Revisit automatic save-state feedback and the extra click before drawing
  another annotation only after the editor lifecycle is deterministic.

## Z-stack navigation and playback

- Show the current Z level and total number of levels.
- Provide previous/next single-level controls.
- Provide play/pause and adjustable playback speed.
- Support ping-pong playback: top to bottom to top.
- Support forward looping: top to bottom, then restart at the top.
- Support reverse looping: bottom to top, then restart at the bottom.
- Preserve pan, zoom, channels, and display settings while changing levels.
- Use bounded adjacent-level prefetching and stop safely on image switches or
  unavailable levels.
- Decide and clearly communicate whether annotations apply to one Z level or
  the complete stack.
- Ensure exports identify and preserve the selected Z level.

## WSI ingestion operations

The scanner-agnostic ingestion workflow has passed real macOS validation with a
17.4 GB dated batch containing four compound VSI acquisitions. The complete
batch was atomically promoted without overwrite, file loss, channel loss, or a
viewer restart. Production live discovery subsequently exposed all four images
with their expected channels.

A top-level dataset directory is an indivisible promotion unit. After a dated
directory is promoted, another directory with the same name cannot be appended
or merged into it. Routine acquisition must therefore use either:

- one end-of-day promotion after imaging for that date is complete; or
- uniquely named batches such as `2026-08-05_batch-01`.

This constraint preserves atomic no-overwrite behavior. A future ingestion
design may support a different batching model, but it must not weaken that
safety guarantee.

## Administration and access backlog

- Add HTTPS/TLS before broader user-specific credentials.
- Add user-specific credentials, authorization, annotation ownership, and
  preferences.
- Add an administrative dashboard for environment health, releases, users, and
  audit information.
- Add a user feedback and ticket workflow.

## Optional acquisition readiness enhancements

- Consider optional scanner-generated acquisition-complete marker adapters only
  as workflow strengthening. The core staged ingestion command must remain
  scanner-independent.

## Cursor development / release workflow

Canonical command details for `wsi-review` / `wsi-commit` live in
`ops/RELEASE-CHEATSHEET.md`. Continuity summary:

```text
Cursor bounded task
  → human scope review
  → wsi-review
  → wsi-commit "message"
  → fresh release cycle
  → Development QC → Staging QC → Production Rehearsal QC
  → explicit PROMOTE → Production QC → production tag
```

- Bounded tasks; human QC mandatory at established gates.
- Failed QC: answer `n`, stop the candidate, fix on the feature branch,
  review/test/commit, start a **fresh** cycle from the new HEAD.
- Do not advance a candidate that failed human QC.

### Context efficiency

Project configuration:

- `.cursorignore` — excludes build outputs, runtime state, secrets, WSI
  binaries, and similar noise from Cursor indexing.
- `.cursor/rules/context-efficiency.mdc` — always-applied agent guidance for
  narrow context and edits.

Agents should start from the smallest relevant context; prefer named files,
symbols, failing tests, or immediate dependencies; expand only for a concrete
need; prefer targeted searches; avoid attaching whole folders for bounded
tasks; make the smallest coherent edit; avoid unrelated cleanup; explain
material scope expansion; use focused tests during implementation; still run
the full review gate before commit; never weaken release safety or required
dependency inspection for “efficiency.”

Recommended human usage: prefer `@code` / a specific symbol when known,
otherwise `@file`; avoid broad folder attaches; use inline/local edits for
genuinely small isolated changes; start bounded tasks with explicit scope and
stop conditions; do not ask Cursor to rediscover the whole project for a
narrow fix. Context efficiency is an optimization, not a guaranteed
token/credit savings claim, and not permission to skip architecture,
dependencies, tests, security, or release controls.

Documentation organization plan: `docs/README-IA-PLAN.md` (future root README
PR; ROADMAP remains the priority record; ops docs remain authoritative for
commands).

## Lessons from the first Cursor-managed production release

- Cursor implements bounded changes effectively when scope and stop conditions
  are explicit.
- Automated tests are necessary but do not replace visual/human QC.
- Development QC caught multiple UI/ergonomic issues before staging.
- Staging/Rehearsal caught export behavior that was not obvious from unit tests.
- Release fingerprint protection correctly blocked resume after HEAD changed.
- Ops tests initially coupled to the historic `feature/multichannel-viewer`
  branch name; that harness coupling was corrected.
- Environment isolation and explicit promotion gates remained essential.
- UI work benefits from inventory/specification before implementation.
- Cursor context should be deliberately constrained for bounded tasks without
  sacrificing required dependency and safety inspection.
