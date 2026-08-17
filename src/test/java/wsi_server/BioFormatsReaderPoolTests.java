package wsi_server;

import loci.formats.IFormatReader;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.concurrent.Callable;
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
