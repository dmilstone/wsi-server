package wsi_server.display;

/**
 * Maps a raw microscope intensity to a display RGB value.
 */
public interface PixelMapper {

    /**
     * Converts a 16-bit microscope intensity into a packed
     * RGB value (0xRRGGBB).
     */
    int map(int value16);

}