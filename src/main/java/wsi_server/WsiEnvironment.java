package wsi_server;

import java.util.Locale;
import java.util.Set;

/** The deployment environments understood by both startup validation and the UI. */
public final class WsiEnvironment {
    private static final Set<String> SUPPORTED = Set.of("production", "staging", "development");

    private WsiEnvironment() {
    }

    public static String normalize(String configured) {
        String normalized = configured == null ? "" : configured.strip().toLowerCase(Locale.ROOT);
        if (!SUPPORTED.contains(normalized)) {
            throw new IllegalArgumentException(
                    "Unsupported wsi.environment '" + configured
                            + "'; expected production, staging, or development."
            );
        }
        return normalized;
    }

    public static String markerFor(String normalizedEnvironment) {
        return ".wsi-environment-" + normalizedEnvironment;
    }
}
