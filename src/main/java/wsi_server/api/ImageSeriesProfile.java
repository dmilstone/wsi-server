package wsi_server.api;

/**
 * One Bio-Formats series (sub-image) inside a multi-series container such as Olympus .vsi.
 */
public record ImageSeriesProfile(
        int index,
        String name,
        int width,
        int height,
        int channels,
        int zPlanes,
        int resolutionCount,
        boolean rgb,
        boolean thumbnail
) {}
