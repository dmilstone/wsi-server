package wsi_server.plugin;

import org.junit.jupiter.api.Test;
import wsi_server.ImageRegistry;
import wsi_server.WsiCatalogScanner;

import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class StarDistSegmentationPluginTests {

    @Test
    void selectsVersatileWeightsByModality() {
        assertEquals(StarDistTensorEngine.FLUO_WEIGHTS, StarDistTensorEngine.modelName(false));
        assertEquals(StarDistTensorEngine.HE_WEIGHTS, StarDistTensorEngine.modelName(true));
        assertEquals(false, StarDistTensorEngine.looksBrightfield(
                WsiCatalogScanner.MODALITY_FLUORESCENCE, WsiCatalogScanner.ENGINE_BIOFORMATS, false));
        assertEquals(true, StarDistTensorEngine.looksBrightfield(
                WsiCatalogScanner.MODALITY_FLUORESCENCE, WsiCatalogScanner.ENGINE_BIOFORMATS, true));
        assertEquals(true, StarDistTensorEngine.looksBrightfield(
                WsiCatalogScanner.MODALITY_BRIGHTFIELD, WsiCatalogScanner.ENGINE_OPENSLIDE, false));
    }

    @Test
    void missingWeightsStayNull() {
        assertEquals(null, StarDistTensorEngine.resolveWeights(Path.of("/tmp/missing-stardist"), StarDistTensorEngine.FLUO_WEIGHTS));
    }

    @Test
    void viewportMatrixYieldsThirtyTwoVertexPolygons() {
        int width = 64;
        int height = 64;
        int[] plane = new int[width * height];
        for (int y = 20; y <= 28; y++) {
            for (int x = 20; x <= 28; x++) {
                double dx = x - 24;
                double dy = y - 24;
                plane[y * width + x] = (int) Math.round(200 * Math.max(0, 1 - Math.hypot(dx, dy) / 6));
            }
        }
        PluginSampleGrid grid = new PluginSampleGrid(
                100, 200, width, height,
                100, 200, width, height,
                1, 1,
                List.of("DAPI"),
                new int[] {0},
                new int[][] {plane}
        );
        List<NucleusPolygon> nuclei = StarDistTensorEngine.infer(grid, false, null);
        assertTrue(nuclei.size() >= 1);
        NucleusPolygon nucleus = nuclei.getFirst();
        assertEquals(StarDistTensorEngine.RAYS, nucleus.vertices().size());
        assertTrue(nucleus.cx() > 100);
        assertTrue(nucleus.cy() > 200);
        for (NucleusPolygon.Vertex vertex : nucleus.vertices()) {
            assertTrue(Double.isFinite(vertex.x()));
            assertTrue(Double.isFinite(vertex.y()));
        }
    }

    @Test
    void brightfieldEntryUsesHeRoute() {
        ImageRegistry.ImageEntry entry = new ImageRegistry.ImageEntry(
                "id", "slide.svs", "slide.svs", "", Path.of("slide.svs"),
                "", 1, 0, 0,
                WsiCatalogScanner.MODALITY_BRIGHTFIELD,
                WsiCatalogScanner.ENGINE_OPENSLIDE
        );
        assertEquals(true, StarDistSegmentationPlugin.isBrightfieldEntry(entry, false));
        assertEquals(StarDistTensorEngine.HE_WEIGHTS,
                StarDistTensorEngine.modelName(StarDistSegmentationPlugin.isBrightfieldEntry(entry, false)));
    }
}
