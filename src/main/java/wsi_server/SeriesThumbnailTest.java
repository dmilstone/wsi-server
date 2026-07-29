package wsi_server;

import loci.formats.ImageReader;
import loci.formats.IFormatReader;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.File;

public class SeriesThumbnailTest {

    public static void main(String[] args) throws Exception {

        String input =
                System.getProperty("user.home")
                        + "/wsi-slides/BS26-037673 B1-1_20260726_064536.vsi";

        IFormatReader reader = new ImageReader();

        try {

            reader.setId(input);

            System.out.println(
                    "Series count: " + reader.getSeriesCount()
            );

            for (int s = 0; s < reader.getSeriesCount(); s++) {

                reader.setSeries(s);

                int width = reader.getSizeX();
                int height = reader.getSizeY();

                System.out.println(
                        "Series " + s +
                                " : " + width +
                                " x " + height
                );

                // Only test reasonably sized images
                if (width > 100 && height > 100) {

                    BufferedImage image =
                            new BufferedImage(
                                    width,
                                    height,
                                    BufferedImage.TYPE_INT_RGB
                            );

                    byte[] pixels =
                            reader.openBytes(0);

                    // Skip actual conversion for now
                    // Just report availability

                    System.out.println(
                            "  Plane bytes: "
                                    + pixels.length
                    );
                }
            }

        } finally {
            reader.close();
        }
    }
}