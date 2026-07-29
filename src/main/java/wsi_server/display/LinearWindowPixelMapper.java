package wsi_server.display;

import wsi_server.model.DisplayWindow;
import wsi_server.model.LutType;

import java.util.Objects;

/**
 * Maps unsigned 16-bit intensities through a fixed linear
 * black/white display window and then through a color LUT.
 *
 * Values at or below black map to LUT intensity 0. Values at or
 * above white map to LUT intensity 255. Values between them are
 * scaled linearly.
 */
public final class LinearWindowPixelMapper
        implements PixelMapper {

    private final int black;
    private final int white;
    private final int range;
    private final LutType lut;

    public LinearWindowPixelMapper(
            DisplayWindow window
    ) {
        this(
                window,
                LutType.GRAY
        );
    }

    public LinearWindowPixelMapper(
            DisplayWindow window,
            LutType lut
    ) {
        this(
                window.black(),
                window.white(),
                lut
        );
    }

    public LinearWindowPixelMapper(
            int black,
            int white
    ) {
        this(
                black,
                white,
                LutType.GRAY
        );
    }

    public LinearWindowPixelMapper(
            int black,
            int white,
            LutType lut
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

        this.black = black;
        this.white = white;
        this.range = white - black;
        this.lut = Objects.requireNonNull(
                lut,
                "LUT cannot be null."
        );
    }

    @Override
    public int map(
            int value16
    ) {
        int intensity;

        if (value16 <= black) {
            intensity = 0;
        } else if (value16 >= white) {
            intensity = 255;
        } else {
            intensity = (value16 - black)
                    * 255
                    / range;
        }

        return lut.color(intensity);
    }
}
