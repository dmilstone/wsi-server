package wsi_server;

import loci.formats.FormatTools;
import loci.formats.IFormatReader;
import loci.formats.ImageReader;

import java.nio.file.Path;

/**
 * Concrete Bio-Formats implementation of {@link WsiReaderEngine}.
 * HTTP tile serving still uses {@link BioFormatsTileService}; this class is the
 * engine-level adapter for factory routing and plugin-side reads.
 */
public class BioFormatsEngine implements WsiReaderEngine {

    public static final String ID = WsiCatalogScanner.ENGINE_BIOFORMATS;

    private final ImageRegistry.ImageEntry entry;
    private final WsiEngineMetadata metadata;

    public BioFormatsEngine(ImageRegistry.ImageEntry entry) {
        this.entry = entry;
        this.metadata = metadataFrom(entry);
    }

    @Override
    public byte[] getTile(int level, int x, int y) throws Exception {
        Path path = entry == null ? null : entry.path();
        if (path == null) throw new IllegalStateException("Bio-Formats engine has no slide path.");
        IFormatReader reader = new ImageReader();
        try {
            reader.setId(path.toString());
            int series = Math.max(0, Math.min(ImageContext.FLUORESCENCE_SERIES, reader.getSeriesCount() - 1));
            reader.setSeries(series);
            int resolutions = Math.max(1, reader.getResolutionCount());
            reader.setResolution(Math.max(0, Math.min(level, resolutions - 1)));
            int tile = ImageContext.TILE_SIZE;
            int px = Math.max(0, x * tile);
            int py = Math.max(0, y * tile);
            int width = Math.max(1, Math.min(tile, reader.getSizeX() - px));
            int height = Math.max(1, Math.min(tile, reader.getSizeY() - py));
            if (px >= reader.getSizeX() || py >= reader.getSizeY()) {
                throw new IllegalArgumentException("Tile is outside the image.");
            }
            return reader.openBytes(reader.getIndex(0, 0, 0), px, py, width, height);
        } finally {
            reader.close();
        }
    }

    @Override
    public WsiEngineMetadata getMetadata() {
        return metadata;
    }

    private static WsiEngineMetadata metadataFrom(ImageRegistry.ImageEntry entry) {
        if (entry == null) {
            return new WsiEngineMetadata("", ID, WsiCatalogScanner.MODALITY_FLUORESCENCE,
                    0, 0, 0, 1, ImageContext.TILE_SIZE, false);
        }
        return new WsiEngineMetadata(
                entry.id(),
                ID,
                entry.modality(),
                0,
                0,
                0,
                1,
                ImageContext.TILE_SIZE,
                false
        );
    }

    static int bytesPerPixel(IFormatReader reader) {
        return FormatTools.getBytesPerPixel(reader.getPixelType());
    }
}
