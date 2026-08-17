package wsi_server.plugin;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class IntensityStatsAnalyzerTests {

    @Test
    void summarizesKnownPlane() {
        int[] plane = {10, 20, 30, 40};
        ChannelIntensityStats stats = IntensityStatsAnalyzer.summarize("DAPI", 0, plane, null);
        assertEquals("DAPI", stats.name());
        assertEquals(0, stats.index());
        assertEquals(25.0, stats.mean(), 1e-9);
        assertEquals(Math.sqrt(125.0), stats.stdDev(), 1e-9);
        assertEquals(40, stats.maximum());
        assertEquals(10, stats.minimum());
        assertEquals(4, stats.sampleCount());
    }

    @Test
    void skipsMaskedSamples() {
        int[] plane = {1, 100, 2, 100};
        boolean[] mask = {true, false, true, false};
        ChannelIntensityStats stats = IntensityStatsAnalyzer.summarize("FITC", 1, plane, mask);
        assertEquals(1.5, stats.mean(), 1e-9);
        assertEquals(1, stats.minimum());
        assertEquals(2, stats.maximum());
        assertEquals(2, stats.sampleCount());
    }
}

class QuantifyNucleiPixelPluginMaskTests {

    @Test
    void emptyNucleiKeepFullFootprint() {
        PluginSampleGrid grid = grid(4, 4, 1.0);
        boolean[] mask = NucleusCircleMask.union(grid, List.of());
        assertEquals(16, mask.length);
        for (boolean bit : mask) assertTrue(bit);
    }

    @Test
    void circleMasksInteriorSamples() {
        PluginSampleGrid grid = grid(8, 8, 1.0);
        boolean[] mask = NucleusCircleMask.union(
                grid,
                List.of(new PluginExecuteRequest.NucleusFootprint(2, 2, 1.5))
        );
        assertTrue(mask[2 * 8 + 2]);
        assertTrue(mask[2 * 8 + 1]);
        assertEquals(false, mask[7 * 8 + 7]);
    }

    @Test
    void circleMaskIncludesBoundaryPixels() {
        PluginSampleGrid grid = grid(5, 5, 1.0);
        boolean[] mask = NucleusCircleMask.single(
                grid,
                new PluginExecuteRequest.NucleusFootprint(0, 0, 1)
        );
        assertTrue(mask[0]);
        assertTrue(mask[1]);
        assertTrue(mask[5]);
        assertEquals(false, mask[6]);
    }

    private static PluginSampleGrid grid(int width, int height, double scale) {
        return new PluginSampleGrid(
                0, 0, width, height,
                0, 0, width, height,
                scale, scale,
                List.of("DAPI"),
                new int[] {0},
                new int[][] {new int[width * height]}
        );
    }
}

class PerObjectPixelQuantifierPluginTests {

    @Test
    void emitsColorKeysWithoutChannelStats() {
        int width = 6;
        int height = 6;
        int[] plane = new int[width * height];
        for (int i = 0; i < plane.length; i++) plane[i] = i * 3;
        PluginSampleGrid grid = new PluginSampleGrid(
                0, 0, width, height,
                0, 0, width, height,
                1, 1,
                List.of("DAPI"),
                new int[] {0},
                new int[][] {plane}
        );
        List<ObjectColorKey> keys = PerObjectPixelQuantifierPlugin.quantifyObjects(
                grid,
                List.of(
                        new PluginExecuteRequest.NucleusFootprint(1, 1, 1),
                        new PluginExecuteRequest.NucleusFootprint(4, 4, 1)
                )
        );
        assertEquals(2, keys.size());
        assertEquals(0, keys.get(0).index());
        assertEquals(1, keys.get(1).index());
        assertTrue(keys.get(1).key() > keys.get(0).key());
    }

    @Test
    void reportsRetainPerChannelStatsForExport() {
        int width = 6;
        int height = 6;
        int[] plane = new int[width * height];
        for (int i = 0; i < plane.length; i++) plane[i] = i * 3;
        PluginSampleGrid grid = new PluginSampleGrid(
                0, 0, width, height,
                0, 0, width, height,
                1, 1,
                List.of("DAPI"),
                new int[] {0},
                new int[][] {plane}
        );
        List<NucleusObjectReport> reports = PerObjectPixelQuantifierPlugin.quantifyReports(
                grid,
                List.of(new PluginExecuteRequest.NucleusFootprint(1, 1, 1))
        );
        assertEquals(1, reports.size());
        assertEquals(1, reports.get(0).channels().size());
        assertTrue(reports.get(0).channels().get(0).sampleCount() > 0);
    }
}
