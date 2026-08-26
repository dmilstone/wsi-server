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
    void probabilityOverrideChangesDetectionCount() {
        // Regression: the AI Labs "probability threshold" slider used to be silently
        // ignored by the backend StarDist plugin, so a second click with a different
        // slider value produced byte-for-byte identical results. Two blobs of very
        // different brightness: a strict override should drop the dim one, a lenient
        // override should keep both.
        int width = 48;
        int height = 48;
        int[] plane = new int[width * height];
        paintBlob(plane, width, 10, 10, 3, 200);
        paintBlob(plane, width, 36, 36, 3, 80);
        PluginSampleGrid grid = new PluginSampleGrid(
                0, 0, width, height,
                0, 0, width, height,
                1, 1,
                List.of("DAPI"),
                new int[] {0},
                new int[][] {plane}
        );
        List<NucleusPolygon> strict = StarDistTensorEngine.infer(
                grid, false, null, new StarDistTensorEngine.Params(0.7, null, null, null, null));
        List<NucleusPolygon> lenient = StarDistTensorEngine.infer(
                grid, false, null, new StarDistTensorEngine.Params(0.2, null, null, null, null));
        assertEquals(1, strict.size(), "a strict probability override must drop the dim blob");
        assertEquals(2, lenient.size(), "a lenient probability override must keep both blobs");
    }

    @Test
    void nmsOverrideChangesDetectionCount() {
        // Regression: the "overlap suppression" (NMS) slider used a hardcoded 5px radius
        // no matter what the UI sent. Two peaks 7px apart: the default/low-suppression
        // radius keeps them separate, a high-suppression override must merge them.
        int width = 48;
        int height = 40;
        int[] plane = new int[width * height];
        paintBlob(plane, width, 17, 20, 3, 200);
        paintBlob(plane, width, 24, 20, 3, 200);
        PluginSampleGrid grid = new PluginSampleGrid(
                0, 0, width, height,
                0, 0, width, height,
                1, 1,
                List.of("DAPI"),
                new int[] {0},
                new int[][] {plane}
        );
        List<NucleusPolygon> defaultNms = StarDistTensorEngine.infer(grid, false, null, StarDistTensorEngine.Params.DEFAULT);
        List<NucleusPolygon> lowSuppression = StarDistTensorEngine.infer(
                grid, false, null, new StarDistTensorEngine.Params(null, 0.1, null, null, null));
        List<NucleusPolygon> highSuppression = StarDistTensorEngine.infer(
                grid, false, null, new StarDistTensorEngine.Params(null, 1.0, null, null, null));
        assertEquals(2, defaultNms.size(), "default NMS radius must keep two 7px-apart peaks separate");
        assertEquals(2, lowSuppression.size(), "low suppression must still keep them separate");
        assertEquals(1, highSuppression.size(), "high suppression must merge two nearby peaks into one");
    }

    @Test
    void maxNucleusRadiusOverrideChangesOutlineReach() {
        // A single bright blob with a broad, gradually-fading halo: a small max-radius
        // override should stop each outline ray early (small polygon), while a large
        // override should let rays travel farther out into the halo (bigger polygon).
        int width = 60;
        int height = 60;
        int[] plane = new int[width * height];
        paintBlob(plane, width, 30, 30, 18, 200);
        PluginSampleGrid grid = new PluginSampleGrid(
                0, 0, width, height,
                0, 0, width, height,
                1, 1,
                List.of("DAPI"),
                new int[] {0},
                new int[][] {plane}
        );
        List<NucleusPolygon> smallRadius = StarDistTensorEngine.infer(
                grid, false, null, new StarDistTensorEngine.Params(null, null, 2.0, null, null));
        List<NucleusPolygon> largeRadius = StarDistTensorEngine.infer(
                grid, false, null, new StarDistTensorEngine.Params(null, null, 40.0, null, null));
        assertEquals(1, smallRadius.size());
        assertEquals(1, largeRadius.size());
        double smallReach = maxVertexDistance(smallRadius.getFirst());
        double largeReach = maxVertexDistance(largeRadius.getFirst());
        assertTrue(largeReach > smallReach,
                "a larger max-nucleus-radius override must let outline rays reach farther out");
    }

    @Test
    void rayCountOverrideChangesVertexCount() {
        int width = 48;
        int height = 48;
        int[] plane = new int[width * height];
        paintBlob(plane, width, 24, 24, 8, 200);
        PluginSampleGrid grid = new PluginSampleGrid(
                0, 0, width, height,
                0, 0, width, height,
                1, 1,
                List.of("DAPI"),
                new int[] {0},
                new int[][] {plane}
        );
        List<NucleusPolygon> sixteenRays = StarDistTensorEngine.infer(
                grid, false, null, new StarDistTensorEngine.Params(null, null, null, 16, null));
        List<NucleusPolygon> sixtyFourRays = StarDistTensorEngine.infer(
                grid, false, null, new StarDistTensorEngine.Params(null, null, null, 64, null));
        assertEquals(16, sixteenRays.getFirst().vertices().size());
        assertEquals(64, sixtyFourRays.getFirst().vertices().size());
    }

    @Test
    void boundaryTightnessOverrideChangesOutlineSize() {
        int width = 48;
        int height = 48;
        int[] plane = new int[width * height];
        paintBlob(plane, width, 24, 24, 12, 200);
        PluginSampleGrid grid = new PluginSampleGrid(
                0, 0, width, height,
                0, 0, width, height,
                1, 1,
                List.of("DAPI"),
                new int[] {0},
                new int[][] {plane}
        );
        List<NucleusPolygon> loose = StarDistTensorEngine.infer(
                grid, false, null, new StarDistTensorEngine.Params(null, null, null, null, 0.4));
        List<NucleusPolygon> tight = StarDistTensorEngine.infer(
                grid, false, null, new StarDistTensorEngine.Params(null, null, null, null, 0.98));
        double looseReach = maxVertexDistance(loose.getFirst());
        double tightReach = maxVertexDistance(tight.getFirst());
        assertTrue(looseReach >= tightReach,
                "a looser boundary tightness override must produce an outline that reaches at least as far");
    }

    @Test
    void outlierRayIsClampedTowardsPeersMedianLength() {
        // Regression for the "spaghetti"/spiky outline bug seen on real slides: when a
        // nucleus touches a neighbor (or a bright non-nuclear region) through a narrow
        // bridge in one specific direction, that single ray can travel far past where
        // every other ray around the same peak stopped. Build a peak whose brightness
        // extends only ~5px in every direction except a single 1px-wide corridor along
        // the +x axis that stays bright out to 20px, and confirm the resulting vertex
        // in that direction is pulled back towards the other rays' length instead of
        // reaching all the way out to the corridor's end.
        int width = 50;
        int height = 50;
        int cx = 25;
        int cy = 25;
        float[] field = new float[width * height];
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                double dist = Math.hypot(x - cx, y - cy);
                field[y * width + x] = dist <= 5 ? 1.0f : 0.0f;
            }
        }
        for (int x = cx; x <= cx + 20; x++) {
            field[cy * width + x] = 1.0f;
        }
        PluginSampleGrid grid = new PluginSampleGrid(
                0, 0, width, height,
                0, 0, width, height,
                1, 1,
                List.of("DAPI"),
                new int[] {0},
                new int[][] {new int[width * height]}
        );
        StarDistTensorEngine.Peak peak = new StarDistTensorEngine.Peak(cx, cy, 1.0, 10f);
        List<NucleusPolygon.Vertex> ring = StarDistTensorEngine.starConvexVertices(
                grid, field, width, height, peak, 0.5f, 8, 1.0f);
        assertEquals(8, ring.size());
        double bridgeRayDist = Math.hypot(ring.get(0).x() - cx, ring.get(0).y() - cy);
        double otherRaysMax = 0;
        for (int i = 1; i < ring.size(); i++) {
            double dist = Math.hypot(ring.get(i).x() - cx, ring.get(i).y() - cy);
            otherRaysMax = Math.max(otherRaysMax, dist);
        }
        assertTrue(bridgeRayDist < 15, "the bridging ray must be clamped well short of the 20px corridor, was " + bridgeRayDist);
        assertTrue(otherRaysMax <= 6, "the un-bridged rays must still stop near the ~5px disk edge, was " + otherRaysMax);
        assertTrue(bridgeRayDist > otherRaysMax,
                "the clamp should still allow the bridging ray to reach somewhat farther than its peers, not erase it entirely");
    }

    @Test
    void lowProminenceBumpIsRejectedWhileSharpPeakSurvives() {
        // Regression for over-segmentation on non-nuclear textured tissue (fibrous
        // stroma, faint background noise): such regions can contain pixels that are
        // technically the single brightest one in their own 5x5 window (a bare local
        // maximum) without being meaningfully brighter than their surroundings. A real
        // nucleus, by contrast, stands out sharply from its immediate neighborhood.
        // Exercise findPeaks() directly (bypassing the channel-blur/normalize pipeline)
        // so both cases are precisely, deterministically controlled.
        int width = 40;
        int height = 40;
        float[] field = new float[width * height];
        float cut = 0.40f;
        // Sharp, high-contrast peak at (10, 10): drops to background within 3px.
        for (int y = 4; y <= 16; y++) {
            for (int x = 4; x <= 16; x++) {
                double d = Math.hypot(x - 10, y - 10);
                float value = (float) Math.max(0, 1.0 - d / 3.0);
                if (value > field[y * width + x]) field[y * width + x] = value;
            }
        }
        // Gently-sloped, low-contrast bump at (28, 28): its peak clears the cut, but
        // its immediate 5x5 neighborhood is nearly identical in value (a shallow hill
        // rather than a real nuclear boundary drop-off).
        for (int y = 22; y <= 34; y++) {
            for (int x = 22; x <= 34; x++) {
                double d2 = Math.pow(x - 28, 2) + Math.pow(y - 28, 2);
                float value = (float) Math.max(0, 0.45 - 0.002 * d2);
                if (value > field[y * width + x]) field[y * width + x] = value;
            }
        }
        List<StarDistTensorEngine.Peak> peaks = StarDistTensorEngine.findPeaks(field, width, height, cut, null, null);
        assertEquals(1, peaks.size(), "the low-prominence bump must be rejected, only the sharp peak should survive");
        StarDistTensorEngine.Peak survivor = peaks.getFirst();
        assertTrue(Math.hypot(survivor.x - 10, survivor.y - 10) < 2, "the surviving peak must be the sharp, high-contrast one");
    }

    private static double maxVertexDistance(NucleusPolygon nucleus) {
        double max = 0;
        for (NucleusPolygon.Vertex vertex : nucleus.vertices()) {
            double dist = Math.hypot(vertex.x() - nucleus.cx(), vertex.y() - nucleus.cy());
            if (dist > max) max = dist;
        }
        return max;
    }

    private static void paintBlob(int[] plane, int width, int cx, int cy, int radius, int peak) {
        int height = plane.length / width;
        for (int y = Math.max(0, cy - radius); y <= Math.min(height - 1, cy + radius); y++) {
            for (int x = Math.max(0, cx - radius); x <= Math.min(width - 1, cx + radius); x++) {
                double dist = Math.hypot(x - cx, y - cy);
                int value = (int) Math.round(peak * Math.max(0, 1 - dist / radius));
                if (value > plane[y * width + x]) plane[y * width + x] = value;
            }
        }
    }

    @Test
    void pluginResultSegmentationEngineDefaultsToNullForNonStarDistPlugins() {
        // Every other plugin (pixel intensity, IHC deconvolution, per-object quantifier)
        // constructs PluginResult via the pre-existing 12-arg compatibility constructor
        // and must keep getting `null` for segmentationEngine -- it's StarDist-specific.
        PluginResult legacy = new PluginResult(
                "quantify-nuclei-pixel", "Pixel Intensity", 0, 0, 10, 10, 10, 10, 0, 100,
                java.util.List.of(), java.util.List.of());
        assertEquals(null, legacy.segmentationEngine());
        assertEquals(0, legacy.nuclei().size());

        PluginResult withNuclei = new PluginResult(
                "stardist-segmentation", "StarDist Nuclear Contours", 0, 0, 10, 10, 10, 10, 0, 0,
                java.util.List.of(), java.util.List.of(), java.util.List.of());
        assertEquals(null, withNuclei.segmentationEngine());

        PluginResult explicit = new PluginResult(
                "stardist-segmentation", "StarDist Nuclear Contours (stardist-fallback-heuristic)",
                0, 0, 10, 10, 10, 10, 0, 0,
                java.util.List.of(), java.util.List.of(), java.util.List.of(),
                StarDistTensorEngine.FALLBACK_ENGINE_LABEL);
        assertEquals("stardist-fallback-heuristic", explicit.segmentationEngine());
    }

    @Test
    void nativeModelImplementedConstantMustStayFalseUntilRealInferenceExists() {
        // Guards against silent doc drift: this must only ever flip to true in the
        // same change that makes tryNativeSession actually execute a forward pass.
        // If this test starts failing because someone flipped the constant, go
        // update PluginResult.segmentationEngine()'s value in StarDistSegmentationPlugin
        // and docs/adr/0001-stardist-is-a-custom-fallback-heuristic.md at the same time.
        assertEquals(false, StarDistTensorEngine.NATIVE_MODEL_IMPLEMENTED,
                "flip this only alongside a real tryNativeSession implementation");
        assertEquals("stardist-fallback-heuristic", StarDistTensorEngine.FALLBACK_ENGINE_LABEL);
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

    @Test
    void modelOverrideForcesRequestedModelRegardlessOfMetadata() {
        // A fluorescence-tagged entry, but the user forces "he" (or "fluorescence")
        // from the new Advanced StarDist Parameters dropdown.
        ImageRegistry.ImageEntry fluoEntry = new ImageRegistry.ImageEntry(
                "id", "slide.tif", "slide.tif", "", Path.of("slide.tif"),
                "", 1, 0, 0,
                WsiCatalogScanner.MODALITY_FLUORESCENCE,
                WsiCatalogScanner.ENGINE_BIOFORMATS
        );
        assertEquals(false, StarDistSegmentationPlugin.resolveBrightfield(null, fluoEntry, false),
                "no override must fall back to metadata-driven auto-detection");
        assertEquals(false, StarDistSegmentationPlugin.resolveBrightfield("auto", fluoEntry, false));
        assertEquals(true, StarDistSegmentationPlugin.resolveBrightfield("he", fluoEntry, false),
                "forcing \"he\" must override fluorescence metadata");
        assertEquals(true, StarDistSegmentationPlugin.resolveBrightfield("brightfield", fluoEntry, false));

        ImageRegistry.ImageEntry brightfieldEntry = new ImageRegistry.ImageEntry(
                "id2", "slide.svs", "slide.svs", "", Path.of("slide.svs"),
                "", 1, 0, 0,
                WsiCatalogScanner.MODALITY_BRIGHTFIELD,
                WsiCatalogScanner.ENGINE_OPENSLIDE
        );
        assertEquals(false, StarDistSegmentationPlugin.resolveBrightfield("fluorescence", brightfieldEntry, false),
                "forcing \"fluorescence\" must override brightfield metadata");
    }
}
