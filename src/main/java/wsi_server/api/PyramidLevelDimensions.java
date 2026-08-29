package wsi_server.api;

/**
 * Native pixel size of one viewer-facing pyramid level (see
 * {@code BioFormatsTileService.bioResolution}, which maps a viewer level to the
 * underlying Bio-Formats resolution index actually read for it).
 *
 * <p>Whole-slide formats routinely downsample by an arbitrary factor per level
 * (Aperio SVS commonly uses 4x, not the 2x OpenSeadragon's tile sources assume by
 * default), so the viewer cannot infer a level's true pixel dimensions from
 * {@code width}/{@code height}/{@code resolutionCount} alone -- it needs the real
 * per-level size to build a correct tile grid and stop requesting tiles for pixel
 * regions that don't exist at that resolution.
 */
public record PyramidLevelDimensions(int level, int width, int height) {}
