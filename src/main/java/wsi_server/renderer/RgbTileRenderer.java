package wsi_server.renderer;

import org.springframework.stereotype.Component;
import wsi_server.display.PixelMapper;
import wsi_server.model.DisplaySettings;

import java.awt.image.BufferedImage;

/**
 * Converts interleaved 8-bit RGB pixel data into a
 * BufferedImage.
 *
 * Expected byte order:
 *
 * R, G, B, R, G, B, ...
 *
 * The PixelMapper parameter is unused because the input
 * already contains display-ready RGB values.
 */
@Component
public class RgbTileRenderer
        implements TileRenderer {

    private static final int CHANNELS = 3;

    @Override
    public BufferedImage render(
            byte[] pixels,
            int width,
            int height,
            DisplaySettings settings,
            PixelMapper mapper
    ) {

        validateInput(
                pixels,
                width,
                height,
                settings
        );

        BufferedImage image =
                new BufferedImage(
                        width,
                        height,
                        BufferedImage.TYPE_INT_RGB
                );

        int pixelCount =
                width * height;

        for (int i = 0; i < pixelCount; i++) {

            int offset =
                    i * CHANNELS;

            int red =
                    pixels[offset] & 0xff;

            int green =
                    pixels[offset + 1] & 0xff;

            int blue =
                    pixels[offset + 2] & 0xff;

            int rgb =
                    (red << 16)
                            | (green << 8)
                            | blue;

            int x =
                    i % width;

            int y =
                    i / width;

            image.setRGB(
                    x,
                    y,
                    rgb
            );
        }

        return image;
    }

    private void validateInput(
            byte[] pixels,
            int width,
            int height,
            DisplaySettings settings
    ) {

        if (pixels == null) {
            throw new IllegalArgumentException(
                    "Pixel data cannot be null."
            );
        }

        if (settings == null) {
            throw new IllegalArgumentException(
                    "Display settings cannot be null."
            );
        }

        if (width <= 0 || height <= 0) {
            throw new IllegalArgumentException(
                    "Image dimensions must be positive."
            );
        }

        long expectedByteCount =
                (long) width
                        * height
                        * CHANNELS;

        if (pixels.length < expectedByteCount) {
            throw new IllegalArgumentException(
                    "Expected at least "
                            + expectedByteCount
                            + " bytes but received "
                            + pixels.length
            );
        }
    }
}