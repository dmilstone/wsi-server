package wsi_server.plugin;

import java.util.ArrayList;
import java.util.List;

/**
 * Cellpose-style nuclear / cytoplasmic detector. A native {@code cellpose}
 * Python session is attempted first; when that runtime is missing this falls
 * back to a diameter-constrained isotropic contour heuristic so the AI Labs
 * selector still produces distinct objects from StarDist / QuPath.
 */
public final class CellposeEngine {

    public static final String FALLBACK_ENGINE_LABEL = "cellpose-fallback-heuristic";
    public static final String NATIVE_ENGINE_LABEL = "cellpose-python";
    public static final boolean NATIVE_MODEL_IMPLEMENTED = false;
    public static final int MAX_CELLS = 2500;

    public record Params(Double probability, Double nms, Double diameter, String model) {
        public static final Params DEFAULT = new Params(null, null, null, null);
    }

    private CellposeEngine() {
    }

    public static String modelName(String override, boolean brightfield) {
        String raw = override == null ? "" : override.trim().toLowerCase();
        if (raw.equals("nuclei") || raw.equals("cyto") || raw.equals("cyto2") || raw.equals("cyto3")) {
            return raw;
        }
        return brightfield ? "cyto2" : "nuclei";
    }

    public static List<NucleusPolygon> detect(PluginSampleGrid grid, boolean brightfield, Params params) {
        if (grid == null || grid.sampleWidth() <= 0 || grid.sampleHeight() <= 0) return List.of();
        Params resolved = params == null ? Params.DEFAULT : params;
        if (NATIVE_MODEL_IMPLEMENTED) {
            List<NucleusPolygon> nativeResult = tryNativeSession(grid, brightfield, resolved);
            if (nativeResult != null) return nativeResult;
        }
        return fallback(grid, brightfield, resolved);
    }

    /**
     * Reserved for a real {@code python -m cellpose} / Cellpose Java binding.
     * Always returns {@code null} until {@link #NATIVE_MODEL_IMPLEMENTED} is flipped.
     */
    static List<NucleusPolygon> tryNativeSession(PluginSampleGrid grid, boolean brightfield, Params params) {
        return null;
    }

    static List<NucleusPolygon> fallback(PluginSampleGrid grid, boolean brightfield, Params params) {
        float[][][] tensor = StarDistTensorEngine.packNhwc(grid, brightfield);
        float[] field = StarDistTensorEngine.nuclearChannel(tensor, brightfield);
        double diameter = params.diameter() != null && Double.isFinite(params.diameter())
                ? Math.max(6, Math.min(80, params.diameter()))
                : 30;
        double radius = diameter / 2.0;
        StarDistTensorEngine.Params starParams = new StarDistTensorEngine.Params(
                params.probability(),
                params.nms() != null ? params.nms() : 0.7,
                radius,
                24,
                0.72
        );
        List<NucleusPolygon> raw = StarDistTensorEngine.polygonsFromProbability(
                grid, field, brightfield, starParams);
        List<NucleusPolygon> rounded = new ArrayList<>();
        for (NucleusPolygon nucleus : raw) {
            if (rounded.size() >= MAX_CELLS) break;
            rounded.add(new NucleusPolygon(
                    rounded.size(),
                    nucleus.cx(),
                    nucleus.cy(),
                    circularize(nucleus.vertices(), nucleus.cx(), nucleus.cy())
            ));
        }
        return List.copyOf(rounded);
    }

    /**
     * Cellpose masks are typically smoother / more isotropic than star-convex
     * ray traces. Replace each vertex radius with the median radius.
     */
    static List<NucleusPolygon.Vertex> circularize(
            List<NucleusPolygon.Vertex> vertices, double cx, double cy
    ) {
        if (vertices == null || vertices.size() < 3) return vertices == null ? List.of() : vertices;
        double[] radii = new double[vertices.size()];
        for (int i = 0; i < vertices.size(); i++) {
            NucleusPolygon.Vertex vertex = vertices.get(i);
            radii[i] = Math.hypot(vertex.x() - cx, vertex.y() - cy);
        }
        double[] sorted = radii.clone();
        java.util.Arrays.sort(sorted);
        double median = sorted[sorted.length / 2];
        if (median < 1.5) median = 1.5;
        List<NucleusPolygon.Vertex> ring = new ArrayList<>(vertices.size());
        for (int i = 0; i < vertices.size(); i++) {
            NucleusPolygon.Vertex vertex = vertices.get(i);
            double angle = Math.atan2(vertex.y() - cy, vertex.x() - cx);
            ring.add(new NucleusPolygon.Vertex(
                    cx + Math.cos(angle) * median,
                    cy + Math.sin(angle) * median
            ));
        }
        return ring;
    }
}
