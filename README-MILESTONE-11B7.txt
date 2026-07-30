Milestone 11B.7 — Corrected zoom readout

The status-bar zoom value is now relative to the fitted Home view:

- Home/Fit view = 1.00x
- Twice the Home scale = 2.00x
- Ten times the Home scale = 10.0x

Previously the readout showed OpenSeadragon's image-pixel zoom. For a large
whole-slide image fitted into a browser window, that value can legitimately be
below one (for example 0.07x), but it is not the expected user-facing zoom
convention.

The high-resolution zoom ceiling introduced in Milestone 11B.6 is retained.
No backend, tile, display, or pixel-sampling code was changed.
