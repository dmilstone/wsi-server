package wsi_server;

import loci.formats.FormatTools;
import loci.formats.IFormatReader;
import loci.formats.ImageReader;
import wsi_server.model.DisplayModel;
import wsi_server.model.DisplayWindow;
import wsi_server.model.LutType;

/** Shared immutable image metadata, automatic windows, and synchronized reader. */
final class ImageContext implements AutoCloseable {
    static final int FLUORESCENCE_SERIES = 2;
    static final int TILE_SIZE = 512;
    private static final int BYTES_PER_PIXEL = 2;
    private static final int HISTOGRAM_SIZE = 65536;
    private static final double LOW_PERCENTILE = 0.01;
    private static final double HIGH_PERCENTILE = 0.99;

    private final ImageRegistry.ImageEntry entry;
    private final IFormatReader reader;
    private final DisplayWindow[] automaticWindows;

    ImageContext(ImageRegistry.ImageEntry entry) throws Exception {
        this.entry = entry;
        this.reader = new ImageReader();
        reader.setFlattenedResolutions(false);
        reader.setId(entry.path().toString());
        reader.setSeries(FLUORESCENCE_SERIES);
        validatePixelType();
        this.automaticWindows = new DisplayWindow[reader.getSizeC()];
        initializeSlideDisplayWindows();
    }

    synchronized IFormatReader reader() {
        reader.setSeries(FLUORESCENCE_SERIES);
        return reader;
    }

    synchronized DisplayModel newDefaultDisplayModel() {
        DisplayModel model = new DisplayModel(reader.getSizeC());
        LutType[] defaults = {LutType.BLUE, LutType.GREEN, LutType.RED,
                LutType.MAGENTA, LutType.CYAN, LutType.GRAY};
        for (int channel = 0; channel < model.getChannelCount(); channel++) {
            var settings = model.getChannel(channel);
            settings.setVisible(true);
            settings.setWindow(automaticWindows[channel]);
            settings.setLut(defaults[channel % defaults.length]);
            settings.setGamma(1.0);
            settings.setOpacity(1.0);
        }
        return model;
    }

    ImageRegistry.ImageEntry entry() { return entry; }

    private void initializeSlideDisplayWindows() throws Exception {
        reader.setSeries(FLUORESCENCE_SERIES);
        reader.setResolution(reader.getResolutionCount() - 1);
        boolean littleEndian = reader.isLittleEndian();
        for (int channel = 0; channel < reader.getSizeC(); channel++) {
            automaticWindows[channel] = calculateChannelDisplayWindow(channel, littleEndian);
        }
        reader.setResolution(0);
    }

    private DisplayWindow calculateChannelDisplayWindow(int channel, boolean littleEndian) throws Exception {
        long[] histogram = new long[HISTOGRAM_SIZE];
        long pixelCount = 0;
        int width = reader.getSizeX(), height = reader.getSizeY();
        int plane = reader.getIndex(0, channel, 0);
        for (int y = 0; y < height; y += TILE_SIZE) {
            int h = Math.min(TILE_SIZE, height - y);
            for (int x = 0; x < width; x += TILE_SIZE) {
                int w = Math.min(TILE_SIZE, width - x);
                byte[] pixels = reader.openBytes(plane, x, y, w, h);
                for (int i = 0; i < w * h; i++) {
                    histogram[readUint16(pixels, i * BYTES_PER_PIXEL, littleEndian)]++;
                }
                pixelCount += (long) w * h;
            }
        }
        if (pixelCount == 0) return new DisplayWindow(0, 65535);
        int black = percentile(histogram, pixelCount, LOW_PERCENTILE);
        int white = percentile(histogram, pixelCount, HIGH_PERCENTILE);
        if (white <= black) {
            int min = 0, max = histogram.length - 1;
            while (min < histogram.length && histogram[min] == 0) min++;
            while (max >= 0 && histogram[max] == 0) max--;
            black = min < histogram.length ? min : 0;
            white = max >= 0 ? max : 65535;
        }
        if (white <= black) {
            if (black < 65535) white = black + 1;
            else { black = 65534; white = 65535; }
        }
        return new DisplayWindow(black, white);
    }

    private int percentile(long[] histogram, long count, double percentile) {
        long target = Math.max(1, (long) Math.ceil(count * percentile)), cumulative = 0;
        for (int value = 0; value < histogram.length; value++) {
            cumulative += histogram[value];
            if (cumulative >= target) return value;
        }
        return histogram.length - 1;
    }

    private int readUint16(byte[] pixels, int offset, boolean littleEndian) {
        int first = pixels[offset] & 0xff, second = pixels[offset + 1] & 0xff;
        return littleEndian ? first | (second << 8) : (first << 8) | second;
    }

    private void validatePixelType() {
        if (reader.getPixelType() != FormatTools.UINT16) {
            throw new IllegalStateException("Fluorescence rendering requires UINT16 data. Received: "
                    + FormatTools.getPixelTypeString(reader.getPixelType()));
        }
    }

    @Override public synchronized void close() throws Exception { reader.close(); }
}
