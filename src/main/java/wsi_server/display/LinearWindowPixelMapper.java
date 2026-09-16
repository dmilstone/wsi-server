package wsi_server.display;

import wsi_server.model.DisplayWindow;
import wsi_server.model.LutType;

import java.util.Objects;

/**
 * Maps unsigned 16-bit intensities through a fixed linear
 * black/white display window, optional gamma correction, and a color LUT.
 */
public final class LinearWindowPixelMapper
        implements PixelMapper {

    /** Legacy low-end histogram truncation (bottom 1% of samples). */
    public static final double LEGACY_LOW_PERCENTILE = 0.01;
    /** Median of the lower half of the intensity distribution. */
    public static final double SUBMEDIAN_PERCENTILE = 0.25;
    /**
     * Added to the submedian so a typical 16-bit IF background near 0
     * opens at the high-contrast floor seen in visual review (~300).
     */
    public static final int HIGH_CONTRAST_FLOOR_OFFSET = 300;

    private final int black;
    private final int white;
    private final int range;
    private final double inverseGamma;
    private final LutType lut;

    public LinearWindowPixelMapper(
            DisplayWindow window
    ) {
        this(window, LutType.GRAY, 1.0);
    }

    public LinearWindowPixelMapper(
            DisplayWindow window,
            LutType lut
    ) {
        this(window, lut, 1.0);
    }

    public LinearWindowPixelMapper(
            DisplayWindow window,
            LutType lut,
            double gamma
    ) {
        this(
                window.black(),
                window.white(),
                lut,
                gamma
        );
    }

    public LinearWindowPixelMapper(
            int black,
            int white
    ) {
        this(black, white, LutType.GRAY, 1.0);
    }

    public LinearWindowPixelMapper(
            int black,
            int white,
            LutType lut
    ) {
        this(black, white, lut, 1.0);
    }

    public LinearWindowPixelMapper(
            int black,
            int white,
            LutType lut,
            double gamma
    ) {
        if (black < 0 || black > 65535) {
            throw new IllegalArgumentException(
                    "Black level must be between 0 and 65535."
            );
        }

        if (white < 0 || white > 65535) {
            throw new IllegalArgumentException(
                    "White level must be between 0 and 65535."
            );
        }

        if (white <= black) {
            throw new IllegalArgumentException(
                    "White level must be greater than black level."
            );
        }

        if (!Double.isFinite(gamma) || gamma <= 0.0) {
            throw new IllegalArgumentException(
                    "Gamma must be a finite value greater than zero."
            );
        }

        this.black = black;
        this.white = white;
        this.range = white - black;
        this.inverseGamma = 1.0 / gamma;
        this.lut = Objects.requireNonNull(
                lut,
                "LUT cannot be null."
        );
    }

    /**
     * Actual minimum occupied intensity. Preserves smooth gradients down to
     * raw 0 when any sample sits in the lowest bin.
     */
    public static int nonDestructiveBlack(long[] histogram) {
        if (histogram == null || histogram.length == 0) {
            return 0;
        }
        for (int value = 0; value < histogram.length; value++) {
            if (histogram[value] > 0) {
                return value;
            }
        }
        return 0;
    }

    /**
     * Default first-view black: submedian (lower-half median) plus a
     * calibrated offset. Maps the faint tail out of the visible register
     * without touching source pixels; Channel min 0 still shows that tail.
     */
    public static int submedianFloorBlack(long[] histogram) {
        if (histogram == null || histogram.length == 0) {
            return 0;
        }
        int submedian = percentile(histogram, SUBMEDIAN_PERCENTILE);
        int floor = submedian + HIGH_CONTRAST_FLOOR_OFFSET;
        int occupiedMin = nonDestructiveBlack(histogram);
        int ceiling = Math.max(occupiedMin, histogram.length - 1);
        return Math.max(occupiedMin, Math.min(ceiling, floor));
    }

    /**
     * Legacy automated statistical clip: the low-end percentile of occupied
     * samples, which discards dim signal below that floor.
     */
    public static int statisticalClipBlack(long[] histogram) {
        return percentile(histogram, LEGACY_LOW_PERCENTILE);
    }

    public static int lowEndBlack(long[] histogram, boolean statisticalClipping) {
        return statisticalClipping
                ? statisticalClipBlack(histogram)
                : submedianFloorBlack(histogram);
    }

    static int percentile(long[] histogram, double percentile) {
        if (histogram == null || histogram.length == 0) {
            return 0;
        }
        long total = 0;
        for (long count : histogram) {
            if (count > 0) {
                total += count;
            }
        }
        if (total <= 0) {
            return 0;
        }
        double bounded = Double.isFinite(percentile) ? percentile : LEGACY_LOW_PERCENTILE;
        if (bounded <= 0.0) {
            return nonDestructiveBlack(histogram);
        }
        long target = Math.max(1, (long) Math.ceil(total * Math.min(1.0, bounded)));
        long cumulative = 0;
        for (int value = 0; value < histogram.length; value++) {
            long count = histogram[value];
            if (count <= 0) {
                continue;
            }
            cumulative += count;
            if (cumulative >= target) {
                return value;
            }
        }
        return histogram.length - 1;
    }

    @Override
    public int map(
            int value16
    ) {
        double normalized;
        if (value16 <= black) {
            normalized = 0.0;
        } else if (value16 >= white) {
            normalized = 1.0;
        } else {
            normalized = (value16 - black) / (double) range;
        }

        if (normalized > 0.0 && normalized < 1.0 && inverseGamma != 1.0) {
            normalized = Math.pow(normalized, inverseGamma);
        }

        int intensity = clamp8((int) Math.round(normalized * 255.0));
        return lut.color(intensity);
    }

    private int clamp8(
            int value
    ) {
        return Math.max(0, Math.min(255, value));
    }
}
