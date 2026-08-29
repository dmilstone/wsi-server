package wsi_server;

import com.sun.jna.Library;
import com.sun.jna.Native;
import com.sun.jna.Pointer;
import com.sun.jna.ptr.LongByReference;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * JNA binding for Homebrew / system {@code libopenslide}. Brightfield
 * {@code .svs}/{@code .ndpi} tiles go through this, not Bio-Formats' NDPIReader
 * (which requires an Intel-only TurboJPEG binary).
 */
final class OpenSlideNative {

    private static final Logger LOGGER = LoggerFactory.getLogger(OpenSlideNative.class);

    static final String[] LIBRARY_FILES = {
            "libopenslide.1.dylib",
            "libopenslide.dylib",
            "libopenslide.so.1",
            "libopenslide.so",
            "libopenslide-0.dll",
            "libopenslide.dll"
    };

    static final String[] SEARCH_DIRECTORIES = {
            "/opt/homebrew/lib",
            "/usr/local/lib",
            "/opt/homebrew/opt/openslide/lib",
            "/usr/lib"
    };

    interface Lib extends Library {
        Pointer openslide_open(String filename);

        void openslide_close(Pointer osr);

        int openslide_get_level_count(Pointer osr);

        void openslide_get_level_dimensions(Pointer osr, int level, LongByReference w, LongByReference h);

        double openslide_get_level_downsample(Pointer osr, int level);

        String openslide_get_error(Pointer osr);

        void openslide_read_region(Pointer osr, int[] dest, long x, long y, int level, long w, long h);

        Pointer openslide_get_associated_image_names(Pointer osr);

        void openslide_get_associated_image_dimensions(Pointer osr, String name, LongByReference w, LongByReference h);

        void openslide_read_associated_image(Pointer osr, String name, int[] dest);

        Pointer openslide_get_property_names(Pointer osr);

        String openslide_get_property_value(Pointer osr, String name);
    }

    private static volatile Lib lib;
    private static volatile Throwable loadError;

    private OpenSlideNative() {
    }

    static synchronized void ensureLoaded() {
        if (lib != null) return;
        List<Path> candidates = candidateLibraries();
        prependJnaLibraryPath(candidates);
        for (Path candidate : candidates) {
            try {
                System.load(candidate.toString());
            } catch (UnsatisfiedLinkError ignored) {
                // JNA still tries Native.load("openslide") using jna.library.path.
            }
        }
        try {
            lib = Native.load("openslide", Lib.class);
            loadError = null;
            LOGGER.info("Loaded OpenSlide native library ({} candidate path(s))", candidates.size());
        } catch (UnsatisfiedLinkError error) {
            loadError = error;
            lib = null;
            LOGGER.warn("OpenSlide native library is not available: {}", error.getMessage());
        }
    }

    static boolean isAvailable() {
        ensureLoaded();
        return lib != null;
    }

    static Lib lib() {
        ensureLoaded();
        if (lib == null) {
            throw new IllegalStateException("OpenSlide native library is not available.", loadError);
        }
        return lib;
    }

    static List<Path> candidateLibraries() {
        Set<Path> found = new LinkedHashSet<>();
        for (String directory : SEARCH_DIRECTORIES) {
            for (String file : LIBRARY_FILES) {
                Path path = Path.of(directory, file);
                if (Files.isRegularFile(path)) found.add(path);
            }
        }
        return List.copyOf(found);
    }

    static void prependJnaLibraryPath(List<Path> libraries) {
        Set<String> directories = new LinkedHashSet<>();
        for (Path library : libraries) {
            Path parent = library.getParent();
            if (parent != null) directories.add(parent.toString());
        }
        for (String directory : SEARCH_DIRECTORIES) {
            if (Files.isDirectory(Path.of(directory))) directories.add(directory);
        }
        if (directories.isEmpty()) return;
        String existing = System.getProperty("jna.library.path", "");
        if (!existing.isBlank()) {
            for (String part : existing.split(java.io.File.pathSeparator)) {
                if (!part.isBlank()) directories.add(part);
            }
        }
        System.setProperty("jna.library.path", String.join(java.io.File.pathSeparator, directories));
    }

    static List<String> stringArray(Pointer pointer) {
        if (pointer == null) return List.of();
        String[] values = pointer.getStringArray(0);
        if (values == null || values.length == 0) return List.of();
        List<String> names = new ArrayList<>();
        for (String value : values) {
            if (value != null && !value.isBlank()) names.add(value);
        }
        return List.copyOf(names);
    }

    static void checkError(Pointer handle, String action) {
        if (handle == null) throw new IllegalStateException("OpenSlide handle is closed during " + action + ".");
        String error = lib().openslide_get_error(handle);
        if (error != null && !error.isBlank()) {
            throw new IllegalStateException("OpenSlide " + action + " failed: " + error);
        }
    }
}
