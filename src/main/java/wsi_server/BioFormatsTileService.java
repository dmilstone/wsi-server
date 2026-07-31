package wsi_server;

import jakarta.annotation.PreDestroy;
import jakarta.servlet.http.HttpSession;
import loci.formats.IFormatReader;
import loci.formats.FormatTools;
import loci.formats.ImageReader;
import loci.formats.MetadataTools;
import loci.formats.gui.BufferedImageReader;
import loci.formats.meta.MetadataRetrieve;
import ome.units.UNITS;
import ome.units.quantity.Length;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import wsi_server.api.AssociatedImageSeriesDto;
import wsi_server.api.ChannelDisplayDto;
import wsi_server.api.DisplayResponse;
import wsi_server.api.DisplayUpdateRequest;
import wsi_server.api.ImageListResponse;
import wsi_server.api.ImageMetadataResponse;
import wsi_server.api.ImageSummary;
import wsi_server.api.PixelBlockResponse;
import wsi_server.api.PixelSampleResponse;
import wsi_server.display.LinearWindowPixelMapper;
import wsi_server.display.PixelMapper;
import wsi_server.model.ChannelDisplaySettings;
import wsi_server.model.DisplayModel;
import wsi_server.model.DisplaySettings;
import wsi_server.model.DisplayWindow;
import wsi_server.model.LutType;
import wsi_server.renderer.FluorescenceTileRenderer;
import wsi_server.renderer.MultichannelTileRenderer;

import javax.imageio.ImageIO;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@Service
public class BioFormatsTileService {
    private static final String SESSION_STATES = BioFormatsTileService.class.getName() + ".displayStates";
    private static final Logger LOGGER = LoggerFactory.getLogger(BioFormatsTileService.class);

    private final ImageRegistry registry;
    private final FluorescenceTileRenderer fluorescenceRenderer;
    private final MultichannelTileRenderer multichannelRenderer;
    private final ExportReaderFactory exportReaderFactory;
    private final ExportValidator exportValidator;
    private final Map<String, ImageContext> contexts = new ConcurrentHashMap<>();
    private final Map<String, AssociatedImages> associatedImageCache = new ConcurrentHashMap<>();

    public BioFormatsTileService(ImageRegistry registry,
                                 FluorescenceTileRenderer fluorescenceRenderer,
                                 MultichannelTileRenderer multichannelRenderer,
                                 ExportReaderFactory exportReaderFactory,
                                 ExportValidator exportValidator) {
        this.registry = registry;
        this.fluorescenceRenderer = fluorescenceRenderer;
        this.multichannelRenderer = multichannelRenderer;
        this.exportReaderFactory = exportReaderFactory;
        this.exportValidator = exportValidator;
    }

    public ImageListResponse listImages() {
        List<ImageSummary> images = registry.getImages().stream()
                .map(entry -> new ImageSummary(entry.id(), entry.name(), entry.relativePath(), entry.folder()))
                .toList();
        return new ImageListResponse(registry.getRootDirectory().toString(), images);
    }

    public ImageMetadataResponse getMetadata(String imageId, HttpSession session) throws Exception {
        ImageContext context = context(imageId);
        SessionDisplayState state = sessionState(session, imageId, context);
        synchronized (context) {
            IFormatReader reader = context.reader();
            reader.setResolution(0);
            Double micronsPerPixelX = physicalSizeMicrons(reader, true);
            Double micronsPerPixelY = physicalSizeMicrons(reader, false);
            return new ImageMetadataResponse(imageId, context.entry().relativePath(),
                    reader.getSizeX(), reader.getSizeY(), reader.getSizeC(),
                    reader.getResolutionCount(), ImageContext.TILE_SIZE, state.revision(),
                    micronsPerPixelX, micronsPerPixelY);
        }
    }

    private Double physicalSizeMicrons(IFormatReader reader, boolean horizontal) {
        try {
            if (!(reader.getMetadataStore() instanceof MetadataRetrieve metadata)) return null;
            Length length = horizontal
                    ? metadata.getPixelsPhysicalSizeX(reader.getSeries())
                    : metadata.getPixelsPhysicalSizeY(reader.getSeries());
            if (length == null) return null;
            Number value = length.value(UNITS.MICROMETER);
            if (value == null) return null;
            double microns = value.doubleValue();
            return Double.isFinite(microns) && microns > 0 ? microns : null;
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    public List<AssociatedImageSeriesDto> getAssociatedImageSeries(String imageId) throws Exception {
        ImageRegistry.ImageEntry entry = registry.getRequired(imageId);
        BufferedImageReader reader = createAssociatedImageReader();
        try {
            reader.setId(entry.path().toString());
            MetadataRetrieve metadata = reader.getMetadataStore() instanceof MetadataRetrieve retrieve
                    ? retrieve : null;
            int label = chooseLabelSeries(reader);
            int macro = chooseMacroSeries(reader);
            List<AssociatedImageSeriesDto> result = new ArrayList<>();
            for (int series = 0; series < reader.getSeriesCount(); series++) {
                reader.setSeries(series);
                result.add(new AssociatedImageSeriesDto(
                        series,
                        seriesName(metadata, series),
                        reader.getSizeX(),
                        reader.getSizeY(),
                        reader.getSizeC(),
                        reader.getResolutionCount(),
                        reader.isRGB(),
                        reader.isThumbnailSeries(),
                        series == label,
                        series == macro));
            }
            return result;
        } finally {
            reader.close();
        }
    }

    public byte[] getSlideLabel(String imageId) throws Exception {
        AssociatedImages images = associatedImages(imageId);
        if (images.label() == null) {
            throw new IllegalStateException("This slide does not contain a readable label associated image.");
        }
        return images.label();
    }

    public byte[] getDisplayThumbnail(String imageId, HttpSession session) throws Exception {
        AssociatedImages images = associatedImages(imageId);
        if (images.macro() == null) {
            throw new IllegalStateException("This slide does not contain a macro/overview associated image.");
        }
        return images.macro();
    }

    private AssociatedImages associatedImages(String imageId) throws Exception {
        AssociatedImages cached = associatedImageCache.get(imageId);
        if (cached != null) return cached;
        synchronized (associatedImageCache) {
            cached = associatedImageCache.get(imageId);
            if (cached != null) return cached;
            ImageRegistry.ImageEntry entry = registry.getRequired(imageId);
            BufferedImageReader reader = createAssociatedImageReader();
            try {
                reader.setId(entry.path().toString());
                byte[] label = null;
                byte[] macro = null;
                try {
                    int labelSeries = chooseLabelSeries(reader);
                    reader.setSeries(labelSeries);
                    label = encodePng(scaleToFit(reader.openImage(0), 1000, 420));
                } catch (Exception ignored) { }
                try {
                    int macroSeries = chooseMacroSeries(reader);
                    if (macroSeries >= 0) {
                        reader.setSeries(macroSeries);
                        macro = encodePng(scaleToFit(reader.openImage(0), 1200, 900));
                    }
                } catch (Exception ignored) { }
                cached = new AssociatedImages(label, macro);
                associatedImageCache.put(imageId, cached);
                return cached;
            } finally {
                reader.close();
            }
        }
    }

    private record AssociatedImages(byte[] label, byte[] macro) { }

    private BufferedImageReader createAssociatedImageReader() {
        ImageReader baseReader = new ImageReader();
        baseReader.setFlattenedResolutions(false);
        baseReader.setMetadataStore(MetadataTools.createOMEXMLMetadata());
        return new BufferedImageReader(baseReader);
    }

    private int chooseMacroSeries(BufferedImageReader reader) {
        int upper = Math.min(ImageContext.FLUORESCENCE_SERIES, reader.getSeriesCount());
        if (upper <= 0) return -1;

        MetadataRetrieve metadata = reader.getMetadataStore() instanceof MetadataRetrieve retrieve
                ? retrieve : null;
        int bestNamed = -1;
        long bestNamedArea = -1;
        int bestFallback = -1;
        long bestFallbackArea = -1;

        for (int series = 0; series < upper; series++) {
            reader.setSeries(series);
            long width = reader.getSizeX();
            long height = reader.getSizeY();
            if (width <= 0 || height <= 0) continue;
            long area = width * height;
            String name = seriesName(metadata, series).toLowerCase();

            boolean label = name.contains("label") || name.contains("barcode");
            boolean macro = name.contains("macro") || name.contains("overview")
                    || name.contains("thumbnail") || name.contains("preview");

            if (macro && !label && area > bestNamedArea) {
                bestNamed = series;
                bestNamedArea = area;
            }
            if (!label && area > bestFallbackArea) {
                bestFallback = series;
                bestFallbackArea = area;
            }
        }
        return bestNamed >= 0 ? bestNamed : bestFallback;
    }

    private String seriesName(MetadataRetrieve metadata, int series) {
        if (metadata == null) return "";
        try {
            String name = metadata.getImageName(series);
            return name == null ? "" : name;
        } catch (RuntimeException ignored) {
            return "";
        }
    }

    private int chooseLabelSeries(BufferedImageReader reader) {
        int upper = Math.min(ImageContext.FLUORESCENCE_SERIES, reader.getSeriesCount());
        if (upper <= 0) {
            throw new IllegalStateException("This slide does not expose a label associated-image series.");
        }

        MetadataRetrieve metadata = reader.getMetadataStore() instanceof MetadataRetrieve retrieve
                ? retrieve : null;
        int bestNamed = -1;
        long bestNamedArea = -1;
        int bestFallback = -1;
        double bestFallbackScore = Double.NEGATIVE_INFINITY;

        for (int series = 0; series < upper; series++) {
            reader.setSeries(series);
            long width = reader.getSizeX();
            long height = reader.getSizeY();
            if (width <= 0 || height <= 0) continue;

            String name = seriesName(metadata, series).toLowerCase();
            boolean namedLabel = name.contains("label") || name.contains("barcode")
                    || name.contains("slide label");
            long area = width * height;
            if (namedLabel && area > bestNamedArea) {
                bestNamed = series;
                bestNamedArea = area;
            }

            double longSide = Math.max(width, height);
            double shortSide = Math.min(width, height);
            double aspect = longSide / Math.max(1.0, shortSide);
            double score = aspect * 10.0 - Math.log1p(area);
            if (score > bestFallbackScore) {
                bestFallbackScore = score;
                bestFallback = series;
            }
        }
        if (bestNamed >= 0) return bestNamed;
        if (bestFallback >= 0) return bestFallback;
        throw new IllegalStateException("This slide does not expose a readable label associated-image series.");
    }

    private BufferedImage scaleToFit(BufferedImage source, int maxWidth, int maxHeight) {
        if (source.getWidth() <= maxWidth && source.getHeight() <= maxHeight) return source;
        double scale = Math.min(maxWidth / (double) source.getWidth(), maxHeight / (double) source.getHeight());
        int width = Math.max(1, (int) Math.round(source.getWidth() * scale));
        int height = Math.max(1, (int) Math.round(source.getHeight() * scale));
        BufferedImage scaled = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        Graphics2D graphics = scaled.createGraphics();
        try {
            graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
            graphics.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
            graphics.drawImage(source, 0, 0, width, height, null);
        } finally {
            graphics.dispose();
        }
        return scaled;
    }

    public DisplayResponse getDisplay(String imageId, HttpSession session) throws Exception {
        ImageContext context = context(imageId);
        SessionDisplayState state = sessionState(session, imageId, context);
        synchronized (state) { return toDisplayResponse(state, context); }
    }

    public PixelSampleResponse getPixelSample(String imageId, int x, int y) throws Exception {
        ImageContext context = context(imageId);
        synchronized (context) {
            IFormatReader reader = context.reader();
            reader.setResolution(0);
            if (x < 0 || y < 0 || x >= reader.getSizeX() || y >= reader.getSizeY()) {
                throw new IllegalArgumentException("Pixel coordinates are outside the image.");
            }
            if (context.isRgb()) {
                int[] rgb = readRgbRegion(reader, x, y, 1, 1);
                int value = rgb[0];
                return new PixelSampleResponse(x, y, List.of(
                        (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff));
            }
            boolean littleEndian = reader.isLittleEndian();
            List<Integer> values = new ArrayList<>(reader.getSizeC());
            for (int channel = 0; channel < reader.getSizeC(); channel++) {
                byte[] pixel = reader.openBytes(reader.getIndex(0, channel, 0), x, y, 1, 1);
                int first = pixel[0] & 0xff;
                int second = pixel[1] & 0xff;
                values.add(littleEndian ? first | (second << 8) : (first << 8) | second);
            }
            return new PixelSampleResponse(x, y, values);
        }
    }

    public PixelBlockResponse getPixelBlock(String imageId, int x, int y, int requestedSize) throws Exception {
        ImageContext context = context(imageId);
        synchronized (context) {
            IFormatReader reader = context.reader();
            reader.setResolution(0);

            int size = Math.max(8, Math.min(requestedSize, 128));
            int blockX = Math.max(0, Math.min(x, reader.getSizeX() - 1));
            int blockY = Math.max(0, Math.min(y, reader.getSizeY() - 1));
            int width = Math.min(size, reader.getSizeX() - blockX);
            int height = Math.min(size, reader.getSizeY() - blockY);
            if (context.isRgb()) {
                int[] rgb = readRgbRegion(reader, blockX, blockY, width, height);
                List<Integer> values = new ArrayList<>(width * height * 3);
                for (int channel = 0; channel < 3; channel++) {
                    int shift = channel == 0 ? 16 : channel == 1 ? 8 : 0;
                    for (int value : rgb) values.add((value >> shift) & 0xff);
                }
                return new PixelBlockResponse(blockX, blockY, width, height, 3, values);
            }
            int channels = reader.getSizeC();
            boolean littleEndian = reader.isLittleEndian();

            List<Integer> values = new ArrayList<>(width * height * channels);
            for (int channel = 0; channel < channels; channel++) {
                byte[] pixels = reader.openBytes(
                        reader.getIndex(0, channel, 0), blockX, blockY, width, height);
                for (int offset = 0; offset < pixels.length; offset += 2) {
                    int first = pixels[offset] & 0xff;
                    int second = pixels[offset + 1] & 0xff;
                    values.add(littleEndian ? first | (second << 8) : (first << 8) | second);
                }
            }
            return new PixelBlockResponse(blockX, blockY, width, height, channels, values);
        }
    }

    public DisplayResponse resetDisplay(String imageId, HttpSession session) throws Exception {
        ImageContext context = context(imageId);
        SessionDisplayState state = sessionState(session, imageId, context);
        synchronized (state) {
            state.reset(context.newDefaultDisplayModel());
            return toDisplayResponse(state, context);
        }
    }

    public DisplayResponse recomputeAutomaticDisplay(String imageId, HttpSession session) throws Exception {
        ImageContext context = context(imageId);
        synchronized (context) {
            context.recomputeAutomaticWindows();
        }
        SessionDisplayState state = sessionState(session, imageId, context);
        synchronized (state) {
            state.reset(context.newDefaultDisplayModel());
            return toDisplayResponse(state, context);
        }
    }

    public DisplayResponse updateDisplay(String imageId, DisplayUpdateRequest request,
                                         HttpSession session) throws Exception {
        if (request == null || request.channels() == null) {
            throw new IllegalArgumentException("Display update must contain channels.");
        }
        ImageContext context = context(imageId);
        SessionDisplayState state = sessionState(session, imageId, context);
        synchronized (state) {
            DisplayModel model = state.model();
            if (request.channels().size() != model.getChannelCount()) {
                throw new IllegalArgumentException("Expected " + model.getChannelCount()
                        + " channels but received " + request.channels().size() + ".");
            }
            for (ChannelDisplayDto dto : request.channels()) {
                if (dto.index() < 0 || dto.index() >= model.getChannelCount()) {
                    throw new IllegalArgumentException("Invalid channel index: " + dto.index());
                }
                ChannelDisplaySettings settings = model.getChannel(dto.index());
                settings.setVisible(dto.visible());
                settings.setLut(LutType.valueOf(dto.lut().toUpperCase()));
                settings.setWindow(new DisplayWindow(dto.black(), dto.white()));
                settings.setGamma(dto.gamma());
                settings.setOpacity(dto.opacity());
            }
            state.incrementRevision();
            return toDisplayResponse(state, context);
        }
    }

    public byte[] getTile(String imageId, int viewerLevel, int channel,
                          int tileX, int tileY, HttpSession session) throws Exception {
        ImageContext context = context(imageId);
        SessionDisplayState state = sessionState(session, imageId, context);
        synchronized (context) {
            IFormatReader reader = context.reader();
            validateChannel(channel, reader.getSizeC());
            reader.setResolution(bioResolution(reader, viewerLevel));
            TileRegion region = region(reader, tileX, tileY);
            if (region.empty()) return new byte[0];
            byte[] pixels = reader.openBytes(reader.getIndex(0, channel, 0),
                    region.x(), region.y(), region.width(), region.height());
            ChannelDisplaySettings channelSettings;
            synchronized (state) { channelSettings = copySettings(state.model().getChannel(channel)); }
            PixelMapper mapper = new LinearWindowPixelMapper(channelSettings.getWindow(),
                    channelSettings.getLut(), channelSettings.getGamma());
            BufferedImage image = fluorescenceRenderer.render(pixels, region.width(), region.height(),
                    DisplaySettings.forPixelData(reader.isLittleEndian()), mapper);
            return encodePng(image);
        }
    }

    public byte[] getCompositeTile(String imageId, int viewerLevel, int tileX, int tileY,
                                   HttpSession session) throws Exception {
        ImageContext context = context(imageId);
        SessionDisplayState state = sessionState(session, imageId, context);
        List<ChannelDisplaySettings> settingsSnapshot = new ArrayList<>();
        synchronized (state) {
            for (int i = 0; i < state.model().getChannelCount(); i++) {
                settingsSnapshot.add(copySettings(state.model().getChannel(i)));
            }
        }
        synchronized (context) {
            IFormatReader reader = context.reader();
            reader.setResolution(bioResolution(reader, viewerLevel));
            TileRegion region = region(reader, tileX, tileY);
            if (region.empty()) return new byte[0];
            return encodePng(renderCompositeRegion(context, reader, settingsSnapshot,
                    region.x(), region.y(), region.width(), region.height()));
        }
    }

    /** Renders resolution zero with the tile display pipeline and an export-owned reader. */
    public byte[] exportRegion(String imageId, int x, int y, int width, int height,
                               double scale, HttpSession session) throws Exception {
        long totalStarted = System.nanoTime();
        ImageContext context = context(imageId);
        SessionDisplayState state = sessionState(session, imageId, context);
        List<ChannelDisplaySettings> settingsSnapshot = new ArrayList<>();
        synchronized (state) {
            for (int channel = 0; channel < state.model().getChannelCount(); channel++) {
                settingsSnapshot.add(copySettings(state.model().getChannel(channel)));
            }
        }

        long acquisitionStarted = System.nanoTime();
        long acquisitionNanos;
        ExportTimings timings = new ExportTimings();
        try (ExportReaderFactory.ExportReader exportReader =
                     exportReaderFactory.open(context.entry())) {
            acquisitionNanos = System.nanoTime() - acquisitionStarted;
            IFormatReader reader = exportReader.reader();
            exportValidator.validate(x, y, width, height, scale,
                    reader.getSizeX(), reader.getSizeY());

            BufferedImage image = renderCompositeRegion(context, reader, settingsSnapshot,
                    x, y, width, height, timings);
            long scalingStarted = System.nanoTime();
            BufferedImage output = scale == 1.0 ? image : scaleImage(image, scale);
            timings.scalingNanos = System.nanoTime() - scalingStarted;
            long encodingStarted = System.nanoTime();
            byte[] png = encodePng(output);
            timings.encodingNanos = System.nanoTime() - encodingStarted;
            LOGGER.info("Export timing image={} region={}x{} scale={} readerAcquireMs={} decodeMs={} compositeMs={} scaleMs={} pngMs={} totalMs={}",
                    imageId, width, height, scale, milliseconds(acquisitionNanos),
                    milliseconds(timings.decodingNanos), milliseconds(timings.compositingNanos),
                    milliseconds(timings.scalingNanos), milliseconds(timings.encodingNanos),
                    milliseconds(System.nanoTime() - totalStarted));
            return png;
        }
    }

    private BufferedImage renderCompositeRegion(ImageContext context, IFormatReader reader,
                                                List<ChannelDisplaySettings> settings,
                                                int x, int y, int width, int height) throws Exception {
        return renderCompositeRegion(context, reader, settings, x, y, width, height, null);
    }

    private BufferedImage renderCompositeRegion(ImageContext context, IFormatReader reader,
                                                List<ChannelDisplaySettings> settings,
                                                int x, int y, int width, int height,
                                                ExportTimings timings) throws Exception {
        long decodingStarted = System.nanoTime();
        if (context.isRgb()) {
            int[] rgb = readRgbRegion(reader, x, y, width, height);
            if (timings != null) timings.decodingNanos = System.nanoTime() - decodingStarted;
            long compositingStarted = System.nanoTime();
            BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
            image.setRGB(0, 0, width, height, rgb, 0, width);
            if (timings != null) timings.compositingNanos = System.nanoTime() - compositingStarted;
            return image;
        }

        List<byte[]> channelPixels = new ArrayList<>();
        List<PixelMapper> mappers = new ArrayList<>();
        List<Double> opacities = new ArrayList<>();
        for (int channel = 0; channel < settings.size(); channel++) {
            ChannelDisplaySettings channelSettings = settings.get(channel);
            if (!channelSettings.isVisible() || channelSettings.getOpacity() <= 0) continue;
            channelPixels.add(reader.openBytes(reader.getIndex(0, channel, 0), x, y, width, height));
            mappers.add(new LinearWindowPixelMapper(channelSettings.getWindow(),
                    channelSettings.getLut(), channelSettings.getGamma()));
            opacities.add(channelSettings.getOpacity());
        }
        if (timings != null) timings.decodingNanos = System.nanoTime() - decodingStarted;
        long compositingStarted = System.nanoTime();
        BufferedImage image = channelPixels.isEmpty()
                ? new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB)
                : multichannelRenderer.render(channelPixels, width, height,
                DisplaySettings.forPixelData(reader.isLittleEndian()), mappers, opacities);
        if (timings != null) timings.compositingNanos = System.nanoTime() - compositingStarted;
        return image;
    }

    private BufferedImage scaleImage(BufferedImage source, double scale) {
        long scaledWidth = Math.round(source.getWidth() * scale);
        long scaledHeight = Math.round(source.getHeight() * scale);
        if (scaledWidth < 1 || scaledHeight < 1
                || scaledWidth > Integer.MAX_VALUE || scaledHeight > Integer.MAX_VALUE
                || scaledWidth * scaledHeight > Integer.MAX_VALUE) {
            throw new IllegalArgumentException("Scale produces invalid export dimensions.");
        }
        BufferedImage scaled = new BufferedImage((int) scaledWidth, (int) scaledHeight,
                BufferedImage.TYPE_INT_RGB);
        Graphics2D graphics = scaled.createGraphics();
        try {
            graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION,
                    RenderingHints.VALUE_INTERPOLATION_BILINEAR);
            graphics.setRenderingHint(RenderingHints.KEY_RENDERING,
                    RenderingHints.VALUE_RENDER_QUALITY);
            graphics.drawImage(source, 0, 0, scaled.getWidth(), scaled.getHeight(), null);
        } finally {
            graphics.dispose();
        }
        return scaled;
    }


    private int[] readRgbRegion(IFormatReader reader, int x, int y, int width, int height) throws Exception {
        int pixelCount = width * height;
        int[] rgb = new int[pixelCount];
        int bytesPerSample = FormatTools.getBytesPerPixel(reader.getPixelType());
        if (bytesPerSample != 1) {
            throw new IllegalStateException("RGB rendering currently requires 8-bit samples.");
        }
        if (reader.isRGB()) {
            int samples = Math.max(3, reader.getRGBChannelCount());
            byte[] bytes = reader.openBytes(reader.getIndex(0, 0, 0), x, y, width, height);
            if (reader.isInterleaved()) {
                for (int i = 0; i < pixelCount; i++) {
                    int offset = i * samples;
                    int r = bytes[offset] & 0xff;
                    int g = bytes[offset + 1] & 0xff;
                    int b = bytes[offset + 2] & 0xff;
                    rgb[i] = (r << 16) | (g << 8) | b;
                }
            } else {
                int planeSize = pixelCount;
                for (int i = 0; i < pixelCount; i++) {
                    int r = bytes[i] & 0xff;
                    int g = bytes[planeSize + i] & 0xff;
                    int b = bytes[2 * planeSize + i] & 0xff;
                    rgb[i] = (r << 16) | (g << 8) | b;
                }
            }
            return rgb;
        }
        byte[][] channels = new byte[3][];
        for (int channel = 0; channel < 3; channel++) {
            channels[channel] = reader.openBytes(reader.getIndex(0, channel, 0), x, y, width, height);
        }
        for (int i = 0; i < pixelCount; i++) {
            rgb[i] = ((channels[0][i] & 0xff) << 16)
                    | ((channels[1][i] & 0xff) << 8)
                    | (channels[2][i] & 0xff);
        }
        return rgb;
    }

    public String firstImageId() { return registry.getFirst().id(); }

    @SuppressWarnings("unchecked")
    private SessionDisplayState sessionState(HttpSession session, String imageId,
                                             ImageContext context) {
        synchronized (session) {
            Map<String, SessionDisplayState> states =
                    (Map<String, SessionDisplayState>) session.getAttribute(SESSION_STATES);
            if (states == null) {
                states = new HashMap<>();
                session.setAttribute(SESSION_STATES, states);
            }
            return states.computeIfAbsent(imageId,
                    ignored -> new SessionDisplayState(context.newDefaultDisplayModel()));
        }
    }

    private ChannelDisplaySettings copySettings(ChannelDisplaySettings source) {
        ChannelDisplaySettings copy = new ChannelDisplaySettings();
        copy.setVisible(source.isVisible());
        copy.setLut(source.getLut());
        copy.setWindow(source.getWindow());
        copy.setGamma(source.getGamma());
        copy.setOpacity(source.getOpacity());
        return copy;
    }

    private ImageContext context(String imageId) throws Exception {
        ImageRegistry.ImageEntry entry = registry.getRequired(imageId);
        ImageContext existing = contexts.get(imageId);
        if (existing != null) return existing;
        synchronized (contexts) {
            existing = contexts.get(imageId);
            if (existing == null) {
                existing = new ImageContext(entry);
                contexts.put(imageId, existing);
            }
            return existing;
        }
    }

    private DisplayResponse toDisplayResponse(SessionDisplayState state, ImageContext context) {
        List<ChannelDisplayDto> channels = new ArrayList<>();
        DisplayModel model = state.model();
        for (int i = 0; i < model.getChannelCount(); i++) {
            ChannelDisplaySettings settings = model.getChannel(i);
            channels.add(new ChannelDisplayDto(i, context.channelLabel(i), settings.isVisible(),
                    settings.getLut().name(), settings.getWindow().black(),
                    settings.getWindow().white(), settings.getGamma(), settings.getOpacity()));
        }
        return new DisplayResponse(state.revision(), channels);
    }

    private int bioResolution(IFormatReader reader, int viewerLevel) {
        int count = reader.getResolutionCount();
        if (viewerLevel < 0 || viewerLevel >= count) {
            throw new IllegalArgumentException("Viewer level must be between 0 and " + (count - 1) + ".");
        }
        return count - 1 - viewerLevel;
    }

    private TileRegion region(IFormatReader reader, int tileX, int tileY) {
        int x = tileX * ImageContext.TILE_SIZE, y = tileY * ImageContext.TILE_SIZE;
        return new TileRegion(x, y, Math.min(ImageContext.TILE_SIZE, reader.getSizeX() - x),
                Math.min(ImageContext.TILE_SIZE, reader.getSizeY() - y));
    }

    private void validateChannel(int channel, int count) {
        if (channel < 0 || channel >= count) {
            throw new IllegalArgumentException("Channel must be between 0 and " + (count - 1) + ".");
        }
    }

    private byte[] encodePng(BufferedImage image) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        if (!ImageIO.write(image, "png", output)) throw new IllegalStateException("No PNG image writer is available.");
        return output.toByteArray();
    }

    private long milliseconds(long nanos) {
        return nanos / 1_000_000;
    }

    private static final class ExportTimings {
        private long decodingNanos;
        private long compositingNanos;
        private long scalingNanos;
        private long encodingNanos;
    }

    @PreDestroy public void closeReaders() {
        for (ImageContext context : contexts.values()) {
            try { context.close(); }
            catch (Exception exception) {
                System.err.println("Could not close reader for " + context.entry().name() + ": " + exception.getMessage());
            }
        }
    }

    private record TileRegion(int x, int y, int width, int height) {
        boolean empty() { return width <= 0 || height <= 0; }
    }
}
