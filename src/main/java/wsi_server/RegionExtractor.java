package wsi_server;

import loci.formats.ImageReader;
import loci.formats.IFormatReader;
import loci.formats.gui.BufferedImageReader;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.File;

public class RegionExtractor {

    public static void main(String[] args) throws Exception {

        String input =
                System.getProperty("user.home")
                        + "/wsi-slides/BS26-037673 B1-1_20260726_064536.vsi";

        String output =
                System.getProperty("user.home")
                        + "/wsi-slides/test-region.jpg";


        IFormatReader baseReader = new ImageReader();

        BufferedImageReader reader =
                new BufferedImageReader(baseReader);


        try {

            reader.setId(input);

            // Choose the main image series
            reader.setSeries(13);

            System.out.println("Series 0");
            System.out.println(
                    "Width: " + reader.getSizeX()
            );
            System.out.println(
                    "Height: " + reader.getSizeY()
            );


            // Read the whole plane for this first test
            BufferedImage image =
                    reader.openImage(0);


            // Extract upper-left 512x512 region
            int x = 1000;
            int y = 7000;

            BufferedImage crop =
                    image.getSubimage(
                            x,
                            y,
                            512,
                            512
                    );


            ImageIO.write(
                    crop,
                    "jpg",
                    new File(output)
            );


            System.out.println(
                    "Created: " + output
            );


        } finally {

            reader.close();

        }
    }
}