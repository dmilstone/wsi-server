package wsi_server;

import loci.formats.FormatTools;
import loci.formats.IFormatReader;
import loci.formats.ImageReader;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import wsi_server.display.LinearWindowPixelMapper;
import wsi_server.display.PixelMapper;
import wsi_server.model.DisplaySettings;
import wsi_server.model.DisplayWindow;
import wsi_server.renderer.FluorescenceTileRenderer;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Reads fluorescence tiles from the VSI file and converts them to PNG images.
 *
 * A single percentile-based display window is calculated for each channel
 * when the service starts. Every tile from a channel therefore uses the same
 * intensity mapping, preventing tile-to-tile contrast changes while panning.
 */
@Service
public class BioFormatsTileService {

    private static final int FLUORESCENCE_SERIES = 2;
    private static final int TILE_SIZE = 512;
    private static final int BYTES_PER_PIXEL = 2;
    private static final int HISTOGRAM_BINS = 65536;
    private static final long TARGET_SAMPLE_COUNT = 1_000_000L;
    private static final double LOWER_PERCENTILE = 0.01;
    private static final double UPPER_PERCENTILE = 0.99;

    private final IFormatReader reader;
    private final FluorescenceTileRenderer fluorescenceRenderer;
    private final Map<Integer, DisplayWindow> channelDisplayWindows;

    public BioFormatsTileService(
            FluorescenceTileRenderer fluorescenceRenderer,
            @Value("${wsi.slide-path}") String slidePath
    ) throws Exception {

        this.fluorescenceRenderer =
                fluorescenceRenderer;

        reader = new ImageReader();

        reader.setFlattenedResolutions(false);
        reader.setId(slidePath);
        reader.setSeries(FLUORESCENCE_SERIES);

        validatePixelType();

        System.out.println(
                "Bio-Formats reader opened: "
                        + slidePath
        );

        System.out.println(
                "Fluorescence series: "
                        + FLUORESCENCE_SERIES
        );

        System.out.println(
                "Resolution count: "
                        + reader.getResolutionCount()
        );

        System.out.println(
                "Channels: "
                        + reader.getSizeC()
        );

        System.out.println(
                "Pixel type: "
                        + FormatTools.getPixelTypeString(
                        reader.getPixelType()
                )
        );

        channelDisplayWindows =
                calculateChannelDisplayWindows();
    }

    public synchronized byte[] getTile(
            int viewerLevel,
            int channel,
            int tileX,
            int tileY
    ) throws Exception {

        reader.setSeries(
                FLUORESCENCE_SERIES
        );

        validateChannel(channel);

        int resolutionCount =
                reader.getResolutionCount();

        validateViewerLevel(
                viewerLevel,
                resolutionCount
        );

        /*
         * OpenSeadragon level 0 is the lowest resolution.
         * Bio-Formats resolution 0 is the highest resolution.
         */
        int bioResolution =
                resolutionCount
                        - 1
                        - viewerLevel;

        reader.setResolution(
                bioResolution
        );

        int pixelX =
                tileX * TILE_SIZE;

        int pixelY =
                tileY * TILE_SIZE;

        int tileWidth =
                Math.min(
                        TILE_SIZE,
                        reader.getSizeX() - pixelX
                );

        int tileHeight =
                Math.min(
                        TILE_SIZE,
                        reader.getSizeY() - pixelY
                );

        if (tileWidth <= 0 || tileHeight <= 0) {
            return new byte[0];
        }

        int planeIndex =
                reader.getIndex(
                        0,
                        channel,
                        0
                );

        byte[] pixels =
                reader.openBytes(
                        planeIndex,
                        pixelX,
                        pixelY,
                        tileWidth,
                        tileHeight
                );

        DisplaySettings settings =
                DisplaySettings.forPixelData(
                        reader.isLittleEndian()
                );

        DisplayWindow window =
                channelDisplayWindows.get(channel);

        if (window == null) {
            throw new IllegalStateException(
                    "No display window is available for channel "
                            + channel
            );
        }

        PixelMapper mapper =
                new LinearWindowPixelMapper(
                        window
                );

        BufferedImage image =
                fluorescenceRenderer.render(
                        pixels,
                        tileWidth,
                        tileHeight,
                        settings,
                        mapper
                );

        ByteArrayOutputStream output =
                new ByteArrayOutputStream();

        boolean written =
                ImageIO.write(
                        image,
                        "png",
                        output
                );

        if (!written) {
            throw new IllegalStateException(
                    "No PNG image writer is available."
            );
        }

        return output.toByteArray();
    }

    private Map<Integer, DisplayWindow> calculateChannelDisplayWindows()
            throws Exception {

        reader.setSeries(
                FLUORESCENCE_SERIES
        );

        int resolutionCount =
                reader.getResolutionCount();

        int samplingResolution =
                resolutionCount - 1;

        reader.setResolution(
                samplingResolution
        );

        int channelCount =
                reader.getSizeC();

        Map<Integer, DisplayWindow> windows =
                new HashMap<>();

        for (int channel = 0; channel < channelCount; channel++) {

            DisplayWindow window =
                    calculateDisplayWindow(channel);

            windows.put(
                    channel,
                    window
            );

            System.out.println(
                    "Channel "
                            + channel
                            + " display window: black="
                            + window.black()
                            + ", white="
                            + window.white()
            );
        }

        return Map.copyOf(windows);
    }

    private DisplayWindow calculateDisplayWindow(
            int channel
    ) throws Exception {

        int imageWidth =
                reader.getSizeX();

        int imageHeight =
                reader.getSizeY();

        long totalPixels =
                (long) imageWidth
                        * imageHeight;

        int sampleStride =
                calculateSampleStride(
                        totalPixels
                );

        long[] histogram =
                new long[HISTOGRAM_BINS];

        long sampleCount = 0;
        int observedMinimum = 65535;
        int observedMaximum = 0;

        int planeIndex =
                reader.getIndex(
                        0,
                        channel,
                        0
                );

        boolean littleEndian =
                reader.isLittleEndian();

        for (int tileY = 0; tileY < imageHeight; tileY += TILE_SIZE) {

            int tileHeight =
                    Math.min(
                            TILE_SIZE,
                            imageHeight - tileY
                    );

            for (int tileX = 0; tileX < imageWidth; tileX += TILE_SIZE) {

                int tileWidth =
                        Math.min(
                                TILE_SIZE,
                                imageWidth - tileX
                        );

                byte[] pixels =
                        reader.openBytes(
                                planeIndex,
                                tileX,
                                tileY,
                                tileWidth,
                                tileHeight
                        );

                for (int localY = 0; localY < tileHeight; localY++) {

                    int globalY =
                            tileY + localY;

                    if (globalY % sampleStride != 0) {
                        continue;
                    }

                    for (int localX = 0; localX < tileWidth; localX++) {

                        int globalX =
                                tileX + localX;

                        if (globalX % sampleStride != 0) {
                            continue;
                        }

                        int pixelIndex =
                                localY * tileWidth
                                        + localX;

                        int value16 =
                                readUint16(
                                        pixels,
                                        pixelIndex * BYTES_PER_PIXEL,
                                        littleEndian
                                );

                        histogram[value16]++;
                        sampleCount++;

                        if (value16 < observedMinimum) {
                            observedMinimum = value16;
                        }

                        if (value16 > observedMaximum) {
                            observedMaximum = value16;
                        }
                    }
                }
            }
        }

        if (sampleCount == 0) {
            throw new IllegalStateException(
                    "No pixels were sampled for channel "
                            + channel
            );
        }

        int black =
                findPercentileValue(
                        histogram,
                        sampleCount,
                        LOWER_PERCENTILE
                );

        int white =
                findPercentileValue(
                        histogram,
                        sampleCount,
                        UPPER_PERCENTILE
                );

        /*
         * Sparse or constant images can place both percentiles in the same
         * histogram bin. Fall back to the observed range so the mapper still
         * has a valid window.
         */
        if (white <= black) {
            black = observedMinimum;
            white = observedMaximum;
        }

        if (white <= black) {
            if (black < 65535) {
                white = black + 1;
            } else {
                black = 65534;
                white = 65535;
            }
        }

        return new DisplayWindow(
                black,
                white
        );
    }

    private int calculateSampleStride(
            long totalPixels
    ) {
        if (totalPixels <= TARGET_SAMPLE_COUNT) {
            return 1;
        }

        double ratio =
                (double) totalPixels
                        / TARGET_SAMPLE_COUNT;

        return Math.max(
                1,
                (int) Math.ceil(
                        Math.sqrt(ratio)
                )
        );
    }

    private int findPercentileValue(
            long[] histogram,
            long sampleCount,
            double percentile
    ) {
        long target =
                Math.max(
                        1L,
                        (long) Math.ceil(
                                sampleCount * percentile
                        )
                );

        long cumulative = 0;

        for (int value = 0; value < histogram.length; value++) {
            cumulative += histogram[value];

            if (cumulative >= target) {
                return value;
            }
        }

        return histogram.length - 1;
    }

    private int readUint16(
            byte[] pixels,
            int offset,
            boolean littleEndian
    ) {

        int first =
                pixels[offset] & 0xff;

        int second =
                pixels[offset + 1] & 0xff;

        if (littleEndian) {
            return first
                    | (second << 8);
        }

        return (first << 8)
                | second;
    }

    private void validatePixelType() {
        if (reader.getPixelType() != FormatTools.UINT16) {
            throw new IllegalStateException(
                    "Fluorescence rendering currently requires UINT16 pixels. "
                            + "Received: "
                            + FormatTools.getPixelTypeString(
                            reader.getPixelType()
                    )
            );
        }
    }

    private void validateChannel(
            int channel
    ) {

        if (
                channel < 0
                        || channel >= reader.getSizeC()
        ) {

            throw new IllegalArgumentException(
                    "Channel must be between 0 and "
                            + (reader.getSizeC() - 1)
                            + ". Received: "
                            + channel
            );
        }
    }

    private void validateViewerLevel(
            int viewerLevel,
            int resolutionCount
    ) {

        if (
                viewerLevel < 0
                        || viewerLevel >= resolutionCount
        ) {

            throw new IllegalArgumentException(
                    "Viewer level must be between 0 and "
                            + (resolutionCount - 1)
                            + ". Received: "
                            + viewerLevel
            );
        }
    }
}
