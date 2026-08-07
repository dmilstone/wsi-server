package wsi_server;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;

import static org.junit.jupiter.api.Assertions.*;

class DiagnosticTimingTests {
    @Test
    void distinguishesProcessImageWarmAndDifferentImageWithControlledDelay() throws Exception {
        List<DiagnosticTiming.Event> events = new CopyOnWriteArrayList<>();
        DiagnosticTiming timing = new DiagnosticTiming(true, events::add);

        assertEquals("result", timing.measure("metadata", "fake_set_id", "private/name.vsi", () -> {
            Thread.sleep(12); return "result";
        }));
        timing.measureVoid("metadata", "fake_set_id", "private/name.vsi", () -> Thread.sleep(2));
        timing.measureVoid("metadata", "fake_set_id", "other-patient.ndpi", () -> Thread.sleep(2));

        assertEquals(List.of("process_cold", "image_warm", "image_cold"),
                events.stream().map(DiagnosticTiming.Event::state).toList());
        assertTrue(events.getFirst().elapsedMillis() >= 8, "controlled fake delay must be observable");
        assertTrue(events.stream().noneMatch(event -> event.toString().contains("private/name")
                || event.toString().contains("other-patient")));
        assertEquals(3, events.size(), "each fake stage is attributed exactly once");
    }

    @Test
    void concurrentFirstWorkIsVisibleRatherThanCoalesced() throws Exception {
        List<DiagnosticTiming.Event> events = new CopyOnWriteArrayList<>();
        DiagnosticTiming timing = new DiagnosticTiming(true, events::add);
        CountDownLatch entered = new CountDownLatch(2);
        CountDownLatch release = new CountDownLatch(1);
        try (var executor = Executors.newFixedThreadPool(2)) {
            var task = (java.util.concurrent.Callable<Void>) () -> {
                timing.measureVoid("embedded_label", "fake_open_bytes", "secret-slide", () -> {
                    entered.countDown();
                    release.await();
                });
                return null;
            };
            var first = executor.submit(task);
            var second = executor.submit(task);
            assertTrue(entered.await(2, java.util.concurrent.TimeUnit.SECONDS));
            release.countDown();
            first.get(); second.get();
        }
        assertEquals(2, events.size());
        assertEquals(1, events.stream().filter(DiagnosticTiming.Event::overlappingFirst).count());
        assertTrue(events.stream().anyMatch(event -> event.state().equals("concurrent_first")));
    }

    @Test
    void failuresKeepSafeCategoryAndDisabledTimingIsTransparent() throws Exception {
        List<DiagnosticTiming.Event> events = new CopyOnWriteArrayList<>();
        DiagnosticTiming timing = new DiagnosticTiming(true, events::add);
        IllegalArgumentException failure = assertThrows(IllegalArgumentException.class,
                () -> timing.measure("embedded_macro", "fake_decode", "patient-123.vsi",
                        () -> { throw new IllegalArgumentException("path=/clinical/patient-123.vsi"); }));
        assertTrue(failure.getMessage().contains("patient-123"), "instrumentation must preserve failure behavior");
        assertEquals("failure", events.getFirst().outcome());
        assertEquals("IllegalArgumentException", events.getFirst().failureCategory());
        assertFalse(events.getFirst().toString().contains("patient-123"));

        List<DiagnosticTiming.Event> disabledEvents = new CopyOnWriteArrayList<>();
        DiagnosticTiming disabled = new DiagnosticTiming(false, disabledEvents::add);
        assertArrayEquals(new byte[]{1, 2, 3},
                disabled.measure("metadata", "fake", "secret", () -> new byte[]{1, 2, 3}));
        assertTrue(disabledEvents.isEmpty());
    }
}
