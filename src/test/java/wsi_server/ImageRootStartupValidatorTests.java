package wsi_server;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ImageRootStartupValidatorTests {
    @TempDir
    Path temporaryDirectory;

    @Test
    void productionMarkerMatchesProduction() throws IOException {
        assertValid("production", ".wsi-environment-production");
    }

    @Test
    void stagingMarkerMatchesStaging() throws IOException {
        assertValid(" STAGING ", ".wsi-environment-staging");
    }

    @Test
    void developmentMarkerMatchesDevelopment() throws IOException {
        assertValid("Development", ".wsi-environment-development");
    }

    @Test
    void developmentRejectsProductionMarker() throws IOException {
        assertWrongMarker("development", ".wsi-environment-production");
    }

    @Test
    void stagingRejectsDevelopmentMarker() throws IOException {
        assertWrongMarker("staging", ".wsi-environment-development");
    }

    @Test
    void productionRejectsStagingMarker() throws IOException {
        assertWrongMarker("production", ".wsi-environment-staging");
    }

    @Test
    void missingMarkerIsRejected() {
        assertRefused("production", temporaryDirectory, "expected environment marker is missing");
    }

    @Test
    void multipleMarkersAreRejected() throws IOException {
        Files.createFile(temporaryDirectory.resolve(".wsi-environment-production"));
        Files.createFile(temporaryDirectory.resolve(".wsi-environment-staging"));
        assertRefused("production", temporaryDirectory, "more than one environment marker is present");
    }

    @Test
    void missingDirectoryIsRejected() {
        assertRefused("production", temporaryDirectory.resolve("absent"), "image directory does not exist");
    }

    @Test
    void regularFileIsRejected() throws IOException {
        Path file = Files.createFile(temporaryDirectory.resolve("not-a-directory"));
        assertRefused("production", file, "configured path is not a directory");
    }

    @Test
    void blankDirectoryIsRejected() {
        assertThatThrownBy(() -> ImageRootStartupValidator.validate("production", "  "))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("environment=production")
                .hasMessageContaining("configuredImageDirectory=<blank>")
                .hasMessageContaining("expectedMarker=.wsi-environment-production")
                .hasMessageContaining("wsi.image-directory is missing or blank");
    }

    @Test
    void symbolicLinkIsRejected() throws IOException {
        Path target = Files.createDirectory(temporaryDirectory.resolve("target"));
        Files.createFile(target.resolve(".wsi-environment-production"));
        Path link = temporaryDirectory.resolve("link");
        Files.createSymbolicLink(link, target);

        assertRefused("production", link, "symbolic links or canonical-path mismatches are not allowed");
    }

    private void assertValid(String environment, String marker) throws IOException {
        Path root = Files.createDirectory(temporaryDirectory.resolve(environment.strip().toLowerCase()));
        Files.createFile(root.resolve(marker));
        assertThat(ImageRootStartupValidator.validate(environment, root.toString())).isEqualTo(root.toRealPath());
    }

    private void assertWrongMarker(String environment, String marker) throws IOException {
        Path root = Files.createDirectory(temporaryDirectory.resolve(environment));
        Files.createFile(root.resolve(marker));
        assertThatThrownBy(() -> ImageRootStartupValidator.validate(environment, root.toString()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("environment=" + environment)
                .hasMessageContaining("expectedMarker=.wsi-environment-" + environment)
                .hasMessageContaining("foundMarkers=[" + marker + "]")
                .hasMessageContaining("marker belongs to another environment");
    }

    private static void assertRefused(String environment, Path path, String reason) {
        assertThatThrownBy(() -> ImageRootStartupValidator.validate(environment, path.toString()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("WSI startup refused")
                .hasMessageContaining(reason);
    }
}
