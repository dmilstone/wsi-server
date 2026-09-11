package wsi_server.plugin;

import java.util.List;

/**
 * Inclusive nuclear masks in sampled image space. Prefer the polygon ring when
 * the client sends vertices; otherwise fall back to a circle. A missing or
 * tiny radius used to paint nothing, which made per-object color-coding return
 * an empty object list after StarDist switched from circles to polygons.
 */
final class NucleusCircleMask {

    private NucleusCircleMask() {
    }

    static boolean[] union(PluginSampleGrid grid, List<PluginExecuteRequest.NucleusFootprint> nuclei) {
        int count = grid.sampleWidth() * grid.sampleHeight();
        boolean[] mask = new boolean[count];
        if (nuclei == null || nuclei.isEmpty()) {
            java.util.Arrays.fill(mask, true);
            return mask;
        }
        for (PluginExecuteRequest.NucleusFootprint nucleus : nuclei) {
            paint(grid, nucleus, mask);
        }
        return mask;
    }

    static boolean[] single(PluginSampleGrid grid, PluginExecuteRequest.NucleusFootprint nucleus) {
        boolean[] mask = new boolean[grid.sampleWidth() * grid.sampleHeight()];
        paint(grid, nucleus, mask);
        return mask;
    }

    private static void paint(
            PluginSampleGrid grid,
            PluginExecuteRequest.NucleusFootprint nucleus,
            boolean[] mask
    ) {
        if (nucleus == null || mask == null || grid == null) return;
        List<PluginExecuteRequest.NucleusFootprint.Vertex> vertices = nucleus.vertices();
        if (vertices != null && vertices.size() >= 3) {
            paintPolygon(grid, vertices, mask);
            return;
        }
        double cx = nucleus.cx();
        double cy = nucleus.cy();
        double radius = nucleus.r();
        if (!(radius > 0) || !Double.isFinite(cx) || !Double.isFinite(cy)) return;
        paintCircle(grid, cx, cy, radius, mask);
    }

    private static void paintCircle(
            PluginSampleGrid grid, double cx, double cy, double radius, boolean[] mask
    ) {
        double radiusSq = radius * radius;
        int width = grid.sampleWidth();
        int height = grid.sampleHeight();
        int minCol = Math.max(0, (int) Math.floor(cx * grid.scaleX() - grid.sampleOriginX() - radius * grid.scaleX() - 1));
        int maxCol = Math.min(width - 1, (int) Math.ceil(cx * grid.scaleX() - grid.sampleOriginX() + radius * grid.scaleX() + 1));
        int minRow = Math.max(0, (int) Math.floor(cy * grid.scaleY() - grid.sampleOriginY() - radius * grid.scaleY() - 1));
        int maxRow = Math.min(height - 1, (int) Math.ceil(cy * grid.scaleY() - grid.sampleOriginY() + radius * grid.scaleY() + 1));
        for (int row = minRow; row <= maxRow; row++) {
            for (int col = minCol; col <= maxCol; col++) {
                double dx = grid.imageXOf(col) - cx;
                double dy = grid.imageYOf(row) - cy;
                if (dx * dx + dy * dy <= radiusSq) {
                    mask[row * width + col] = true;
                }
            }
        }
    }

    private static void paintPolygon(
            PluginSampleGrid grid,
            List<PluginExecuteRequest.NucleusFootprint.Vertex> vertices,
            boolean[] mask
    ) {
        int width = grid.sampleWidth();
        int height = grid.sampleHeight();
        int n = vertices.size();
        double[] xs = new double[n];
        double[] ys = new double[n];
        double minX = Double.POSITIVE_INFINITY;
        double minY = Double.POSITIVE_INFINITY;
        double maxX = Double.NEGATIVE_INFINITY;
        double maxY = Double.NEGATIVE_INFINITY;
        int filled = 0;
        for (int i = 0; i < n; i++) {
            PluginExecuteRequest.NucleusFootprint.Vertex vertex = vertices.get(i);
            if (vertex == null || !Double.isFinite(vertex.x()) || !Double.isFinite(vertex.y())) continue;
            xs[filled] = vertex.x();
            ys[filled] = vertex.y();
            if (vertex.x() < minX) minX = vertex.x();
            if (vertex.y() < minY) minY = vertex.y();
            if (vertex.x() > maxX) maxX = vertex.x();
            if (vertex.y() > maxY) maxY = vertex.y();
            filled += 1;
        }
        if (filled < 3) return;
        int minCol = Math.max(0, (int) Math.floor(minX * grid.scaleX() - grid.sampleOriginX() - 1));
        int maxCol = Math.min(width - 1, (int) Math.ceil(maxX * grid.scaleX() - grid.sampleOriginX() + 1));
        int minRow = Math.max(0, (int) Math.floor(minY * grid.scaleY() - grid.sampleOriginY() - 1));
        int maxRow = Math.min(height - 1, (int) Math.ceil(maxY * grid.scaleY() - grid.sampleOriginY() + 1));
        for (int row = minRow; row <= maxRow; row++) {
            double py = grid.imageYOf(row);
            for (int col = minCol; col <= maxCol; col++) {
                if (pointInPolygon(grid.imageXOf(col), py, xs, ys, filled)) {
                    mask[row * width + col] = true;
                }
            }
        }
    }

    static boolean pointInPolygon(double x, double y, double[] xs, double[] ys, int n) {
        boolean inside = false;
        for (int i = 0, j = n - 1; i < n; j = i++) {
            double xi = xs[i];
            double yi = ys[i];
            double xj = xs[j];
            double yj = ys[j];
            boolean intersect = ((yi > y) != (yj > y))
                    && (x < (xj - xi) * (y - yi) / ((yj - yi) == 0 ? 1e-9 : (yj - yi)) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }
}
