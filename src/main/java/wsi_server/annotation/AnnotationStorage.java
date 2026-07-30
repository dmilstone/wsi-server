package wsi_server.annotation;

import tools.jackson.databind.json.JsonMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import wsi_server.ImageRegistry;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/** Filesystem persistence with atomic replacement of complete JSON documents. */
@Service
public class AnnotationStorage {
    private final Path rootDirectory;
    private final JsonMapper jsonMapper;

    public AnnotationStorage(
            @Value("${wsi.annotations.directory:${user.home}/.wsi-server/annotations}") String configuredDirectory,
            JsonMapper jsonMapper
    ) throws IOException {
        this.rootDirectory = Path.of(configuredDirectory).toAbsolutePath().normalize();
        this.jsonMapper = jsonMapper;
        Files.createDirectories(rootDirectory);
    }

    public AnnotationCollection read(String userId, ImageRegistry.ImageEntry image) throws IOException {
        Path file = fileFor(userId, image);
        if (!Files.exists(file)) return null;
        return jsonMapper.readValue(file, AnnotationCollection.class);
    }

    public void write(String userId, ImageRegistry.ImageEntry image, AnnotationCollection collection) throws IOException {
        Path target = fileFor(userId, image);
        Files.createDirectories(target.getParent());
        Path temporary = Files.createTempFile(target.getParent(), target.getFileName().toString(), ".tmp");
        try {
            jsonMapper.writerWithDefaultPrettyPrinter().writeValue(temporary, collection);
            try {
                Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException ignored) {
                Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    Path fileFor(String userId, ImageRegistry.ImageEntry image) {
        String safeUser = AnnotationUserResolver.normalize(userId, "local");
        Path userDirectory = rootDirectory.resolve(safeUser).normalize();
        if (!userDirectory.startsWith(rootDirectory)) {
            throw new IllegalArgumentException("Invalid annotation user id.");
        }
        return userDirectory.resolve(sha256(image.relativePath()) + ".json");
    }

    private static String sha256(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is unavailable.", e);
        }
    }
}
