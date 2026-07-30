Milestone 11B.9 — Disable click-to-zoom

Changes
-------
- Disabled OpenSeadragon single-click zoom for mouse, touch, and pen.
- Disabled double-click zoom for mouse, touch, and pen.
- Drag-to-pan remains enabled.
- Mouse-wheel, trackpad, pinch, and toolbar zoom controls remain enabled.
- Preserves the corrected relative zoom readout and immediate pixel sampling.

Installation
------------
For the replacement package, copy:
  src/main/resources/static/index.html
into the matching location in the project.

Then hard-refresh the browser.
