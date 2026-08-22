package wsi_server.annotation;

import org.springframework.stereotype.Service;
import wsi_server.ImageRegistry;

import java.io.IOException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

/** Validates, normalizes, loads, and saves complete annotation documents. */
@Service
public class AnnotationService {
    private static final String DEFAULT_COLOR = "#ff3b30";
    /** Maximum annotation name length, measured in Unicode code points. */
    public static final int MAX_NAME_LENGTH = 200;

    private final ImageRegistry imageRegistry;
    private final AnnotationStorage storage;

    public AnnotationService(ImageRegistry imageRegistry, AnnotationStorage storage) {
        this.imageRegistry = imageRegistry;
        this.storage = storage;
    }

    public AnnotationCollection load(String imageId, String userId) throws IOException {
        ImageRegistry.ImageEntry image = imageRegistry.getRequired(imageId);
        AnnotationCollection stored = storage.read(userId, image);
        if (stored == null) return empty(image, userId);
        return normalizeDocument(image, userId, stored, false);
    }

    public AnnotationCollection save(String imageId, String userId, AnnotationCollection request) throws IOException {
        ImageRegistry.ImageEntry image = imageRegistry.getRequired(imageId);
        AnnotationCollection normalized = normalizeDocument(image, userId, request, true);
        storage.write(userId, image, normalized);
        return normalized;
    }

    private AnnotationCollection empty(ImageRegistry.ImageEntry image, String userId) {
        return new AnnotationCollection(
                AnnotationCollection.CURRENT_VERSION,
                image.id(),
                image.relativePath(),
                userId,
                Instant.now(),
                List.of()
        );
    }

    private AnnotationCollection normalizeDocument(
            ImageRegistry.ImageEntry image,
            String userId,
            AnnotationCollection document,
            boolean touchModifiedTime
    ) {
        if (document == null) throw new IllegalArgumentException("Annotation document is required.");
        if (document.version() != 0 && document.version() != AnnotationCollection.CURRENT_VERSION) {
            throw new IllegalArgumentException("Unsupported annotation document version: " + document.version());
        }

        Instant now = Instant.now();
        List<Annotation> source = document.annotations() == null ? List.of() : document.annotations();
        List<Annotation> normalized = new ArrayList<>(source.size());
        Set<String> ids = new HashSet<>();
        for (int index = 0; index < source.size(); index++) {
            Annotation annotation = normalizeAnnotation(source.get(index), now, touchModifiedTime, index);
            if (!ids.add(annotation.id())) {
                throw new IllegalArgumentException("Duplicate annotation id: " + annotation.id());
            }
            normalized.add(annotation);
        }

        return new AnnotationCollection(
                AnnotationCollection.CURRENT_VERSION,
                image.id(),
                image.relativePath(),
                userId,
                touchModifiedTime || document.modifiedAt() == null ? now : document.modifiedAt(),
                List.copyOf(normalized)
        );
    }

    private Annotation normalizeAnnotation(Annotation value, Instant now, boolean touchModifiedTime, int index) {
        if (value == null) throw new IllegalArgumentException("Annotation at index " + index + " is null.");
        if (value.type() == null) throw new IllegalArgumentException("Annotation type is required.");
        requireFinite(value.x(), "x");
        requireFinite(value.y(), "y");
        requireFinite(value.width(), "width");
        requireFinite(value.height(), "height");
        requireFinite(value.rotation(), "rotation");
        requireFinite(value.lineWidth(), "lineWidth");
        if (value.x() < 0 || value.y() < 0) throw new IllegalArgumentException("Annotation coordinates cannot be negative.");
        if (value.width() <= 0 || value.height() <= 0) throw new IllegalArgumentException("Annotation dimensions must be positive.");
        if (value.lineWidth() <= 0 || value.lineWidth() > 100) {
            throw new IllegalArgumentException("Annotation lineWidth must be greater than 0 and at most 100.");
        }
        if ((value.type() == AnnotationShape.SQUARE || value.type() == AnnotationShape.CIRCLE)
                && Math.abs(value.width() - value.height()) > 0.001) {
            throw new IllegalArgumentException(value.type().toJson() + " annotations require equal width and height.");
        }

        String id = value.id() == null || value.id().isBlank()
                ? UUID.randomUUID().toString()
                : validateUuid(value.id());
        String name = value.name() == null ? null : value.name().trim();
        if (name != null && name.isEmpty()) name = null;
        if (name != null && name.codePointCount(0, name.length()) > MAX_NAME_LENGTH) {
            throw new IllegalArgumentException("Annotation name must be at most 200 Unicode characters.");
        }
        String color = value.color() == null || value.color().isBlank() ? DEFAULT_COLOR : value.color().trim();
        if (!color.matches("#[0-9A-Fa-f]{6}")) {
            throw new IllegalArgumentException("Annotation color must use #RRGGBB format.");
        }
        Instant created = value.createdAt() == null ? now : value.createdAt();
        Instant modified = touchModifiedTime || value.modifiedAt() == null ? now : value.modifiedAt();

        List<List<Double>> vertices = value.vertices() == null ? List.of() : value.vertices().stream()
                .filter(Objects::nonNull)
                .map(point -> {
                    if (point.size() < 2) return null;
                    Double vx = point.get(0);
                    Double vy = point.get(1);
                    if (vx == null || vy == null || !Double.isFinite(vx) || !Double.isFinite(vy)) return null;
                    return List.of(vx, vy);
                })
                .filter(Objects::nonNull)
                .toList();

        return new Annotation(
                id, value.type(), name, value.visible(), value.locked(), color.toLowerCase(), value.lineWidth(),
                value.x(), value.y(), value.width(), value.height(), value.rotation(), created, modified,
                value.bodies() == null ? List.of() : value.bodies().stream().filter(Objects::nonNull).toList(),
                vertices
        );
    }

    private static String validateUuid(String value) {
        try {
            return UUID.fromString(value.trim()).toString();
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("Annotation id must be a UUID: " + value);
        }
    }

    private static void requireFinite(double value, String field) {
        if (!Double.isFinite(value)) throw new IllegalArgumentException("Annotation " + field + " must be finite.");
    }
}
