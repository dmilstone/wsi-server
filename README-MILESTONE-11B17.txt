Milestone 11B.17 - Whole-slide macro overview

The overview overlay now uses the scanner-provided macro/overview associated image rather than a downsampled image from the high-resolution fluorescence pyramid.

Behavior:
- Prefer associated-series names containing macro, overview, thumbnail, or preview.
- Exclude series identified as label or barcode.
- If names are unavailable, choose the largest non-label associated series before the fluorescence series.
- Never fall back to the fluorescence pyramid. If no associated macro image exists, the overlay reports that it is unavailable.
- The slide label remains independently displayed.

Existing endpoint compatibility is preserved: /api/images/{imageId}/thumbnail.png now returns the scanner macro overview.
