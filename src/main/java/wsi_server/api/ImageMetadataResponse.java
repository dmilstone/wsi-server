package wsi_server.api;

public record ImageMetadataResponse(
        String imageId,
        String relativePath,
        int width,
        int height,
        int channels,
        int resolutionCount,
        int tileSize,
        long revision,
        Double micronsPerPixelX,
        Double micronsPerPixelY
) {}
