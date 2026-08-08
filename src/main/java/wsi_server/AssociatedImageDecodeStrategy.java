package wsi_server;

import java.util.Locale;

/** Pixel-read strategy for an associated series selected elsewhere. */
enum AssociatedImageDecodeStrategy {
    FULL,
    BIO_FORMATS_THUMBNAIL;

    static AssociatedImageDecodeStrategy fromConfiguration(String value) {
        if (value == null || value.isBlank() || "full".equalsIgnoreCase(value)) return FULL;
        if ("bio-formats-thumbnail".equals(value.toLowerCase(Locale.ROOT))) return BIO_FORMATS_THUMBNAIL;
        throw new IllegalArgumentException("Unsupported associated-image decode strategy: " + value);
    }

    String timingStage() {
        return this == FULL ? "full_open_image_decode" : "thumbnail_open_image_decode";
    }
}
