package wsi_server.plugin;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.PriorityQueue;

/**
 * Java port of QuPath's built-in <em>Cell detection</em> command (watershed on a
 * blurred / background-subtracted nuclear channel, optional cytoplasm expansion).
 * This is not a QuPath process launch; it implements the same classical steps
 * QuPath's extension runs inside the viewer.
 */
public final class QuPathCellDetectionEngine {

    public static final String ENGINE_LABEL = "qupath-cell-detection-watershed";
    public static final int MAX_CELLS = 2500;

    public record Params(
            Double probability,
            Double backgroundRadius,
            Double sigma,
            Double minArea,
            Double maxArea,
            Double cellExpansion,
            String cellExpansionMode,
            Double cellConstrainScale
    ) {
        public static final Params DEFAULT = new Params(null, null, null, null, null, null, null, null);

        public Params(
                Double probability,
                Double backgroundRadius,
                Double sigma,
                Double minArea,
                Double maxArea,
                Double cellExpansion
        ) {
            this(probability, backgroundRadius, sigma, minArea, maxArea, cellExpansion, null, null);
        }
    }

    private QuPathCellDetectionEngine() {
    }

    public static List<NucleusPolygon> detect(PluginSampleGrid grid, boolean brightfield, Params params) {
        if (grid == null || grid.sampleWidth() <= 0 || grid.sampleHeight() <= 0) return List.of();
        Params resolved = params == null ? Params.DEFAULT : params;
        float[][][] tensor = StarDistTensorEngine.packNhwc(grid, brightfield);
        float[] field = StarDistTensorEngine.nuclearChannel(tensor, brightfield);
        int width = grid.sampleWidth();
        int height = grid.sampleHeight();
        subtractBackground(field, width, height, resolve(resolved.backgroundRadius(), 8, 0, 24));
        blur(field, width, height, resolve(resolved.sigma(), 1.5, 0.5, 4));
        float cut = threshold(field, resolved.probability());
        boolean[] mask = new boolean[width * height];
        int maskCount = 0;
        for (int i = 0; i < mask.length; i++) {
            if (field[i] >= cut) {
                mask[i] = true;
                maskCount += 1;
            }
        }
        if (maskCount < 8) return List.of();
        float[] distance = distanceTransform(mask, width, height);
        int[] labels = watershed(distance, mask, width, height);
        double minArea = resolve(resolved.minArea(), 10, 4, 200);
        double maxArea = resolve(resolved.maxArea(), 400, 40, 2000);
        if (maxArea < minArea) maxArea = minArea;
        CellBoundaryExpander.Mode mode = CellBoundaryExpander.parse(
                resolved.cellExpansionMode(), CellBoundaryExpander.Mode.WATERSHED);
        double constrain = resolve(resolved.cellConstrainScale(), CellBoundaryExpander.DEFAULT_CONSTRAIN, 1.0, 3.0);
        if (mode == CellBoundaryExpander.Mode.NONE) {
            return polygonsFromLabels(grid, labels, width, height, minArea, maxArea, null);
        }
        if (mode == CellBoundaryExpander.Mode.WATERSHED) {
            int expansion = (int) Math.round(resolve(resolved.cellExpansion(), 4, 0, 20));
            int[] cellLabels = null;
            if (expansion > 0) {
                cellLabels = labels.clone();
                expandLabels(cellLabels, width, height, expansion);
            }
            return CellBoundaryExpander.constrainCells(
                    polygonsFromLabels(grid, labels, width, height, minArea, maxArea, cellLabels),
                    constrain);
        }
        double amount = mode == CellBoundaryExpander.Mode.RADIAL
                ? resolve(resolved.cellExpansion(), CellBoundaryExpander.DEFAULT_RADIAL, 1.0, 2.5)
                : resolve(resolved.cellExpansion(), CellBoundaryExpander.DEFAULT_OFFSET_PX, 0, 20);
        return CellBoundaryExpander.attach(
                polygonsFromLabels(grid, labels, width, height, minArea, maxArea, null),
                mode,
                amount,
                constrain);
    }

    static void subtractBackground(float[] field, int width, int height, double radius) {
        int r = (int) Math.round(radius);
        if (r <= 0) return;
        float[] copy = field.clone();
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                float min = copy[y * width + x];
                for (int dy = -r; dy <= r; dy++) {
                    int yy = y + dy;
                    if (yy < 0 || yy >= height) continue;
                    for (int dx = -r; dx <= r; dx++) {
                        if (dx * dx + dy * dy > r * r) continue;
                        int xx = x + dx;
                        if (xx < 0 || xx >= width) continue;
                        float value = copy[yy * width + xx];
                        if (value < min) min = value;
                    }
                }
                field[y * width + x] = Math.max(0f, copy[y * width + x] - min);
            }
        }
    }

    static void blur(float[] field, int width, int height, double sigma) {
        int passes = Math.max(1, (int) Math.round(sigma));
        for (int pass = 0; pass < passes; pass++) {
            float[] next = new float[field.length];
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
                            sum += field[yy * width + xx];
                            n += 1;
                        }
                    }
                    next[y * width + x] = n == 0 ? field[y * width + x] : sum / n;
                }
            }
            System.arraycopy(next, 0, field, 0, field.length);
        }
    }

    static float threshold(float[] field, Double probability) {
        float max = 0f;
        double sum = 0;
        int count = 0;
        for (float value : field) {
            if (value > max) max = value;
            if (value > 0.02f) {
                sum += value;
                count += 1;
            }
        }
        if (max < 0.05f || count < 8) return 1f;
        if (probability != null && Double.isFinite(probability)) {
            double clamped = Math.max(0.05, Math.min(0.95, probability));
            return (float) Math.max(0.04, clamped * max);
        }
        float mean = (float) (sum / count);
        return Math.max(0.08f, mean + 0.18f * Math.max(0.04f, max - mean));
    }

    static float[] distanceTransform(boolean[] mask, int width, int height) {
        float[] dt = new float[mask.length];
        final float inf = width + height + 1f;
        for (int i = 0; i < mask.length; i++) dt[i] = mask[i] ? inf : 0f;
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                int i = y * width + x;
                if (!mask[i]) continue;
                if (x > 0) dt[i] = Math.min(dt[i], dt[i - 1] + 1f);
                if (y > 0) dt[i] = Math.min(dt[i], dt[i - width] + 1f);
            }
        }
        for (int y = height - 1; y >= 0; y--) {
            for (int x = width - 1; x >= 0; x--) {
                int i = y * width + x;
                if (!mask[i]) continue;
                if (x + 1 < width) dt[i] = Math.min(dt[i], dt[i + 1] + 1f);
                if (y + 1 < height) dt[i] = Math.min(dt[i], dt[i + width] + 1f);
            }
        }
        return dt;
    }

    static int[] watershed(float[] distance, boolean[] mask, int width, int height) {
        int[] labels = new int[mask.length];
        for (int i = 0; i < labels.length; i++) labels[i] = mask[i] ? 0 : -1;
        record Seed(int x, int y, float d, int label) {
        }
        PriorityQueue<Seed> queue = new PriorityQueue<>(Comparator.comparingDouble((Seed s) -> -s.d));
        int next = 1;
        for (int y = 1; y < height - 1 && next <= MAX_CELLS; y++) {
            for (int x = 1; x < width - 1 && next <= MAX_CELLS; x++) {
                int i = y * width + x;
                if (!mask[i] || distance[i] < 1.5f) continue;
                boolean peak = true;
                for (int dy = -1; dy <= 1 && peak; dy++) {
                    for (int dx = -1; dx <= 1; dx++) {
                        if (dx == 0 && dy == 0) continue;
                        if (distance[(y + dy) * width + (x + dx)] > distance[i]) {
                            peak = false;
                            break;
                        }
                    }
                }
                if (!peak) continue;
                labels[i] = next;
                queue.add(new Seed(x, y, distance[i], next));
                next += 1;
            }
        }
        int[][] dirs = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
        while (!queue.isEmpty()) {
            Seed seed = queue.poll();
            for (int[] dir : dirs) {
                int xx = seed.x + dir[0];
                int yy = seed.y + dir[1];
                if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
                int ni = yy * width + xx;
                if (labels[ni] != 0) continue;
                labels[ni] = seed.label;
                queue.add(new Seed(xx, yy, distance[ni], seed.label));
            }
        }
        return labels;
    }

    static void expandLabels(int[] labels, int width, int height, int radius) {
        int[] current = labels.clone();
        int[][] dirs = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
        for (int step = 0; step < radius; step++) {
            int[] next = current.clone();
            for (int y = 0; y < height; y++) {
                for (int x = 0; x < width; x++) {
                    int i = y * width + x;
                    if (current[i] > 0) continue;
                    int found = 0;
                    for (int[] dir : dirs) {
                        int xx = x + dir[0];
                        int yy = y + dir[1];
                        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
                        int label = current[yy * width + xx];
                        if (label <= 0) continue;
                        if (found == 0) found = label;
                        else if (found != label) {
                            found = 0;
                            break;
                        }
                    }
                    if (found > 0) next[i] = found;
                }
            }
            current = next;
        }
        System.arraycopy(current, 0, labels, 0, labels.length);
    }

    static List<NucleusPolygon> polygonsFromLabels(
            PluginSampleGrid grid, int[] labels, int width, int height, double minArea, double maxArea
    ) {
        return polygonsFromLabels(grid, labels, width, height, minArea, maxArea, null);
    }

    static List<NucleusPolygon> polygonsFromLabels(
            PluginSampleGrid grid,
            int[] labels,
            int width,
            int height,
            double minArea,
            double maxArea,
            int[] cellLabels
    ) {
        int maxLabel = 0;
        for (int label : labels) if (label > maxLabel) maxLabel = label;
        int[] area = new int[maxLabel + 1];
        double[] sumX = new double[maxLabel + 1];
        double[] sumY = new double[maxLabel + 1];
        int[] seedX = new int[maxLabel + 1];
        int[] seedY = new int[maxLabel + 1];
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                int label = labels[y * width + x];
                if (label <= 0) continue;
                area[label] += 1;
                sumX[label] += x;
                sumY[label] += y;
                if (seedX[label] == 0 && seedY[label] == 0) {
                    seedX[label] = x;
                    seedY[label] = y;
                }
            }
        }
        List<NucleusPolygon> polygons = new ArrayList<>();
        for (int label = 1; label <= maxLabel && polygons.size() < MAX_CELLS; label++) {
            if (area[label] < minArea || area[label] > maxArea) continue;
            List<NucleusPolygon.Vertex> ring = traceContour(grid, labels, width, height, label, seedX[label], seedY[label]);
            if (ring.size() < 3) continue;
            List<NucleusPolygon.Vertex> cellRing = cellLabels == null
                    ? List.of()
                    : traceContour(grid, cellLabels, width, height, label, seedX[label], seedY[label]);
            polygons.add(new NucleusPolygon(
                    polygons.size(),
                    grid.imageXOf((int) Math.round(sumX[label] / area[label])),
                    grid.imageYOf((int) Math.round(sumY[label] / area[label])),
                    ring,
                    cellRing.size() >= 3 ? cellRing : List.of()
            ));
        }
        return List.copyOf(polygons);
    }

    static List<NucleusPolygon.Vertex> traceContour(
            PluginSampleGrid grid, int[] labels, int width, int height, int label, int startX, int startY
    ) {
        int x0 = startX;
        int y0 = startY;
        search:
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                if (labels[y * width + x] != label) continue;
                if (x == 0 || y == 0 || x == width - 1 || y == height - 1
                        || labels[y * width + x - 1] != label
                        || labels[(y - 1) * width + x] != label) {
                    x0 = x;
                    y0 = y;
                    break search;
                }
            }
        }
        int[][] dirs = {{1, 0}, {1, 1}, {0, 1}, {-1, 1}, {-1, 0}, {-1, -1}, {0, -1}, {1, -1}};
        List<int[]> path = new ArrayList<>();
        int x = x0;
        int y = y0;
        int dir = 0;
        for (int step = 0; step < width * height; step++) {
            path.add(new int[] {x, y});
            boolean moved = false;
            for (int offset = 0; offset < 8; offset++) {
                int nextDir = (dir + 6 + offset) % 8;
                int xx = x + dirs[nextDir][0];
                int yy = y + dirs[nextDir][1];
                if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
                if (labels[yy * width + xx] != label) continue;
                x = xx;
                y = yy;
                dir = nextDir;
                moved = true;
                break;
            }
            if (!moved) break;
            if (x == x0 && y == y0 && path.size() > 2) break;
        }
        int stride = Math.max(1, path.size() / 24);
        List<NucleusPolygon.Vertex> ring = new ArrayList<>();
        for (int i = 0; i < path.size(); i += stride) {
            ring.add(new NucleusPolygon.Vertex(
                    grid.imageXOf(path.get(i)[0]),
                    grid.imageYOf(path.get(i)[1])
            ));
        }
        return ring;
    }

    private static double resolve(Double value, double fallback, double min, double max) {
        if (value == null || !Double.isFinite(value)) return fallback;
        return Math.max(min, Math.min(max, value));
    }
}
