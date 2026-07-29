package wsi_server;

import loci.formats.FormatTools;
import loci.formats.IFormatReader;
import loci.formats.ImageReader;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import wsi_server.display.AutoContrastPixelMapper;
import wsi_server.display.PixelMapper;
import wsi_server.model.ChannelDisplaySettings;
import wsi_server.model.DisplayModel;
import wsi_server.model.DisplaySettings;
import wsi_server.model.DisplayWindow;
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

    private final IFormatReader reader;
    private final FluorescenceTileRenderer fluorescenceRenderer;
    private final DisplayModel displayModel;

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

        displayModel = new DisplayModel(
                reader.getSizeC()
        );

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

        ChannelDisplaySettings channelSettings =
                displayModel.getChannel(channel);

        DisplayWindow displayWindow =
                calculateTileDisplayWindow(
                        pixels,
                        tileWidth,
                        tileHeight,
                        settings.littleEndian()
                );

        channelSettings.setWindow(
                displayWindow
        );

        PixelMapper mapper =
                createAutoContrastMapper(
                        channelSettings.getWindow()
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

    private DisplayWindow calculateTileDisplayWindow(
            byte[] pixels,
            int width,
            int height,
            boolean littleEndian
    ) {

        int pixelCount =
                width * height;

        int minimum =
                65535;

        int maximum =
                0;

        for (int i = 0; i < pixelCount; i++) {

            int value16 =
                    readUint16(
                            pixels,
                            i * BYTES_PER_PIXEL,
                            littleEndian
                    );

            if (value16 < minimum) {
                minimum = value16;
            }

            if (value16 > maximum) {
                maximum = value16;
            }
        }

        return new DisplayWindow(
                minimum,
                maximum
        );
    }

    private PixelMapper createAutoContrastMapper(
            DisplayWindow displayWindow
    ) {
        return new AutoContrastPixelMapper(
                displayWindow.minimum(),
                displayWindow.maximum()
        );
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
