# WSI Viewer Roadmap

## Release operations

The established development-to-production validation is consolidated under
`./ops/wsi-release cycle --step`. Individual `stage`, `rehearse`, `promote`,
`verify`, `status`, `history`, `rollback`, and `tag` commands remain available
for diagnosis and controlled partial reruns.

## Completed viewer features

- Global annotation visibility.
- Persistent user-editable annotation names.
- Optional on-slide annotation name labels.
- Compact, responsive viewer toolbar with separate viewer/export and annotation
  palettes.
- Authenticated in-viewer Help guide with a printable PDF.

## Immediate priorities

1. Annotation save-state reliability and visible Saving/Saved/Failed feedback,
   including protection against leaving while changes remain pending.
2. Safe live discovery of newly added images and directories without restarting
   the server.
3. Improve cold Bio-Formats metadata and embedded label/thumbnail performance.
   Embedded metadata images must never be synthesized from diagnostic pixels.
4. Remove the extra image click required before drawing another annotation.

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
