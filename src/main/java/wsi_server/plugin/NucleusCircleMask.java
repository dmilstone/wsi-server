package wsi_server.plugin;

import java.util.List;

/**
 * Inclusive circular masks in sampled image space ({@code dx² + dy² ≤ r²}).
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
        if (nucleus == null || mask == null) return;
        double cx = nucleus.cx();
        double cy = nucleus.cy();
        double radius = nucleus.r();
        if (!(radius > 0) || !Double.isFinite(cx) || !Double.isFinite(cy)) return;
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
}
