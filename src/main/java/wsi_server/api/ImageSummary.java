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
        int zLayers
) {
    public ImageSummary {
        clinicalMarker = clinicalMarker == null ? "" : clinicalMarker;
    }
}
