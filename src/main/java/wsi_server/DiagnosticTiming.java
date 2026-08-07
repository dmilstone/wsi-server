package wsi_server;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/** Privacy-safe, opt-in stage timings for metadata and associated-image diagnosis. */
public final class DiagnosticTiming {
    private static final Logger LOGGER = LoggerFactory.getLogger("wsi.performance");
    private final boolean enabled;
    private final Sink sink;
    private final Set<String> processStagesSeen = ConcurrentHashMap.newKeySet();
    private final Set<String> imagesSeen = ConcurrentHashMap.newKeySet();
    private final ConcurrentHashMap<String, AtomicInteger> inFlight = new ConcurrentHashMap<>();

    public DiagnosticTiming(boolean enabled) {
        this(enabled, event -> LOGGER.info(
                "wsi_timing category={} stage={} state={} image={} elapsed_ms={} outcome={} failure={} overlapping_first={}",
                event.category(), event.stage(), event.state(), event.opaqueImageId(), event.elapsedMillis(),
                event.outcome(), event.failureCategory(), event.overlappingFirst()));
    }

    DiagnosticTiming(boolean enabled, Sink sink) {
        this.enabled = enabled;
        this.sink = sink;
    }

    public <T> T measure(String category, String stage, String imageId, CheckedSupplier<T> operation)
            throws Exception {
        if (!enabled) return operation.get();
        String opaque = opaqueId(imageId);
        String stageKey = category + ":" + stage;
        String imageStageKey = opaque + ":" + stageKey;
        boolean processCold = processStagesSeen.add(stageKey);
        boolean imageCold = imagesSeen.add(imageStageKey);
        AtomicInteger active = inFlight.computeIfAbsent(imageStageKey, ignored -> new AtomicInteger());
        int previousActive = active.getAndIncrement();
        boolean overlap = previousActive > 0;
        String state = overlap ? "concurrent_first" : processCold ? "process_cold"
                : imageCold ? "image_cold" : "image_warm";
        long started = System.nanoTime();
        try {
            T value = operation.get();
            emit(category, stage, state, opaque, started, "success", "none", overlap);
            return value;
        } catch (Exception exception) {
            emit(category, stage, state, opaque, started, "failure",
                    exception.getClass().getSimpleName(), overlap);
            throw exception;
        } finally {
            if (active.decrementAndGet() == 0) inFlight.remove(imageStageKey, active);
        }
    }

    public void measure(String category, String stage, String imageId, CheckedRunnable operation)
            throws Exception {
        measure(category, stage, imageId, () -> { operation.run(); return null; });
    }

    private void emit(String category, String stage, String state, String opaque, long started,
                      String outcome, String failure, boolean overlap) {
        sink.accept(new Event(category, stage, state, opaque,
                (System.nanoTime() - started) / 1_000_000.0, outcome, failure, overlap));
    }

    static String opaqueId(String imageId) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(imageId.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest, 0, 6);
        } catch (Exception impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    record Event(String category, String stage, String state, String opaqueImageId,
                 double elapsedMillis, String outcome, String failureCategory,
                 boolean overlappingFirst) { }
    interface Sink { void accept(Event event); }
    @FunctionalInterface public interface CheckedSupplier<T> { T get() throws Exception; }
    @FunctionalInterface public interface CheckedRunnable { void run() throws Exception; }
}
