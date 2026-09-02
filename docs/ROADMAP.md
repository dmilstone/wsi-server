# WSI Viewer Roadmap

This roadmap is the durable planning record for priorities and design decisions
validated through implementation, browser testing, and bounded feasibility
studies. Accepted priorities and completed feasibility results are also recorded
in the associated GitHub issues and pull requests.

## Release operations

The normal monitored development-to-production release is:

```sh
./ops/wsi-release cycle --tag NAME
```

The cycle uses explicit `y`/`n` human gates and stores canonical state so an
interrupted cycle can be resumed. `cycle --step` is an optional
command-by-command diagnostic mode, not the normal release path. Individual
`stage`, `rehearse`, `promote`, `verify`, `status`, `history`, `rollback`, and
`tag` commands remain available for diagnosis, controlled partial reruns, and
recovery.

## Now

### 1. Non-obscuring viewer controls

First make the export and annotation palettes compact and
collapsible/dockable so controls do not obscure the image or annotations. This
panel boundary and palette behavior is the prerequisite for broader layout
work.

### 2. Annotation reliability foundation

The stable baseline remains Annotorious' click-away lifecycle: a moved
annotation is committed when editing is finalized by clicking away. Attempts
to force a commit on pointer release caused geometry, label, selection, or
persistence regressions and must not return without real-browser evidence.

The custom Fabric 5 overlay and maintained Fabric 7 overlay experiments were
failed feasibility spikes. They warn against replacing the editor without
proving its complete lifecycle; they did not resolve annotation persistence.

- Pin exact Annotorious and OpenSeadragon integration versions rather than an
  unversioned `latest` build.
- Add real-browser regression tests for pointer release, click-away commit,
  selection, persistence, image switching, and label synchronization before
  changing save behavior.
- Revisit automatic save-state feedback and the extra click before drawing
  another annotation only after the lifecycle is deterministic.

### 3. Export correctness and operator feedback

- Rename **Entire View** to **Current view** or **Visible region** so the action
  accurately describes the exported area.
- Show proposed export dimensions and the configured 16-million-pixel limit
  before export.
- Surface server export errors instead of failing silently.
- Reject HTML and other unexpected response types rather than saving them with
  a `.png` filename.
- Improve generated export naming.
- Document browser-dependent download and save-location behavior.
- Defer safe downsampled or tiled/streamed whole-slide export; it must not
  bypass the server's memory-safety limit.

### 4. Navigator-thumbnail interaction

Support scroll-wheel zoom through the navigator when it has pointer hover or
keyboard focus, while preserving normal OpenSeadragon behavior and accessible
keyboard/focus interaction.

### 5. Basic Z-stack navigation

Implement the first phase only:

- Display current Z and total Z levels.
- Provide previous/next single-level controls.
- Preserve pan, zoom, channels, and display state while changing levels.
- Define and clearly communicate whether annotations belong to one level or
  the full stack.
- Ensure exports identify and preserve the selected Z level.

## Next

### Responsive and extended-desktop layout

- Improve narrow-screen and mobile layouts without reducing the usable image
  area or hiding essential controls.
- Support movable or dockable panels across the full extended desktop.
- Add user-specific layout preferences after identity and preference storage
  are available.

### Annotation workflow option

After dependency pinning and browser lifecycle coverage, evaluate an explicit
**Done editing** or **Save position** action as the lowest-risk alternative to
changing Annotorious' implicit save behavior.

### User feedback workflow

Plan a user feedback and ticket workflow. No end-user feedback system currently
exists; its identity, privacy, triage, and audit requirements must be designed
before implementation.

## Planned

### Alternate layouts and skins

Only after panel boundaries and palette behavior are stable, design alternate
CSS layouts or skins. Future skins should be selectable at runtime without
losing viewer state, and must preserve usable image area, menus, label
presentation, fonts, colors, and accessibility. Skins are planning work, not an
implemented feature.

### Later Z-stack phases

- Add play/pause and adjustable playback speed.
- Support ping-pong, forward-loop, and reverse-loop modes.
- Add bounded adjacent-level prefetching that stops safely on image switches or
  unavailable levels.

## Longer-term operations

### Scanner-independent ingestion automation

The validated baseline remains manually authorized promotion of one complete
top-level staged dataset directory as an indivisible unit. It is
scanner-independent, journaled, crash-recoverable, idempotent, atomic, and
no-overwrite. The operator must confirm acquisition appears complete before
sealing; stable whole-tree observations reduce risk but cannot establish
semantic completeness. Compound files, companion directories, and associated
files must never be separated.

Today, after a dated directory is promoted, another directory with the same
name cannot be appended or merged. Operators therefore use either one
end-of-day promotion after imaging is complete or uniquely named batches such
as `2026-08-05_batch-01`. Never weaken this fail-closed safety guarantee merely
to make batching more convenient.

A future unattended or minimally attended design should:

- allow scanner or copy output to accumulate in dated acquisition directories
  while monitoring filesystem activity without manual inspection;
- discover independent acquisitions within a dated directory, treating each
  compound file and its companion directory as an indivisible unit;
- establish readiness through stable repeated observations, strengthened when
  available by optional scanner-specific completion-marker adapters;
- quarantine incomplete or ambiguous acquisitions instead of promoting them;
- retain journaled, crash-recoverable, idempotent, atomic, no-overwrite
  promotion;
- allow production to contain dated directories without making the entire day
  one permanently closed promotion unit;
- fail closed on duplicate names and late-arriving acquisitions; and
- keep the core scanner-independent rather than depending on vendor logs, APIs,
  filename conventions, open-file signals, Bio-Formats opening results, or
  completion markers.

This is future design work, not current ingestion behavior.

### Administration and access

- Add HTTPS/TLS before exposing broader user-specific access.
- Add user-specific identity and authorization, annotation ownership, and
  preferences.
- Design broader remote operations and administration for environment health,
  releases, users, and audit information only after authentication,
  authorization, TLS, least-privilege execution, and audit boundaries are
  defined.

The current authenticated operations dashboard is intentionally loopback-only;
it is not a remote administration interface.

## Evidence-triggered performance work

Cold associated-image performance is not an immediate optimization priority.
Diagnosis is complete for one bounded, deidentified VSI fixture: genuine pixel
decode dominated cold label/overview latency. Bio-Formats thumbnail decoding
was slower for the tested fixture and was rejected. This is a negative
feasibility result, not an optimization and not a general conclusion about
other files or formats.

The existing same-process associated-image byte cache is fast when warm, but it
is unbounded and lacks source-change invalidation. Persistent caching or a
different decode approach would require proved resource bounds, source-change
invalidation, concurrency behavior, reader isolation, and unchanged failure
semantics. Real-file NDPI validation remains outstanding. Resume this work only
when measurements or operational impact justify it.

## Completed

### Viewer and access

- Global annotation visibility, persistent user-editable annotation names, and
  optional on-slide name labels.
- Compact responsive toolbar with separate viewer/export and annotation
  palettes (with non-obscuring palette behavior still planned above).
- Authenticated in-viewer Help guide with a printable PDF.
- Red development and yellow staging environment identification.

### Local operations dashboard

- Loopback-only authenticated WSI operations dashboard, kept independent of
  the viewer service.
- Protected HTML and PDF release cheat-sheet access.
- Dashboard-triggered inspect, seal, observe, promotion dry-run, and typed
  `SEAL`/`PROMOTE` operations, validated in real browsers.

### Ingestion and discovery

- Scanner-independent, manually authorized, crash-safe atomic promotion of
  complete staged dataset directories without overwrite.
- Real macOS validation with a 17.4 GB dated batch of four compound VSI
  acquisitions, promoted without file or channel loss.
- Safe live discovery of newly added images and directories without restarting
  the server; the promoted VSI images appeared with their expected channels.

### Release safety

- Explicit `y`/`n` release-cycle gates with resumable canonical state,
  environment fingerprints, requested production tags, and recovery commands.
- Staging, rehearsal, verified backup, promotion, production verification,
  rollback, history, and tagging safeguards remain part of the established
  release workflow.

### Bio-Formats diagnosis

- Diagnostic instrumentation for cold metadata, label, and overview request
  paths.
- Bounded deidentified VSI performance study identifying genuine pixel decode
  as the dominant cold cost.
- Bounded rejection of Bio-Formats thumbnail decoding because it was slower for
  the tested VSI fixture; no optimization claim is made.
