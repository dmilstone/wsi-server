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

    @Override
    public int map(
            int value16
    ) {
        int intensity = windowIntensity(value16);

        if (intensity > 0 && intensity < 255 && inverseGamma != 1.0) {
            double normalized = intensity / 255.0;
            intensity = clamp8(
                    (int) Math.round(
                            Math.pow(normalized, inverseGamma) * 255.0
                    )
            );
        }

        return lut.color(intensity);
    }

    private int windowIntensity(
            int value16
    ) {
        if (value16 <= black) {
            return 0;
        }

        if (value16 >= white) {
            return 255;
        }

        return (value16 - black)
                * 255
                / range;
    }

    private int clamp8(
            int value
    ) {
        return Math.max(0, Math.min(255, value));
    }
}
