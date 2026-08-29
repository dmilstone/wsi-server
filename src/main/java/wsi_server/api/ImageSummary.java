package wsi_server.api;

public record ImageSummary(
        String id,
        String name,
        String relativePath,
        String folder,
        /** Pre-saved promote-time clinical marker ({@code if.<epitope>}), or empty. */
        String clinicalMarker,
        int zPlanes,
        int depth,
        int zLayers,
        String modality,
        String engine,
        /**
         * True when server-side OCR has already run for this slide at least once
         * (regardless of whether it found a marker). The sidebar's client-side Tesseract
         * fallback uses this to skip re-scanning a slide whose label genuinely has no
         * readable marker instead of re-running the slow OCR pass on every page load.
         */
        boolean ocrAttempted
) {
    public ImageSummary {
        clinicalMarker = clinicalMarker == null ? "" : clinicalMarker;
        modality = modality == null || modality.isBlank() ? "FLUORESCENCE" : modality;
        engine = engine == null || engine.isBlank() ? "BIOFORMATS" : engine;
    }
}
