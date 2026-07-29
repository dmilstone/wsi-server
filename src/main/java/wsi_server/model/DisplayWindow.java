package wsi_server.model;

/**
 * Fixed intensity window used to map raw fluorescence values
 * into the visible 0-255 display range.
 */
public record DisplayWindow(
        int black,
        int white
) {

    public DisplayWindow {
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
    }
}
