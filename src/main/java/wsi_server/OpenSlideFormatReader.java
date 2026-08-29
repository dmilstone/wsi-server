package wsi_server;

import com.sun.jna.Pointer;
import com.sun.jna.ptr.LongByReference;
import loci.formats.CoreMetadata;
import loci.formats.FormatException;
import loci.formats.FormatReader;
import loci.formats.FormatTools;
import loci.formats.MetadataTools;
import loci.formats.meta.MetadataStore;
import ome.units.UNITS;
import ome.units.quantity.Length;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * Bio-Formats {@link FormatReader} backed by native OpenSlide. Used for
 * brightfield {@code .svs}, {@code .ndpi}, and {@code .mrxs} so the tile
 * pipeline never opens Bio-Formats' JPEG preview or TurboJPEG NDPI reader.
 */
public final class OpenSlideFormatReader extends FormatReader {

    private static final Logger LOGGER = LoggerFactory.getLogger(OpenSlideFormatReader.class);
    private static final int TILE = ImageContext.TILE_SIZE;

    private Pointer handle;
    private double[] downsample;
    private List<String> associatedNames = List.of();

    public OpenSlideFormatReader() {
        super("OpenSlide", new String[]{"svs", "ndpi", "mrxs"});
    }

    static boolean handles(Path path) {
        if (WsiCatalogScanner.isOpenSlideExtension(path)) return true;
        return MrxsSlideInfo.isMrxs(path) && !MrxsSlideInfo.isFluorescence(path);
    }

    @Override
    public boolean isThisType(String name, boolean open) {
        return handles(name == null ? null : Path.of(name));
    }

    @Override
    protected void initFile(String id) throws FormatException, IOException {
        super.initFile(id);
        if (!OpenSlideNative.isAvailable()) {
            throw new FormatException("OpenSlide native library is not available.");
        }
        OpenSlideNative.Lib lib = OpenSlideNative.lib();
        Pointer opened = lib.openslide_open(id);
        if (opened == null) {
            throw new FormatException("OpenSlide could not open " + id + ".");
        }
        this.handle = opened;
        try {
            OpenSlideNative.checkError(handle, "open");
            int levels = lib.openslide_get_level_count(handle);
            if (levels < 1) throw new FormatException("OpenSlide reported no pyramid levels for " + id + ".");
            downsample = new double[levels];
            core.clear();
            List<String> seriesNames = new ArrayList<>();
            for (int level = 0; level < levels; level++) {
                LongByReference width = new LongByReference();
                LongByReference height = new LongByReference();
                lib.openslide_get_level_dimensions(handle, level, width, height);
                OpenSlideNative.checkError(handle, "level dimensions");
                downsample[level] = lib.openslide_get_level_downsample(handle, level);
                if (!(downsample[level] > 0) || !Double.isFinite(downsample[level])) {
                    downsample[level] = level == 0 ? 1.0 : (1 << level);
                }
                CoreMetadata ms = rgbCore((int) width.getValue(), (int) height.getValue());
                ms.resolutionCount = level == 0 ? levels : 1;
                core.add(ms);
            }
            seriesNames.add("baseline");

            associatedNames = OpenSlideNative.stringArray(lib.openslide_get_associated_image_names(handle));
            for (String name : associatedNames) {
                LongByReference width = new LongByReference();
                LongByReference height = new LongByReference();
                lib.openslide_get_associated_image_dimensions(handle, name, width, height);
                OpenSlideNative.checkError(handle, "associated " + name);
                if (width.getValue() <= 0 || height.getValue() <= 0) continue;
                CoreMetadata ms = rgbCore((int) width.getValue(), (int) height.getValue());
                ms.resolutionCount = 1;
                ms.thumbnail = true;
                core.add(ms);
                seriesNames.add(name);
            }

            MetadataStore store = makeFilterMetadata();
            MetadataTools.populatePixels(store, this);
            for (int series = 0; series < seriesNames.size(); series++) {
                store.setImageName(seriesNames.get(series), series);
            }
            populateMicrons(lib, store);
            LOGGER.info("Opened {} with OpenSlide ({} level(s), {} associated)", id, levels, associatedNames.size());
        } catch (RuntimeException | FormatException exception) {
            closeHandle();
            throw exception;
        }
    }

    private void populateMicrons(OpenSlideNative.Lib lib, MetadataStore store) {
        try {
            double mppX = parsePositive(lib.openslide_get_property_value(handle, "openslide.mpp-x"));
            double mppY = parsePositive(lib.openslide_get_property_value(handle, "openslide.mpp-y"));
            if (mppX > 0) store.setPixelsPhysicalSizeX(new Length(mppX, UNITS.MICROMETER), 0);
            if (mppY > 0) store.setPixelsPhysicalSizeY(new Length(mppY, UNITS.MICROMETER), 0);
        } catch (RuntimeException ignored) {
            // Microns are optional; tiles still render without them.
        }
    }

    @Override
    public byte[] openBytes(int no, byte[] buf, int x, int y, int w, int h)
            throws FormatException, IOException {
        FormatTools.checkPlaneParameters(this, no, buf.length, x, y, w, h);
        if (handle == null) throw new IOException("OpenSlide handle is closed.");
        int[] argb = new int[Math.multiplyExact(w, h)];
        if (getSeries() == 0) {
            int level = getResolution();
            double scale = (downsample != null && level >= 0 && level < downsample.length)
                    ? downsample[level] : 1.0;
            long x0 = level0Coordinate(x, scale);
            long y0 = level0Coordinate(y, scale);
            OpenSlideNative.lib().openslide_read_region(handle, argb, x0, y0, level, w, h);
            OpenSlideNative.checkError(handle, "read_region");
        } else {
            String name = associatedName(getSeries());
            int fullW = getSizeX();
            int fullH = getSizeY();
            int[] full = new int[Math.multiplyExact(fullW, fullH)];
            OpenSlideNative.lib().openslide_read_associated_image(handle, name, full);
            OpenSlideNative.checkError(handle, "associated " + name);
            copyRegion(full, fullW, argb, x, y, w, h);
        }
        argbToRgb(argb, buf);
        return buf;
    }

    @Override
    public int getOptimalTileWidth() {
        return TILE;
    }

    @Override
    public int getOptimalTileHeight() {
        return TILE;
    }

    @Override
    public void close(boolean fileOnly) throws IOException {
        closeHandle();
        downsample = null;
        associatedNames = List.of();
        super.close(fileOnly);
    }

    private void closeHandle() {
        if (handle == null) return;
        try {
            OpenSlideNative.lib().openslide_close(handle);
        } catch (RuntimeException ignored) {
            // Best-effort native close.
        }
        handle = null;
    }

    private String associatedName(int series) throws FormatException {
        int index = series - 1;
        if (index < 0 || index >= associatedNames.size()) {
            throw new FormatException("No OpenSlide associated image for series " + series + ".");
        }
        return associatedNames.get(index);
    }

    static CoreMetadata rgbCore(int width, int height) {
        CoreMetadata ms = new CoreMetadata();
        ms.sizeX = width;
        ms.sizeY = height;
        ms.sizeZ = 1;
        ms.sizeC = 3;
        ms.sizeT = 1;
        ms.imageCount = 1;
        ms.rgb = true;
        ms.interleaved = true;
        ms.littleEndian = true;
        ms.indexed = false;
        ms.pixelType = FormatTools.UINT8;
        ms.dimensionOrder = "XYCZT";
        ms.resolutionCount = 1;
        ms.thumbnail = false;
        return ms;
    }

    static long level0Coordinate(int levelCoordinate, double downsample) {
        if (levelCoordinate <= 0) return 0;
        double scale = downsample > 0 && Double.isFinite(downsample) ? downsample : 1.0;
        return Math.max(0L, Math.round(levelCoordinate * scale));
    }

    static void argbToRgb(int[] argb, byte[] rgb) {
        int pixels = argb.length;
        for (int i = 0; i < pixels; i++) {
            int pixel = argb[i];
            int alpha = (pixel >>> 24) & 0xff;
            int r;
            int g;
            int b;
            if (alpha == 0) {
                r = 255;
                g = 255;
                b = 255;
            } else {
                r = (pixel >> 16) & 0xff;
                g = (pixel >> 8) & 0xff;
                b = pixel & 0xff;
            }
            int offset = i * 3;
            rgb[offset] = (byte) r;
            rgb[offset + 1] = (byte) g;
            rgb[offset + 2] = (byte) b;
        }
    }

    static void copyRegion(int[] source, int sourceWidth, int[] dest, int x, int y, int w, int h) {
        for (int row = 0; row < h; row++) {
            int src = (y + row) * sourceWidth + x;
            System.arraycopy(source, src, dest, row * w, w);
        }
    }

    private static double parsePositive(String raw) {
        if (raw == null || raw.isBlank()) return 0;
        try {
            double value = Double.parseDouble(raw.trim());
            return value > 0 && Double.isFinite(value) ? value : 0;
        } catch (NumberFormatException ignored) {
            return 0;
        }
    }
}
