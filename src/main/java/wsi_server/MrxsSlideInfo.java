package wsi_server;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;

/**
 * 3DHistech {@code .mrxs} companion folder. The {@code .mrxs} file itself is
 * often a JFIF preview, so Bio-Formats' JPEG reader claims it; the real slide
 * type lives in {@code <stem>/Slidedat.ini}.
 */
final class MrxsSlideInfo {
    private MrxsSlideInfo() {
    }

    static boolean isMrxs(Path slidePath) {
        if (slidePath == null || slidePath.getFileName() == null) return false;
        return slidePath.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".mrxs");
    }

    static Path slidedatPath(Path slidePath) {
        if (!isMrxs(slidePath)) return null;
        String fileName = slidePath.getFileName().toString();
        int dot = fileName.lastIndexOf('.');
        String stem = dot > 0 ? fileName.substring(0, dot) : fileName;
        Path parent = slidePath.getParent();
        Path companion = parent == null ? Path.of(stem) : parent.resolve(stem);
        return companion.resolve("Slidedat.ini");
    }

    static boolean isFluorescence(Path slidePath) {
        Path ini = slidedatPath(slidePath);
        if (ini == null || !Files.isRegularFile(ini)) return false;
        try {
            for (String line : Files.readAllLines(ini, StandardCharsets.ISO_8859_1)) {
                int eq = line.indexOf('=');
                if (eq < 0) continue;
                String key = line.substring(0, eq).trim();
                if (!key.equalsIgnoreCase("SLIDE_TYPE")) continue;
                String value = line.substring(eq + 1).trim().toUpperCase(Locale.ROOT);
                return value.contains("FLUOR");
            }
        } catch (IOException ignored) {
            return false;
        }
        return false;
    }
}
