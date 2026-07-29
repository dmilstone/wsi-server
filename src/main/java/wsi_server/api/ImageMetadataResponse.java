package wsi_server.api;

public record ImageMetadataResponse(
        String id,
        String name,
        int width,
        int height,
        int channels,
        int resolutionCount,
        int tileSize,
        long revision
) {
}
