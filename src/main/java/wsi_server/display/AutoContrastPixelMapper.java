package wsi_server.display;

/**
 * Performs a simple linear contrast stretch between a
 * minimum and maximum intensity.
 *
 * The output is a grayscale RGB value.
 */
public class AutoContrastPixelMapper
        implements PixelMapper {

    private final int minimum;
    private final int maximum;
    private final int range;

    public AutoContrastPixelMapper(
            int minimum,
            int maximum
    ) {

        this.minimum = minimum;
        this.maximum = maximum;

        int r = maximum - minimum;

        this.range = (r <= 0)
                ? 1
                : r;
    }

    @Override
    public int map(
            int value16
    ) {

        int gray =
                (value16 - minimum)
                        * 255
                        / range;

        gray = Math.max(
                0,
                Math.min(
                        255,
                        gray
                )
        );

        return (gray << 16)
                | (gray << 8)
                | gray;
    }

}