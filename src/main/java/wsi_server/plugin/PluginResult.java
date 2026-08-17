package wsi_server.plugin;

import java.util.List;

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
        List<ObjectColorKey> objects
) {
}
