package wsi_server.annotation;

import java.time.Instant;
import java.util.List;

/** Versioned annotation document stored for one user and one slide. */
public record AnnotationCollection(
        int version,
        String imageId,
        String slidePath,
        String userId,
        Instant modifiedAt,
        List<Annotation> annotations,
        List<DetectionObject> detections
) {
    public static final int CURRENT_VERSION = 1;

    public AnnotationCollection {
        annotations = annotations == null ? List.of() : List.copyOf(annotations);
        detections = detections == null ? List.of() : List.copyOf(detections);
    }

    public AnnotationCollection(
            int version,
            String imageId,
            String slidePath,
            String userId,
            Instant modifiedAt,
            List<Annotation> annotations
    ) {
        this(version, imageId, slidePath, userId, modifiedAt, annotations, List.of());
    }
}
