package wsi_server;

import loci.formats.IFormatReader;
import loci.formats.ImageReader;
import org.springframework.stereotype.Service;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;

@Service
public class BioFormatsTileService {

    private final IFormatReader reader;
    private final TileRenderer renderer;

    private final String vsiPath =
            "/Users/dm026/wsi-slides/BS26-037673 B1-1_20260726_064536.vsi";

    public BioFormatsTileService(RgbTileRenderer renderer) throws Exception {
        this.renderer = renderer;

        reader = new ImageReader();
        reader.setId(vsiPath);

        System.out.println("Series count: " + reader.getSeriesCount());

        for (int series = 0; series < reader.getSeriesCount(); series++) {
            reader.setSeries(series);

            System.out.println();
            System.out.println("========== SERIES " + series + " ==========");
            System.out.println("Size X: " + reader.getSizeX());
            System.out.println("Size Y: " + reader.getSizeY());
            System.out.println("Size Z: " + reader.getSizeZ());
            System.out.println("Size C: " + reader.getSizeC());
            System.out.println("Size T: " + reader.getSizeT());
            System.out.println("Image count: " + reader.getImageCount());
            System.out.println("RGB: " + reader.isRGB());
            System.out.println("Interleaved: " + reader.isInterleaved());
            System.out.println("Effective channels: " + reader.getEffectiveSizeC());
            System.out.println(
                    "Pixel type: "
                            + loci.formats.FormatTools.getPixelTypeString(
                            reader.getPixelType()
                    )
            );
            System.out.println("Bits per pixel: " + reader.getBitsPerPixel());
            System.out.println("Resolution count: " + reader.getResolutionCount());
        }

        reader.setSeries(0);
    }

    public synchronized byte[] getTile(
            int series,
            int x,
            int y
    ) throws Exception {

        reader.setSeries(series);

        int width = Math.min(
                512,
                reader.getSizeX() - x
        );

        int height = Math.min(
                512,
                reader.getSizeY() - y
        );

        if (width <= 0 || height <= 0) {
            return new byte[0];
        }

        byte[] pixels = reader.openBytes(
                0,
                x,
                y,
                width,
                height
        );

        BufferedImage image =
                renderer.render(pixels, width, height);

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