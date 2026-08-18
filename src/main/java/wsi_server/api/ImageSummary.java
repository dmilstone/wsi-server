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
        String engine
) {
    public ImageSummary {
        clinicalMarker = clinicalMarker == null ? "" : clinicalMarker;
        modality = modality == null || modality.isBlank() ? "FLUORESCENCE" : modality;
        engine = engine == null || engine.isBlank() ? "BIOFORMATS" : engine;
    }
}
