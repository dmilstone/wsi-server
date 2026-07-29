package wsi_server;

import loci.formats.ImageReader;
import loci.formats.FormatTools;
import loci.formats.IFormatReader;
import org.springframework.stereotype.Service;

import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import javax.imageio.ImageIO;


@Service
public class BioFormatsTileService {


    private final IFormatReader reader;


    private final String vsiPath =
            "/Users/dm026/wsi-slides/BS26-037673 B1-1_20260726_064536.vsi";


    public BioFormatsTileService() throws Exception {

        reader = new ImageReader();

        reader.setId(vsiPath);

        System.out.println(
                "Bio-Formats reader opened"
        );
    }


    public synchronized byte[] getTile(
            int series,
            int x,
            int y
    ) throws Exception {


        reader.setSeries(series);


        int width =
                Math.min(
                        512,
                        reader.getSizeX() - x
                );


        int height =
                Math.min(
                        512,
                        reader.getSizeY() - y
                );


        if (width <=0 || height <=0) {
            return new byte[0];
        }


        byte[] pixels =
                reader.openBytes(
                        0,
                        x,
                        y,
                        width,
                        height
                );


        BufferedImage image =
                new BufferedImage(
                        width,
                        height,
                        BufferedImage.TYPE_INT_RGB
                );


        int i=0;

        for(int yy=0; yy<height; yy++) {

            for(int xx=0; xx<width; xx++) {

                int r = pixels[i++] & 0xff;
                int g = pixels[i++] & 0xff;
                int b = pixels[i++] & 0xff;

                int rgb =
                        (r<<16) |
                                (g<<8) |
                                b;

                image.setRGB(
                        xx,
                        yy,
                        rgb
                );
            }
        }


        ByteArrayOutputStream out =
                new ByteArrayOutputStream();


        ImageIO.write(
                image,
                "jpg",
                out
        );


        return out.toByteArray();
    }
}