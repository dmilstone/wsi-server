package wsi_server.annotation;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import wsi_server.ImageRegistry;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;

class ImageRegistryCompatibilityTests {
    @TempDir
    Path images;

    @Test
    void publicTwoArgumentConstructorIsAvailableOutsideRegistryPackage() throws Exception {
        Files.writeString(images.resolve("compatibility.svs"), "placeholder");

        ImageRegistry registry = new ImageRegistry(images.toString(), true);

        assertEquals(1, registry.getImages().size());
    }
}
