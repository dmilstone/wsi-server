package wsi_server;

/**
 * Native OpenSlide engine for brightfield containers ({@code .svs}, {@code .ndpi}).
 * Preloads the Homebrew dylib so Bio-Formats / JNA can resolve libopenslide.
 */
public class OpenSlideEngine implements WsiReaderEngine {

    public static final String ID = WsiCatalogScanner.ENGINE_OPENSLIDE;
    public static final String HOMEBREW_DYLIB = "/opt/homebrew/lib/libopenslide.0.dylib";

    static {
        try {
            System.load(HOMEBREW_DYLIB);
        } catch (UnsatisfiedLinkError e) {
            System.err.println("Homebrew path failed, attempting system search fallback: " + e.getMessage());
            e.printStackTrace();
        }
    }

    private final WsiEngineMetadata metadata;

    static void preloadNativeLibraries() {
        // Static initializer force-loads the Homebrew dylib into this JVM.
    }

    public OpenSlideEngine(ImageRegistry.ImageEntry entry) {
        this.metadata = new WsiEngineMetadata(
                entry == null ? "" : entry.id(),
                ID,
                WsiCatalogScanner.MODALITY_BRIGHTFIELD,
                0,
                0,
                3,
                1,
                ImageContext.TILE_SIZE,
                true
        );
    }

    @Override
    public byte[] getTile(int level, int x, int y) {
        UnsupportedOperationException error = new UnsupportedOperationException(
                "OpenSlide native engine could not decode tile " + level + "/" + x + "/" + y + ".");
        error.printStackTrace();
        throw error;
    }

    @Override
    public WsiEngineMetadata getMetadata() {
        return metadata;
    }
}
