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
        List<Annotation> annotations
) {
    public static final int CURRENT_VERSION = 1;
}
