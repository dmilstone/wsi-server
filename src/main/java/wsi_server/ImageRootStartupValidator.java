package wsi_server;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.BeansException;
import org.springframework.beans.factory.config.BeanFactoryPostProcessor;
import org.springframework.beans.factory.config.ConfigurableListableBeanFactory;
import org.springframework.context.EnvironmentAware;
import org.springframework.core.Ordered;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.Locale;

/** Validates the image root during context setup, before the embedded web server starts. */
@Component
public final class ImageRootStartupValidator
        implements BeanFactoryPostProcessor, EnvironmentAware, Ordered {
    private static final Logger LOGGER = LoggerFactory.getLogger(ImageRootStartupValidator.class);
    private static final String MARKER_PREFIX = ".wsi-environment-";

    private Environment properties;

    @Override
    public void setEnvironment(Environment environment) {
        this.properties = environment;
    }

    @Override
    public int getOrder() {
        return Ordered.HIGHEST_PRECEDENCE;
    }

    @Override
    public void postProcessBeanFactory(ConfigurableListableBeanFactory beanFactory) throws BeansException {
        validate(properties.getProperty("wsi.environment", "production"),
                properties.getProperty("wsi.image-directory"));
    }

    static Path validate(String configuredEnvironment, String configuredDirectory) {
        final String environment;
        try {
            environment = WsiEnvironment.normalize(configuredEnvironment);
        } catch (IllegalArgumentException exception) {
            throw refused(configuredEnvironment == null ? "<invalid>"
                            : configuredEnvironment.strip().toLowerCase(Locale.ROOT),
                    configuredDirectory, null, "<unknown>", List.of(), exception.getMessage(), exception);
        }
        String expectedMarker = WsiEnvironment.markerFor(environment);
        if (configuredDirectory == null || configuredDirectory.isBlank()) {
            throw refused(environment, configuredDirectory, null, expectedMarker, List.of(),
                    "wsi.image-directory is missing or blank", null);
        }

        Path configured;
        try {
            configured = Paths.get(configuredDirectory).toAbsolutePath().normalize();
        } catch (RuntimeException exception) {
            throw refused(environment, configuredDirectory, null, expectedMarker, List.of(),
                    "configured image-directory path is invalid", exception);
        }
        if (!Files.exists(configured, LinkOption.NOFOLLOW_LINKS)) {
            throw refused(environment, configuredDirectory, null, expectedMarker, List.of(),
                    "image directory does not exist", null);
        }
        if (Files.isSymbolicLink(configured)) {
            throw refused(environment, configuredDirectory, null, expectedMarker, List.of(),
                    "configured image-root entry is a symbolic link", null);
        }
        final Path resolved;
        try {
            resolved = configured.toRealPath();
        } catch (IOException exception) {
            throw refused(environment, configuredDirectory, null, expectedMarker, List.of(),
                    "canonical image-directory path cannot be resolved", exception);
        }
        if (!Files.isDirectory(resolved, LinkOption.NOFOLLOW_LINKS)) {
            throw refused(environment, configuredDirectory, resolved, expectedMarker, List.of(),
                    "configured path is not a directory", null);
        }

        final List<String> markers;
        try (var entries = Files.list(resolved)) {
            markers = entries
                    .map(path -> path.getFileName().toString())
                    .filter(name -> name.startsWith(MARKER_PREFIX))
                    .sorted()
                    .toList();
        } catch (IOException exception) {
            throw refused(environment, configuredDirectory, resolved, expectedMarker, List.of(),
                    "environment markers cannot be inspected", exception);
        }

        if (markers.size() > 1) {
            throw refused(environment, configuredDirectory, resolved, expectedMarker, markers,
                    "more than one environment marker is present", null);
        }
        if (markers.isEmpty()) {
            throw refused(environment, configuredDirectory, resolved, expectedMarker, markers,
                    "expected environment marker is missing", null);
        }
        if (!markers.getFirst().equals(expectedMarker)) {
            throw refused(environment, configuredDirectory, resolved, expectedMarker, markers,
                    "marker belongs to another environment", null);
        }

        LOGGER.info("WSI image root validated: environment={}, canonicalRoot={}, marker={}",
                environment, resolved, expectedMarker);
        return resolved;
    }

    private static IllegalStateException refused(
            String environment, String configured, Path resolved, String expected,
            List<String> found, String reason, Throwable cause
    ) {
        String message = "WSI startup refused: environment=" + environment
                + ", configuredImageDirectory=" + printable(configured)
                + ", resolvedPath=" + (resolved == null ? "<unavailable>" : resolved)
                + ", expectedMarker=" + expected
                + ", foundMarkers=" + found
                + ", reason=" + reason;
        return new IllegalStateException(message, cause);
    }

    private static String printable(String value) {
        return value == null || value.isBlank() ? "<blank>" : value;
    }
}
