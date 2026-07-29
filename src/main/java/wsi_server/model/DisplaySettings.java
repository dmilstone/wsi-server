package wsi_server.model;

/**
 * Rendering options used when converting raw microscope
 * pixels into a displayable image.
 *
 * Additional settings such as black level, white level,
 * gamma, and pseudocolor will be added here later.
 */
public record DisplaySettings(
        boolean littleEndian
) {

    public static DisplaySettings forPixelData(
            boolean littleEndian
    ) {
        return new DisplaySettings(
                littleEndian
        );
    }
}