package wsi_server.plugin;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import wsi_server.BioFormatsTileService;
import wsi_server.ImageRegistry;
import wsi_server.WsiCatalogScanner;

import java.nio.file.Path;
import java.util.List;

/**
 * Dual-model StarDist segmentation. Fluorescence slides load
 * {@code stardist_2d_versatile_fluo}; brightfield / H&amp;E slides load
 * {@code stardist_2d_versatile_he}. Each nucleus is returned as image-space
 * vertex coordinates, not a fixed-radius circle.
 */
@Component
public class StarDistSegmentationPlugin implements WsiPlugin {

    public static final String ID = "stardist-segmentation";
    public static final String TITLE = "StarDist Nuclear Contours";

    private final BioFormatsTileService tileService;
    private final ImageRegistry registry;
    private final Path modelDirectory;

    public StarDistSegmentationPlugin(
            BioFormatsTileService tileService,
            ImageRegistry registry,
            @Value("${wsi.stardist.model-directory:${user.home}/.wsi-server/stardist}") String modelDirectory
    ) {
        this.tileService = tileService;
        this.registry = registry;
        this.modelDirectory = Path.of(modelDirectory == null || modelDirectory.isBlank()
                ? System.getProperty("user.home") + "/.wsi-server/stardist"
                : modelDirectory);
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
        boolean brightfield = resolveBrightfield(request.modelOverride(), entry, rgbSeries);
        String weightsName = StarDistTensorEngine.modelName(brightfield);
        Path weights = StarDistTensorEngine.resolveWeights(modelDirectory, weightsName);
        List<String> channels = brightfield
                ? rgbChannels(request.channels())
                : request.channels();
        PluginSampleGrid grid = tileService.readPluginSampleGrid(
                request.imageId(),
                series,
                z,
                request.x(),
                request.y(),
                request.width(),
                request.height(),
                channels
        );
        List<NucleusPolygon> nuclei = StarDistTensorEngine.infer(
                grid, brightfield, weights, request.starDistParams());
        return new PluginResult(
                ID,
                TITLE + " (" + weightsName + ")",
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
                nuclei
        );
    }

    /**
     * "auto" (default, {@code null}, or unrecognized) keeps the existing modality/engine
     * detection; "fluorescence" and "he"/"brightfield" force that model regardless of
     * what the slide's metadata says, for the rare edge case where auto-detection guesses
     * wrong (e.g. a brightfield scan mis-tagged as fluorescence).
     */
    static boolean resolveBrightfield(String modelOverride, ImageRegistry.ImageEntry entry, boolean rgbSeries) {
        String normalized = modelOverride == null ? "" : modelOverride.trim().toLowerCase();
        if ("fluorescence".equals(normalized) || "fluo".equals(normalized)) return false;
        if ("he".equals(normalized) || "brightfield".equals(normalized)) return true;
        return StarDistTensorEngine.looksBrightfield(entry.modality(), entry.engine(), rgbSeries);
    }

    static boolean isBrightfieldEntry(ImageRegistry.ImageEntry entry, boolean rgbSeries) {
        if (entry == null) return rgbSeries;
        return StarDistTensorEngine.looksBrightfield(entry.modality(), entry.engine(), rgbSeries)
                || WsiCatalogScanner.ENGINE_OPENSLIDE.equals(entry.engine());
    }

    private static List<String> rgbChannels(List<String> requested) {
        if (requested != null && !requested.isEmpty()) return requested;
        return List.of("R", "G", "B");
    }
}
