package wsi_server.model;

/**
 * Fixed 256-entry color lookup tables for fluorescence display.
 *
 * Each lookup table converts an 8-bit intensity into a packed
 * RGB value in 0xRRGGBB format.
 */
public enum LutType {
    GRAY(255, 255, 255),
    GREEN(0, 255, 0),
    MAGENTA(255, 0, 255),
    CYAN(0, 255, 255),
    RED(255, 0, 0),
    YELLOW(255, 255, 0);

    private static final int LUT_SIZE = 256;

    private final int[] colors;

    LutType(
            int maximumRed,
            int maximumGreen,
            int maximumBlue
    ) {
        colors = new int[LUT_SIZE];

        for (int intensity = 0; intensity < LUT_SIZE; intensity++) {
            int red = intensity * maximumRed / 255;
            int green = intensity * maximumGreen / 255;
            int blue = intensity * maximumBlue / 255;

            colors[intensity] = (red << 16)
                    | (green << 8)
                    | blue;
        }
    }

    /**
     * Maps an 8-bit intensity to a packed RGB color.
     */
    public int color(
            int intensity
    ) {
        if (intensity < 0 || intensity >= LUT_SIZE) {
            throw new IllegalArgumentException(
                    "LUT intensity must be between 0 and 255. Received: "
                            + intensity
            );
        }

        return colors[intensity];
    }
}
