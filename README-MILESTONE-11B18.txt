Milestone 11B.18 - VSI associated-image discovery fix

The slide label and macro readers now use the same Bio-Formats series layout as the main fluorescence reader:
- flattened resolution series are disabled before setId(...)
- an OME-XML metadata store is installed before opening the file

This is important for Olympus VSI files because flattened pyramid resolutions can otherwise be presented as independent series, shifting or obscuring the true label and macro associated images.

Selection changes:
- Label selection now prefers metadata names containing label, slide label, or barcode, then uses the previous aspect-ratio fallback.
- Macro selection continues to prefer macro/overview/thumbnail/preview names and then the largest non-label associated series.

Diagnostic endpoint:
GET /api/images/{imageId}/associated-images

The endpoint reports every unflattened series with its name, dimensions, channel count, resolution count, RGB/thumbnail flags, and whether it was selected as label or macro. This makes scanner-specific VSI layouts directly inspectable without changing viewer behavior.
