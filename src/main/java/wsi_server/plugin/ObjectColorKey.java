package wsi_server.plugin;

/**
 * Scalar color-map key for one nucleus. Intensity statistics stay server-side;
 * the client maps {@code key} onto the rainbow overlay color.
 */
public record ObjectColorKey(
        int index,
        double cx,
        double cy,
        double r,
        double key
) {
}
