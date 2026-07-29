package wsi_server;

import jakarta.annotation.PreDestroy;
import jakarta.servlet.http.HttpSession;
import loci.formats.IFormatReader;
import org.springframework.stereotype.Service;
import wsi_server.api.ChannelDisplayDto;
import wsi_server.api.DisplayResponse;
import wsi_server.api.DisplayUpdateRequest;
import wsi_server.api.ImageListResponse;
import wsi_server.api.ImageMetadataResponse;
import wsi_server.api.ImageSummary;
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

    private final ImageRegistry registry;
    private final FluorescenceTileRenderer fluorescenceRenderer;
    private final MultichannelTileRenderer multichannelRenderer;
    private final Map<String, ImageContext> contexts = new ConcurrentHashMap<>();

    public BioFormatsTileService(ImageRegistry registry,
                                 FluorescenceTileRenderer fluorescenceRenderer,
                                 MultichannelTileRenderer multichannelRenderer) {
        this.registry = registry;
        this.fluorescenceRenderer = fluorescenceRenderer;
        this.multichannelRenderer = multichannelRenderer;
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
            return new ImageMetadataResponse(imageId, context.entry().relativePath(),
                    reader.getSizeX(), reader.getSizeY(), reader.getSizeC(),
                    reader.getResolutionCount(), ImageContext.TILE_SIZE, state.revision());
        }
    }

    public DisplayResponse getDisplay(String imageId, HttpSession session) throws Exception {
        ImageContext context = context(imageId);
        SessionDisplayState state = sessionState(session, imageId, context);
        synchronized (state) { return toDisplayResponse(state); }
    }

    public DisplayResponse resetDisplay(String imageId, HttpSession session) throws Exception {
        ImageContext context = context(imageId);
        SessionDisplayState state = sessionState(session, imageId, context);
        synchronized (state) {
            state.reset(context.newDefaultDisplayModel());
            return toDisplayResponse(state);
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
            return toDisplayResponse(state);
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
            List<byte[]> channelPixels = new ArrayList<>();
            List<PixelMapper> mappers = new ArrayList<>();
            List<Double> opacities = new ArrayList<>();
            for (int channel = 0; channel < settingsSnapshot.size(); channel++) {
                ChannelDisplaySettings settings = settingsSnapshot.get(channel);
                if (!settings.isVisible() || settings.getOpacity() <= 0) continue;
                channelPixels.add(reader.openBytes(reader.getIndex(0, channel, 0),
                        region.x(), region.y(), region.width(), region.height()));
                mappers.add(new LinearWindowPixelMapper(settings.getWindow(), settings.getLut(), settings.getGamma()));
                opacities.add(settings.getOpacity());
            }
            BufferedImage image = channelPixels.isEmpty()
                    ? new BufferedImage(region.width(), region.height(), BufferedImage.TYPE_INT_RGB)
                    : multichannelRenderer.render(channelPixels, region.width(), region.height(),
                    DisplaySettings.forPixelData(reader.isLittleEndian()), mappers, opacities);
            return encodePng(image);
        }
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

    private DisplayResponse toDisplayResponse(SessionDisplayState state) {
        List<ChannelDisplayDto> channels = new ArrayList<>();
        DisplayModel model = state.model();
        for (int i = 0; i < model.getChannelCount(); i++) {
            ChannelDisplaySettings settings = model.getChannel(i);
            channels.add(new ChannelDisplayDto(i, "Channel " + i, settings.isVisible(),
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
