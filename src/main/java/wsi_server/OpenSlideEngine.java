package wsi_server;

/**
 * Catalog / factory marker for brightfield containers ({@code .svs}, {@code .ndpi}).
 * Tile decode uses {@link OpenSlideFormatReader} via {@link BioFormatsTileService}.
 */
public class OpenSlideEngine implements WsiReaderEngine {

    public static final String ID = WsiCatalogScanner.ENGINE_OPENSLIDE;
    public static final String HOMEBREW_DYLIB = "/opt/homebrew/lib/libopenslide.1.dylib";

    static {
        OpenSlideNative.ensureLoaded();
    }

    private final WsiEngineMetadata metadata;

    static void preloadNativeLibraries() {
        OpenSlideNative.ensureLoaded();
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
