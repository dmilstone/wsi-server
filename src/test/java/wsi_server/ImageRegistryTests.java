package wsi_server;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

class ImageRegistryTests {
    @TempDir
    Path root;

    @Test
    void markerNamesAreNeverReturnedAsImagesOrBrowseEntries() throws Exception {
        Files.createFile(root.resolve(".wsi-environment-production"));
        Files.createFile(root.resolve(".wsi-environment-production.tif"));
        Files.createFile(root.resolve("slide.tif"));

        ImageRegistry registry = new ImageRegistry(root.toString(), true);

        assertThat(registry.getImages())
                .extracting(ImageRegistry.ImageEntry::name)
                .containsExactly("slide.tif");
    }
}
