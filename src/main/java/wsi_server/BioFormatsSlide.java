package wsi_server;

import loci.formats.IFormatReader;
import loci.formats.ImageReader;
import org.springframework.stereotype.Component;

@Component
public class BioFormatsSlide {

    private final IFormatReader reader;

    private final String vsiPath =
            "/Users/dm026/wsi-slides/BS26-037673 B1-1_20260726_064536.vsi";

    public BioFormatsSlide() throws Exception {

        reader = new ImageReader();

        reader.setId(vsiPath);

        System.out.println("Bio-Formats reader opened");
    }

    public synchronized byte[] readTile(
            int series,
            int x,
            int y,
            int width,
            int height
    ) throws Exception {

        reader.setSeries(series);

        return reader.openBytes(
                0,
                x,
                y,
                width,
                height
        );
    }

    public synchronized int getWidth(int series) {

        reader.setSeries(series);

        return reader.getSizeX();
    }

    public synchronized int getHeight(int series) {

        reader.setSeries(series);

        return reader.getSizeY();
    }
}