package wsi_server.plugin;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class CellDetectionPluginTests {

    @Test
    void qupathWatershedFindsACompactBlob() {
        PluginSampleGrid grid = blobGrid();
        List<NucleusPolygon> nuclei = QuPathCellDetectionEngine.detect(
                grid, false, new QuPathCellDetectionEngine.Params(0.35, 2.0, 1.0, 8.0, 400.0, 0.0));
        assertFalse(nuclei.isEmpty(), "watershed should keep the bright blob");
        NucleusPolygon nucleus = nuclei.getFirst();
        assertTrue(nucleus.vertices().size() >= 3);
        assertTrue(nucleus.cx() > 100);
        assertTrue(nucleus.cy() > 200);
    }

    @Test
    void cellposeFallbackReturnsIsotropicPolygons() {
        PluginSampleGrid grid = blobGrid();
        List<NucleusPolygon> nuclei = CellposeEngine.detect(
                grid, false, new CellposeEngine.Params(0.35, 0.5, 16.0, "nuclei"));
        assertFalse(nuclei.isEmpty(), "cellpose fallback should keep the bright blob");
        NucleusPolygon nucleus = nuclei.getFirst();
        assertTrue(nucleus.vertices().size() >= 3);
        double[] radii = nucleus.vertices().stream()
                .mapToDouble(vertex -> Math.hypot(vertex.x() - nucleus.cx(), vertex.y() - nucleus.cy()))
                .toArray();
        double min = radii[0];
        double max = radii[0];
        for (double radius : radii) {
            if (radius < min) min = radius;
            if (radius > max) max = radius;
        }
        assertTrue(max - min < 1e-6, "fallback outlines should be circularized");
    }

    @Test
    void cellposeModelNameDefaultsByModality() {
        assertEquals("nuclei", CellposeEngine.modelName(null, false));
        assertEquals("cyto2", CellposeEngine.modelName("auto", true));
        assertEquals("cyto3", CellposeEngine.modelName("cyto3", false));
    }

    @Test
    void cellBoundaryExpanderGrowsARingAndCapsIt() {
        List<NucleusPolygon.Vertex> square = List.of(
                new NucleusPolygon.Vertex(0, 0),
                new NucleusPolygon.Vertex(10, 0),
                new NucleusPolygon.Vertex(10, 10),
                new NucleusPolygon.Vertex(0, 10)
        );
        NucleusPolygon nucleus = new NucleusPolygon(0, 5, 5, square);
        List<NucleusPolygon> radial = CellBoundaryExpander.attach(
                List.of(nucleus), CellBoundaryExpander.Mode.RADIAL, 2.0, 1.5);
        assertEquals(1, radial.size());
        assertFalse(radial.getFirst().cellVertices().isEmpty());
        NucleusPolygon.Vertex grown = radial.getFirst().cellVertices().getFirst();
        assertTrue(Math.hypot(grown.x() - 5, grown.y() - 5) <= Math.hypot(-5, -5) * 1.5 + 1e-6);

        List<NucleusPolygon> none = CellBoundaryExpander.attach(
                List.of(nucleus), CellBoundaryExpander.Mode.NONE, 2.0, 1.5);
        assertTrue(none.getFirst().cellVertices().isEmpty());
        assertEquals(CellBoundaryExpander.Mode.OFFSET, CellBoundaryExpander.parse("perimeter", null));
        assertEquals(CellBoundaryExpander.Mode.WATERSHED, CellBoundaryExpander.parse("watershed", null));
    }

    @Test
    void pluginIdsMatchTheAiLabsSelector() {
        assertEquals("cellpose-segmentation", CellposeSegmentationPlugin.ID);
        assertEquals("qupath-cell-detection", QuPathCellDetectionPlugin.ID);
        assertEquals("stardist-segmentation", StarDistSegmentationPlugin.ID);
    }

    private static PluginSampleGrid blobGrid() {
        int width = 48;
        int height = 48;
        int[] plane = new int[width * height];
        for (int y = 16; y <= 28; y++) {
            for (int x = 16; x <= 28; x++) {
                double dx = x - 22;
                double dy = y - 22;
                plane[y * width + x] = (int) Math.round(220 * Math.max(0, 1 - Math.hypot(dx, dy) / 8));
            }
        }
        return new PluginSampleGrid(
                100, 200, width, height,
                100, 200, width, height,
                1, 1,
                List.of("DAPI"),
                new int[] {0},
                new int[][] {plane}
        );
    }
}
