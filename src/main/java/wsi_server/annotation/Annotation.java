package wsi_server.annotation;

import java.time.Instant;

/**
 * One rectangular or elliptical ROI in level-0 slide pixel coordinates.
 * Square and circle constraints are enforced by the client and validated here.
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
        Instant modifiedAt
) {
}
