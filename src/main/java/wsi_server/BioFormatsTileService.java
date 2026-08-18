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
import wsi_server.plugin.PluginSampleGrid;
import wsi_server.renderer.FluorescenceTileRenderer;
import wsi_server.renderer.MultichannelTileRenderer;

import javax.imageio.ImageIO;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
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
    private final BioFormatsReaderPool readerPool;
    private final PngTileCache tileCache;
    private final WsiReaderEngineFactory engineFactory;
    private final Map<String, ImageContext> contexts = new ConcurrentHashMap<>();
    private final Map<String, AssociatedImages> associatedImageCache = new ConcurrentHashMap<>();
    private final Map<String, Object> associatedLocks = new ConcurrentHashMap<>();

    public BioFormatsTileService(ImageRegistry registry,
                                 FluorescenceTileRenderer fluorescenceRenderer,
                                 MultichannelTileRenderer multichannelRenderer,
                                 ExportReaderFactory exportReaderFactory,
                                 ExportValidator exportValidator,
                                 BioFormatsReaderPool readerPool,
                                 PngTileCache tileCache,
                                 WsiReaderEngineFactory engineFactory,
                                 @Value("${wsi.diagnostic-timing.enabled:false}") boolean diagnosticTimingEnabled) {
        this.registry = registry;
        this.fluorescenceRenderer = fluorescenceRenderer;
        this.multichannelRenderer = multichannelRenderer;
        this.exportReaderFactory = exportReaderFactory;
        this.exportValidator = exportValidator;
        this.readerPool = readerPool;
        this.tileCache = tileCache;
        this.engineFactory = engineFactory;
        this.timing = new DiagnosticTiming(diagnosticTimingEnabled);
        if (this.engineFactory != null) this.engineFactory.ensureNativeLibraries();
    }

    public ImageListResponse listImages() {
        try {
            return timing.measure("image_list", "snapshot_read", "registry", this::listImagesMeasured);
        } catch (Exception impossible) {
            impossible.printStackTrace();
            throw new IllegalStateException(impossible);
        }
    }

    private ImageListResponse listImagesMeasured() {
        List<ImageSummary> images = registry.getImages().stream()
                .map(entry -> new ImageSummary(
                        entry.id(),
                        entry.name(),
                        entry.relativePath(),
                        entry.folder(),
                        entry.clinicalMarker(),
                        entry.zPlanes(),
                        entry.depth(),
                        entry.zLayers(),
                        entry.modality(),
                        entry.engine()))
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
        return context.withReader(reader -> {
            List<ImageSeriesProfile> profiles = catalogSeriesProfiles(reader);
            reader.setSeries(series);
            reader.setResolution(0);
            Double micronsPerPixelX = physicalSizeMicrons(reader, true);
            Double micronsPerPixelY = physicalSizeMicrons(reader, false);
            return new ImageMetadataResponse(imageId, context.entry().relativePath(),
                    reader.getSizeX(), reader.getSizeY(), reader.getSizeC(),
                    reader.getResolutionCount(), ImageContext.TILE_SIZE, state.revision(),
                    micronsPerPixelX, micronsPerPixelY, zPlaneCount(reader.getSizeZ()),
                    series, List.copyOf(profiles),
                    context.entry().modality(), context.entry().engine(), context.isRgb());
        });
    }

    /** Bio-Formats sizeZ for 2D slides is often 0/1; always expose at least one focal plane. */
    static int zPlaneCount(int sizeZ) {
        return Math.max(1, sizeZ);
    }

    /** RGB / H&E planes are often a single Z; keep leftover channel-stack Z requests on-screen. */
    static int clampRgbZ(int z, int sizeZ) {
        int planes = zPlaneCount(sizeZ);
        if (z < 0) return 0;
        return Math.min(z, planes - 1);
    }

    private List<ImageSeriesProfile> catalogSeriesProfiles(IFormatReader reader) {
        MetadataRetrieve metadata = reader.getMetadataStore() instanceof MetadataRetrieve retrieve
                ? retrieve : null;
        int previous = reader.getSeries();
        List<ImageSeriesProfile> profiles = new ArrayList<>();
        try {
            for (int index = 0; index < reader.getSeriesCount(); index++) {
                reader.setSeries(index);
                String name = seriesName(metadata, index);
                boolean thumbnail = reader.isThumbnailSeries();
                profiles.add(new ImageSeriesProfile(
                        index,
                        name,
                        reader.getSizeX(),
                        reader.getSizeY(),
                        reader.getSizeC(),
                        zPlaneCount(reader.getSizeZ()),
                        reader.getResolutionCount(),
                        reader.isRGB(),
                        thumbnail,
                        AssociatedImageSelection.isDiagnosticSpecimen(name, thumbnail)));
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
        return getSlideLabel(imageId, 0);
    }

    public byte[] getSlideLabel(String imageId, int maxEdge) throws Exception {
        AssociatedImages images = timing.measure("embedded_label", "request_total", imageId,
                () -> associatedImages(imageId, true, false));
        if (images.label() == null) {
            throw new IllegalStateException(AssociatedImageSelection.MISSING_LABEL_MESSAGE);
        }
        if (maxEdge > 0 && maxEdge < 1000) {
            return scalePngToFit(images.label(), maxEdge, maxEdge);
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
        return associatedImages(imageId, true, true);
    }

    private boolean associatedSatisfies(AssociatedImages images, boolean needLabel, boolean needMacro) {
        if (images == null) return false;
        if (needLabel && images.label() == null) return false;
        if (needMacro && images.macro() == null) return false;
        return true;
    }

    private AssociatedImages associatedImages(String imageId, boolean needLabel, boolean needMacro)
            throws Exception {
        AssociatedImages cached = associatedImageCache.get(imageId);
        if (associatedSatisfies(cached, needLabel, needMacro)) return cached;
        Object lock = associatedLocks.computeIfAbsent(imageId, id -> new Object());
        synchronized (lock) {
            cached = associatedImageCache.get(imageId);
            if (associatedSatisfies(cached, needLabel, needMacro)) return cached;
            ImageRegistry.ImageEntry entry = registry.getRequired(imageId);
            BufferedImageReader reader = timing.measure("embedded_bundle", "reader_create", imageId,
                    this::createAssociatedImageReader);
            try {
                timing.measureVoid("embedded_bundle", "set_id_metadata_parse", imageId,
                        () -> reader.setId(entry.path().toString()));
                byte[] label = cached != null ? cached.label() : null;
                byte[] macro = cached != null ? cached.macro() : null;
                AssociatedImageSelection selection = AssociatedImageSelection.select(List.of());
                try {
                    MetadataRetrieve metadata = reader.getMetadataStore() instanceof MetadataRetrieve retrieve
                            ? retrieve : null;
                    selection = timing.measure("embedded_bundle", "series_search", imageId,
                            () -> selectAssociatedImages(reader, metadata));
                } catch (Exception ignored) { }
                if (needLabel && label == null) {
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
                }
                if (needMacro && macro == null) {
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
                }
                cached = new AssociatedImages(label, macro);
                associatedImageCache.put(imageId, cached);
                return cached;
            } finally {
                reader.close();
            }
        }
    }

    private byte[] scalePngToFit(byte[] png, int maxWidth, int maxHeight) {
        try {
            BufferedImage source = ImageIO.read(new ByteArrayInputStream(png));
            if (source == null) return png;
            return encodePng(scaleToFit(source, maxWidth, maxHeight));
        } catch (Exception ignored) {
            return png;
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
        return context.withReader(reader -> {
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
        });
    }

    public PixelBlockResponse getPixelBlock(String imageId, int series, int x, int y, int requestedSize)
            throws Exception {
        ImageContext context = context(imageId, series);
        return context.withReader(reader -> {
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
        });
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
        context.recomputeAutomaticWindows();
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
        if (context.isRgb()) {
            return getCompositeTile(imageId, viewerLevel, tileX, tileY,
                    clampRgbZ(z, context.sizeZ()), series, session);
        }
        SessionDisplayState state = sessionState(session, imageId, series, context);
        validateZ(z, context.sizeZ());
        long revision;
        ChannelDisplaySettings channelSettings;
        synchronized (state) {
            validateChannel(channel, state.model().getChannelCount());
            revision = state.revision();
            channelSettings = copySettings(state.model().getChannel(channel));
        }
        String cacheKey = PngTileCache.key(imageId, z, "c" + channel, viewerLevel, tileX, tileY,
                revision, displayFingerprint(channelSettings));
        byte[] cached = tileCache.get(cacheKey);
        if (cached != null) return cached;
        byte[] png = context.withReader(reader -> {
            validateChannel(channel, reader.getSizeC());
            reader.setResolution(bioResolution(reader, viewerLevel));
            TileRegion region = region(reader, tileX, tileY);
            if (region.empty()) return new byte[0];
            byte[] pixels = reader.openBytes(reader.getIndex(z, channel, 0),
                    region.x(), region.y(), region.width(), region.height());
            PixelMapper mapper = new LinearWindowPixelMapper(channelSettings.getWindow(),
                    channelSettings.getLut(), channelSettings.getGamma());
            BufferedImage image = fluorescenceRenderer.render(pixels, region.width(), region.height(),
                    DisplaySettings.forPixelData(reader.isLittleEndian()), mapper);
            return encodePng(image);
        });
        tileCache.put(cacheKey, png);
        return png;
    }

    public byte[] getCompositeTile(String imageId, int viewerLevel, int tileX, int tileY,
                                   int z, int series, HttpSession session) throws Exception {
        ImageContext context = context(imageId, series);
        SessionDisplayState state = sessionState(session, imageId, series, context);
        validateZ(z, context.sizeZ());
        long revision;
        List<ChannelDisplaySettings> settingsSnapshot = new ArrayList<>();
        synchronized (state) {
            revision = state.revision();
            for (int i = 0; i < state.model().getChannelCount(); i++) {
                settingsSnapshot.add(copySettings(state.model().getChannel(i)));
            }
        }
        String cacheKey = PngTileCache.key(imageId, z, "composite", viewerLevel, tileX, tileY,
                revision, displayFingerprint(settingsSnapshot));
        byte[] cached = tileCache.get(cacheKey);
        if (cached != null) return cached;
        byte[] png = context.withReader(reader -> {
            reader.setResolution(bioResolution(reader, viewerLevel));
            TileRegion region = region(reader, tileX, tileY);
            if (region.empty()) return new byte[0];
            return encodePng(renderCompositeRegion(context, reader, settingsSnapshot,
                    region.x(), region.y(), region.width(), region.height(), z));
        });
        tileCache.put(cacheKey, png);
        return png;
    }

    /**
     * Native-resolution crop of a slide region for analysis. Picks a pyramid
     * level so the raster stays within {@code maxEdge} and the export pixel cap,
     * instead of using the viewer's already-downsampled canvas.
     */
    public byte[] renderAnalysisRegion(String imageId, int series, int z,
                                       int x, int y, int width, int height,
                                       int maxEdge, HttpSession session) throws Exception {
        ImageContext context = context(imageId, series);
        SessionDisplayState state = sessionState(session, imageId, series, context);
        List<ChannelDisplaySettings> settingsSnapshot = new ArrayList<>();
        synchronized (state) {
            for (int channel = 0; channel < state.model().getChannelCount(); channel++) {
                settingsSnapshot.add(copySettings(state.model().getChannel(channel)));
            }
        }
        int cap = maxEdge > 0 ? Math.min(maxEdge, 4096) : 2048;
        return context.withReader(reader -> {
            validateZ(z, reader.getSizeZ());
            reader.setResolution(0);
            int fullW = reader.getSizeX();
            int fullH = reader.getSizeY();
            int rx = Math.max(0, Math.min(x, fullW - 1));
            int ry = Math.max(0, Math.min(y, fullH - 1));
            int rw = Math.max(1, Math.min(width, fullW - rx));
            int rh = Math.max(1, Math.min(height, fullH - ry));
            int level = 0;
            int count = Math.max(1, reader.getResolutionCount());
            while (level < count - 1) {
                reader.setResolution(level);
                double sx = fullW / (double) Math.max(1, reader.getSizeX());
                int outW = Math.max(1, (int) Math.round(rw / sx));
                int outH = Math.max(1, (int) Math.round(rh / sx));
                if (outW <= cap && outH <= cap && (long) outW * outH <= 16_000_000L) break;
                level += 1;
            }
            reader.setResolution(level);
            double scale = fullW / (double) Math.max(1, reader.getSizeX());
            int lx = Math.max(0, (int) Math.floor(rx / scale));
            int ly = Math.max(0, (int) Math.floor(ry / scale));
            int lw = Math.max(1, Math.min(reader.getSizeX() - lx, (int) Math.ceil(rw / scale)));
            int lh = Math.max(1, Math.min(reader.getSizeY() - ly, (int) Math.ceil(rh / scale)));
            try {
                BufferedImage image = renderCompositeRegion(context, reader, settingsSnapshot, lx, ly, lw, lh, z);
                if (Math.max(image.getWidth(), image.getHeight()) > cap) {
                    image = scaleToFit(image, cap, cap);
                }
                return encodePng(image);
            } finally {
                reader.setResolution(0);
            }
        });
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
                                                int x, int y, int width, int height, int z) throws Exception {
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
                try {
                    if (engineFactory != null && isBrightfieldEntry(entry)) {
                        engineFactory.open(entry);
                    }
                    existing = new ImageContext(entry, timing, series, readerPool);
                    contexts.put(key, existing);
                } catch (Exception exception) {
                    exception.printStackTrace();
                    throw exception;
                }
            }
            return existing;
        }
    }

    private static boolean isBrightfieldEntry(ImageRegistry.ImageEntry entry) {
        if (entry == null) return false;
        return WsiCatalogScanner.ENGINE_OPENSLIDE.equals(entry.engine())
                || WsiCatalogScanner.MODALITY_BRIGHTFIELD.equals(entry.modality())
                || WsiCatalogScanner.isOpenSlideExtension(entry.path());
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

    private static String displayFingerprint(ChannelDisplaySettings settings) {
        return (settings.isVisible() ? "1" : "0")
                + ":" + settings.getLut().name()
                + ":" + settings.getWindow().black()
                + ":" + settings.getWindow().white()
                + ":" + settings.getGamma()
                + ":" + settings.getOpacity();
    }

    private static String displayFingerprint(List<ChannelDisplaySettings> settings) {
        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < settings.size(); i++) {
            if (i > 0) builder.append('|');
            builder.append(displayFingerprint(settings.get(i)));
        }
        return builder.toString();
    }

    /**
     * Raw intensity planes for plugin analysis. Large footprints are read at a
     * pyramid level that stays at or under {@code 512×512} samples.
     */
    public PluginSampleGrid readPluginSampleGrid(
            String imageId,
            int series,
            int z,
            int x,
            int y,
            int width,
            int height,
            List<String> requestedChannels
    ) throws Exception {
        ImageContext context = context(imageId, series);
        return context.withReader(reader -> {
            reader.setResolution(0);
            int fullX = context.sizeX();
            int fullY = context.sizeY();
            int clipX = Math.max(0, x);
            int clipY = Math.max(0, y);
            int clipW = Math.max(0, Math.min(width, fullX - clipX));
            int clipH = Math.max(0, Math.min(height, fullY - clipY));
            if (clipW <= 0 || clipH <= 0) {
                throw new IllegalArgumentException("Plugin region is outside the image.");
            }
            int planeZ = Math.max(0, Math.min(z, Math.max(0, context.sizeZ() - 1)));
            int maxPixels = 512 * 512;
            int resolution = 0;
            if ((long) clipW * clipH > maxPixels) {
                int count = Math.max(1, reader.getResolutionCount());
                for (int res = 1; res < count; res++) {
                    reader.setResolution(res);
                    double sx = reader.getSizeX() / (double) fullX;
                    double sy = reader.getSizeY() / (double) fullY;
                    int rw = Math.max(1, (int) Math.round(clipW * sx));
                    int rh = Math.max(1, (int) Math.round(clipH * sy));
                    resolution = res;
                    if ((long) rw * rh <= maxPixels) break;
                }
            }
            reader.setResolution(resolution);
            double scaleX = reader.getSizeX() / (double) fullX;
            double scaleY = reader.getSizeY() / (double) fullY;
            int sampleX = Math.max(0, Math.min(reader.getSizeX() - 1, (int) Math.floor(clipX * scaleX)));
            int sampleY = Math.max(0, Math.min(reader.getSizeY() - 1, (int) Math.floor(clipY * scaleY)));
            int sampleW = Math.max(1, Math.min(reader.getSizeX() - sampleX, Math.max(1, (int) Math.round(clipW * scaleX))));
            int sampleH = Math.max(1, Math.min(reader.getSizeY() - sampleY, Math.max(1, (int) Math.round(clipH * scaleY))));
            if ((long) sampleW * sampleH > maxPixels) {
                double shrink = Math.sqrt(maxPixels / (double) sampleW / sampleH);
                sampleW = Math.max(1, (int) Math.floor(sampleW * shrink));
                sampleH = Math.max(1, (int) Math.floor(sampleH * shrink));
            }

            int[] channelIndexes = resolvePluginChannels(context, requestedChannels);
            String[] names = new String[channelIndexes.length];
            int[][] planes = new int[channelIndexes.length][];
            if (context.isRgb()) {
                int[] rgb = readRgbRegion(reader, sampleX, sampleY, sampleW, sampleH, planeZ);
                for (int i = 0; i < channelIndexes.length; i++) {
                    int channel = channelIndexes[i];
                    names[i] = pluginChannelName(context, channel, requestedChannels, i);
                    int shift = channel == 0 ? 16 : channel == 1 ? 8 : 0;
                    int[] plane = new int[rgb.length];
                    for (int p = 0; p < rgb.length; p++) {
                        plane[p] = (rgb[p] >> shift) & 0xff;
                    }
                    planes[i] = plane;
                }
            } else {
                boolean littleEndian = reader.isLittleEndian();
                int bytesPerSample = FormatTools.getBytesPerPixel(reader.getPixelType());
                for (int i = 0; i < channelIndexes.length; i++) {
                    int channel = channelIndexes[i];
                    names[i] = pluginChannelName(context, channel, requestedChannels, i);
                    byte[] bytes = reader.openBytes(
                            reader.getIndex(planeZ, channel, 0), sampleX, sampleY, sampleW, sampleH);
                    planes[i] = decodeIntensityPlane(bytes, sampleW * sampleH, bytesPerSample, littleEndian);
                }
            }
            return new PluginSampleGrid(
                    clipX,
                    clipY,
                    clipW,
                    clipH,
                    sampleX,
                    sampleY,
                    sampleW,
                    sampleH,
                    scaleX,
                    scaleY,
                    List.of(names),
                    channelIndexes,
                    planes
            );
        });
    }

    private static final String[] PLUGIN_BAND_NAMES = {"DAPI", "FITC", "TRITC"};

    private static int[] resolvePluginChannels(ImageContext context, List<String> requested) {
        int sizeC = Math.max(1, context.sizeC());
        if (requested == null || requested.isEmpty()) {
            int count = Math.min(3, sizeC);
            int[] indexes = new int[count];
            for (int i = 0; i < count; i++) indexes[i] = i;
            return indexes;
        }
        List<Integer> resolved = new ArrayList<>();
        for (String token : requested) {
            int index = pluginChannelIndex(token, context, sizeC);
            if (index >= 0 && !resolved.contains(index)) resolved.add(index);
        }
        if (resolved.isEmpty()) {
            throw new IllegalArgumentException("No matching channels for plugin request.");
        }
        return resolved.stream().mapToInt(Integer::intValue).toArray();
    }

    private static int pluginChannelIndex(String token, ImageContext context, int sizeC) {
        String raw = token == null ? "" : token.trim();
        if (raw.isEmpty()) return -1;
        try {
            int parsed = Integer.parseInt(raw);
            if (parsed >= 0 && parsed < sizeC) return parsed;
        } catch (NumberFormatException ignored) {
            // Fall through to name matching.
        }
        String key = raw.toUpperCase(java.util.Locale.ROOT).replace("CHANNEL", "").trim();
        if (key.equals("DAPI") || key.equals("BLUE") || key.equals("1") || key.equals("B")) {
            return sizeC > 0 ? 0 : -1;
        }
        if (key.equals("FITC") || key.equals("GREEN") || key.equals("2") || key.equals("G")) {
            return sizeC > 1 ? 1 : -1;
        }
        if (key.equals("TRITC") || key.equals("RED") || key.equals("3") || key.equals("R")) {
            return sizeC > 2 ? 2 : -1;
        }
        for (int i = 0; i < sizeC; i++) {
            String label = context.channelLabel(i);
            if (label != null && label.equalsIgnoreCase(raw)) return i;
        }
        return -1;
    }

    private static String pluginChannelName(
            ImageContext context,
            int channel,
            List<String> requested,
            int requestedIndex
    ) {
        if (requested != null && requestedIndex >= 0 && requestedIndex < requested.size()) {
            String given = requested.get(requestedIndex);
            if (given != null && !given.isBlank()) return given.trim();
        }
        if (channel >= 0 && channel < PLUGIN_BAND_NAMES.length) return PLUGIN_BAND_NAMES[channel];
        return context.channelLabel(channel);
    }

    private static int[] decodeIntensityPlane(byte[] bytes, int pixelCount, int bytesPerSample, boolean littleEndian) {
        int[] plane = new int[pixelCount];
        if (bytes == null || bytes.length == 0) return plane;
        if (bytesPerSample <= 1) {
            int n = Math.min(pixelCount, bytes.length);
            for (int i = 0; i < n; i++) plane[i] = bytes[i] & 0xff;
            return plane;
        }
        int n = Math.min(pixelCount, bytes.length / 2);
        for (int i = 0; i < n; i++) {
            int first = bytes[i * 2] & 0xff;
            int second = bytes[i * 2 + 1] & 0xff;
            plane[i] = littleEndian ? first | (second << 8) : (first << 8) | second;
        }
        return plane;
    }

    @PreDestroy public void closeReaders() {
        try {
            readerPool.close();
        } catch (Exception exception) {
            LOGGER.warn("Could not close the Bio-Formats reader pool: {}", exception.getMessage());
        }
        contexts.clear();
    }

    private record TileRegion(int x, int y, int width, int height) {
        boolean empty() { return width <= 0 || height <= 0; }
    }
}
