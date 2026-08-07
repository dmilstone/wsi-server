package wsi_server;

import loci.formats.FormatTools;
import loci.formats.IFormatReader;
import loci.formats.ImageReader;
import loci.formats.MetadataTools;
import loci.formats.meta.MetadataRetrieve;
import wsi_server.model.DisplayModel;
import wsi_server.model.DisplayWindow;
import wsi_server.model.LutType;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/** Shared immutable image metadata, automatic windows, and synchronized reader. */
final class ImageContext implements AutoCloseable {
    static final int FLUORESCENCE_SERIES = 2;
    static final int TILE_SIZE = 512;
    private static final int BYTES_PER_PIXEL = 2;
    private static final int HISTOGRAM_SIZE = 65536;
    private static final int MAX_SAMPLE_TILES = 100;
    private static final double SIGNAL_HIGH_PERCENTILE = 0.999;
    private static final double FALLBACK_HIGH_PERCENTILE = 0.9999;
    private static final double MAD_TO_SIGMA = 1.4826;
    private static final double BACKGROUND_SIGMA_CUTOFF = 4.0;
    private static final long MIN_SIGNAL_PIXELS = 256;

    private final ImageRegistry.ImageEntry entry;
    private final IFormatReader reader;
    private final DisplayWindow[] automaticWindows;
    private final boolean rgb;
    private final String[] channelLabels;

    ImageContext(ImageRegistry.ImageEntry entry, DiagnosticTiming timing) throws Exception {
        this.entry = entry;
        String imageId = entry.id();
        DiagnosticTiming.CheckedSupplier<ImageReader> readerFactory = ImageReader::new;
        this.reader = timing.measure("metadata", "reader_create", imageId, readerFactory);
        reader.setMetadataStore(MetadataTools.createOMEXMLMetadata());
        reader.setFlattenedResolutions(false);
        timing.measureVoid("metadata", "set_id_metadata_parse", imageId,
                () -> reader.setId(entry.path().toString()));
        timing.measureVoid("metadata", "series_select", imageId,
                () -> reader.setSeries(FLUORESCENCE_SERIES));
        this.rgb = reader.getPixelType() == FormatTools.UINT8 && (reader.isRGB() || reader.getSizeC() >= 3);
        validatePixelType();
        this.channelLabels = timing.measure("metadata", "metadata_extract", imageId,
                this::initializeChannelLabels);
        this.automaticWindows = new DisplayWindow[reader.getSizeC()];
        if (rgb) {
            for (int channel = 0; channel < automaticWindows.length; channel++) {
                automaticWindows[channel] = new DisplayWindow(0, 255);
            }
        } else {
            timing.measureVoid("metadata", "automatic_window_open_bytes", imageId,
                    this::initializeSlideDisplayWindows);
        }
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
            settings.setGamma(rgb ? 1.0 : 0.85);
            settings.setOpacity(rgb ? 1.0 : 0.70);
        }
        return model;
    }

    ImageRegistry.ImageEntry entry() { return entry; }

    boolean isRgb() { return rgb; }

    String channelLabel(int channel) {
        if (channel < 0 || channel >= channelLabels.length) return "Channel " + channel;
        return channelLabels[channel];
    }

    private String[] initializeChannelLabels() {
        String[] labels = new String[reader.getSizeC()];
        for (int channel = 0; channel < labels.length; channel++) {
            String base = "Channel " + channel;
            if (rgb) {
                labels[channel] = base;
                continue;
            }
            String designation = acquisitionDesignation(channel);
            labels[channel] = designation == null || designation.isBlank()
                    ? base : base + " - " + designation;
        }
        return labels;
    }

    private String acquisitionDesignation(int channel) {
        List<String> candidates = new ArrayList<>();
        if (reader.getMetadataStore() instanceof MetadataRetrieve metadata) {
            addCandidate(candidates, invokeMetadataString(metadata, "getChannelName", channel));
            addCandidate(candidates, invokeMetadataString(metadata, "getChannelFluor", channel));
        }
        collectChannelMetadataCandidates(candidates, reader.getSeriesMetadata(), channel);
        collectChannelMetadataCandidates(candidates, reader.getGlobalMetadata(), channel);

        for (String candidate : candidates) {
            String canonical = canonicalFluorDesignation(candidate);
            if (canonical != null) return canonical;
        }
        for (String candidate : candidates) {
            String cleaned = cleanCubeName(candidate, channel);
            if (cleaned != null) return cleaned;
        }
        return null;
    }

    private String invokeMetadataString(MetadataRetrieve metadata, String methodName, int channel) {
        try {
            Method method = metadata.getClass().getMethod(methodName, int.class, int.class);
            Object value = method.invoke(metadata, reader.getSeries(), channel);
            return value == null ? null : value.toString();
        } catch (ReflectiveOperationException | RuntimeException ignored) {
            return null;
        }
    }

    private void collectChannelMetadataCandidates(List<String> candidates, Map<?, ?> metadata, int channel) {
        if (metadata == null || metadata.isEmpty()) return;
        int oneBased = channel + 1;
        Pattern channelPattern = Pattern.compile(
                "(?i)(?:channel|ch|cube|filter)[\\s_#:-]*(?:" + channel + "|" + oneBased + ")(?:\\D|$)");
        for (Map.Entry<?, ?> entry : metadata.entrySet()) {
            String key = entry.getKey() == null ? "" : entry.getKey().toString();
            String value = entry.getValue() == null ? "" : entry.getValue().toString();
            if (channelPattern.matcher(key).find()) {
                addCandidate(candidates, value);
                addCandidate(candidates, key);
            }
        }
    }

    private void addCandidate(List<String> candidates, String candidate) {
        if (candidate == null) return;
        String trimmed = candidate.trim();
        if (!trimmed.isEmpty() && !candidates.contains(trimmed)) candidates.add(trimmed);
    }

    private String canonicalFluorDesignation(String value) {
        if (value == null) return null;
        String normalized = value.toUpperCase().replaceAll("[^A-Z0-9]+", " ").trim();
        if (normalized.isEmpty()) return null;
        if (normalized.contains("MCHERRY")) return "mCherry";
        if (normalized.matches(".*\\bDAPI\\b.*") || normalized.contains("HOECHST")
                || normalized.contains("U FUW") || normalized.contains("U FUNA")) return "DAPI";
        if (normalized.matches(".*\\bFITC\\b.*") || normalized.matches(".*\\bGFP\\b.*")
                || normalized.contains("MNIBA")) return "FITC";
        if (normalized.matches(".*\\bTRITC\\b.*") || normalized.contains("TEXAS RED")
                || normalized.contains("MWIG")) return "TRITC";
        if (normalized.matches(".*\\bCY ?7\\b.*")) return "Cy7";
        if (normalized.matches(".*\\bCY ?5(?: 5)?\\b.*") || normalized.contains("MCY5")) return "Cy5";
        if (normalized.matches(".*\\bCY ?3\\b.*")) return "Cy3";
        if (normalized.matches(".*\\bCFP\\b.*")) return "CFP";
        if (normalized.matches(".*\\bYFP\\b.*")) return "YFP";
        if (normalized.matches(".*\\bGFP\\b.*")) return "GFP";
        return null;
    }

    private String cleanCubeName(String value, int channel) {
        if (value == null) return null;
        String cleaned = value.replaceAll("[\\r\\n\\t]+", " ").replaceAll("\\s+", " ").trim();
        if (cleaned.isEmpty() || cleaned.length() > 80) return null;
        String lower = cleaned.toLowerCase();
        if (lower.equals("channel " + channel) || lower.equals("channel " + (channel + 1))
                || lower.matches("channel\\s*#?\\s*\\d+")) return null;
        if (lower.matches("[-+]?\\d+(?:\\.\\d+)?")) return null;
        return cleaned;
    }

    private synchronized void initializeSlideDisplayWindows() throws Exception {
        recomputeAutomaticWindows();
    }

    synchronized void recomputeAutomaticWindows() throws Exception {
        if (rgb) return;
        reader.setSeries(FLUORESCENCE_SERIES);
        reader.setResolution(reader.getResolutionCount() - 1);
        boolean littleEndian = reader.isLittleEndian();
        for (int channel = 0; channel < reader.getSizeC(); channel++) {
            automaticWindows[channel] = calculateChannelDisplayWindow(channel, littleEndian);
        }
        reader.setResolution(0);
    }

    private DisplayWindow calculateChannelDisplayWindow(int channel, boolean littleEndian) throws Exception {
        long[] histogram = sampleHistogram(channel, littleEndian);
        long total = totalCount(histogram, 0);
        if (total == 0) return new DisplayWindow(0, 65535);

        int backgroundMode = backgroundMode(histogram, total);
        int backgroundMad = histogramMedianAbsoluteDeviation(histogram, total, backgroundMode);
        int spread = Math.max(2, (int) Math.ceil(backgroundMad * MAD_TO_SIGMA));
        int signalThreshold = Math.min(65534, backgroundMode
                + Math.max(4, (int) Math.ceil(BACKGROUND_SIGMA_CUTOFF * spread)));

        long signalCount = totalCount(histogram, signalThreshold + 1);
        int black = Math.min(signalThreshold, 65534);
        int white;
        if (signalCount >= MIN_SIGNAL_PIXELS) {
            white = percentileFrom(histogram, signalThreshold + 1, signalCount, SIGNAL_HIGH_PERCENTILE);
        } else {
            black = percentileFrom(histogram, 0, total, 0.01);
            white = percentileFrom(histogram, 0, total, FALLBACK_HIGH_PERCENTILE);
        }

        // Preserve a useful tonal range for sparse or nearly uniform channels.
        if (white <= black + 16) {
            int observedMax = highestObserved(histogram);
            white = Math.max(black + 1, observedMax);
        }
        white = Math.min(65535, white);
        if (white <= black) {
            black = Math.max(0, Math.min(65534, black));
            white = black + 1;
        }
        return new DisplayWindow(black, white);
    }

    private long[] sampleHistogram(int channel, boolean littleEndian) throws Exception {
        long[] histogram = new long[HISTOGRAM_SIZE];
        int width = reader.getSizeX(), height = reader.getSizeY();
        int tilesX = Math.max(1, (width + TILE_SIZE - 1) / TILE_SIZE);
        int tilesY = Math.max(1, (height + TILE_SIZE - 1) / TILE_SIZE);
        int totalTiles = tilesX * tilesY;
        int sampleCount = Math.min(MAX_SAMPLE_TILES, totalTiles);
        int plane = reader.getIndex(0, channel, 0);

        for (int sample = 0; sample < sampleCount; sample++) {
            int tileIndex = sampleCount == 1 ? 0
                    : (int) Math.round(sample * (totalTiles - 1.0) / (sampleCount - 1.0));
            int tileX = tileIndex % tilesX, tileY = tileIndex / tilesX;
            int x = tileX * TILE_SIZE, y = tileY * TILE_SIZE;
            int w = Math.min(TILE_SIZE, width - x), h = Math.min(TILE_SIZE, height - y);
            byte[] pixels = reader.openBytes(plane, x, y, w, h);
            for (int offset = 0; offset < pixels.length; offset += BYTES_PER_PIXEL) {
                histogram[readUint16(pixels, offset, littleEndian)]++;
            }
        }
        return histogram;
    }

    private int backgroundMode(long[] histogram, long total) {
        int upper = percentileFrom(histogram, 0, total, 0.60);
        int mode = 0;
        for (int value = 1; value <= upper; value++) {
            if (histogram[value] > histogram[mode]) mode = value;
        }
        return mode;
    }

    private int histogramMedianAbsoluteDeviation(long[] histogram, long total, int center) {
        long target = Math.max(1, (long) Math.ceil(total * 0.50));
        long cumulative = histogram[center];
        if (cumulative >= target) return 0;
        for (int distance = 1; distance < histogram.length; distance++) {
            int lower = center - distance, upper = center + distance;
            if (lower >= 0) cumulative += histogram[lower];
            if (upper < histogram.length) cumulative += histogram[upper];
            if (cumulative >= target) return distance;
            if (lower < 0 && upper >= histogram.length) break;
        }
        return 0;
    }

    private long totalCount(long[] histogram, int start) {
        long total = 0;
        for (int value = Math.max(0, start); value < histogram.length; value++) total += histogram[value];
        return total;
    }

    private int percentileFrom(long[] histogram, int start, long count, double percentile) {
        long target = Math.max(1, (long) Math.ceil(count * percentile));
        long cumulative = 0;
        for (int value = Math.max(0, start); value < histogram.length; value++) {
            cumulative += histogram[value];
            if (cumulative >= target) return value;
        }
        return histogram.length - 1;
    }

    private int highestObserved(long[] histogram) {
        for (int value = histogram.length - 1; value >= 0; value--) {
            if (histogram[value] > 0) return value;
        }
        return 65535;
    }

    private int readUint16(byte[] pixels, int offset, boolean littleEndian) {
        int first = pixels[offset] & 0xff, second = pixels[offset + 1] & 0xff;
        return littleEndian ? first | (second << 8) : (first << 8) | second;
    }

    private void validatePixelType() {
        if (rgb) return;
        if (reader.getPixelType() != FormatTools.UINT16) {
            throw new IllegalStateException("Supported primary images are 8-bit RGB or UINT16 fluorescence. Received: "
                    + FormatTools.getPixelTypeString(reader.getPixelType()));
        }
    }

    @Override public synchronized void close() throws Exception { reader.close(); }
}
