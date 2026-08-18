package wsi_server;

/**
 * Engine-neutral slide header used by {@link WsiReaderEngine#getMetadata()}.
 */
public record WsiEngineMetadata(
        String imageId,
        String engine,
        String modality,
        int width,
        int height,
        int channels,
        int resolutionCount,
        int tileSize,
        boolean rgb
) {
    public WsiEngineMetadata {
        imageId = imageId == null ? "" : imageId;
        engine = engine == null ? WsiCatalogScanner.ENGINE_BIOFORMATS : engine;
        modality = modality == null ? WsiCatalogScanner.MODALITY_FLUORESCENCE : modality;
    }
}
