package wsi_server.plugin;

import org.springframework.stereotype.Component;
import wsi_server.BioFormatsTileService;

import java.util.ArrayList;
import java.util.List;

/**
 * Proof-of-principle plugin: raw intensity statistics (mean, stdev, min, max)
 * over the requested spatial footprint, optionally masked to nuclear circles.
 */
@Component
public class QuantifyNucleiPixelPlugin implements WsiPlugin {

    public static final String ID = "quantify-nuclei-pixel";
    public static final String TITLE = "Quantify Nuclei Pixel Intensity";

    private final BioFormatsTileService tileService;

    public QuantifyNucleiPixelPlugin(BioFormatsTileService tileService) {
        this.tileService = tileService;
    }

    @Override
    public String id() {
        return ID;
    }

    @Override
    public String title() {
        return TITLE;
    }

    @Override
    public PluginResult execute(PluginExecuteRequest request) throws Exception {
        int series = request.series() == null ? 0 : Math.max(0, request.series());
        int z = request.z() == null ? 0 : Math.max(0, request.z());
        PluginSampleGrid grid = tileService.readPluginSampleGrid(
                request.imageId(),
                series,
                z,
                request.x(),
                request.y(),
                request.width(),
                request.height(),
                request.channels()
        );
        boolean[] mask = NucleusCircleMask.union(grid, request.nuclei());
        List<ChannelIntensityStats> stats = new ArrayList<>(grid.channelNames().size());
        for (int channel = 0; channel < grid.channelNames().size(); channel++) {
            stats.add(IntensityStatsAnalyzer.summarize(
                    grid.channelNames().get(channel),
                    grid.channelIndexes()[channel],
                    grid.planes()[channel],
                    mask
            ));
        }
        long samples = stats.isEmpty() ? 0 : stats.getFirst().sampleCount();
        int nucleusCount = request.nuclei() == null ? 0 : request.nuclei().size();
        return new PluginResult(
                ID,
                TITLE,
                grid.imageX(),
                grid.imageY(),
                grid.imageWidth(),
                grid.imageHeight(),
                grid.sampleWidth(),
                grid.sampleHeight(),
                nucleusCount,
                samples,
                List.copyOf(stats),
                List.of()
        );
    }
}
