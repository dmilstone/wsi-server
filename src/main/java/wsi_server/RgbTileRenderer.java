package wsi_server;

import org.springframework.stereotype.Component;

import java.awt.image.BufferedImage;

@Component
public class RgbTileRenderer implements TileRenderer {

    @Override
    public BufferedImage render(byte[] pixels, int width, int height) {

        BufferedImage image =
                new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);

        int i = 0;

        for (int y = 0; y < height; y++) {

            for (int x = 0; x < width; x++) {

                int r = pixels[i++] & 0xff;
                int g = pixels[i++] & 0xff;
                int b = pixels[i++] & 0xff;

                image.setRGB(
                        x,
                        y,
                        (r << 16) |
                                (g << 8) |
                                b
                );
            }
        }

        return image;
    }
}