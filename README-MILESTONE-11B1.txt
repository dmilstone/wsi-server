Milestone 11B.1 panel visibility fix

Replace:
  src/main/resources/static/index.html

Changes:
- Moves the pan/zoom hint to the lower-right of the viewer.
- Adds visible "Show images" and "Show channels" edge tabs whenever a side panel is collapsed.
- Keeps the header panel buttons synchronized with the current panel state.
- Preserves existing backend and rendering behavior.
