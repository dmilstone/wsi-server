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
        boolean thumbnail,
        /**
         * False for Label / Macro / Overview / Thumbnail / Preview series identified by
         * the same authoritative name and thumbnail metadata checks used for associated images.
         * True for actual specimen / diagnostic scans (size is never used to exclude specimens).
         */
        boolean isDiagnosticSpecimen
) {}
