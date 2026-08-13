package wsi_server.feedback;

import tools.jackson.databind.json.JsonMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.locks.ReentrantReadWriteLock;
import java.util.stream.Stream;

/** Thread-safe filesystem persistence for pilot feedback submissions. */
@Service
public class PilotFeedbackStorage {
    private final Path rootDirectory;
    private final Path jsonlFile;
    private final JsonMapper jsonMapper;
    private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock();

    public PilotFeedbackStorage(
            @Value("${wsi.feedback.directory:${user.home}/.wsi-server/feedback}") String configuredDirectory,
            JsonMapper jsonMapper
    ) throws IOException {
        this.rootDirectory = Path.of(configuredDirectory).toAbsolutePath().normalize();
        this.jsonlFile = rootDirectory.resolve("submissions.jsonl");
        this.jsonMapper = jsonMapper;
        Files.createDirectories(rootDirectory);
    }

    public void append(PilotFeedbackEntry entry) throws IOException {
        lock.writeLock().lock();
        try {
            Path target = fileFor(entry.responseId());
            Files.createDirectories(target.getParent());
            Path temporary = Files.createTempFile(target.getParent(), entry.responseId(), ".tmp");
            try {
                jsonMapper.writerWithDefaultPrettyPrinter().writeValue(temporary, entry);
                try {
                    Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
                } catch (AtomicMoveNotSupportedException ignored) {
                    Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING);
                }
            } finally {
                Files.deleteIfExists(temporary);
            }
            String line = jsonMapper.writeValueAsString(entry) + System.lineSeparator();
            Files.writeString(jsonlFile, line, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } finally {
            lock.writeLock().unlock();
        }
    }

    public List<PilotFeedbackEntry> readAll() throws IOException {
        lock.readLock().lock();
        try {
            if (!Files.isDirectory(rootDirectory)) return List.of();
            List<PilotFeedbackEntry> entries = new ArrayList<>();
            try (Stream<Path> paths = Files.list(rootDirectory)) {
                List<Path> files = paths.filter(path -> path.getFileName().toString().endsWith(".json")).toList();
                for (Path path : files) {
                    entries.add(jsonMapper.readValue(path.toFile(), PilotFeedbackEntry.class));
                }
            }
            entries.sort(Comparator.comparing(PilotFeedbackEntry::submittedAt).thenComparing(PilotFeedbackEntry::responseId));
            return List.copyOf(entries);
        } finally {
            lock.readLock().unlock();
        }
    }

    public Instant latestSubmissionTime() throws IOException {
        return readAll().stream()
                .map(PilotFeedbackEntry::submittedAt)
                .max(Comparator.naturalOrder())
                .orElse(null);
    }

    Path fileFor(String responseId) {
        String safeId = responseId.replaceAll("[^a-zA-Z0-9-]", "");
        if (safeId.isBlank()) throw new IllegalArgumentException("Invalid response id.");
        Path target = rootDirectory.resolve(safeId + ".json").normalize();
        if (!target.startsWith(rootDirectory)) {
            throw new IllegalArgumentException("Invalid response id.");
        }
        return target;
    }

    Path rootDirectory() {
        return rootDirectory;
    }
}
