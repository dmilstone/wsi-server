package wsi_server;

import loci.formats.ImageReader;
import loci.formats.IFormatReader;

public class BioFormatsReader {

    public static void main(String[] args) throws Exception {

        String filePath = System.getProperty("user.home")
                + "/wsi-slides/BS26-037673 B1-1_20260726_064536.vsi";

        IFormatReader reader = new ImageReader();

        try {
            reader.setId(filePath);

            System.out.println("File:");
            System.out.println(filePath);

            System.out.println();

            System.out.println("Series count: "
                    + reader.getSeriesCount());

            for (int series = 0;
                 series < reader.getSeriesCount();
                 series++) {

                reader.setSeries(series);

                System.out.println();
                System.out.println("Series: " + series);

                System.out.println(
                        "Width: "
                                + reader.getSizeX()
                );

                System.out.println(
                        "Height: "
                                + reader.getSizeY()
                );

                System.out.println(
                        "Channels: "
                                + reader.getSizeC()
                );

                System.out.println(
                        "Z sections: "
                                + reader.getSizeZ()
                );

                System.out.println(
                        "Time points: "
                                + reader.getSizeT()
                );
            }

        } finally {
            reader.close();
        }
    }
}