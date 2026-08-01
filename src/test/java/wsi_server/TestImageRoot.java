package wsi_server;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

final class TestImageRoot {
    static final Path ROOT = create();

    private TestImageRoot() {
    }

    private static Path create() {
        try {
            Path root = Files.createTempDirectory("wsi-context-images-").toRealPath();
            Files.createFile(root.resolve(".wsi-environment-production"));
            Files.createFile(root.resolve("context-test.tif"));
            root.toFile().deleteOnExit();
            return root;
        } catch (IOException exception) {
            throw new ExceptionInInitializerError(exception);
        }
    }
}
