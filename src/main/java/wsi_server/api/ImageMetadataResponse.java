package wsi_server.api;

import java.util.List;

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
        Double micronsPerPixelY,
        /** Total focal-plane count for the selected series. Standard 2D images report 1. */
        int zPlanes,
        /** Active Bio-Formats series index used for the top-level dimension fields. */
        int series,
        /** Ordered catalog of every series/sub-image in the container. */
        List<ImageSeriesProfile> seriesProfiles
) {}
