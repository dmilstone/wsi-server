package wsi_server.plugin;

public record ChannelIntensityStats(
        String name,
        int index,
        double mean,
        double stdDev,
        int maximum,
        int minimum,
        long sampleCount
) {
}
