package wsi_server.model;

/**
 * Defines the inclusive unsigned 16-bit intensity range that is mapped
 * to the visible display range.
 *
 * The canonical accessors are minimum() and maximum(). The black() and
 * white() aliases preserve compatibility with display mappers that use
 * black/white-level terminology.
 */
public record DisplayWindow(
        int minimum,
        int maximum
) {

    private static final int UINT16_MINIMUM = 0;
    private static final int UINT16_MAXIMUM = 65535;

    public DisplayWindow {
        if (minimum < UINT16_MINIMUM || minimum > UINT16_MAXIMUM) {
            throw new IllegalArgumentException(
                    "Minimum must be between 0 and 65535. Received: "
                            + minimum
            );
        }

        if (maximum < UINT16_MINIMUM || maximum > UINT16_MAXIMUM) {
            throw new IllegalArgumentException(
                    "Maximum must be between 0 and 65535. Received: "
                            + maximum
            );
        }

        if (maximum < minimum) {
            throw new IllegalArgumentException(
                    "Maximum must be greater than or equal to minimum."
            );
        }
    }

    public int black() {
        return minimum;
    }

    public int white() {
        return maximum;
    }
}