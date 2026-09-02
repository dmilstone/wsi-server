# Fabric annotation spike validation

## Scope and dependency review

This page is an isolated, authenticated experiment at `http://<development-host>:8081/fabric-spike.html`. It has no navigation entry in the production viewer, uses only GET requests, and holds its annotations in JavaScript memory. Reloading discards them.

| Component | Exact version | License | Source | Maintenance / compatibility finding | Selection reason |
|---|---:|---|---|---|---|
| OpenSeadragon | 4.1.0 | BSD-3-Clause | https://github.com/openseadragon/openseadragon | The application's existing viewer version. | Keeps the experiment on the production viewport API without changing the normal viewer. |
| Fabric.js | 5.3.0 | MIT | https://github.com/fabricjs/fabric.js | Stable Fabric 5 browser-global distribution; released 2022. | Exact, non-`latest` build with the established Canvas/Object event API needed by the experiment. |
| Fabric OSD Overlay | 1.0.0 (first-party spike module) | application license | `fabric-osd-overlay.js` in this repository | Tested specifically against OSD 4.1.0 and Fabric 5.3.0 by the focused suite. It is deliberately small and isolated, not represented as a reusable maintained upstream package. | Upstream `openseadragon-fabricjs-overlay` 0.2.4 is effectively unmaintained and documents old Fabric/OSD-era APIs; no maintained candidate with verified OSD 4.1.0 compatibility was identified. Copying or silently adapting that source would be less dependable. |

The overlay was implemented from the public OpenSeadragon coordinate APIs rather than copying third-party plugin source. This is a lifecycle feasibility experiment, **not** a migration recommendation. Re-check upstream activity and compatibility before any production proposal.

## Chrome and Safari protocol

Use a real development WSI; synthetic events are not sufficient evidence.

1. Start the development application on port 8081 and authenticate normally. Open `http://localhost:8081/fabric-spike.html` directly. Confirm the yellow **FABRIC ANNOTATION SPIKE — NOT PERSISTED** banner and that the normal viewer has no link to it.
2. In DevTools Network, preserve the log and filter for `annotations`. Complete the protocol and confirm there are no annotation `PUT`, `POST`, `PATCH`, or `DELETE` requests (there should be no annotation requests at all).
3. Pan and zoom. Enter draw mode and drag one rectangle. Confirm one rectangle and one `logical:commit` increment, with no duplicate.
4. Select the rectangle, drag it repeatedly, and watch the counters. `object:moving` must increment continuously, its label must follow continuously, and `object:modified` plus `logical:commit` must each increment exactly once at pointer release. The rectangle must stop at the release location without another click.
5. Immediately click empty space, reselect it, and select another rectangle. Resize using a corner handle. Confirm continuous label attachment and exactly one release commit. Delete the selected rectangle.
6. Set and change a plain-text name. Toggle geometry and names independently.
7. Export JSON, note the image-coordinate geometry, move a rectangle, import the earlier JSON, and confirm the old position is restored with no duplicate IDs and metadata retained.
8. Pan, zoom, resize the window, and enter/leave fullscreen. Confirm geometry/labels remain aligned. Pan gestures must not increment `logical:commit`.
9. Rapidly switch between two images. Confirm each image displays only its own records and no delayed object appears. Switch back to confirm the first image's in-memory records remain.
10. Reload. Confirm every spike annotation disappears.

## Required real-browser pass/fail record

Automated results do not fill this table. A human tester must record observations from actual Chrome and Safari runs before calling the spike successful.

| Gate | Chrome | Safari | Notes |
|---|---|---|---|
| Label follows continuously while moving/resizing | Not run | Not run | |
| Geometry stops at intended released position | Not run | Not run | |
| Exactly one logical commit on release | Not run | Not run | |
| Export/import retains movement and does not duplicate | Not run | Not run | |
| Selection is immediately usable and repeated moves do not stick | Not run | Not run | |
| Pan/zoom/resize/fullscreen alignment remains correct | Not run | Not run | |
| Image switching is isolated, including rapid switches | Not run | Not run | |
| No annotation network writes | Not run | Not run | |
| Reload clears all annotations | Not run | Not run | |

**Success gate:** do not recommend migration unless every row passes in real Chrome and Safari on an actual WSI.

## Drawing lifecycle correction

Chrome validation of the initial implementation found that it called Fabric's public `setActiveObject()` for the newly rebuilt rectangle from inside the same `mouse:up` dispatch that completed the custom preview. Fabric 5.3.0 had not yet finished its pointer transform processing, so the new active object could inherit that completed interaction and remain attached to later pointer movement.

The corrected sequence clears the preview references, disables Draw, removes the preview, calls `discardActiveObject()`, restores OpenSeadragon mouse navigation, and only then creates/rebuilds the canonical rectangle. It deliberately does **not** select the new object. The new rectangle must remain deselected until a later ordinary Fabric click selects it. This uses only public Fabric lifecycle methods and does not synthesize events or inspect Fabric internals.
