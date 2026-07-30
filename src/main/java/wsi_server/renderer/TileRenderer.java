package wsi_server.renderer;

import wsi_server.model.DisplaySettings;

import java.awt.image.BufferedImage;

/**
 * Converts raw pixel bytes into a displayable image.
 */
public interface TileRenderer {

    BufferedImage render(
            byte[] pixels,
            int width,
            int height,
            DisplaySettings settings
    );
}