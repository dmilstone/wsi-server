package wsi_server;

import loci.formats.FormatTools;
import loci.formats.IFormatReader;
import loci.formats.ImageReader;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import wsi_server.display.LinearWindowPixelMapper;
import wsi_server.display.PixelMapper;
import wsi_server.model.ChannelDisplaySettings;
import wsi_server.model.DisplayModel;
import wsi_server.model.DisplaySettings;
import wsi_server.model.DisplayWindow;
import wsi_server.model.LutType;
import wsi_server.renderer.FluorescenceTileRenderer;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;

/**
 * Reads fluorescence tiles from the VSI file and converts them to PNG images.
 */
@Service
public class BioFormatsTileService {

    private static final int FLUORESCENCE_SERIES = 2;
    private static final int TILE_SIZE = 512;
    private static final int BYTES_PER_PIXEL = 2;
    private static final int HISTOGRAM_SIZE = 65536;
    private static final double LOW_PERCENTILE = 0.01;
    private static final double HIGH_PERCENTILE = 0.99;

    private final IFormatReader reader;
    private final FluorescenceTileRenderer fluorescenceRenderer;
    private final DisplayModel displayModel;

    public BioFormatsTileService(
            FluorescenceTileRenderer fluorescenceRenderer,
            @Value("${wsi.slide-path}") String slidePath
    ) throws Exception {

        this.fluorescenceRenderer = fluorescenceRenderer;

        reader = new ImageReader();
        reader.setFlattenedResolutions(false);
        reader.setId(slidePath);
        reader.setSeries(FLUORESCENCE_SERIES);

        validatePixelType();

        displayModel = new DisplayModel(
                reader.getSizeC()
        );

        initializeDefaultLuts();
        initializeSlideDisplayWindows();

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
    }

    public synchronized byte[] getTile(
            int viewerLevel,
            int channel,
            int tileX,
            int tileY
    ) throws Exception {

        reader.setSeries(FLUORESCENCE_SERIES);

        validateChannel(channel);

        int resolutionCount = reader.getResolutionCount();

        validateViewerLevel(
                viewerLevel,
                resolutionCount
        );

        /*
         * OpenSeadragon level 0 is the lowest resolution.
         * Bio-Formats resolution 0 is the highest resolution.
         */
        int bioResolution = resolutionCount
                - 1
                - viewerLevel;

        reader.setResolution(bioResolution);

        int pixelX = tileX * TILE_SIZE;
        int pixelY = tileY * TILE_SIZE;

        int tileWidth = Math.min(
                TILE_SIZE,
                reader.getSizeX() - pixelX
        );

        int tileHeight = Math.min(
                TILE_SIZE,
                reader.getSizeY() - pixelY
        );

        if (tileWidth <= 0 || tileHeight <= 0) {
            return new byte[0];
        }

        int planeIndex = reader.getIndex(
                0,
                channel,
                0
        );

        byte[] pixels = reader.openBytes(
                planeIndex,
                pixelX,
                pixelY,
                tileWidth,
                tileHeight
        );

        DisplaySettings settings = DisplaySettings.forPixelData(
                reader.isLittleEndian()
        );

        ChannelDisplaySettings channelSettings =
                displayModel.getChannel(channel);

        PixelMapper mapper = new LinearWindowPixelMapper(
                channelSettings.getWindow(),
                channelSettings.getLut()
        );

        BufferedImage image = fluorescenceRenderer.render(
                pixels,
                tileWidth,
                tileHeight,
                settings,
                mapper
        );

        ByteArrayOutputStream output = new ByteArrayOutputStream();

        boolean written = ImageIO.write(
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

    private void initializeDefaultLuts() {
        LutType[] defaults = {
                LutType.GREEN,
                LutType.MAGENTA,
                LutType.CYAN,
                LutType.RED,
                LutType.YELLOW,
                LutType.GRAY
        };

        for (int channel = 0;
             channel < displayModel.getChannelCount();
             channel++) {
            LutType lut = defaults[channel % defaults.length];

            displayModel.getChannel(channel).setLut(lut);

            System.out.println(
                    "Channel "
                            + channel
                            + " LUT: "
                            + lut
            );
        }
    }

    private void initializeSlideDisplayWindows()
            throws Exception {

        reader.setSeries(FLUORESCENCE_SERIES);

        int lowestResolution = reader.getResolutionCount() - 1;
        reader.setResolution(lowestResolution);

        boolean littleEndian = reader.isLittleEndian();
        int channelCount = reader.getSizeC();

        System.out.println(
                "Computing slide-wide display windows from Bio-Formats resolution "
                        + lowestResolution
                        + " ("
                        + reader.getSizeX()
                        + " x "
                        + reader.getSizeY()
                        + ")."
        );

        for (int channel = 0; channel < channelCount; channel++) {
            DisplayWindow window = calculateChannelDisplayWindow(
                    channel,
                    littleEndian
            );

            displayModel.getChannel(channel).setWindow(window);

            System.out.println(
                    "Channel "
                            + channel
                            + " display window: "
                            + window.black()
                            + " - "
                            + window.white()
            );
        }

        reader.setResolution(0);
    }

    private DisplayWindow calculateChannelDisplayWindow(
            int channel,
            boolean littleEndian
    ) throws Exception {

        long[] histogram = new long[HISTOGRAM_SIZE];
        long pixelCount = 0L;

        int imageWidth = reader.getSizeX();
        int imageHeight = reader.getSizeY();
        int planeIndex = reader.getIndex(0, channel, 0);

        for (int y = 0; y < imageHeight; y += TILE_SIZE) {
            int regionHeight = Math.min(
                    TILE_SIZE,
                    imageHeight - y
            );

            for (int x = 0; x < imageWidth; x += TILE_SIZE) {
                int regionWidth = Math.min(
                        TILE_SIZE,
                        imageWidth - x
                );

                byte[] pixels = reader.openBytes(
                        planeIndex,
                        x,
                        y,
                        regionWidth,
                        regionHeight
                );

                addToHistogram(
                        pixels,
                        regionWidth * regionHeight,
                        littleEndian,
                        histogram
                );

                pixelCount += (long) regionWidth * regionHeight;
            }
        }

        if (pixelCount == 0L) {
            return new DisplayWindow(0, 65535);
        }

        int black = findPercentile(
                histogram,
                pixelCount,
                LOW_PERCENTILE
        );

        int white = findPercentile(
                histogram,
                pixelCount,
                HIGH_PERCENTILE
        );

        if (white <= black) {
            int[] nonEmptyRange = findNonEmptyRange(histogram);
            black = nonEmptyRange[0];
            white = nonEmptyRange[1];
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

    private void addToHistogram(
            byte[] pixels,
            int pixelCount,
            boolean littleEndian,
            long[] histogram
    ) {
        int expectedBytes = pixelCount * BYTES_PER_PIXEL;

        if (pixels.length < expectedBytes) {
            throw new IllegalArgumentException(
                    "Pixel buffer is smaller than expected. Expected at least "
                            + expectedBytes
                            + " bytes but received "
                            + pixels.length
                            + "."
            );
        }

        for (int i = 0; i < pixelCount; i++) {
            int value16 = readUint16(
                    pixels,
                    i * BYTES_PER_PIXEL,
                    littleEndian
            );

            histogram[value16]++;
        }
    }

    private int findPercentile(
            long[] histogram,
            long pixelCount,
            double percentile
    ) {
        long target = Math.max(
                1L,
                (long) Math.ceil(pixelCount * percentile)
        );

        long cumulative = 0L;

        for (int value = 0; value < histogram.length; value++) {
            cumulative += histogram[value];

            if (cumulative >= target) {
                return value;
            }
        }

        return histogram.length - 1;
    }

    private int[] findNonEmptyRange(
            long[] histogram
    ) {
        int minimum = 0;
        int maximum = histogram.length - 1;

        while (
                minimum < histogram.length
                        && histogram[minimum] == 0L
        ) {
            minimum++;
        }

        while (
                maximum >= 0
                        && histogram[maximum] == 0L
        ) {
            maximum--;
        }

        if (minimum >= histogram.length || maximum < 0) {
            return new int[]{0, 65535};
        }

        return new int[]{minimum, maximum};
    }

    private int readUint16(
            byte[] pixels,
            int offset,
            boolean littleEndian
    ) {
        int first = pixels[offset] & 0xff;
        int second = pixels[offset + 1] & 0xff;

        if (littleEndian) {
            return first | (second << 8);
        }

        return (first << 8) | second;
    }

    private void validatePixelType() {
        int pixelType = reader.getPixelType();

        if (pixelType != FormatTools.UINT16) {
            throw new IllegalStateException(
                    "Fluorescence rendering currently requires UINT16 data. "
                            + "Received: "
                            + FormatTools.getPixelTypeString(pixelType)
            );
        }
    }

    private void validateChannel(
            int channel
    ) {
        if (channel < 0 || channel >= reader.getSizeC()) {
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
        if (viewerLevel < 0 || viewerLevel >= resolutionCount) {
            throw new IllegalArgumentException(
                    "Viewer level must be between 0 and "
                            + (resolutionCount - 1)
                            + ". Received: "
                            + viewerLevel
            );
        }
    }
}
