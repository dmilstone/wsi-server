package wsi_server.plugin;

import java.util.List;

/**
 * StarDist nucleus contour in slide image pixels. {@code vertices} are the
 * star-convex ring compiled from radial offsets (typically 32 rays).
 * {@code cellVertices} is the optional cytoplasm ring produced by
 * {@link CellBoundaryExpander}; empty when expansion is off.
 */
public record NucleusPolygon(
        int index,
        double cx,
        double cy,
        List<Vertex> vertices,
        List<Vertex> cellVertices
) {
    public NucleusPolygon {
        vertices = vertices == null ? List.of() : List.copyOf(vertices);
        cellVertices = cellVertices == null ? List.of() : List.copyOf(cellVertices);
    }

    public NucleusPolygon(int index, double cx, double cy, List<Vertex> vertices) {
        this(index, cx, cy, vertices, List.of());
    }

    public NucleusPolygon withCellVertices(List<Vertex> cell) {
        return new NucleusPolygon(index, cx, cy, vertices, cell);
    }

    public record Vertex(double x, double y) {
    }
}
