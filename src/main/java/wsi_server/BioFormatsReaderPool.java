package wsi_server;

import loci.formats.IFormatReader;
import loci.formats.ImageReader;
import loci.formats.MetadataTools;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Per-slide Bio-Formats reader pool. Each file path owns 2–4 exclusive readers so
 * concurrent tile requests do not share one synchronized {@link IFormatReader}.
 */
@Component
final class BioFormatsReaderPool implements AutoCloseable {
    private static final Logger LOGGER = LoggerFactory.getLogger(BioFormatsReaderPool.class);
    private static final int MIN_SIZE = 2;
    private static final int MAX_SIZE = 4;
    private static final long BORROW_TIMEOUT_MS = 30_000;

    @FunctionalInterface
    interface Factory {
        IFormatReader open(Path path) throws Exception;
    }

    private final int maxPerSlide;
    private final Factory factory;
    private final ConcurrentHashMap<String, SlidePool> pools = new ConcurrentHashMap<>();

    @Autowired
    BioFormatsReaderPool(@Value("${wsi.reader-pool.size:4}") int size) {
        this(size, BioFormatsReaderPool::openDefault);
    }

    BioFormatsReaderPool(int size, Factory factory) {
        this.maxPerSlide = Math.max(MIN_SIZE, Math.min(MAX_SIZE, size));
        this.factory = factory;
    }

    int maxPerSlide() {
        return maxPerSlide;
    }

    Lease acquire(Path path) throws Exception {
        if (path == null) throw new IllegalArgumentException("Slide path is required.");
        String key = path.toAbsolutePath().normalize().toString();
        SlidePool pool = pools.computeIfAbsent(key, ignored -> new SlidePool(key, maxPerSlide, factory));
        return pool.acquire();
    }

    @Override
    public void close() {
        for (SlidePool pool : pools.values()) {
            pool.close();
        }
        pools.clear();
    }

    static IFormatReader openDefault(Path path) throws Exception {
        if (OpenSlideFormatReader.handles(path) && OpenSlideNative.isAvailable()) {
            try {
                return openConfigured(new OpenSlideFormatReader(), path);
            } catch (Exception openslideFailed) {
                LOGGER.warn("OpenSlide failed for {}; falling back to Bio-Formats", path, openslideFailed);
            }
        }
        return openConfigured(new ImageReader(), path);
    }

    private static IFormatReader openConfigured(IFormatReader reader, Path path) throws Exception {
        boolean opened = false;
        try {
            reader.setMetadataStore(MetadataTools.createOMEXMLMetadata());
            reader.setFlattenedResolutions(false);
            reader.setId(path.toString());
            opened = true;
            return reader;
        } finally {
            if (!opened) {
                try {
                    reader.close();
                } catch (Exception ignored) {
                    // Construction failed; the reader did not open.
                }
            }
        }
    }

    static final class Lease implements AutoCloseable {
        private final SlidePool pool;
        private final IFormatReader reader;
        private boolean closed;

        Lease(SlidePool pool, IFormatReader reader) {
            this.pool = pool;
            this.reader = reader;
        }

        IFormatReader reader() {
            return reader;
        }

        @Override
        public void close() {
            if (closed) return;
            closed = true;
            pool.release(reader);
        }
    }

    static final class SlidePool {
        private final String path;
        private final int max;
        private final Factory factory;
        private final AtomicInteger created = new AtomicInteger();
        private final ArrayBlockingQueue<IFormatReader> idle;
        // Bio-Formats' setId() on a large, many-resolution slide (a multi-GB
        // BigTIFF .svs/.ndpi routinely walks dozens of pyramid/associated-image
        // IFDs) is the one genuinely expensive step in opening a reader --
        // everything after that first successful open is comparatively fast
        // region decoding. A brand-new viewport's first paint typically fires
        // several tile requests for the same never-yet-opened slide at once;
        // without this lock they would each independently race to open their
        // own reader, so up to `max` full metadata parses of the same huge
        // file would run concurrently and fight each other for the same disk
        // pages/CPU, making that first paint slower than a single open alone
        // would be. Serializing only the open (not the whole acquire/lease
        // lifecycle) means the first waiter's open finishes as fast as
        // possible, and each subsequent one starts immediately after --
        // still growing the pool up to `max`, just never in a simultaneous
        // stampede against a slide that has no idle reader yet.
        private final ReentrantLock openLock = new ReentrantLock();
        private volatile boolean closed;

        SlidePool(String path, int max, Factory factory) {
            this.path = path;
            this.max = max;
            this.factory = factory;
            this.idle = new ArrayBlockingQueue<>(max);
        }

        Lease acquire() throws Exception {
            if (closed) throw new IllegalStateException("Reader pool is closed.");
            IFormatReader existing = idle.poll();
            if (existing != null) return new Lease(this, existing);
            while (true) {
                if (closed) throw new IllegalStateException("Reader pool is closed.");
                if (created.get() < max) {
                    openLock.lock();
                    try {
                        existing = idle.poll();
                        if (existing != null) return new Lease(this, existing);
                        int n = created.get();
                        if (n < max && created.compareAndSet(n, n + 1)) {
                            try {
                                return new Lease(this, factory.open(Path.of(path)));
                            } catch (Exception exception) {
                                created.decrementAndGet();
                                throw exception;
                            }
                        }
                    } finally {
                        openLock.unlock();
                    }
                    continue;
                }
                try {
                    IFormatReader waited = idle.poll(BORROW_TIMEOUT_MS, TimeUnit.MILLISECONDS);
                    if (waited != null) return new Lease(this, waited);
                    throw new IllegalStateException("Timed out waiting for a Bio-Formats reader.");
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException("Interrupted waiting for a Bio-Formats reader.", interrupted);
                }
            }
        }

        void release(IFormatReader reader) {
            if (reader == null) return;
            if (closed || !idle.offer(reader)) {
                created.decrementAndGet();
                try {
                    reader.close();
                } catch (Exception ignored) {
                    // Best-effort close of an overflow / shutdown reader.
                }
            }
        }

        void close() {
            closed = true;
            List<IFormatReader> leftover = new ArrayList<>();
            idle.drainTo(leftover);
            for (IFormatReader reader : leftover) {
                try {
                    reader.close();
                } catch (Exception ignored) {
                    // Best-effort pool teardown.
                }
            }
            created.set(0);
        }
    }
}
