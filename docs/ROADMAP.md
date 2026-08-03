# WSI Viewer Roadmap

## Release operations

The established development-to-production validation is consolidated under
`./ops/wsi-release cycle --step`. Individual `stage`, `rehearse`, `promote`,
`verify`, `status`, `history`, `rollback`, and `tag` commands remain available
for diagnosis and controlled partial reruns.

## Immediate priorities

Completed: global annotation visibility and persistent user-editable annotation
names.

1. On-slide annotation name labels.

## Agreed backlog

- Make the development banner red while staging remains yellow.
- Improve cold Bio-Formats metadata and embedded label/thumbnail performance.
- Safely discover newly added images and directories while the server is live.
- Remove the extra image click required before drawing another annotation.
- Support movable panels across extended displays.
- Add user-specific layout preferences.
- Add a user feedback and ticket workflow.
