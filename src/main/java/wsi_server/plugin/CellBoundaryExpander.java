package wsi_server.plugin;

import java.util.ArrayList;
import java.util.List;

/**
 * QuPath-style cytoplasm approximation: grow a nuclear ring into a cell
 * boundary by radial scale, perimeter offset, or (for Cell Detection) a
 * watershed label grow. {@code constrainScale} caps cell radius as a
 * multiple of the nucleus radius so neighboring expansions do not balloon.
 */
public final class CellBoundaryExpander {

    public enum Mode {
        NONE,
        RADIAL,
        OFFSET,
        WATERSHED
    }

    public static final double DEFAULT_RADIAL = 1.45;
    public static final double DEFAULT_OFFSET_PX = 5;
    public static final double DEFAULT_CONSTRAIN = 1.5;

    private CellBoundaryExpander() {
    }

    public static Mode parse(String raw, Mode fallback) {
        String normalized = raw == null ? "" : raw.trim().toLowerCase();
        if (normalized.isEmpty() || "auto".equals(normalized)) {
            return fallback == null ? Mode.RADIAL : fallback;
        }
        if ("none".equals(normalized) || "off".equals(normalized) || "nuclei".equals(normalized)) {
            return Mode.NONE;
        }
        if ("offset".equals(normalized) || "perimeter".equals(normalized) || "pixels".equals(normalized)
                || "px".equals(normalized)) {
            return Mode.OFFSET;
        }
        if ("watershed".equals(normalized) || "qupath".equals(normalized) || "label".equals(normalized)) {
            return Mode.WATERSHED;
        }
        if ("radial".equals(normalized) || "scale".equals(normalized)) {
            return Mode.RADIAL;
        }
        return fallback == null ? Mode.RADIAL : fallback;
    }

    public static List<NucleusPolygon> attach(List<NucleusPolygon> nuclei, PluginExecuteRequest request) {
        Mode mode = parse(request == null ? null : request.cellExpansionMode(), Mode.RADIAL);
        return attach(nuclei, mode, amountFrom(request, mode), constrainFrom(request));
    }

    public static List<NucleusPolygon> attach(
            List<NucleusPolygon> nuclei, Mode mode, double amount, double constrainScale
    ) {
        if (nuclei == null || nuclei.isEmpty()) return nuclei == null ? List.of() : nuclei;
        if (mode == null || mode == Mode.NONE || mode == Mode.WATERSHED) return nuclei;
        if (!(amount > 0) || (mode == Mode.RADIAL && amount <= 1.0)) return nuclei;
        List<NucleusPolygon> out = new ArrayList<>(nuclei.size());
        for (NucleusPolygon nucleus : nuclei) {
            List<NucleusPolygon.Vertex> cell = expand(
                    nucleus.vertices(), nucleus.cx(), nucleus.cy(), mode, amount);
            out.add(nucleus.withCellVertices(constrain(
                    nucleus.vertices(), cell, nucleus.cx(), nucleus.cy(), constrainScale)));
        }
        return List.copyOf(out);
    }

    public static List<NucleusPolygon> constrainCells(List<NucleusPolygon> nuclei, double constrainScale) {
        if (nuclei == null || nuclei.isEmpty()) return nuclei == null ? List.of() : nuclei;
        List<NucleusPolygon> out = new ArrayList<>(nuclei.size());
        for (NucleusPolygon nucleus : nuclei) {
            if (nucleus.cellVertices().isEmpty()) {
                out.add(nucleus);
                continue;
            }
            out.add(nucleus.withCellVertices(constrain(
                    nucleus.vertices(), nucleus.cellVertices(),
                    nucleus.cx(), nucleus.cy(), constrainScale)));
        }
        return List.copyOf(out);
    }

    public static List<NucleusPolygon.Vertex> expand(
            List<NucleusPolygon.Vertex> vertices, double cx, double cy, Mode mode, double amount
    ) {
        if (vertices == null || vertices.size() < 3 || mode == null || mode == Mode.NONE) {
            return vertices == null ? List.of() : vertices;
        }
        List<NucleusPolygon.Vertex> ring = new ArrayList<>(vertices.size());
        for (NucleusPolygon.Vertex vertex : vertices) {
            double dx = vertex.x() - cx;
            double dy = vertex.y() - cy;
            double radius = Math.hypot(dx, dy);
            if (mode == Mode.RADIAL) {
                ring.add(new NucleusPolygon.Vertex(cx + dx * amount, cy + dy * amount));
                continue;
            }
            double ux = radius > 1e-6 ? dx / radius : 1;
            double uy = radius > 1e-6 ? dy / radius : 0;
            ring.add(new NucleusPolygon.Vertex(vertex.x() + ux * amount, vertex.y() + uy * amount));
        }
        return ring;
    }

    public static List<NucleusPolygon.Vertex> constrain(
            List<NucleusPolygon.Vertex> nucleus,
            List<NucleusPolygon.Vertex> cell,
            double cx,
            double cy,
            double constrainScale
    ) {
        if (cell == null || cell.isEmpty()) return cell == null ? List.of() : cell;
        if (!(constrainScale > 1.0) || nucleus == null || nucleus.isEmpty()) return cell;
        List<NucleusPolygon.Vertex> out = new ArrayList<>(cell.size());
        for (int i = 0; i < cell.size(); i++) {
            NucleusPolygon.Vertex grown = cell.get(i);
            NucleusPolygon.Vertex seed = nucleus.get(Math.min(i, nucleus.size() - 1));
            double nucleusRadius = Math.hypot(seed.x() - cx, seed.y() - cy);
            double cellRadius = Math.hypot(grown.x() - cx, grown.y() - cy);
            double cap = Math.max(nucleusRadius, nucleusRadius * constrainScale);
            if (cellRadius > cap && cellRadius > 1e-6) {
                double t = cap / cellRadius;
                out.add(new NucleusPolygon.Vertex(cx + (grown.x() - cx) * t, cy + (grown.y() - cy) * t));
            } else {
                out.add(grown);
            }
        }
        return out;
    }

    static double amountFrom(PluginExecuteRequest request, Mode mode) {
        Double raw = request == null ? null : request.cellExpansion();
        if (mode == Mode.RADIAL) {
            if (raw == null || !Double.isFinite(raw)) return DEFAULT_RADIAL;
            return Math.max(1.0, Math.min(2.5, raw));
        }
        if (raw == null || !Double.isFinite(raw)) return DEFAULT_OFFSET_PX;
        return Math.max(0, Math.min(20, raw));
    }

    static double constrainFrom(PluginExecuteRequest request) {
        Double raw = request == null ? null : request.cellConstrainScale();
        if (raw == null || !Double.isFinite(raw)) return DEFAULT_CONSTRAIN;
        return Math.max(1.0, Math.min(3.0, raw));
    }
}
