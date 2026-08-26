package wsi_server.plugin;

import java.util.List;

/**
 * {@code segmentationEngine} is a self-describing field (not just documentation)
 * so that any caller of {@code POST /api/plugins/execute} -- including other
 * software that assumes a standard model is behind a given {@code pluginId} --
 * can detect at runtime which engine actually produced {@code nuclei}, rather
 * than relying on out-of-band docs that can silently go stale. Only the StarDist
 * segmentation plugin currently sets it (see {@code StarDistSegmentationPlugin}
 * and {@code StarDistTensorEngine.NATIVE_MODEL_IMPLEMENTED}); every other plugin
 * leaves it {@code null} via the compatibility constructor below.
 */
public record PluginResult(
        String pluginId,
        String title,
        int x,
        int y,
        int width,
        int height,
        int sampledWidth,
        int sampledHeight,
        int nucleusCount,
        long sampleCount,
        List<ChannelIntensityStats> channels,
        List<ObjectColorKey> objects,
        List<NucleusPolygon> nuclei,
        String segmentationEngine
) {
    public PluginResult(
            String pluginId,
            String title,
            int x,
            int y,
            int width,
            int height,
            int sampledWidth,
            int sampledHeight,
            int nucleusCount,
            long sampleCount,
            List<ChannelIntensityStats> channels,
            List<ObjectColorKey> objects
    ) {
        this(pluginId, title, x, y, width, height, sampledWidth, sampledHeight,
                nucleusCount, sampleCount, channels, objects, List.of(), null);
    }

    public PluginResult(
            String pluginId,
            String title,
            int x,
            int y,
            int width,
            int height,
            int sampledWidth,
            int sampledHeight,
            int nucleusCount,
            long sampleCount,
            List<ChannelIntensityStats> channels,
            List<ObjectColorKey> objects,
            List<NucleusPolygon> nuclei
    ) {
        this(pluginId, title, x, y, width, height, sampledWidth, sampledHeight,
                nucleusCount, sampleCount, channels, objects, nuclei, null);
    }
}
