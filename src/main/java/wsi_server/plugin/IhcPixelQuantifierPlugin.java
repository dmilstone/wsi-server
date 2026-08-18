package wsi_server.plugin;

import org.springframework.stereotype.Component;
import wsi_server.BioFormatsTileService;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Brightfield IHC plugin: Ruifrok–Johnston H-DAB unmixing inside each nucleus.
 * Mean / SD / max / min DAB optical density stay server-side; the viewer only
 * receives a scalar color-map key.
 */
@Component
public class IhcPixelQuantifierPlugin implements WsiPlugin {

    public static final String ID = "ihc-pixel-quantifier";
    public static final String TITLE = "IHC Color Deconvolution";

    private final BioFormatsTileService tileService;

    public IhcPixelQuantifierPlugin(BioFormatsTileService tileService) {
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
                rgbChannels(request.channels())
        );
        List<ObjectColorKey> keys = quantifyObjects(grid, nuclei);
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
        int[] red = plane(grid, 0, "R", "RED", "TRITC");
        int[] green = plane(grid, 1, "G", "GREEN", "FITC");
        int[] blue = plane(grid, 2, "B", "BLUE", "DAPI");
        if (red == null || green == null || blue == null) return List.of();
        double[] dab = IhcColorDeconvolution.dabPlane(red, green, blue);
        List<ObjectColorKey> keys = new ArrayList<>();
        for (int index = 0; index < nuclei.size(); index++) {
            PluginExecuteRequest.NucleusFootprint nucleus = nuclei.get(index);
            if (nucleus == null) continue;
            boolean[] mask = NucleusCircleMask.single(grid, nucleus);
            IhcColorDeconvolution.OdSummary stats = IhcColorDeconvolution.summarize(dab, mask);
            if (stats.sampleCount() <= 0) continue;
            keys.add(new ObjectColorKey(
                    index,
                    nucleus.cx(),
                    nucleus.cy(),
                    nucleus.r(),
                    stats.mean()
            ));
        }
        return keys;
    }

    private static List<String> rgbChannels(List<String> requested) {
        if (requested != null && !requested.isEmpty()) return requested;
        return List.of("R", "G", "B");
    }

    private static int[] plane(PluginSampleGrid grid, int fallbackIndex, String... aliases) {
        if (grid == null || grid.planes() == null) return null;
        List<String> names = grid.channelNames();
        if (names != null) {
            for (int i = 0; i < names.size() && i < grid.planes().length; i++) {
                String name = names.get(i) == null ? "" : names.get(i).trim().toUpperCase(Locale.ROOT);
                for (String alias : aliases) {
                    if (name.equals(alias) || (alias.length() > 1 && name.contains(alias))) {
                        return grid.planes()[i];
                    }
                }
            }
        }
        if (fallbackIndex >= 0 && fallbackIndex < grid.planes().length) return grid.planes()[fallbackIndex];
        return null;
    }
}
