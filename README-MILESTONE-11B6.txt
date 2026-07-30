Milestone 11B.6 — Extended zoom and stable status readouts

Changes
- Increased OpenSeadragon maxZoomPixelRatio from 2 to 80.
- Zoom can now continue to approximately 80 image pixels per screen pixel.
- Assigned fixed widths to Zoom, Image X, Image Y, and Pixel readouts.
- Enabled tabular numerals so changing digits do not shift adjacent fields.
- Long multi-channel pixel readouts remain within a fixed field and use ellipsis if necessary.

No backend/API/rendering changes were made in this milestone.

Validation
- Embedded JavaScript passed node --check.
