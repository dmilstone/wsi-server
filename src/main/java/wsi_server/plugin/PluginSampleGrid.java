package wsi_server.plugin;

import java.util.List;

/**
 * Downsampled raw intensity planes in image space. Sample column {@code c}
 * maps to image X {@code round((sampleOriginX + c) / scaleX)}.
 */
public record PluginSampleGrid(
        int imageX,
        int imageY,
        int imageWidth,
        int imageHeight,
        int sampleOriginX,
        int sampleOriginY,
        int sampleWidth,
        int sampleHeight,
        double scaleX,
        double scaleY,
        List<String> channelNames,
        int[] channelIndexes,
        int[][] planes
) {
    public int imageXOf(int column) {
        return (int) Math.round((sampleOriginX + column) / scaleX);
    }

    public int imageYOf(int row) {
        return (int) Math.round((sampleOriginY + row) / scaleY);
    }
}
