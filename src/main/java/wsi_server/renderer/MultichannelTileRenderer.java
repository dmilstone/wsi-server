package wsi_server.renderer;

import org.springframework.stereotype.Component;
import wsi_server.display.PixelMapper;
import wsi_server.model.DisplaySettings;

import java.awt.image.BufferedImage;
import java.util.List;

/**
 * Additively composites multiple unsigned 16-bit fluorescence channels.
 */
@Component
public final class MultichannelTileRenderer {

    private static final int BYTES_PER_PIXEL = 2;

    public BufferedImage render(
            List<byte[]> channelPixels,
            int width,
            int height,
            DisplaySettings settings,
            List<PixelMapper> mappers,
            List<Double> opacities
    ) {
        validateInput(
                channelPixels,
                width,
                height,
                settings,
                mappers,
                opacities
        );

        BufferedImage image = new BufferedImage(
                width,
                height,
                BufferedImage.TYPE_INT_RGB
        );

        int pixelCount = width * height;

        for (int pixelIndex = 0;
             pixelIndex < pixelCount;
             pixelIndex++) {

            double red = 0.0;
            double green = 0.0;
            double blue = 0.0;

            for (int channel = 0;
                 channel < channelPixels.size();
                 channel++) {

                int value16 = readUint16(
                        channelPixels.get(channel),
                        pixelIndex * BYTES_PER_PIXEL,
                        settings.littleEndian()
                );

                int rgb = mappers.get(channel).map(value16);
                double opacity = opacities.get(channel);

                red += ((rgb >> 16) & 0xff) * opacity;
                green += ((rgb >> 8) & 0xff) * opacity;
                blue += (rgb & 0xff) * opacity;
            }

            int compositeRgb = (clamp8(red) << 16)
                    | (clamp8(green) << 8)
                    | clamp8(blue);

            image.setRGB(
                    pixelIndex % width,
                    pixelIndex / width,
                    compositeRgb
            );
        }

        return image;
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

    private int clamp8(
            double value
    ) {
        return Math.max(
                0,
                Math.min(255, (int) Math.round(value))
        );
    }

    private void validateInput(
            List<byte[]> channelPixels,
            int width,
            int height,
            DisplaySettings settings,
            List<PixelMapper> mappers,
            List<Double> opacities
    ) {
        if (channelPixels == null || channelPixels.isEmpty()) {
            throw new IllegalArgumentException(
                    "At least one channel is required for compositing."
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

        if (mappers == null
                || mappers.size() != channelPixels.size()) {
            throw new IllegalArgumentException(
                    "A pixel mapper is required for every channel."
            );
        }

        if (opacities == null
                || opacities.size() != channelPixels.size()) {
            throw new IllegalArgumentException(
                    "An opacity is required for every channel."
            );
        }

        long expectedByteCount = (long) width
                * height
                * BYTES_PER_PIXEL;

        for (int channel = 0;
             channel < channelPixels.size();
             channel++) {

            byte[] pixels = channelPixels.get(channel);

            if (pixels == null || pixels.length < expectedByteCount) {
                throw new IllegalArgumentException(
                        "Channel "
                                + channel
                                + " requires at least "
                                + expectedByteCount
                                + " bytes."
                );
            }

            Double opacity = opacities.get(channel);

            if (opacity == null
                    || !Double.isFinite(opacity)
                    || opacity < 0.0
                    || opacity > 1.0) {
                throw new IllegalArgumentException(
                        "Channel opacity must be between 0.0 and 1.0."
                );
            }
        }
    }
}
