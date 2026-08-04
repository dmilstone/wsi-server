# Development live image discovery validation

This protocol is **development-only**. Use synthetic or explicitly nonclinical
test images. Do not use production slides, restart services, or copy/move data
between environment roots.

## Behavior under test

The server periodically performs a bounded filesystem rescan below the
canonical configured `wsi.image-directory`; it never scans a parent. Runtime
additions are pending until size and modification time are unchanged across two
observations separated by `wsi.discovery.stability-window` (default `10s`). The
list-trigger throttle is `wsi.discovery.refresh-interval` (default `30s`). The
registry publishes a complete immutable snapshot in one atomic replacement, so
tile and metadata readers continue using the prior snapshot during a scan or
after a failed scan.

For this release, removal is intentionally conservative: once published, an
entry remains registered until server restart even if later scans cannot see
it. Pending entries that disappear are discarded. Discovery never deletes or
changes annotation documents.

## Protocol

1. Start the development instance on port `8081`, using only its validated
   development image root.
2. Open the normal viewer and keep an existing image open.
3. Copy a nonclinical test WSI into the development root under a temporary name,
   or copy it slowly so its size continues to grow.
4. Use **Refresh images** and confirm that the incomplete file does not appear.
5. Finish the copy and atomically rename it to a supported suffix if a temporary
   unsupported suffix was used.
6. After the stability window and another refresh observation, confirm the image
   appears without a server restart.
7. Create a new nested directory beneath the development root and add a second
   nonclinical test WSI. (This requires `wsi.scan-recursive=true`.)
8. Confirm the new folder and image appear after stability confirmation.
9. Confirm the originally open image was not reopened and its viewport,
   channels, display settings, selection, and annotations remain unchanged.
10. Confirm no production, staging, or rehearsal roots were read or modified.

Also confirm that status text contains only discovery outcomes and never a
filesystem path, and that automatic checks pause while the tab is hidden.
