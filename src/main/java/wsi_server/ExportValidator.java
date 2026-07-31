package wsi_server;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
class ExportValidator {
    private final long maximumPixels;

    ExportValidator(@Value("${wsi.export.max-pixels:16000000}") long maximumPixels) {
        if (maximumPixels <= 0) {
            throw new IllegalArgumentException("wsi.export.max-pixels must be greater than zero.");
        }
        this.maximumPixels = maximumPixels;
    }

    void validate(int x, int y, int width, int height, double scale,
                  int imageWidth, int imageHeight) {
        if (x < 0 || y < 0 || width <= 0 || height <= 0
                || (long) x + width > imageWidth || (long) y + height > imageHeight) {
            throw new IllegalArgumentException("Export region must be contained within the image.");
        }

        long sourcePixels = (long) width * height;
        long scaledWidth = Math.round(width * scale);
        long scaledHeight = Math.round(height * scale);
        if (scaledWidth < 1 || scaledHeight < 1 || scaledWidth > Integer.MAX_VALUE
                || scaledHeight > Integer.MAX_VALUE) {
            throw new IllegalArgumentException("Scale produces invalid export dimensions.");
        }
        long outputPixels;
        try {
            outputPixels = Math.multiplyExact(scaledWidth, scaledHeight);
        } catch (ArithmeticException exception) {
            throw new IllegalArgumentException("Scale produces invalid export dimensions.");
        }
        if (sourcePixels > maximumPixels || outputPixels > maximumPixels) {
            throw new IllegalArgumentException("Export exceeds the configured maximum of "
                    + maximumPixels + " pixels.");
        }
    }
}
