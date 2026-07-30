# Milestone 11B.8 — Non-starving pixel sampling

- Removed per-pointer-move cancellation of pixel-value requests.
- Pixel sampling still starts immediately with no timer or debounce.
- Older responses are prevented from overwriting the value for the current pointer position.
- Completed samples remain cached for immediate repeat display.
- Preserves the corrected Home-relative zoom readout from 11B.7.
