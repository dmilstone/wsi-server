package wsi_server;

import loci.formats.IFormatReader;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.Future;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;

class BioFormatsReaderPoolTests {

    @Test
    void clampsPoolSizeToTwoThroughFour() {
        BioFormatsReaderPool.Factory factory = path -> mock(IFormatReader.class);
        assertEquals(2, new BioFormatsReaderPool(0, factory).maxPerSlide());
        assertEquals(2, new BioFormatsReaderPool(1, factory).maxPerSlide());
        assertEquals(3, new BioFormatsReaderPool(3, factory).maxPerSlide());
        assertEquals(4, new BioFormatsReaderPool(4, factory).maxPerSlide());
        assertEquals(4, new BioFormatsReaderPool(9, factory).maxPerSlide());
    }

    @Test
    void concurrentBorrowsOnTheSameSlideAreDistinctReaders() throws Exception {
        AtomicInteger opened = new AtomicInteger();
        BioFormatsReaderPool pool = new BioFormatsReaderPool(4, path -> {
            opened.incrementAndGet();
            return mock(IFormatReader.class);
        });
        Path slide = Path.of("/tmp/concurrent-slide.vsi");
        CountDownLatch bothHeld = new CountDownLatch(2);
        CountDownLatch release = new CountDownLatch(1);
        AtomicReference<IFormatReader> first = new AtomicReference<>();
        AtomicReference<IFormatReader> second = new AtomicReference<>();
        try (var executor = Executors.newFixedThreadPool(2)) {
            Callable<Void> task = () -> {
                try (BioFormatsReaderPool.Lease lease = pool.acquire(slide)) {
                    IFormatReader reader = lease.reader();
                    if (!first.compareAndSet(null, reader)) {
                        second.set(reader);
                    }
                    bothHeld.countDown();
                    assertTrue(release.await(5, TimeUnit.SECONDS));
                }
                return null;
            };
            var left = executor.submit(task);
            var right = executor.submit(task);
            assertTrue(bothHeld.await(5, TimeUnit.SECONDS));
            assertNotSame(first.get(), second.get());
            assertEquals(2, opened.get());
            release.countDown();
            left.get(5, TimeUnit.SECONDS);
            right.get(5, TimeUnit.SECONDS);
        } finally {
            pool.close();
        }
    }

    @Test
    void concurrentFirstAcquiresOnANeverOpenedSlideNeverOpenSimultaneously() throws Exception {
        // A brand-new viewport's first paint can fire several tile requests
        // for the same never-yet-opened slide at once. Each of those must
        // still eventually get its own reader (pool grows to `max`), but the
        // expensive open() itself (Bio-Formats' setId(), the one slow step
        // for a large multi-resolution slide) must never run concurrently
        // with another open() for that same slide -- see the comment on
        // SlidePool.openLock for why.
        AtomicInteger concurrentOpens = new AtomicInteger();
        AtomicInteger maxConcurrentOpens = new AtomicInteger();
        AtomicInteger opened = new AtomicInteger();
        BioFormatsReaderPool pool = new BioFormatsReaderPool(4, path -> {
            int now = concurrentOpens.incrementAndGet();
            maxConcurrentOpens.getAndUpdate(prev -> Math.max(prev, now));
            try {
                Thread.sleep(50); // stand in for Bio-Formats' expensive setId()
            } finally {
                concurrentOpens.decrementAndGet();
            }
            opened.incrementAndGet();
            return mock(IFormatReader.class);
        });
        Path slide = Path.of("/tmp/stampede-slide.svs");
        int concurrentRequests = 4;
        try (var executor = Executors.newFixedThreadPool(concurrentRequests)) {
            CountDownLatch allHeld = new CountDownLatch(concurrentRequests);
            CountDownLatch release = new CountDownLatch(1);
            List<Future<Void>> futures = new ArrayList<>();
            for (int i = 0; i < concurrentRequests; i++) {
                futures.add(executor.submit(() -> {
                    try (BioFormatsReaderPool.Lease lease = pool.acquire(slide)) {
                        allHeld.countDown();
                        assertTrue(release.await(5, TimeUnit.SECONDS));
                    }
                    return null;
                }));
            }
            assertTrue(allHeld.await(5, TimeUnit.SECONDS));
            assertEquals(concurrentRequests, opened.get());
            assertEquals(1, maxConcurrentOpens.get());
            release.countDown();
            for (var future : futures) future.get(5, TimeUnit.SECONDS);
        } finally {
            pool.close();
        }
    }

    @Test
    void releasedReaderIsReusedForTheSameSlide() throws Exception {
        AtomicInteger opened = new AtomicInteger();
        BioFormatsReaderPool pool = new BioFormatsReaderPool(2, path -> {
            opened.incrementAndGet();
            return mock(IFormatReader.class);
        });
        Path slide = Path.of("/tmp/reuse-slide.vsi");
        try {
            IFormatReader first;
            try (BioFormatsReaderPool.Lease lease = pool.acquire(slide)) {
                first = lease.reader();
            }
            try (BioFormatsReaderPool.Lease lease = pool.acquire(slide)) {
                assertSame(first, lease.reader());
            }
            assertEquals(1, opened.get());
        } finally {
            pool.close();
        }
    }
}
