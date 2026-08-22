package wsi_server.annotation;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * One ROI in level-0 slide pixel coordinates. Rectangle and ellipse use the
 * bounding box; wand / polygon / polyline persist {@code vertices} as
 * image-pixel {@code [x, y]} pairs.
 */
public record Annotation(
        String id,
        AnnotationShape type,
        String name,
        boolean visible,
        boolean locked,
        String color,
        double lineWidth,
        double x,
        double y,
        double width,
        double height,
        double rotation,
        Instant createdAt,
        Instant modifiedAt,
        List<Map<String, Object>> bodies,
        List<List<Double>> vertices
) {
    public Annotation {
        bodies = bodies == null ? List.of() : List.copyOf(bodies);
        vertices = vertices == null ? List.of() : List.copyOf(vertices);
    }
}
