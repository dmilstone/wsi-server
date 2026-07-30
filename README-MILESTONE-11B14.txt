Milestone 11B.14 — Background-aware automatic fluorescence contrast

What changed
- Replaced the whole-image global-percentile default with background-aware calibration.
- Samples up to 100 tiles distributed across the lowest-resolution slide level.
- Estimates each channel's dominant low-intensity background mode.
- Uses a robust median-absolute-deviation estimate to separate background from signal.
- Computes the white point from the upper 99.9th percentile of signal pixels only.
- Falls back safely for channels with too little detected signal.
- New default gamma: 0.85; default opacity: 0.70.
- "Reset display" restores the cached automatic calibration.
- "Recompute auto" resamples the image and rebuilds automatic windows.
- Browser display-preference version advanced to v3 so older bright defaults do not override this calibration.

Notes
- Manual black, white, gamma, opacity, LUT, and channel visibility controls are unchanged.
- The recompute endpoint is POST /api/images/{imageId}/display/recompute-auto.
- Calibration is display-only and does not modify source pixel data.
