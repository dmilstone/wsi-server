package wsi_server;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.nio.file.Path;

/**
 * Routes a catalogued slide to Bio-Formats or the OpenSlide brightfield engine.
 */
@Component
public class WsiReaderEngineFactory {

    private static final Logger LOGGER = LoggerFactory.getLogger(WsiReaderEngineFactory.class);

    static {
        OpenSlideEngine.preloadNativeLibraries();
    }

    public void ensureNativeLibraries() {
        OpenSlideEngine.preloadNativeLibraries();
    }

    public WsiReaderEngine open(ImageRegistry.ImageEntry entry) {
        if (entry == null) throw new IllegalArgumentException("image entry is required");
        try {
            WsiCatalogScanner.SlideInspection inspection = WsiCatalogScanner.inspect(entry.path());
            LOGGER.info("Routing slide {} as {} via {}", entry.name(), inspection.modality(), inspection.engine());
            if (WsiCatalogScanner.ENGINE_OPENSLIDE.equals(inspection.engine())
                    || WsiCatalogScanner.MODALITY_BRIGHTFIELD.equals(inspection.modality())) {
                return new OpenSlideEngine(entry);
            }
            return new BioFormatsEngine(entry);
        } catch (Exception e) {
            e.printStackTrace();
            if (e instanceof RuntimeException runtime) throw runtime;
            throw new IllegalStateException("Brightfield slide routing failed.", e);
        }
    }

    public static WsiCatalogScanner.SlideInspection inspect(Path path) {
        return WsiCatalogScanner.inspect(path);
    }
}
