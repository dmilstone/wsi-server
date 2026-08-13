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
import org.springframework.beans.factory.annotation.Value;
import wsi_server.api.AssociatedImageSeriesDto;
import wsi_server.api.ChannelDisplayDto;
import wsi_server.api.DisplayResponse;
import wsi_server.api.DisplayUpdateRequest;
import wsi_server.api.ImageListResponse;
import wsi_server.api.ImageMetadataResponse;
import wsi_server.api.ImageSeriesProfile;
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
    private final DiagnosticTiming timing;
    private final Map<String, ImageContext> contexts = new ConcurrentHashMap<>();
    private final Map<String, AssociatedImages> associatedImageCache = new ConcurrentHashMap<>();

    public BioFormatsTileService(ImageRegistry registry,
                                 FluorescenceTileRenderer fluorescenceRenderer,
                                 MultichannelTileRenderer multichannelRenderer,
                                 ExportReaderFactory exportReaderFactory,
                                 ExportValidator exportValidator,
                                 @Value("${wsi.diagnostic-timing.enabled:false}") boolean diagnosticTimingEnabled) {
        this.registry = registry;
        this.fluorescenceRenderer = fluorescenceRenderer;
        this.multichannelRenderer = multichannelRenderer;
        this.exportReaderFactory = exportReaderFactory;
        this.exportValidator = exportValidator;
        this.timing = new DiagnosticTiming(diagnosticTimingEnabled);
    }

    public ImageListResponse listImages() {
        try {
            return timing.measure("image_list", "snapshot_read", "registry", this::listImagesMeasured);
        } catch (Exception impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private ImageListResponse listImagesMeasured() {
        List<ImageSummary> images = registry.getImages().stream()
                .map(entry -> new ImageSummary(entry.id(), entry.name(), entry.relativePath(), entry.folder()))
                .toList();
        return new ImageListResponse(registry.getRootDirectory().toString(), images);
    }

    public ImageMetadataResponse getMetadata(String imageId, int series, HttpSession session) throws Exception {
        return timing.measure("metadata", "request_total", imageId,
                () -> getMetadataMeasured(imageId, series, session));
    }

    private ImageMetadataResponse getMetadataMeasured(String imageId, int series, HttpSession session)
            throws Exception {
        ImageContext context = context(imageId, series);
        SessionDisplayState state = sessionState(session, imageId, series, context);
        synchronized (context) {
            IFormatReader reader = context.reader();
            List<ImageSeriesProfile> profiles = catalogSeriesProfiles(reader);
            reader.setSeries(series);
            reader.setResolution(0);
            Double micronsPerPixelX = physicalSizeMicrons(reader, true);
            Double micronsPerPixelY = physicalSizeMicrons(reader, false);
            return new ImageMetadataResponse(imageId, context.entry().relativePath(),
                    reader.getSizeX(), reader.getSizeY(), reader.getSizeC(),
                    reader.getResolutionCount(), ImageContext.TILE_SIZE, state.revision(),
                    micronsPerPixelX, micronsPerPixelY, zPlaneCount(reader.getSizeZ()),
                    series, List.copyOf(profiles));
        }
    }

    /** Bio-Formats sizeZ for 2D slides is often 0/1; always expose at least one focal plane. */
    static int zPlaneCount(int sizeZ) {
        return Math.max(1, sizeZ);
    }

    private List<ImageSeriesProfile> catalogSeriesProfiles(IFormatReader reader) {
        MetadataRetrieve metadata = reader.getMetadataStore() instanceof MetadataRetrieve retrieve
                ? retrieve : null;
        int previous = reader.getSeries();
        List<ImageSeriesProfile> profiles = new ArrayList<>();
        try {
            for (int series = 0; series < reader.getSeriesCount(); series++) {
                reader.setSeries(series);
                profiles.add(new ImageSeriesProfile(
                        series,
                        seriesName(metadata, series),
                        reader.getSizeX(),
                        reader.getSizeY(),
                        reader.getSizeC(),
                        zPlaneCount(reader.getSizeZ()),
                        reader.getResolutionCount(),
                        reader.isRGB(),
                        reader.isThumbnailSeries()));
            }
        } finally {
            reader.setSeries(previous);
        }
        return profiles;
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
        return timing.measure("associated_catalog", "request_total", imageId,
                () -> getAssociatedImageSeriesMeasured(imageId));
    }

    private List<AssociatedImageSeriesDto> getAssociatedImageSeriesMeasured(String imageId) throws Exception {
        ImageRegistry.ImageEntry entry = registry.getRequired(imageId);
        BufferedImageReader reader = timing.measure("associated_catalog", "reader_create", imageId,
                this::createAssociatedImageReader);
        try {
            timing.measureVoid("associated_catalog", "set_id_metadata_parse", imageId,
                    () -> reader.setId(entry.path().toString()));
            MetadataRetrieve metadata = reader.getMetadataStore() instanceof MetadataRetrieve retrieve
                    ? retrieve : null;
            AssociatedImageSelection associated = timing.measure("associated_catalog", "series_search", imageId,
                    () -> selectAssociatedImages(reader, metadata));
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
                        associated.isLabel(series),
                        associated.isOverview(series)));
            }
            return result;
        } finally {
            reader.close();
        }
    }

    public byte[] getSlideLabel(String imageId) throws Exception {
        AssociatedImages images = timing.measure("embedded_label", "request_total", imageId,
                () -> associatedImages(imageId));
        if (images.label() == null) {
            throw new IllegalStateException(AssociatedImageSelection.MISSING_LABEL_MESSAGE);
        }
        return images.label();
    }

    public byte[] getDisplayThumbnail(String imageId, HttpSession session) throws Exception {
        AssociatedImages images = timing.measure("embedded_macro", "request_total", imageId,
                () -> associatedImages(imageId));
        if (images.macro() == null) {
            throw new IllegalStateException(AssociatedImageSelection.MISSING_OVERVIEW_MESSAGE);
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
            BufferedImageReader reader = timing.measure("embedded_bundle", "reader_create", imageId,
                    this::createAssociatedImageReader);
            try {
                timing.measureVoid("embedded_bundle", "set_id_metadata_parse", imageId,
                        () -> reader.setId(entry.path().toString()));
                byte[] label = null;
                byte[] macro = null;
                AssociatedImageSelection selection = AssociatedImageSelection.select(List.of());
                try {
                    MetadataRetrieve metadata = reader.getMetadataStore() instanceof MetadataRetrieve retrieve
                            ? retrieve : null;
                    selection = timing.measure("embedded_bundle", "series_search", imageId,
                            () -> selectAssociatedImages(reader, metadata));
                } catch (Exception ignored) { }
                try {
                    int labelSeries = selection.labelSeries();
                    if (labelSeries >= 0) {
                        reader.setSeries(labelSeries);
                        BufferedImage source = timing.measure("embedded_label", "open_bytes_decode", imageId,
                                () -> reader.openImage(0));
                        BufferedImage rendered = timing.measure("embedded_label", "render_scale", imageId,
                                () -> scaleToFit(source, 1000, 420));
                        label = timing.measure("embedded_label", "png_encode", imageId,
                                () -> encodePng(rendered));
                    }
                } catch (Exception ignored) { }
                try {
                    int macroSeries = selection.overviewSeries();
                    if (macroSeries >= 0) {
                        reader.setSeries(macroSeries);
                        BufferedImage source = timing.measure("embedded_macro", "open_bytes_decode", imageId,
                                () -> reader.openImage(0));
                        BufferedImage rendered = timing.measure("embedded_macro", "render_scale", imageId,
                                () -> scaleToFit(source, 1200, 900));
                        macro = timing.measure("embedded_macro", "png_encode", imageId,
                                () -> encodePng(rendered));
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

    private AssociatedImageSelection selectAssociatedImages(BufferedImageReader reader, MetadataRetrieve metadata) {
        int upper = Math.min(ImageContext.FLUORESCENCE_SERIES, reader.getSeriesCount());
        List<AssociatedImageSelection.SeriesIdentity> identities = new ArrayList<>();
        for (int series = 0; series < upper; series++) {
            reader.setSeries(series);
            identities.add(new AssociatedImageSelection.SeriesIdentity(series, seriesName(metadata, series),
                    reader.getSizeX(), reader.getSizeY(), reader.isThumbnailSeries()));
        }
        return AssociatedImageSelection.select(identities);
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

    public DisplayResponse getDisplay(String imageId, int series, HttpSession session) throws Exception {
        ImageContext context = context(imageId, series);
        SessionDisplayState state = sessionState(session, imageId, series, context);
        synchronized (state) { return toDisplayResponse(state, context); }
    }

    public PixelSampleResponse getPixelSample(String imageId, int series, int x, int y) throws Exception {
        ImageContext context = context(imageId, series);
        synchronized (context) {
            IFormatReader reader = context.reader();
            reader.setSeries(series);
            reader.setResolution(0);
            if (x < 0 || y < 0 || x >= reader.getSizeX() || y >= reader.getSizeY()) {
                throw new IllegalArgumentException("Pixel coordinates are outside the image.");
            }
            if (context.isRgb()) {
                int[] rgb = readRgbRegion(reader, x, y, 1, 1, 0);
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

    public PixelBlockResponse getPixelBlock(String imageId, int series, int x, int y, int requestedSize)
            throws Exception {
        ImageContext context = context(imageId, series);
        synchronized (context) {
            IFormatReader reader = context.reader();
            reader.setSeries(series);
            reader.setResolution(0);

            int size = Math.max(8, Math.min(requestedSize, 128));
            int blockX = Math.max(0, Math.min(x, reader.getSizeX() - 1));
            int blockY = Math.max(0, Math.min(y, reader.getSizeY() - 1));
            int width = Math.min(size, reader.getSizeX() - blockX);
            int height = Math.min(size, reader.getSizeY() - blockY);
            if (context.isRgb()) {
                int[] rgb = readRgbRegion(reader, blockX, blockY, width, height, 0);
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

    public DisplayResponse resetDisplay(String imageId, int series, HttpSession session) throws Exception {
        ImageContext context = context(imageId, series);
        SessionDisplayState state = sessionState(session, imageId, series, context);
        synchronized (state) {
            state.reset(context.newDefaultDisplayModel());
            return toDisplayResponse(state, context);
        }
    }

    public DisplayResponse recomputeAutomaticDisplay(String imageId, int series, HttpSession session)
            throws Exception {
        ImageContext context = context(imageId, series);
        synchronized (context) {
            context.recomputeAutomaticWindows();
        }
        SessionDisplayState state = sessionState(session, imageId, series, context);
        synchronized (state) {
            state.reset(context.newDefaultDisplayModel());
            return toDisplayResponse(state, context);
        }
    }

    public DisplayResponse updateDisplay(String imageId, int series, DisplayUpdateRequest request,
                                         HttpSession session) throws Exception {
        if (request == null || request.channels() == null) {
            throw new IllegalArgumentException("Display update must contain channels.");
        }
        ImageContext context = context(imageId, series);
        SessionDisplayState state = sessionState(session, imageId, series, context);
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
                          int tileX, int tileY, int z, int series, HttpSession session) throws Exception {
        ImageContext context = context(imageId, series);
        SessionDisplayState state = sessionState(session, imageId, series, context);
        synchronized (context) {
            IFormatReader reader = context.reader();
            reader.setSeries(series);
            validateChannel(channel, reader.getSizeC());
            validateZ(z, reader.getSizeZ());
            reader.setResolution(bioResolution(reader, viewerLevel));
            TileRegion region = region(reader, tileX, tileY);
            if (region.empty()) return new byte[0];
            byte[] pixels = reader.openBytes(reader.getIndex(z, channel, 0),
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
                                   int z, int series, HttpSession session) throws Exception {
        ImageContext context = context(imageId, series);
        SessionDisplayState state = sessionState(session, imageId, series, context);
        List<ChannelDisplaySettings> settingsSnapshot = new ArrayList<>();
        synchronized (state) {
            for (int i = 0; i < state.model().getChannelCount(); i++) {
                settingsSnapshot.add(copySettings(state.model().getChannel(i)));
            }
        }
        synchronized (context) {
            IFormatReader reader = context.reader();
            reader.setSeries(series);
            validateZ(z, reader.getSizeZ());
            reader.setResolution(bioResolution(reader, viewerLevel));
            TileRegion region = region(reader, tileX, tileY);
            if (region.empty()) return new byte[0];
            return encodePng(renderCompositeRegion(context, reader, settingsSnapshot,
                    region.x(), region.y(), region.width(), region.height(), z));
        }
    }

    /** Renders resolution zero with the tile display pipeline and an export-owned reader. */
    public byte[] exportRegion(String imageId, int x, int y, int width, int height,
                               double scale, HttpSession session) throws Exception {
        long totalStarted = System.nanoTime();
        int series = ImageContext.FLUORESCENCE_SERIES;
        ImageContext context = context(imageId, series);
        SessionDisplayState state = sessionState(session, imageId, series, context);
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
                    x, y, width, height, 0, timings);
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
                                                int x, int y, int width, int height,
                                                int z) throws Exception {
        return renderCompositeRegion(context, reader, settings, x, y, width, height, z, null);
    }

    private BufferedImage renderCompositeRegion(ImageContext context, IFormatReader reader,
                                                List<ChannelDisplaySettings> settings,
                                                int x, int y, int width, int height,
                                                int z, ExportTimings timings) throws Exception {
        long decodingStarted = System.nanoTime();
        if (context.isRgb()) {
            int[] rgb = readRgbRegion(reader, x, y, width, height, z);
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
            channelPixels.add(reader.openBytes(reader.getIndex(z, channel, 0), x, y, width, height));
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


    private int[] readRgbRegion(IFormatReader reader, int x, int y, int width, int height, int z)
            throws Exception {
        int pixelCount = width * height;
        int[] rgb = new int[pixelCount];
        int bytesPerSample = FormatTools.getBytesPerPixel(reader.getPixelType());
        if (bytesPerSample != 1) {
            throw new IllegalStateException("RGB rendering currently requires 8-bit samples.");
        }
        if (reader.isRGB()) {
            int samples = Math.max(3, reader.getRGBChannelCount());
            byte[] bytes = reader.openBytes(reader.getIndex(z, 0, 0), x, y, width, height);
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
            channels[channel] = reader.openBytes(reader.getIndex(z, channel, 0), x, y, width, height);
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
    private SessionDisplayState sessionState(HttpSession session, String imageId, int series,
                                             ImageContext context) {
        String stateKey = sessionStateKey(imageId, series);
        synchronized (session) {
            Map<String, SessionDisplayState> states =
                    (Map<String, SessionDisplayState>) session.getAttribute(SESSION_STATES);
            if (states == null) {
                states = new HashMap<>();
                session.setAttribute(SESSION_STATES, states);
            }
            return states.computeIfAbsent(stateKey,
                    ignored -> new SessionDisplayState(context.newDefaultDisplayModel()));
        }
    }

    static String sessionStateKey(String imageId, int series) {
        return imageId + "#" + series;
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

    private ImageContext context(String imageId, int series) throws Exception {
        ImageRegistry.ImageEntry entry = registry.getRequired(imageId);
        String key = sessionStateKey(imageId, series);
        ImageContext existing = contexts.get(key);
        if (existing != null) return existing;
        synchronized (contexts) {
            existing = contexts.get(key);
            if (existing == null) {
                existing = new ImageContext(entry, timing, series);
                contexts.put(key, existing);
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

    private void validateZ(int z, int sizeZ) {
        int planes = zPlaneCount(sizeZ);
        if (z < 0 || z >= planes) {
            throw new IllegalArgumentException("Z-plane must be between 0 and " + (planes - 1) + ".");
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
