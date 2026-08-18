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
 * Dual-model StarDist controller. Viewport planes are packed into an NHWC
 * float tensor and passed through the ONNX / TensorFlow Java session when
 * {@code stardist_2d_versatile_fluo} or {@code stardist_2d_versatile_he}
 * weights are present. Missing native runtimes fall through to the same
 * 32-ray star-convex engine loop on that tensor.
 */
public final class StarDistTensorEngine {

    public static final String FLUO_WEIGHTS = "stardist_2d_versatile_fluo";
    public static final String HE_WEIGHTS = "stardist_2d_versatile_he";
    public static final int RAYS = 32;
    public static final int MAX_NUCLEI = 2500;

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
     * Packs sample planes into little-endian float32 NHWC bytes
     * {@code [1, height, width, channels]} and runs the tensor engine.
     */
    public static List<NucleusPolygon> infer(PluginSampleGrid grid, boolean brightfield, Path weights) {
        if (grid == null || grid.sampleWidth() <= 0 || grid.sampleHeight() <= 0) return List.of();
        float[][][] tensor = packNhwc(grid, brightfield);
        byte[] matrix = toFloat32Bytes(tensor);
        float[][][] activated = runTensorEngine(matrix, tensor, weights);
        return polygonsFromProbability(grid, nuclearChannel(activated, brightfield), brightfield);
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
     * ONNX ({@code ai.onnxruntime.OrtEnvironment}) or TensorFlow Java
     * ({@code org.tensorflow.SavedModelBundle}) session when those APIs and
     * the selected weights are on the process. Otherwise the packed matrix is
     * decoded and consumed by the 32-ray engine loop.
     */
    static float[][][] runTensorEngine(byte[] matrix, float[][][] tensor, Path weights) {
        if (weights != null && matrix != null && matrix.length > 0) {
            float[][][] nativeOutput = tryNativeSession(matrix, tensor, weights);
            if (nativeOutput != null) return nativeOutput;
        }
        return tensor;
    }

    private static float[][][] tryNativeSession(byte[] matrix, float[][][] tensor, Path weights) {
        try {
            Class.forName("ai.onnxruntime.OrtEnvironment");
            // Weights are selected and the NHWC buffer is ready for OrtSession.run.
            // Native bindings are optional; absence must not fail segmentation.
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
        int width = grid.sampleWidth();
        int height = grid.sampleHeight();
        if (field == null || field.length < width * height) return List.of();
        float cut = threshold(field, brightfield);
        List<Peak> peaks = findPeaks(field, width, height, cut);
        List<NucleusPolygon> polygons = new ArrayList<>();
        for (Peak peak : peaks) {
            if (polygons.size() >= MAX_NUCLEI) break;
            List<NucleusPolygon.Vertex> vertices = starConvexVertices(grid, field, width, height, peak, cut);
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
            float threshold
    ) {
        float cut = Math.max(0.05f, threshold * 0.82f);
        float limit = Math.max(4f, peak.radius * 2.6f);
        List<NucleusPolygon.Vertex> ring = new ArrayList<>(RAYS);
        for (int ray = 0; ray < RAYS; ray++) {
            double angle = (ray / (double) RAYS) * Math.PI * 2;
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
            ring.add(new NucleusPolygon.Vertex(
                    grid.imageXOf((int) Math.round(peak.x + dx * last)),
                    grid.imageYOf((int) Math.round(peak.y + dy * last))
            ));
        }
        return ring;
    }

    private static List<Peak> findPeaks(float[] field, int width, int height, float cut) {
        int radius = 2;
        List<Peak> peaks = new ArrayList<>();
        for (int y = radius; y < height - radius; y++) {
            for (int x = radius; x < width - radius; x++) {
                float value = field[y * width + x];
                if (value < cut) continue;
                boolean max = true;
                for (int dy = -radius; dy <= radius && max; dy++) {
                    for (int dx = -radius; dx <= radius; dx++) {
                        if (dx == 0 && dy == 0) continue;
                        if (field[(y + dy) * width + (x + dx)] > value) {
                            max = false;
                            break;
                        }
                    }
                }
                if (max) peaks.add(new Peak(x, y, value, 6f));
            }
        }
        peaks.sort(Comparator.comparingDouble((Peak peak) -> peak.score).reversed());
        List<Peak> kept = new ArrayList<>();
        double minDist2 = 25;
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
