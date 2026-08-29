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
        List<ImageSeriesProfile> seriesProfiles,
        /**
         * Native pixel size of every viewer-facing pyramid level, indexed by viewer level
         * (0 = lowest resolution, {@code resolutionCount - 1} = full baseline resolution).
         * The viewer must not assume a uniform 2x-per-level downsample -- see
         * {@link PyramidLevelDimensions}.
         */
        List<PyramidLevelDimensions> levelDimensions,
        String modality,
        String engine,
        /** True when the selected series is 8-bit RGB (H&E / IHC), not planar fluorescence. */
        boolean rgb,
        /**
         * Inclusive intensity ceiling for B&C sliders: 255 for 8-bit RGB or 8-bit
         * fluorescence, 65535 for UINT16 fluorescence.
         */
        int intensityMax
) {}
