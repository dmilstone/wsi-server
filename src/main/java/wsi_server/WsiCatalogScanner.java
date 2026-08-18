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

    public static final String MODALITY_BRIGHTFIELD = "BRIGHTFIELD";
    public static final String MODALITY_FLUORESCENCE = "FLUORESCENCE";
    public static final String ENGINE_OPENSLIDE = "OPENSLIDE";
    public static final String ENGINE_BIOFORMATS = "BIOFORMATS";

    private WsiCatalogScanner() {
    }

    public record SlideInspection(String modality, String engine) {
        public SlideInspection {
            modality = modality == null || modality.isBlank() ? MODALITY_FLUORESCENCE : modality;
            engine = engine == null || engine.isBlank() ? ENGINE_BIOFORMATS : engine;
        }
    }

    public record SidecarMetadata(
            String clinicalMarker,
            int zPlanes,
            int depth,
            int zLayers,
            int channels,
            boolean fluorescentArrays,
            boolean rgb,
            String modalityHint
    ) {
        public SidecarMetadata {
            clinicalMarker = clinicalMarker == null ? "" : clinicalMarker;
            modalityHint = modalityHint == null ? "" : modalityHint;
        }

        public static SidecarMetadata empty() {
            return new SidecarMetadata("", 0, 0, 0, 0, false, false, "");
        }

        public boolean lacksFluorescentArrays() {
            return !fluorescentArrays;
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
            String clinicalMarker = readClinicalMarkerNode(root);
            int channels = readPositiveInt(root, "channels", "sizeC", "size_c", "channelCount", "channel_count");
            boolean rgb = readBoolean(root, "rgb", "isRgb", "is_rgb");
            String modalityHint = readModalityHint(root);
            return new SidecarMetadata(
                    clinicalMarker,
                    readPositiveInt(root, "zPlanes", "z_planes", "zPlaneCount", "z_plane_count"),
                    readPositiveInt(root, "depth", "zDepth", "z_depth"),
                    readPositiveInt(root, "zLayers", "z_layers", "layers"),
                    channels,
                    readFluorescentArrays(root, clinicalMarker, channels, modalityHint),
                    rgb,
                    modalityHint
            );
        } catch (IOException | RuntimeException ignored) {
            return SidecarMetadata.empty();
        }
    }

    /** Returns the pre-saved clinical marker ({@code if.<epitope>}) or empty string. */
    public static String readClinicalMarker(Path slidePath) {
        return read(slidePath).clinicalMarker();
    }

    /**
     * Extension and sidecar inspection used to flag brightfield slides and
     * route them to the OpenSlide engine.
     */
    public static SlideInspection inspect(Path slidePath) {
        Path meta = metadataPathForSlide(slidePath);
        boolean sidecarPresent = meta != null && Files.isRegularFile(meta);
        return inspect(slidePath, read(slidePath), sidecarPresent);
    }

    public static SlideInspection inspect(Path slidePath, SidecarMetadata sidecar, boolean sidecarPresent) {
        if (isOpenSlideExtension(slidePath)) {
            return new SlideInspection(MODALITY_BRIGHTFIELD, ENGINE_OPENSLIDE);
        }
        SidecarMetadata data = sidecar == null ? SidecarMetadata.empty() : sidecar;
        if (sidecarPresent && data.lacksFluorescentArrays() && looksBrightfield(data)) {
            return new SlideInspection(MODALITY_BRIGHTFIELD, ENGINE_OPENSLIDE);
        }
        return new SlideInspection(MODALITY_FLUORESCENCE, ENGINE_BIOFORMATS);
    }

    public static boolean isOpenSlideExtension(Path slidePath) {
        if (slidePath == null || slidePath.getFileName() == null) return false;
        String name = slidePath.getFileName().toString().toLowerCase(Locale.ROOT);
        return name.endsWith(".svs") || name.endsWith(".ndpi");
    }

    static boolean looksBrightfield(SidecarMetadata sidecar) {
        if (sidecar == null) return false;
        String hint = sidecar.modalityHint().toLowerCase(Locale.ROOT);
        if (hint.contains("bright") || hint.contains("ihc") || hint.contains("dab")
                || hint.contains("h&e") || hint.contains("h-e") || hint.equals("he")) {
            return true;
        }
        if (sidecar.rgb() && sidecar.lacksFluorescentArrays()) return true;
        return sidecar.channels() > 0 && sidecar.channels() <= 3 && sidecar.lacksFluorescentArrays();
    }

    static String normalizeClinicalMarker(String raw) {
        String text = String.valueOf(raw == null ? "" : raw).trim();
        if (text.isEmpty()) return "";
        text = text.replaceFirst("(?i)if[\\s.]+", "if.");
        Matcher matcher = IF_MARKER.matcher(text);
        if (matcher.find()) {
            String token = matcher.group();
            if (token.matches("(?i)if\\.(pending|none|unknown|n/?a)")) return "";
            return token;
        }
        return text.toLowerCase(Locale.ROOT).startsWith("if.") ? text : "";
    }

    private static String readClinicalMarkerNode(JsonNode root) {
        if (root == null || !root.isObject()) return "";
        for (String name : new String[] {
                "clinicalMarker", "clinical_marker", "epitope", "if_epitope", "ifEpitope", "stain"
        }) {
            JsonNode marker = root.get(name);
            if (marker == null || marker.isNull()) continue;
            String normalized = normalizeClinicalMarker(marker.asText(""));
            if (!normalized.isEmpty()) return normalized;
        }
        JsonNode ocr = root.get("ocr");
        if (ocr != null && ocr.isObject()) {
            JsonNode nested = ocr.get("clinicalMarker");
            if (nested == null || nested.isNull()) nested = ocr.get("clinical_marker");
            if (nested == null || nested.isNull()) nested = ocr.get("epitope");
            if (nested != null && !nested.isNull()) {
                return normalizeClinicalMarker(nested.asText(""));
            }
        }
        return "";
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

    private static boolean readBoolean(JsonNode root, String... names) {
        for (String name : names) {
            JsonNode node = root.get(name);
            if (node == null || node.isNull()) continue;
            if (node.isBoolean()) return node.asBoolean();
            String text = node.asText("").trim();
            if (text.equalsIgnoreCase("true") || text.equals("1")) return true;
        }
        return false;
    }

    private static String readModalityHint(JsonNode root) {
        for (String name : new String[] {"modality", "stainType", "stain_type", "mode", "imagingMode"}) {
            JsonNode node = root.get(name);
            if (node == null || node.isNull()) continue;
            String text = node.asText("").trim();
            if (!text.isEmpty()) return text;
        }
        return "";
    }

    private static boolean readFluorescentArrays(
            JsonNode root,
            String clinicalMarker,
            int channels,
            String modalityHint
    ) {
        if (clinicalMarker != null && clinicalMarker.regionMatches(true, 0, "if.", 0, 3)
                && !normalizeClinicalMarker(clinicalMarker).isEmpty()) {
            return true;
        }
        if (channels > 3) return true;
        String hint = modalityHint == null ? "" : modalityHint.toLowerCase(Locale.ROOT);
        if (hint.contains("fluor")) return true;
        if (readBoolean(root, "fluorescent", "isFluorescent", "is_fluorescent", "multiChannel", "fluorescence")) {
            return true;
        }
        JsonNode names = root.get("channelNames");
        if (names == null) names = root.get("channels");
        if (names != null && names.isArray()) {
            for (JsonNode node : names) {
                if (node == null || node.isNull()) continue;
                if (isFluorescentChannelName(node.asText(""))) return true;
            }
        }
        return false;
    }

    private static boolean isFluorescentChannelName(String raw) {
        String name = raw == null ? "" : raw.toUpperCase(Locale.ROOT);
        return name.contains("DAPI") || name.contains("FITC") || name.contains("TRITC")
                || name.contains("CY5") || name.contains("CY3") || name.contains("AF4")
                || name.contains("AF5") || name.contains("HOECHST");
    }
}
