package wsi_server.plugin;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

/**
 * <b>This is NOT stock/upstream StarDist.</b> It is a from-scratch, custom Java
 * approximation of a StarDist-style detector (per-pixel peak-finding + 32-ray
 * star-convex boundary tracing), named after and loosely modeled on the real
 * algorithm, but it is not the published StarDist neural network and does not
 * reproduce its accuracy characteristics. See {@code docs/adr/0001-stardist-is-a-custom-fallback-heuristic.md}
 * for the full rationale and implications for any external tooling that expects
 * a standard StarDist model/output here.
 * <p>
 * Viewport planes are packed into an NHWC float tensor and {@link #runTensorEngine}
 * is <em>intended</em> to pass that tensor through a real ONNX / TensorFlow Java
 * session when {@code stardist_2d_versatile_fluo} or {@code stardist_2d_versatile_he}
 * weights are present. As of now that native-model path ({@link #tryNativeSession})
 * is an unimplemented detection stub — see {@link #NATIVE_MODEL_IMPLEMENTED} — so
 * every call, regardless of environment or installed weights, runs the 32-ray
 * star-convex heuristic loop below instead of a trained model's output.
 */
public final class StarDistTensorEngine {

    public static final String FLUO_WEIGHTS = "stardist_2d_versatile_fluo";
    public static final String HE_WEIGHTS = "stardist_2d_versatile_he";
    public static final int RAYS = 32;
    public static final int MAX_NUCLEI = 2500;

    /**
     * {@code true} once {@link #tryNativeSession} actually executes a trained-model
     * forward pass (an ONNX {@code OrtSession.run(...)} or TensorFlow
     * {@code SavedModelBundle} runner call) and returns its real output instead of
     * unconditionally returning {@code null}. Today this is always {@code false}:
     * {@code tryNativeSession} only checks whether the ONNX Runtime / TensorFlow
     * Java classes are on the classpath and whether a weights file/directory
     * exists at the resolved path — it never calls the inference API itself, so
     * installing real weights currently changes nothing about the output.
     * {@link StarDistSegmentationPlugin} reports this to API clients via
     * {@code PluginResult.segmentationEngine()} so any caller (including other
     * software integrating with this server) can detect the actual engine in use
     * without relying on documentation alone. Flip this the moment
     * {@code tryNativeSession} genuinely runs a forward pass.
     */
    public static final boolean NATIVE_MODEL_IMPLEMENTED = false;

    /**
     * Machine-readable label reported to API callers (via
     * {@code PluginResult.segmentationEngine()}) whenever {@link #NATIVE_MODEL_IMPLEMENTED}
     * is {@code false} -- i.e. always, today.
     */
    public static final String FALLBACK_ENGINE_LABEL = "stardist-fallback-heuristic";

    /**
     * Minimum peak "prominence" (a candidate's own value minus the mean of its
     * immediate local-max search ring), expressed as a fraction of the region's
     * detection cut. A bare local-maximum test alone (the loop below) accepts any
     * pixel that is merely the single brightest one in its 5x5 window; on smooth,
     * low-contrast textured tissue (fibrous stroma, tissue edges, faint background
     * noise) that produces a dense field of only-marginally-brighter "peaks" packed
     * close together, each spawning its own tiny outline — the tangled/over-segmented
     * mesh seen on non-nuclear textured regions. Requiring real local contrast filters
     * those out while leaving genuine, sharply-defined nucleus centers untouched.
     */
    private static final float PEAK_PROMINENCE_FRACTION = 0.05f;

    /**
     * A boundary-tracing ray must drop to at most this fraction of its own peak's
     * brightness to count as "outside" the nucleus (a half-max-style criterion).
     * Without this, a peak sitting inside a broader, locally-elevated-background
     * region (e.g. a diffuse non-nuclear marker channel, or higher baseline stain
     * intensity) can satisfy the flat global cut for a very long distance, tracing
     * the boundary of that whole broader region instead of the individual nucleus.
     */
    private static final float RAY_RELATIVE_DROPOFF = 0.55f;

    /**
     * Caps any single ray's length to this multiple of the peak's own median ray
     * length. Real nuclei are reasonably star-convex/compact; when one or two rays
     * happen to bridge into a touching neighbor or a stray bright pixel they can
     * shoot out far past their neighbors, producing a spiky, self-intersecting
     * outline. Clamping relative to the peak's own median keeps moderate, genuine
     * anisotropy (elongated nuclei) intact while suppressing outlier spikes.
     */
    private static final double RAY_OUTLIER_MEDIAN_FACTOR = 2.2;

    private StarDistTensorEngine() {
    }

    public static String modelName(boolean brightfield) {
        return brightfield ? HE_WEIGHTS : FLUO_WEIGHTS;
    }

    public static boolean looksBrightfield(String modality, String engine, boolean rgbSeries) {
        String mode = modality == null ? "" : modality.trim().toUpperCase(Locale.ROOT);
        String runtime = engine == null ? "" : engine.trim().toUpperCase(Locale.ROOT);
        return rgbSeries
                || "BRIGHTFIELD".equals(mode)
                || "OPENSLIDE".equals(runtime);
    }

    public static Path resolveWeights(Path modelDirectory, String modelName) {
        if (modelDirectory == null || modelName == null || modelName.isBlank()) return null;
        Path onnx = modelDirectory.resolve(modelName + ".onnx");
        if (Files.isRegularFile(onnx)) return onnx;
        Path pb = modelDirectory.resolve(modelName + ".pb");
        if (Files.isRegularFile(pb)) return pb;
        Path saved = modelDirectory.resolve(modelName);
        if (Files.isDirectory(saved)) return saved;
        return null;
    }

    /**
     * Every user-tunable knob the fallback 32-ray engine loop actually reads.
     * All fields are nullable; {@code null} preserves the pre-existing legacy
     * default for that one parameter, so old callers (and the ONNX/TensorFlow
     * native-model path, which ignores all of these) are unaffected.
     */
    public record Params(
            Double probability,
            Double nms,
            Double maxNucleusRadius,
            Integer rayCount,
            Double boundaryTightness
    ) {
        public static final Params DEFAULT = new Params(null, null, null, null, null);
    }

    /**
     * Packs sample planes into little-endian float32 NHWC bytes
     * {@code [1, height, width, channels]} and runs the tensor engine.
     * Uses every legacy adaptive/fixed default (see {@link Params#DEFAULT}).
     */
    public static List<NucleusPolygon> infer(PluginSampleGrid grid, boolean brightfield, Path weights) {
        return infer(grid, brightfield, weights, Params.DEFAULT);
    }

    /**
     * Same as {@link #infer(PluginSampleGrid, boolean, Path)} but lets the caller
     * override every tunable parameter of the fallback star-convex engine loop
     * (e.g. from the AI Labs panel's "Advanced StarDist Parameters" controls)
     * instead of always relying on adaptive statistics / hardcoded defaults.
     *
     * @param params probability (0.05-0.95 fraction of the tile's peak intensity;
     *               higher = stricter/fewer detections), nms (0.1-1.0 suppression
     *               strength; higher = detections pushed farther apart / merged),
     *               maxNucleusRadius (2-40px expected/max nucleus radius; controls
     *               how far each of the 32 outline rays searches), rayCount (8-128
     *               outline vertices per nucleus; higher = smoother polygons), and
     *               boundaryTightness (0.4-0.98; higher = tighter outline hugging
     *               only the brightest core, lower = looser/larger outline).
     */
    public static List<NucleusPolygon> infer(
            PluginSampleGrid grid,
            boolean brightfield,
            Path weights,
            Params params
    ) {
        if (grid == null || grid.sampleWidth() <= 0 || grid.sampleHeight() <= 0) return List.of();
        float[][][] tensor = packNhwc(grid, brightfield);
        byte[] matrix = toFloat32Bytes(tensor);
        float[][][] activated = runTensorEngine(matrix, tensor, weights);
        Params resolved = params == null ? Params.DEFAULT : params;
        return polygonsFromProbability(grid, nuclearChannel(activated, brightfield), brightfield, resolved);
    }

    static float[][][] packNhwc(PluginSampleGrid grid, boolean brightfield) {
        int width = grid.sampleWidth();
        int height = grid.sampleHeight();
        int channels = Math.max(1, grid.planes() == null ? 1 : grid.planes().length);
        float[][][] tensor = new float[height][width][channels];
        for (int channel = 0; channel < channels; channel++) {
            int[] plane = grid.planes()[channel];
            if (plane == null) continue;
            float scale = peak(plane);
            if (scale <= 0) scale = 1f;
            for (int y = 0; y < height; y++) {
                int row = y * width;
                for (int x = 0; x < width; x++) {
                    int index = row + x;
                    float value = index < plane.length ? plane[index] / scale : 0f;
                    tensor[y][x][channel] = brightfield ? 1f - value : value;
                }
            }
        }
        return tensor;
    }

    static byte[] toFloat32Bytes(float[][][] tensor) {
        int height = tensor.length;
        int width = height == 0 ? 0 : tensor[0].length;
        int channels = width == 0 ? 0 : tensor[0][0].length;
        ByteBuffer buffer = ByteBuffer.allocate(height * width * channels * Float.BYTES)
                .order(ByteOrder.LITTLE_ENDIAN);
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                for (int c = 0; c < channels; c++) {
                    buffer.putFloat(tensor[y][x][c]);
                }
            }
        }
        return buffer.array();
    }

    /**
     * Placeholder hook for a future real ONNX ({@code ai.onnxruntime.OrtEnvironment})
     * or TensorFlow Java ({@code org.tensorflow.SavedModelBundle}) inference call.
     * See {@link #NATIVE_MODEL_IMPLEMENTED}: {@link #tryNativeSession} currently
     * always returns {@code null} (see below), so this unconditionally falls through
     * to the 32-ray heuristic loop today, regardless of {@code weights}.
     */
    static float[][][] runTensorEngine(byte[] matrix, float[][][] tensor, Path weights) {
        if (weights != null && matrix != null && matrix.length > 0) {
            float[][][] nativeOutput = tryNativeSession(matrix, tensor, weights);
            if (nativeOutput != null) return nativeOutput;
        }
        return tensor;
    }

    /**
     * NOT YET A REAL MODEL CALL. This only detects whether the ONNX Runtime /
     * TensorFlow Java classes are on the classpath and whether a plausible weights
     * file/directory exists — it deliberately stops short of actually invoking
     * {@code OrtSession.run(...)} or a TensorFlow {@code SavedModelBundle} runner,
     * and always returns {@code null} either way. Update {@link #NATIVE_MODEL_IMPLEMENTED}
     * to {@code true} (and {@code PluginResult.segmentationEngine()}'s caller in
     * {@link StarDistSegmentationPlugin}) once this actually runs a forward pass.
     */
    private static float[][][] tryNativeSession(byte[] matrix, float[][][] tensor, Path weights) {
        try {
            Class.forName("ai.onnxruntime.OrtEnvironment");
            // Weights are selected and the NHWC buffer is ready for OrtSession.run,
            // but that call is not yet implemented -- see the Javadoc above.
            if (Files.isRegularFile(weights) && weights.getFileName().toString().endsWith(".onnx")) {
                return null;
            }
        } catch (ClassNotFoundException ignored) {
            // ONNX Runtime Java is not on the classpath.
        }
        try {
            Class.forName("org.tensorflow.SavedModelBundle");
            if (Files.isDirectory(weights)) {
                return null;
            }
        } catch (ClassNotFoundException ignored) {
            // TensorFlow Java is not on the classpath.
        }
        return matrix == null ? null : tensor;
    }

    static float[] nuclearChannel(float[][][] tensor, boolean brightfield) {
        int height = tensor.length;
        int width = height == 0 ? 0 : tensor[0].length;
        int channels = width == 0 ? 0 : tensor[0][0].length;
        float[] field = new float[width * height];
        for (int y = 0; y < height; y++) {
            int row = y * width;
            for (int x = 0; x < width; x++) {
                float value;
                if (brightfield) {
                    float sum = 0f;
                    for (int c = 0; c < channels; c++) sum += tensor[y][x][c];
                    value = channels == 0 ? 0f : sum / channels;
                } else {
                    value = tensor[y][x][0];
                    for (int c = 1; c < channels; c++) {
                        if (tensor[y][x][c] > value) value = tensor[y][x][c];
                    }
                }
                field[row + x] = value;
            }
        }
        return blur3(field, width, height);
    }

    static List<NucleusPolygon> polygonsFromProbability(PluginSampleGrid grid, float[] field, boolean brightfield) {
        return polygonsFromProbability(grid, field, brightfield, Params.DEFAULT);
    }

    static List<NucleusPolygon> polygonsFromProbability(
            PluginSampleGrid grid,
            float[] field,
            boolean brightfield,
            Params params
    ) {
        int width = grid.sampleWidth();
        int height = grid.sampleHeight();
        if (field == null || field.length < width * height) return List.of();
        float cut = threshold(field, brightfield, params.probability());
        int rayCount = resolveRayCount(params.rayCount());
        float boundaryTightness = resolveBoundaryTightness(params.boundaryTightness());
        List<Peak> peaks = findPeaks(field, width, height, cut, params.nms(), params.maxNucleusRadius());
        List<NucleusPolygon> polygons = new ArrayList<>();
        for (Peak peak : peaks) {
            if (polygons.size() >= MAX_NUCLEI) break;
            List<NucleusPolygon.Vertex> vertices = starConvexVertices(
                    grid, field, width, height, peak, cut, rayCount, boundaryTightness);
            if (vertices.size() < 3) continue;
            polygons.add(new NucleusPolygon(
                    polygons.size(),
                    grid.imageXOf((int) Math.round(peak.x)),
                    grid.imageYOf((int) Math.round(peak.y)),
                    vertices));
        }
        return List.copyOf(polygons);
    }

    static List<NucleusPolygon.Vertex> starConvexVertices(
            PluginSampleGrid grid,
            float[] field,
            int width,
            int height,
            Peak peak,
            float threshold,
            int rayCount,
            float boundaryTightness
    ) {
        // Bound the boundary-tracing cut to this specific peak's own brightness (not
        // just the flat global cut) so a nucleus sitting inside a broader, locally
        // brighter region still gets an outline sized to itself, not to that region.
        float cut = Math.max(Math.max(0.05f, threshold * boundaryTightness), (float) (peak.score * RAY_RELATIVE_DROPOFF));
        float limit = Math.max(4f, peak.radius * 2.6f);
        double[] lengths = new double[rayCount];
        for (int ray = 0; ray < rayCount; ray++) {
            double angle = (ray / (double) rayCount) * Math.PI * 2;
            double dx = Math.cos(angle);
            double dy = Math.sin(angle);
            double last = 1.5;
            for (int r = 1; r <= limit; r++) {
                int x = (int) Math.round(peak.x + dx * r);
                int y = (int) Math.round(peak.y + dy * r);
                if (x < 0 || y < 0 || x >= width || y >= height) break;
                if (field[y * width + x] < cut) break;
                last = r;
            }
            lengths[ray] = last;
        }
        double median = median(lengths);
        double outlierCap = Math.max(median * RAY_OUTLIER_MEDIAN_FACTOR, 2.5);
        List<NucleusPolygon.Vertex> ring = new ArrayList<>(rayCount);
        for (int ray = 0; ray < rayCount; ray++) {
            double angle = (ray / (double) rayCount) * Math.PI * 2;
            double dx = Math.cos(angle);
            double dy = Math.sin(angle);
            double last = Math.min(lengths[ray], outlierCap);
            ring.add(new NucleusPolygon.Vertex(
                    grid.imageXOf((int) Math.round(peak.x + dx * last)),
                    grid.imageYOf((int) Math.round(peak.y + dy * last))
            ));
        }
        return ring;
    }

    private static double median(double[] values) {
        if (values.length == 0) return 0;
        double[] sorted = values.clone();
        java.util.Arrays.sort(sorted);
        int mid = sorted.length / 2;
        return sorted.length % 2 == 0 ? (sorted[mid - 1] + sorted[mid]) / 2.0 : sorted[mid];
    }

    static List<Peak> findPeaks(
            float[] field, int width, int height, float cut, Double nmsOverride, Double maxNucleusRadiusOverride
    ) {
        int radius = 2;
        float peakRadius = resolvePeakRadius(maxNucleusRadiusOverride);
        List<Peak> peaks = new ArrayList<>();
        for (int y = radius; y < height - radius; y++) {
            for (int x = radius; x < width - radius; x++) {
                float value = field[y * width + x];
                if (value < cut) continue;
                boolean max = true;
                double neighborSum = 0;
                int neighborCount = 0;
                for (int dy = -radius; dy <= radius && max; dy++) {
                    for (int dx = -radius; dx <= radius; dx++) {
                        if (dx == 0 && dy == 0) continue;
                        float neighbor = field[(y + dy) * width + (x + dx)];
                        if (neighbor > value) {
                            max = false;
                            break;
                        }
                        neighborSum += neighbor;
                        neighborCount += 1;
                    }
                }
                if (!max) continue;
                // Prominence gate — see PEAK_PROMINENCE_FRACTION.
                double neighborMean = neighborCount == 0 ? 0 : neighborSum / neighborCount;
                if (value - neighborMean < cut * PEAK_PROMINENCE_FRACTION) continue;
                peaks.add(new Peak(x, y, value, peakRadius));
            }
        }
        peaks.sort(Comparator.comparingDouble((Peak peak) -> peak.score).reversed());
        List<Peak> kept = new ArrayList<>();
        double minDist2 = resolveNmsMinDist2(nmsOverride);
        for (Peak peak : peaks) {
            boolean near = false;
            for (Peak other : kept) {
                double dx = other.x - peak.x;
                double dy = other.y - peak.y;
                if (dx * dx + dy * dy < minDist2) {
                    near = true;
                    break;
                }
            }
            if (!near) kept.add(peak);
        }
        return kept;
    }

    private static float threshold(float[] field, boolean brightfield) {
        double sum = 0;
        int count = 0;
        float max = 0;
        for (float value : field) {
            if (value > 0.05f) {
                sum += value;
                count += 1;
            }
            if (value > max) max = value;
        }
        if (max < 0.08f || count < 8) return 1f;
        float mean = (float) (sum / count);
        float strict = brightfield ? 0.38f : 0.32f;
        return Math.max(0.12f, mean + (0.14f + strict * 0.42f) * Math.max(0.04f, max - mean));
    }

    /**
     * Same adaptive threshold as {@link #threshold(float[], boolean)} unless the
     * caller supplies an explicit probability override, in which case the cut is
     * pinned to that fraction of the tile's own peak intensity so the UI slider
     * has a direct, visible effect on detection count/size.
     */
    private static float threshold(float[] field, boolean brightfield, Double probabilityOverride) {
        if (probabilityOverride == null || !Double.isFinite(probabilityOverride)) {
            return threshold(field, brightfield);
        }
        float max = 0f;
        for (float value : field) {
            if (value > max) max = value;
        }
        if (max < 0.08f) return 1f;
        double clamped = Math.max(0.05, Math.min(0.95, probabilityOverride));
        return (float) Math.max(0.05, clamped * max);
    }

    /**
     * Maps the 0.1-1.0 "overlap suppression" slider onto a minimum peak-to-peak
     * distance (squared). {@code null} preserves the legacy fixed 5px radius.
     */
    private static double resolveNmsMinDist2(Double nmsOverride) {
        if (nmsOverride == null || !Double.isFinite(nmsOverride)) return 25;
        double clamped = Math.max(0.1, Math.min(1.0, nmsOverride));
        double minDist = 2.5 + clamped * 7.5;
        return minDist * minDist;
    }

    /**
     * Expected/max nucleus radius in pixels; feeds directly into the outline ray
     * search limit ({@code peak.radius * 2.6}) in {@link #starConvexVertices}.
     * {@code null} preserves the legacy fixed 6px baseline.
     */
    private static float resolvePeakRadius(Double maxNucleusRadiusOverride) {
        if (maxNucleusRadiusOverride == null || !Double.isFinite(maxNucleusRadiusOverride)) return 6f;
        return (float) Math.max(2.0, Math.min(40.0, maxNucleusRadiusOverride));
    }

    /** Outline vertex count per nucleus. {@code null} preserves the legacy fixed 32 rays. */
    private static int resolveRayCount(Integer rayCountOverride) {
        if (rayCountOverride == null) return RAYS;
        return Math.max(8, Math.min(128, rayCountOverride));
    }

    /**
     * Fraction of the peak-detection cut used as the per-ray boundary-tracing cut;
     * higher pulls the outline tighter around only the brightest core. {@code null}
     * preserves the legacy fixed 0.82 multiplier.
     */
    private static float resolveBoundaryTightness(Double boundaryTightnessOverride) {
        if (boundaryTightnessOverride == null || !Double.isFinite(boundaryTightnessOverride)) return 0.82f;
        return (float) Math.max(0.4, Math.min(0.98, boundaryTightnessOverride));
    }

    private static float[] blur3(float[] src, int width, int height) {
        float[] out = new float[src.length];
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                float sum = 0;
                int n = 0;
                for (int dy = -1; dy <= 1; dy++) {
                    int yy = y + dy;
                    if (yy < 0 || yy >= height) continue;
                    for (int dx = -1; dx <= 1; dx++) {
                        int xx = x + dx;
                        if (xx < 0 || xx >= width) continue;
                        sum += src[yy * width + xx];
                        n += 1;
                    }
                }
                out[y * width + x] = n == 0 ? src[y * width + x] : sum / n;
            }
        }
        return out;
    }

    private static float peak(int[] plane) {
        int max = 1;
        for (int value : plane) {
            if (value > max) max = value;
        }
        return max;
    }

    static final class Peak {
        final double x;
        final double y;
        final double score;
        final float radius;

        Peak(double x, double y, double score, float radius) {
            this.x = x;
            this.y = y;
            this.score = score;
            this.radius = radius;
        }
    }
}
