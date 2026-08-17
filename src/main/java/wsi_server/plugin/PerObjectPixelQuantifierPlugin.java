package wsi_server.plugin;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import wsi_server.BioFormatsTileService;

import java.util.ArrayList;
import java.util.List;

/**
 * Per-nucleus intensity quantifier. Mean / SD / max / min are computed internally,
 * written to a local CSV export, and reduced to a scalar color-map key. Numeric
 * stats are not returned to the viewer.
 */
@Component
public class PerObjectPixelQuantifierPlugin implements WsiPlugin {

    private static final Logger LOGGER = LoggerFactory.getLogger(PerObjectPixelQuantifierPlugin.class);

    public static final String ID = "per-object-pixel-quantifier";
    public static final String TITLE = "Per-Object Pixel Quantifier";

    private final BioFormatsTileService tileService;
    private final NucleiMetricsExporter exporter;

    public PerObjectPixelQuantifierPlugin(
            BioFormatsTileService tileService,
            NucleiMetricsExporter exporter
    ) {
        this.tileService = tileService;
        this.exporter = exporter;
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
        List<PluginExecuteRequest.NucleusFootprint> nuclei = request.nuclei();
        if (nuclei == null || nuclei.isEmpty()) {
            throw new IllegalArgumentException("No nucleus objects to quantify.");
        }
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
        List<NucleusObjectReport> reports = quantifyReports(grid, nuclei);
        exportQuietly(request.imageId(), reports);
        List<ObjectColorKey> keys = colorKeys(reports);
        return new PluginResult(
                ID,
                TITLE,
                grid.imageX(),
                grid.imageY(),
                grid.imageWidth(),
                grid.imageHeight(),
                grid.sampleWidth(),
                grid.sampleHeight(),
                keys.size(),
                0,
                List.of(),
                List.copyOf(keys)
        );
    }

    static List<ObjectColorKey> quantifyObjects(
            PluginSampleGrid grid,
            List<PluginExecuteRequest.NucleusFootprint> nuclei
    ) {
        return colorKeys(quantifyReports(grid, nuclei));
    }

    static List<NucleusObjectReport> quantifyReports(
            PluginSampleGrid grid,
            List<PluginExecuteRequest.NucleusFootprint> nuclei
    ) {
        List<NucleusObjectReport> reports = new ArrayList<>(nuclei.size());
        for (int index = 0; index < nuclei.size(); index++) {
            PluginExecuteRequest.NucleusFootprint nucleus = nuclei.get(index);
            if (nucleus == null) continue;
            boolean[] mask = NucleusCircleMask.single(grid, nucleus);
            List<ChannelIntensityStats> perChannel = new ArrayList<>(grid.channelNames().size());
            double weighted = 0;
            long samples = 0;
            for (int channel = 0; channel < grid.channelNames().size(); channel++) {
                ChannelIntensityStats stats = IntensityStatsAnalyzer.summarize(
                        grid.channelNames().get(channel),
                        grid.channelIndexes()[channel],
                        grid.planes()[channel],
                        mask
                );
                perChannel.add(stats);
                if (stats.sampleCount() <= 0) continue;
                weighted += stats.mean() * stats.sampleCount();
                samples += stats.sampleCount();
            }
            double key = samples > 0 ? weighted / samples : Double.NaN;
            reports.add(new NucleusObjectReport(
                    index,
                    nucleus.cx(),
                    nucleus.cy(),
                    nucleus.r(),
                    List.copyOf(perChannel),
                    key
            ));
        }
        return reports;
    }

    static List<ObjectColorKey> colorKeys(List<NucleusObjectReport> reports) {
        List<ObjectColorKey> keys = new ArrayList<>();
        for (NucleusObjectReport report : reports) {
            if (report == null || !Double.isFinite(report.key())) continue;
            keys.add(new ObjectColorKey(
                    report.objectId(),
                    report.x(),
                    report.y(),
                    report.radius(),
                    report.key()
            ));
        }
        return keys;
    }

    private void exportQuietly(String imageId, List<NucleusObjectReport> reports) {
        if (exporter == null) return;
        try {
            exporter.write(imageId, reports);
        } catch (Exception exception) {
            LOGGER.warn("Nuclei metrics export failed: {}", exception.toString());
        }
    }
}
