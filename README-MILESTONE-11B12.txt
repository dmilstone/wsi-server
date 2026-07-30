Milestone 11B.12 — Metadata-calibrated scale bar

Changes:
- Initializes Bio-Formats with an OME-XML metadata store.
- Reads PhysicalSizeX and PhysicalSizeY and converts them to micrometres.
- Adds micronsPerPixelX/Y to the image metadata response.
- Adds a lower-left scale bar that updates continuously with zoom.
- Uses readable 1–2–5 scale lengths and switches between µm and mm.
- Shows pixel calibration in the image information panel.
- Hides the scale bar and reports “Not calibrated” when physical pixel size is unavailable.

Validation:
- Embedded JavaScript passed node --check.
- ZIP archives passed unzip -t.
- Maven could not be run in the packaging environment because the wrapper dependency could not be downloaded.
