package wsi_server;

import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/** Maintains an atomically published registry of supported files below one security root. */
@Service
public class ImageRegistry {
    private static final Logger LOGGER = LoggerFactory.getLogger(ImageRegistry.class);
    private static final List<String> SUPPORTED_SUFFIXES = List.of(
            ".ome.tif", ".ome.tiff", ".tif", ".tiff", ".czi", ".nd2", ".lif", ".vsi", ".svs");

    private final Path rootDirectory;
    private final boolean recursive;
    private final Duration refreshInterval;
    private final Duration stabilityWindow;
    private final Clock clock;
    private final AtomicReference<Snapshot> snapshot;
    private final Map<String, Observation> pending = new HashMap<>();
    private final AtomicBoolean scanning = new AtomicBoolean();
    private final ExecutorService scanner = Executors.newSingleThreadExecutor(r -> {
        Thread thread = new Thread(r, "wsi-image-discovery");
        thread.setDaemon(true);
        return thread;
    });
    private volatile Instant lastStarted = Instant.EPOCH;
    private volatile RefreshStatus status = new RefreshStatus(false, 0, 0, null);

    @org.springframework.beans.factory.annotation.Autowired
    public ImageRegistry(
            @Value("${wsi.image-directory:${wsi.slide-path:}}") String configuredPath,
            @Value("${wsi.scan-recursive:true}") boolean recursive,
            @Value("${wsi.discovery.refresh-interval:30s}") Duration refreshInterval,
            @Value("${wsi.discovery.stability-window:10s}") Duration stabilityWindow) throws Exception {
        this(configuredPath, recursive, refreshInterval, stabilityWindow, Clock.systemUTC());
    }

    /**
     * Compatibility constructor for existing callers. Uses documented live-discovery defaults.
     */
    public ImageRegistry(String configuredPath, boolean recursive) throws Exception {
        this(configuredPath, recursive, Duration.ofSeconds(30), Duration.ofSeconds(10), Clock.systemUTC());
    }

    ImageRegistry(String configuredPath, boolean recursive, Duration refreshInterval,
                  Duration stabilityWindow, Clock clock) throws Exception {
        if (configuredPath == null || configuredPath.isBlank())
            throw new IllegalStateException("Set wsi.image-directory to the image root directory.");
        Path configured = Paths.get(configuredPath).toAbsolutePath().normalize();
        if (Files.isSymbolicLink(configured)) throw new IllegalStateException("Image root must not be a symbolic link.");
        rootDirectory = configured.toRealPath();
        if (!Files.isDirectory(rootDirectory, LinkOption.NOFOLLOW_LINKS))
            throw new IllegalStateException("Image directory does not exist.");
        this.recursive = recursive;
        this.refreshInterval = requireNonNegative(refreshInterval, "refresh interval");
        this.stabilityWindow = requireNonNegative(stabilityWindow, "stability window");
        this.clock = clock;
        Map<String, Candidate> initial = scanFilesystem();
        snapshot = new AtomicReference<>(makeSnapshot(initial.values()));
        if (snapshot.get().ordered().isEmpty()) throw new IllegalStateException("No supported image files were found.");
        LOGGER.info("Image discovery completed; added={}, unavailable-or-skipped={}, elapsed-ms={}", initial.size(), 0, 0);
    }

    private static Duration requireNonNegative(Duration value, String name) {
        if (value == null || value.isNegative()) throw new IllegalArgumentException(name + " must not be negative");
        return value;
    }

    public Path getRootDirectory() { return rootDirectory; }
    public List<ImageEntry> getImages() {
        restampPublishedSidecars();
        return snapshot.get().ordered();
    }

    /**
     * Re-read {@code <stem>.metadata.json} for already-published slides so
     * later OCR / ingest tokens appear without a process restart.
     */
    void restampPublishedSidecars() {
        Snapshot previous = snapshot.get();
        if (previous == null || previous.ordered().isEmpty()) return;
        Map<String, ImageEntry> relative = new LinkedHashMap<>(previous.byRelative());
        boolean changed = false;
        for (ImageEntry entry : previous.ordered()) {
            WsiCatalogScanner.SidecarMetadata sidecar = WsiCatalogScanner.read(entry.path());
            if (sidecar.clinicalMarker().equals(entry.clinicalMarker())
                    && sidecar.zPlanes() == entry.zPlanes()
                    && sidecar.depth() == entry.depth()
                    && sidecar.zLayers() == entry.zLayers()) {
                continue;
            }
            relative.put(entry.relativePath(), new ImageEntry(
                    entry.id(),
                    entry.name(),
                    entry.relativePath(),
                    entry.folder(),
                    entry.path(),
                    sidecar.clinicalMarker(),
                    sidecar.zPlanes(),
                    sidecar.depth(),
                    sidecar.zLayers()));
            changed = true;
        }
        if (changed) snapshot.set(makeSnapshotEntries(relative.values()));
    }
    public ImageEntry getFirst() { return snapshot.get().ordered().getFirst(); }
    public ImageEntry getRequired(String imageId) {
        ImageEntry entry = snapshot.get().byId().get(imageId);
        if (entry == null) throw new IllegalArgumentException("Unknown image id");
        return entry;
    }

    /** Requests a throttled asynchronous scan. Existing lookups never wait for it. */
    public boolean requestRefresh(boolean force) {
        Instant now = clock.instant();
        if (!force && now.isBefore(lastStarted.plus(refreshInterval))) return false;
        if (!scanning.compareAndSet(false, true)) return false;
        lastStarted = now;
        status = new RefreshStatus(true, 0, 0, null);
        scanner.execute(() -> {
            try { refreshAlreadyClaimed(); } finally { scanning.set(false); }
        });
        return true;
    }

    /** Visible for deterministic tests and administrative callers; concurrent calls safely skip. */
    boolean refreshNow() {
        if (!scanning.compareAndSet(false, true)) return false;
        lastStarted = clock.instant();
        status = new RefreshStatus(true, 0, 0, null);
        try { refreshAlreadyClaimed(); } finally { scanning.set(false); }
        return true;
    }

    private void refreshAlreadyClaimed() {
        long started = System.nanoTime();
        LOGGER.info("Image discovery refresh started");
        try {
            Map<String, Candidate> found = scanFilesystem();
            Snapshot previous = snapshot.get();
            Map<String, ImageEntry> published = new HashMap<>(previous.byRelative());
            Instant now = clock.instant();
            int added = 0;

            pending.keySet().removeIf(relative -> !found.containsKey(relative));
            for (Candidate candidate : found.values()) {
                if (published.containsKey(candidate.relativePath())) continue;
                Observation old = pending.get(candidate.relativePath());
                if (old != null && old.matches(candidate) && !now.isBefore(old.firstSeen().plus(stabilityWindow))) {
                    published.put(candidate.relativePath(), candidate.entry());
                    pending.remove(candidate.relativePath());
                    added++;
                } else if (old == null || !old.matches(candidate)) {
                    pending.put(candidate.relativePath(), new Observation(candidate.size(), candidate.modified(),
                            candidate.fileKey(), now));
                }
            }
            // Published images are deliberately retained until restart. A transient absence can never
            // remove an image or its annotation association in this release.
            snapshot.set(makeSnapshotEntries(published.values()));
            status = new RefreshStatus(false, added, pending.size(), null);
            LOGGER.info("Image discovery refresh completed; added={}, unavailable-or-skipped={}, elapsed-ms={}",
                    added, pending.size(), elapsedMillis(started));
        } catch (Exception exception) {
            status = new RefreshStatus(false, 0, pending.size(), exception.getClass().getSimpleName());
            LOGGER.warn("Image discovery refresh failed; category={}, elapsed-ms={}",
                    exception.getClass().getSimpleName(), elapsedMillis(started));
        }
    }

    private static long elapsedMillis(long started) { return (System.nanoTime() - started) / 1_000_000; }

    public RefreshStatus getStatus() { return status; }
    public Duration getRefreshInterval() { return refreshInterval; }

    private Map<String, Candidate> scanFilesystem() throws IOException {
        Map<String, Candidate> result = new HashMap<>();
        int maxDepth = recursive ? Integer.MAX_VALUE : 1;
        Files.walkFileTree(rootDirectory, EnumSet.noneOf(FileVisitOption.class), maxDepth,
                new SimpleFileVisitor<>() {
                    @Override public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) throws IOException {
                        if (!dir.equals(rootDirectory) && (attrs.isSymbolicLink() || Files.isSymbolicLink(dir)))
                            return FileVisitResult.SKIP_SUBTREE;
                        Path real = dir.toRealPath(LinkOption.NOFOLLOW_LINKS);
                        return real.startsWith(rootDirectory) ? FileVisitResult.CONTINUE : FileVisitResult.SKIP_SUBTREE;
                    }
                    @Override public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                        try {
                            if (attrs.isSymbolicLink() || !attrs.isRegularFile() || Files.isSymbolicLink(file)
                                    || !hasSupportedSuffix(file)) return FileVisitResult.CONTINUE;
                            Path real = file.toRealPath(LinkOption.NOFOLLOW_LINKS);
                            BasicFileAttributes checked = Files.readAttributes(real, BasicFileAttributes.class,
                                    LinkOption.NOFOLLOW_LINKS);
                            if (!real.startsWith(rootDirectory) || checked.isSymbolicLink() || !checked.isRegularFile())
                                return FileVisitResult.CONTINUE;
                            String relative = normalizeRelative(rootDirectory.relativize(real));
                            ImageEntry entry = entry(relative, real);
                            result.put(relative, new Candidate(relative, entry, checked.size(),
                                    checked.lastModifiedTime().toMillis(), checked.fileKey()));
                        } catch (IOException | SecurityException ignored) { /* count is intentionally path-free */ }
                        return FileVisitResult.CONTINUE;
                    }
                });
        return result;
    }

    private Snapshot makeSnapshot(Collection<Candidate> candidates) {
        return makeSnapshotEntries(candidates.stream().map(Candidate::entry).toList());
    }

    private Snapshot makeSnapshotEntries(Collection<ImageEntry> entries) {
        List<ImageEntry> ordered = new ArrayList<>(entries);
        ordered.sort((a, b) -> compareNatural(a.relativePath(), b.relativePath()));
        Map<String, ImageEntry> ids = new LinkedHashMap<>();
        Map<String, ImageEntry> relative = new LinkedHashMap<>();
        for (ImageEntry entry : ordered) { ids.put(entry.id(), entry); relative.put(entry.relativePath(), entry); }
        return new Snapshot(List.copyOf(ordered), Map.copyOf(ids), Map.copyOf(relative));
    }

    private ImageEntry entry(String relativePath, Path path) {
        String id = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(relativePath.getBytes(StandardCharsets.UTF_8));
        int slash = relativePath.lastIndexOf('/');
        WsiCatalogScanner.SidecarMetadata sidecar = WsiCatalogScanner.read(path);
        return new ImageEntry(
                id,
                slash < 0 ? relativePath : relativePath.substring(slash + 1),
                relativePath,
                slash < 0 ? "" : relativePath.substring(0, slash),
                path,
                sidecar.clinicalMarker(),
                sidecar.zPlanes(),
                sidecar.depth(),
                sidecar.zLayers()
        );
    }

    static int compareNatural(String left, String right) {
        int li = 0, ri = 0;
        while (li < left.length() && ri < right.length()) {
            char lc = left.charAt(li), rc = right.charAt(ri);
            if (Character.isDigit(lc) && Character.isDigit(rc)) {
                int le = li, re = ri;
                while (le < left.length() && Character.isDigit(left.charAt(le))) le++;
                while (re < right.length() && Character.isDigit(right.charAt(re))) re++;
                String ln = left.substring(li, le).replaceFirst("^0+(?!$)", "");
                String rn = right.substring(ri, re).replaceFirst("^0+(?!$)", "");
                if (ln.length() != rn.length()) return Integer.compare(ln.length(), rn.length());
                int c = ln.compareTo(rn); if (c != 0) return c;
                c = Integer.compare(le - li, re - ri); if (c != 0) return c;
                li = le; ri = re; continue;
            }
            int c = Character.compare(Character.toLowerCase(lc), Character.toLowerCase(rc));
            if (c != 0) return c;
            li++; ri++;
        }
        int c = Integer.compare(left.length(), right.length());
        return c != 0 ? c : left.compareTo(right);
    }

    private static String normalizeRelative(Path path) { return path.toString().replace('\\', '/'); }
    private static boolean hasSupportedSuffix(Path path) {
        String name = path.getFileName().toString().toLowerCase(Locale.ROOT);
        return !name.startsWith(".wsi-environment-") && SUPPORTED_SUFFIXES.stream().anyMatch(name::endsWith);
    }

    @PreDestroy void close() { scanner.shutdownNow(); }

    public record ImageEntry(String id, String name, String relativePath, String folder, Path path,
                             String clinicalMarker, int zPlanes, int depth, int zLayers) {
        public ImageEntry {
            clinicalMarker = clinicalMarker == null ? "" : clinicalMarker;
        }
    }
    public record RefreshStatus(boolean running, int added, int unavailableOrPending, String failureCategory) {}
    private record Snapshot(List<ImageEntry> ordered, Map<String, ImageEntry> byId,
                            Map<String, ImageEntry> byRelative) {}
    private record Candidate(String relativePath, ImageEntry entry, long size, long modified, Object fileKey) {}
    private record Observation(long size, long modified, Object fileKey, Instant firstSeen) {
        boolean matches(Candidate candidate) {
            return size == candidate.size() && modified == candidate.modified()
                    && Objects.equals(fileKey, candidate.fileKey());
        }
    }
}
