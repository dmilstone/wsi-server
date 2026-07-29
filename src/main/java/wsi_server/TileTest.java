package wsi_server;

import loci.formats.ImageReader;
import loci.formats.IFormatReader;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.awt.Color;
import java.io.File;

public class TileTest {

    public static void main(String[] args) throws Exception {

        String input =
                System.getProperty("user.home")
                        + "/wsi-slides/BS26-037673 B1-1_20260726_064536.vsi";

        String output =
                System.getProperty("user.home")
                        + "/wsi-slides/tile-test.jpg";


        IFormatReader reader = new ImageReader();

        try {

            reader.setId(input);

            // Try the main slide series
            reader.setSeries(13);

            int tileWidth = 512;
            int tileHeight = 512;

            // center of the slide
            int x = 12000;
            int y = 7000;


            byte[] bytes =
                    reader.openBytes(
                            0,
                            x,
                            y,
                            tileWidth,
                            tileHeight
                    );


            System.out.println(
                    "Bytes returned: "
                            + bytes.length
            );


            System.out.println(
                    "Pixel type: "
                            + reader.getPixelType()
            );


            BufferedImage image =
                    new BufferedImage(
                            tileWidth,
                            tileHeight,
                            BufferedImage.TYPE_INT_RGB
                    );


            // Convert RGB bytes
            for (int yy = 0; yy < tileHeight; yy++) {
                for (int xx = 0; xx < tileWidth; xx++) {

                    int index =
                            (yy * tileWidth + xx) * 3;

                    int r = bytes[index] & 0xff;
                    int g = bytes[index + 1] & 0xff;
                    int b = bytes[index + 2] & 0xff;

                    image.setRGB(
                            xx,
                            yy,
                            new Color(r,g,b).getRGB()
                    );
                }
            }


            ImageIO.write(
                    image,
                    "jpg",
                    new File(output)
            );


            System.out.println(
                    "Created "
                            + output
            );


        }
        finally {
            reader.close();
        }
    }
}