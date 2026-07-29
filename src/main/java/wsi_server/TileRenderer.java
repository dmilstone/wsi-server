package wsi_server;

import java.awt.image.BufferedImage;

public interface TileRenderer {

    BufferedImage render(byte[] bytes, int width, int height);

}