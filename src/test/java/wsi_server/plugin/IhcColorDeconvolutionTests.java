package wsi_server.plugin;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class IhcColorDeconvolutionTests {

    @Test
    void brownPixelsHaveHigherDabThanHematoxylinBlue() {
        double brown = IhcColorDeconvolution.dabAmount(120, 70, 30);
        double blue = IhcColorDeconvolution.dabAmount(40, 50, 180);
        assertTrue(brown > blue);
    }

    @Test
    void opticalDensityIsZeroAtWhite() {
        assertEquals(0.0, IhcColorDeconvolution.opticalDensity(255), 1e-12);
    }

    @Test
    void quantifyObjectsEmitsKeysWithoutChannelStats() {
        int width = 5;
        int height = 5;
        int[] red = new int[width * height];
        int[] green = new int[width * height];
        int[] blue = new int[width * height];
        java.util.Arrays.fill(red, 220);
        java.util.Arrays.fill(green, 220);
        java.util.Arrays.fill(blue, 220);
        red[12] = 90;
        green[12] = 55;
        blue[12] = 25;
        PluginSampleGrid grid = new PluginSampleGrid(
                0, 0, width, height,
                0, 0, width, height,
                1, 1,
                List.of("R", "G", "B"),
                new int[] {0, 1, 2},
                new int[][] {red, green, blue}
        );
        List<ObjectColorKey> keys = IhcPixelQuantifierPlugin.quantifyObjects(
                grid,
                List.of(new PluginExecuteRequest.NucleusFootprint(2, 2, 1.5))
        );
        assertEquals(1, keys.size());
        assertEquals(0, keys.get(0).index());
        assertTrue(keys.get(0).key() > 0);
    }
}
