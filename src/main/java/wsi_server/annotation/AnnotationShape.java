package wsi_server.annotation;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

import java.util.Locale;

/** Shape types persisted in the annotation document. */
public enum AnnotationShape {
    RECTANGLE,
    SQUARE,
    ELLIPSE,
    CIRCLE,
    POLYGON,
    POLYLINE,
    LINE,
    WAND,
    BRUSH,
    POINTS;

    @JsonCreator
    public static AnnotationShape fromJson(String value) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("Annotation type is required.");
        }
        return valueOf(value.trim().toUpperCase(Locale.ROOT));
    }

    @JsonValue
    public String toJson() {
        return name().toLowerCase(Locale.ROOT);
    }
}
