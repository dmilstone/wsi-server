package wsi_server.plugin;

import org.springframework.stereotype.Component;
import wsi_server.BioFormatsTileService;
import wsi_server.ImageRegistry;

import java.util.List;

/**
 * Cellpose detector for the AI Labs popup. Uses a native Cellpose runtime when
 * {@link CellposeEngine#NATIVE_MODEL_IMPLEMENTED} is true; otherwise the
 * diameter-based fallback heuristic.
 */
@Component
public class CellposeSegmentationPlugin implements WsiPlugin {

    public static final String ID = "cellpose-segmentation";
    public static final String TITLE = "Cellpose";

    private final BioFormatsTileService tileService;
    private final ImageRegistry registry;

    public CellposeSegmentationPlugin(BioFormatsTileService tileService, ImageRegistry registry) {
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
        boolean brightfield = StarDistSegmentationPlugin.resolveBrightfield(
                fluorescenceOrAuto(request.modelOverride()), entry, rgbSeries);
        String cellposeModel = CellposeEngine.modelName(request.modelOverride(), brightfield);
        List<String> channels = brightfield ? rgbChannels(request.channels()) : request.channels();
        PluginSampleGrid grid = tileService.readPluginSampleGrid(
                request.imageId(), series, z,
                request.x(), request.y(), request.width(), request.height(),
                channels
        );
        List<NucleusPolygon> nuclei = CellposeEngine.detect(
                grid,
                brightfield,
                new CellposeEngine.Params(
                        request.probability(),
                        request.nms(),
                        request.diameter(),
                        cellposeModel
                )
        );
        String engine = CellposeEngine.NATIVE_MODEL_IMPLEMENTED
                ? CellposeEngine.NATIVE_ENGINE_LABEL
                : CellposeEngine.FALLBACK_ENGINE_LABEL;
        return new PluginResult(
                ID,
                TITLE + " (" + engine + ", " + cellposeModel + ")",
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
                engine
        );
    }

    /**
     * Cellpose model names ({@code nuclei}/{@code cyto*}) must not be treated as
     * StarDist fluo/H&amp;E overrides. Anything else still goes through auto-detect.
     */
    static String fluorescenceOrAuto(String modelOverride) {
        String raw = modelOverride == null ? "" : modelOverride.trim().toLowerCase();
        if (raw.equals("nuclei") || raw.equals("cyto") || raw.equals("cyto2") || raw.equals("cyto3")) {
            return "auto";
        }
        return modelOverride;
    }

    private static List<String> rgbChannels(List<String> requested) {
        if (requested != null && !requested.isEmpty()) return requested;
        return List.of("R", "G", "B");
    }
}
