package wsi_server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Reads promote-time companion metadata written next to WSI containers
 * ({@code <stem>.metadata.json}) during Python ingestion / retro OCR.
 */
public final class WsiCatalogScanner {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Pattern IF_MARKER = Pattern.compile("(?i)if\\.\\S+");

    private WsiCatalogScanner() {
    }

    public record SidecarMetadata(String clinicalMarker, int zPlanes, int depth, int zLayers) {
        public SidecarMetadata {
            clinicalMarker = clinicalMarker == null ? "" : clinicalMarker;
        }

        public static SidecarMetadata empty() {
            return new SidecarMetadata("", 0, 0, 0);
        }
    }

    /** Companion metadata path for a slide container. */
    public static Path metadataPathForSlide(Path slidePath) {
        if (slidePath == null) return null;
        String fileName = slidePath.getFileName().toString();
        int dot = fileName.lastIndexOf('.');
        String stem = dot > 0 ? fileName.substring(0, dot) : fileName;
        Path parent = slidePath.getParent();
        if (parent == null) return Path.of(stem + ".metadata.json");
        return parent.resolve(stem + ".metadata.json");
    }

    /** Full sidecar map, or empty values when the file is missing/malformed. */
    public static SidecarMetadata read(Path slidePath) {
        Path meta = metadataPathForSlide(slidePath);
        if (meta == null || !Files.isRegularFile(meta)) return SidecarMetadata.empty();
        try {
            JsonNode root = MAPPER.readTree(Files.readString(meta));
            if (root == null || !root.isObject()) return SidecarMetadata.empty();
            return new SidecarMetadata(
                    readClinicalMarkerNode(root),
                    readPositiveInt(root, "zPlanes", "z_planes", "zPlaneCount", "z_plane_count"),
                    readPositiveInt(root, "depth", "zDepth", "z_depth"),
                    readPositiveInt(root, "zLayers", "z_layers", "layers")
            );
        } catch (IOException | RuntimeException ignored) {
            return SidecarMetadata.empty();
        }
    }

    /** Returns the pre-saved clinical marker ({@code if.<epitope>}) or empty string. */
    public static String readClinicalMarker(Path slidePath) {
        return read(slidePath).clinicalMarker();
    }

    static String normalizeClinicalMarker(String raw) {
        String text = String.valueOf(raw == null ? "" : raw).trim();
        if (text.isEmpty()) return "";
        text = text.replaceFirst("(?i)if[\\s.]+", "if.");
        Matcher matcher = IF_MARKER.matcher(text);
        if (matcher.find()) return matcher.group();
        return text.toLowerCase(Locale.ROOT).startsWith("if.") ? text : "";
    }

    private static String readClinicalMarkerNode(JsonNode root) {
        JsonNode marker = root.get("clinicalMarker");
        if (marker == null || marker.isNull()) marker = root.get("clinical_marker");
        if (marker == null || marker.isNull()) marker = root.get("epitope");
        if (marker == null || marker.isNull()) return "";
        return normalizeClinicalMarker(marker.asText(""));
    }

    private static int readPositiveInt(JsonNode root, String... names) {
        for (String name : names) {
            JsonNode node = root.get(name);
            if (node == null || node.isNull()) continue;
            if (node.isNumber()) {
                int value = node.asInt();
                if (value > 0) return value;
                continue;
            }
            try {
                int value = Integer.parseInt(node.asText("").trim());
                if (value > 0) return value;
            } catch (NumberFormatException ignored) {
                // Keep scanning aliases.
            }
        }
        return 0;
    }
}
