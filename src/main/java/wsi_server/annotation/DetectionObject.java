package wsi_server.annotation;

import java.util.List;

/**
 * One persisted cell / nucleus detection in level-0 slide pixel coordinates.
 * Stored beside annotations in the same per-workstation document.
 */
public record DetectionObject(
        String id,
        String name,
        String color,
        String pathClass,
        String classification,
        Double cx,
        Double cy,
        Double radius,
        List<List<Double>> vertices,
        List<List<Double>> cellVertices
) {
    public DetectionObject {
        vertices = vertices == null ? List.of() : List.copyOf(vertices);
        cellVertices = cellVertices == null ? List.of() : List.copyOf(cellVertices);
    }
}
