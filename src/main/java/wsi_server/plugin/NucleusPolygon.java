package wsi_server.plugin;

import java.util.List;

/**
 * StarDist nucleus contour in slide image pixels. {@code vertices} are the
 * star-convex ring compiled from radial offsets (typically 32 rays).
 */
public record NucleusPolygon(
        int index,
        double cx,
        double cy,
        List<Vertex> vertices
) {
    public NucleusPolygon {
        vertices = vertices == null ? List.of() : List.copyOf(vertices);
    }

    public record Vertex(double x, double y) {
    }
}
