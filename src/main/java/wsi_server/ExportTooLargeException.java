package wsi_server;

/**
 * Raised when an export request exceeds {@code wsi.export.max-pixels}.
 * Mapped to a stable {@code EXPORT_TOO_LARGE} problem response.
 */
class ExportTooLargeException extends IllegalArgumentException {
    static final String CODE = "EXPORT_TOO_LARGE";

    ExportTooLargeException(String message) {
        super(message);
    }
}
