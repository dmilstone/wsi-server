# WSI Viewer Roadmap

## Release operations

The established development-to-production validation is consolidated under
`./ops/wsi-release cycle --step`. Individual `stage`, `rehearse`, `promote`,
`verify`, `status`, `history`, `rollback`, and `tag` commands remain
available for diagnosis and controlled partial reruns.

## Completed viewer features

- Global annotation visibility.
- Persistent user-editable annotation names.
- Optional on-slide annotation name labels.
- Compact, responsive viewer toolbar with separate viewer/export and annotation
  palettes.
- Authenticated in-viewer Help guide with a printable PDF.

## Immediate priorities

1. Safe live discovery of newly added images and directories without restarting
   the server.
2. Improve cold Bio-Formats metadata and embedded label/thumbnail performance.
   Embedded metadata images must never be synthesized from diagnostic pixels.
3. Add Z-stack navigation and playback for supported images.

## Annotation editor investigation

The current production behavior is the stable baseline: Annotorious commits a
moved annotation when editing is finalized by clicking away. Attempts to force
a commit directly on pointer release caused geometry, label, selection, or
persistence regressions and must not be restored without real-browser evidence.

- Pin the exact Annotorious and OpenSeadragon integration versions instead of
  loading an unversioned `latest` build.
- Add real-browser tests for pointer release, click-away commit, selection,
  persistence, image switching, and label synchronization.
- Evaluate an explicit **Done editing** or **Save position** action as the
  lowest-risk Annotorious workflow.
- Build an isolated Fabric.js/OpenSeadragon Fabric overlay proof of concept for
  rectangle creation, selection, movement, resizing, deletion, labels, pan/zoom,
  image switching, JSON round trips, and exactly one committed update per edit.
- Consider replacing Annotorious only if that proof of concept passes in Safari
  and Chrome without changing the production annotation data format.
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

## Export follow-ups

- Rename **Entire View** to **Current view** or **Visible region** so the action
  accurately describes the exported area.
- Show the proposed export dimensions and the configured 16-million-pixel limit
  before starting an export.
- Display server export errors to the user instead of failing silently.
- Document browser-dependent download and save-location behavior.
- Later support a safe downsampled or tiled/streamed whole-slide export without
  bypassing the server's memory-safety limit.
- Reject HTML or other unexpected response types instead of saving them with a
  `.png` filename.

## Interface and layout backlog

- Make the development banner red while staging remains yellow.
- Improve narrow-screen and mobile layouts.
- Support movable panels across the full extended desktop.
- Add user-specific layout preferences.

## Administration and access backlog

- Add user-specific credentials, authorization, annotation ownership, and
  preferences.
- Add an administrative dashboard for environment health, releases, users, and
  audit information.
- Add a user feedback and ticket workflow.
