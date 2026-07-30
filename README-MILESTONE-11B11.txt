Milestone 11B.11 — Fixed-width pixel value display

Changes
- Keeps the full Pixel status region at a fixed 48-character width.
- Renders each channel in an independent fixed-width 10-character cell.
- Uses tabular numerals so changing digit values do not shift the display.
- Preserves block-cached pixel sampling, corrected zoom display, and disabled click-to-zoom.

Files changed
- src/main/resources/static/index.html
