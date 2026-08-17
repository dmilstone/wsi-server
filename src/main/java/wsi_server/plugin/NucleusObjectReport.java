package wsi_server.plugin;

import java.util.List;

/**
 * Per-nucleus intensity report used for local file export. Not serialized to the
 * viewer; overlay coloring still uses {@link ObjectColorKey} only.
 */
record NucleusObjectReport(
        int objectId,
        double x,
        double y,
        double radius,
        List<ChannelIntensityStats> channels,
        double key
) {
}
