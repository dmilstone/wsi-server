package wsi_server.renderer;

import org.springframework.stereotype.Component;
import wsi_server.display.AutoContrastPixelMapper;
import wsi_server.display.PixelMapper;
import wsi_server.model.DisplaySettings;

import java.awt.image.BufferedImage;

/**
 * Converts unsigned 16-bit fluorescence pixels into a
 * display image.
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
            DisplaySettings settings
    ) {
        validateInput(pixels, width, height, settings);

        int minimum = 0xffff;
        int maximum = 0;
        int pixelCount = width * height;

        for (int i = 0; i < pixelCount; i++) {
            int value16 = readUint16(
                    pixels,
                    i * BYTES_PER_PIXEL,
                    settings.littleEndian()
            );
            minimum = Math.min(minimum, value16);
            maximum = Math.max(maximum, value16);
        }

        return render(
                pixels,
                width,
                height,
                settings,
                new AutoContrastPixelMapper(minimum, maximum)
        );
    }

    /**
     * Renders fluorescence pixels using the caller-supplied display mapping.
     * This overload is used for persistent slide-wide window, LUT and gamma
     * settings.
     */
    public BufferedImage render(
            byte[] pixels,
            int width,
            int height,
            DisplaySettings settings,
            PixelMapper mapper
    ) {
        validateInput(pixels, width, height, settings);
        if (mapper == null) {
            throw new IllegalArgumentException("Pixel mapper is required.");
        }

        int pixelCount = width * height;
        BufferedImage image = new BufferedImage(
                width,
                height,
                BufferedImage.TYPE_INT_RGB
        );

        for (int i = 0; i < pixelCount; i++) {
            int value16 = readUint16(
                    pixels,
                    i * BYTES_PER_PIXEL,
                    settings.littleEndian()
            );
            int rgb = mapper.map(value16);
            image.setRGB(i % width, i / width, rgb);
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

        long expected =
                (long) width
                        * height
                        * BYTES_PER_PIXEL;

        if (pixels.length < expected) {
            throw new IllegalArgumentException(
                    "Expected "
                            + expected
                            + " bytes but received "
                            + pixels.length
            );
        }
    }

}