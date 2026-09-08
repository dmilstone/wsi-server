package wsi_server.plugin;

import org.springframework.stereotype.Component;
import wsi_server.BioFormatsTileService;
import wsi_server.ImageRegistry;

import java.util.List;

/**
 * QuPath's built-in Cell detection (watershed + optional cytoplasm expansion),
 * exposed as a {@code POST /api/plugins/execute} plugin so the AI Labs detector
 * list can run it on the current viewport.
 */
@Component
public class QuPathCellDetectionPlugin implements WsiPlugin {

    public static final String ID = "qupath-cell-detection";
    public static final String TITLE = "QuPath Cell Detection";

    private final BioFormatsTileService tileService;
    private final ImageRegistry registry;

    public QuPathCellDetectionPlugin(BioFormatsTileService tileService, ImageRegistry registry) {
        this.tileService = tileService;
        this.registry = registry;
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
        ImageRegistry.ImageEntry entry = registry.getRequired(request.imageId());
        boolean rgbSeries = tileService.isRgbSeries(request.imageId(), series);
        boolean brightfield = StarDistSegmentationPlugin.resolveBrightfield(request.modelOverride(), entry, rgbSeries);
        List<String> channels = brightfield ? rgbChannels(request.channels()) : request.channels();
        PluginSampleGrid grid = tileService.readPluginSampleGrid(
                request.imageId(), series, z,
                request.x(), request.y(), request.width(), request.height(),
                channels
        );
        List<NucleusPolygon> nuclei = QuPathCellDetectionEngine.detect(
                grid,
                brightfield,
                new QuPathCellDetectionEngine.Params(
                        request.probability(),
                        request.backgroundRadius(),
                        request.sigma(),
                        request.minArea(),
                        request.maxArea(),
                        request.cellExpansion()
                )
        );
        return new PluginResult(
                ID,
                TITLE + " (" + QuPathCellDetectionEngine.ENGINE_LABEL + ")",
                grid.imageX(),
                grid.imageY(),
                grid.imageWidth(),
                grid.imageHeight(),
                grid.sampleWidth(),
                grid.sampleHeight(),
                nuclei.size(),
                0,
                List.of(),
                List.of(),
                nuclei,
                QuPathCellDetectionEngine.ENGINE_LABEL
        );
    }

    private static List<String> rgbChannels(List<String> requested) {
        if (requested != null && !requested.isEmpty()) return requested;
        return List.of("R", "G", "B");
    }
}
