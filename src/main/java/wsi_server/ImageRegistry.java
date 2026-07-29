package wsi_server;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Recursively discovers supported files below one configured security root. */
@Service
public class ImageRegistry {
    private static final List<String> SUPPORTED_SUFFIXES = List.of(
            ".ome.tif", ".ome.tiff", ".tif", ".tiff",
            ".czi", ".nd2", ".lif", ".vsi", ".svs"
    );

    private final Path rootDirectory;
    private final boolean recursive;
    private final Map<String, ImageEntry> entries;

    public ImageRegistry(
            @Value("${wsi.image-directory:${wsi.slide-path:}}") String configuredPath,
            @Value("${wsi.scan-recursive:true}") boolean recursive
    ) throws Exception {
        if (configuredPath == null || configuredPath.isBlank()) {
            throw new IllegalStateException("Set wsi.image-directory to the image root directory.");
        }
        Path configured = Paths.get(configuredPath).toAbsolutePath().normalize();
        this.rootDirectory = Files.isDirectory(configured) ? configured : configured.getParent();
        this.recursive = recursive;
        if (rootDirectory == null || !Files.isDirectory(rootDirectory)) {
            throw new IllegalStateException("Image directory does not exist: " + configuredPath);
        }
        this.entries = discoverImages();
        if (entries.isEmpty()) {
            throw new IllegalStateException("No supported image files were found in " + rootDirectory);
        }
        System.out.println("Image root directory: " + rootDirectory);
        System.out.println("Recursive image scan: " + recursive);
        System.out.println("Discovered image files: " + entries.size());
    }

    public Path getRootDirectory() { return rootDirectory; }
    public List<ImageEntry> getImages() { return List.copyOf(entries.values()); }
    public ImageEntry getFirst() { return entries.values().iterator().next(); }

    public ImageEntry getRequired(String imageId) {
        ImageEntry entry = entries.get(imageId);
        if (entry == null) throw new IllegalArgumentException("Unknown image id: " + imageId);
        return entry;
    }

    private Map<String, ImageEntry> discoverImages() throws Exception {
        List<Path> paths = new ArrayList<>();
        int depth = recursive ? Integer.MAX_VALUE : 1;
        try (var stream = Files.walk(rootDirectory, depth)) {
            stream.filter(Files::isRegularFile)
                    .filter(this::hasSupportedSuffix)
                    .forEach(paths::add);
        }
        paths.sort(Comparator.comparing(
                path -> normalizeRelative(rootDirectory.relativize(path)),
                String.CASE_INSENSITIVE_ORDER
        ));

        Map<String, ImageEntry> result = new LinkedHashMap<>();
        for (Path path : paths) {
            Path normalized = path.toAbsolutePath().normalize();
            if (!normalized.startsWith(rootDirectory)) continue;
            String relativePath = normalizeRelative(rootDirectory.relativize(normalized));
            String id = Base64.getUrlEncoder().withoutPadding()
                    .encodeToString(relativePath.getBytes(StandardCharsets.UTF_8));
            int slash = relativePath.lastIndexOf('/');
            String folder = slash < 0 ? "" : relativePath.substring(0, slash);
            String name = slash < 0 ? relativePath : relativePath.substring(slash + 1);
            result.put(id, new ImageEntry(id, name, relativePath, folder, normalized));
        }
        return result;
    }

    private String normalizeRelative(Path path) {
        return path.toString().replace('\\', '/');
    }

    private boolean hasSupportedSuffix(Path path) {
        String name = path.getFileName().toString().toLowerCase(Locale.ROOT);
        return SUPPORTED_SUFFIXES.stream().anyMatch(name::endsWith);
    }

    public record ImageEntry(String id, String name, String relativePath, String folder, Path path) {}
}
