package wsi_server.display;

import wsi_server.model.DisplayWindow;

/**
 * Maps unsigned 16-bit intensities through a fixed linear
 * black/white display window.
 *
 * Values at or below black become black. Values at or above
 * white become white. Values between them are scaled linearly.
 */
public class LinearWindowPixelMapper
        implements PixelMapper {

    private final int black;
    private final int white;
    private final int range;

    public LinearWindowPixelMapper(
            DisplayWindow window
    ) {
        this(
                window.black(),
                window.white()
        );
    }

    public LinearWindowPixelMapper(
            int black,
            int white
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
    }

    @Override
    public int map(
            int value16
    ) {
        int gray;

        if (value16 <= black) {
            gray = 0;
        } else if (value16 >= white) {
            gray = 255;
        } else {
            gray = (value16 - black)
                    * 255
                    / range;
        }

        return (gray << 16)
                | (gray << 8)
                | gray;
    }
}
