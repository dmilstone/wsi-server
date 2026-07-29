package wsi_server.renderer;

import org.springframework.stereotype.Component;
import wsi_server.display.PixelMapper;
import wsi_server.model.DisplaySettings;

import java.awt.image.BufferedImage;

/**
 * Converts unsigned 16-bit fluorescence pixels into a
 * display image.
 *
 * Intensity-to-color conversion is delegated to the
 * supplied PixelMapper.
 */
@Component
public class FluorescenceTileRenderer
        implements TileRenderer {

    private static final int BYTES_PER_PIXEL = 2;

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
                settings,
                mapper
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

            int value16 =
                    readUint16(
                            pixels,
                            i * BYTES_PER_PIXEL,
                            settings.littleEndian()
                    );

            int rgb =
                    mapper.map(value16);

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

    private void validateInput(
            byte[] pixels,
            int width,
            int height,
            DisplaySettings settings,
            PixelMapper mapper
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

        if (mapper == null) {
            throw new IllegalArgumentException(
                    "Pixel mapper cannot be null."
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
                        * BYTES_PER_PIXEL;

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