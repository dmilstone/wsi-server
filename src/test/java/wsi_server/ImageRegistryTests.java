package wsi_server;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.*;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.*;

import static org.assertj.core.api.Assertions.assertThat;

class ImageRegistryTests {
    @TempDir Path root;

    @Test void runtimeAdditionWaitsForTwoStableObservationsAndKeepsItsId() throws Exception {
        Path existing = Files.writeString(root.resolve("slide2.tif"), "old");
        MutableClock clock = new MutableClock();
        ImageRegistry registry = registry(true, clock, Duration.ofSeconds(10));
        String id = registry.getImages().getFirst().id();
        Path added = Files.writeString(root.resolve("slide10.tif"), "part");

        registry.refreshNow();
        assertThat(registry.getImages()).hasSize(1);
        clock.advance(Duration.ofSeconds(11));
        Files.writeString(added, "still growing");
        registry.refreshNow();
        assertThat(registry.getImages()).hasSize(1);
        clock.advance(Duration.ofSeconds(11));
        registry.refreshNow();

        assertThat(registry.getImages()).extracting(ImageRegistry.ImageEntry::name)
                .containsExactly("slide2.tif", "slide10.tif");
        assertThat(registry.getRequired(id).path()).isEqualTo(existing.toRealPath());
        registry.close();
    }

    @Test void finishedArchiveWithOldMtimePublishesOnFirstRefresh() throws Exception {
        Files.writeString(root.resolve("already.tif"), "old");
        MutableClock clock = new MutableClock();
        ImageRegistry registry = registry(true, clock, Duration.ofSeconds(10));
        Path added = Files.writeString(root.resolve("ingested.tif"), "done");
        Files.setLastModifiedTime(added, java.nio.file.attribute.FileTime.from(
                clock.instant().minus(Duration.ofMinutes(5))));
        registry.refreshNow();
        assertThat(registry.getImages()).extracting(ImageRegistry.ImageEntry::name)
                .containsExactly("already.tif", "ingested.tif");
        registry.close();
    }

    @Test void disappearingPendingFileIsDiscardedAndPublishedAbsenceIsRetained() throws Exception {
        Files.writeString(root.resolve("published.tif"), "x");
        MutableClock clock = new MutableClock();
        ImageRegistry registry = registry(true, clock, Duration.ZERO);
        Path pending = Files.writeString(root.resolve("pending.tif"), "x");
        registry.refreshNow();
        Files.delete(pending);
        registry.refreshNow();
        assertThat(registry.getImages()).extracting(ImageRegistry.ImageEntry::name).containsExactly("published.tif");
        Files.delete(root.resolve("published.tif"));
        registry.refreshNow();
        assertThat(registry.getImages()).extracting(ImageRegistry.ImageEntry::name).containsExactly("published.tif");
        registry.close();
    }

    @Test void failedRefreshRetainsSnapshotAndDoesNotMutateAnnotationDocuments() throws Exception {
        Path image = Files.writeString(root.resolve("published.tif"), "x");
        Path annotations = Files.writeString(root.resolve("annotations.json"), "do-not-change");
        ImageRegistry registry = new ImageRegistry(root.toString(), true);
        String id = registry.getImages().getFirst().id();
        Files.delete(image);
        Files.delete(annotations);
        Files.delete(root);

        registry.refreshNow();

        assertThat(registry.getImages()).extracting(ImageRegistry.ImageEntry::id).containsExactly(id);
        assertThat(registry.getStatus().failureCategory()).isNotNull();
        // Discovery never invokes annotation storage; an unsupported document present during a
        // successful scan is likewise left byte-for-byte unchanged.
        Files.createDirectory(root);
        Path document = Files.writeString(root.resolve("annotations.json"), "do-not-change");
        registry.refreshNow();
        assertThat(Files.readString(document)).isEqualTo("do-not-change");
        registry.close();
    }

    @Test void nestedDirectoryAppearsOnlyForRecursiveRegistry() throws Exception {
        Files.writeString(root.resolve("base.tif"), "x");
        MutableClock clock = new MutableClock();
        ImageRegistry recursive = registry(true, clock, Duration.ZERO);
        ImageRegistry flat = registry(false, clock, Duration.ZERO);
        Path nested = Files.createDirectories(root.resolve("new/folder"));
        Files.writeString(nested.resolve("image.vsi"), "x");
        recursive.refreshNow(); recursive.refreshNow();
        flat.refreshNow(); flat.refreshNow();
        assertThat(recursive.getImages()).extracting(ImageRegistry.ImageEntry::relativePath)
                .contains("new/folder/image.vsi");
        assertThat(flat.getImages()).hasSize(1);
        recursive.close(); flat.close();
    }

    @Test void rejectsMarkersUnsupportedFilesAndSymbolicLinks() throws Exception {
        Files.writeString(root.resolve("slide.tif"), "x");
        Files.writeString(root.resolve(".wsi-environment-production.tif"), "x");
        Files.writeString(root.resolve("notes.txt"), "x");
        Path outside = Files.createTempFile("outside-wsi-", ".tif");
        try {
            Files.createSymbolicLink(root.resolve("escape.tif"), outside);
            Path outsideDir = Files.createTempDirectory("outside-wsi-dir-");
            Files.writeString(outsideDir.resolve("nested.tif"), "x");
            Files.createSymbolicLink(root.resolve("linked-dir"), outsideDir);
        } catch (UnsupportedOperationException ignored) { }
        ImageRegistry registry = new ImageRegistry(root.toString(), true);
        assertThat(registry.getImages()).extracting(ImageRegistry.ImageEntry::name).containsExactly("slide.tif");
        registry.close();
    }

    @Test void readersObserveOnlyCompleteNaturallyOrderedSnapshots() throws Exception {
        Files.writeString(root.resolve("image1.tif"), "x");
        MutableClock clock = new MutableClock();
        ImageRegistry registry = registry(true, clock, Duration.ZERO);
        for (int i = 2; i <= 20; i++) Files.writeString(root.resolve("image" + i + ".tif"), "x");
        registry.refreshNow();
        ExecutorService readers = Executors.newFixedThreadPool(4);
        List<Future<List<Integer>>> futures = new ArrayList<>();
        for (int i = 0; i < 100; i++) futures.add(readers.submit(() -> registry.getImages().stream()
                .map(entry -> Integer.parseInt(entry.name().replaceAll("\\D", ""))).toList()));
        registry.refreshNow();
        for (Future<List<Integer>> future : futures) {
            List<Integer> seen = future.get();
            assertThat(seen.size()).isIn(1, 20);
            assertThat(seen).isSorted();
        }
        readers.shutdownNow(); registry.close();
    }

    @Test void concurrentRefreshRequestsDoNotOverlap() throws Exception {
        Files.writeString(root.resolve("slide.tif"), "x");
        ImageRegistry registry = new ImageRegistry(root.toString(), true);
        ExecutorService callers = Executors.newFixedThreadPool(8);
        long accepted = callers.invokeAll(java.util.Collections.nCopies(40,
                        (Callable<Boolean>) registry::refreshNow)).stream()
                .map(future -> { try { return future.get(); } catch (Exception e) { return false; } })
                .filter(Boolean::booleanValue).count();
        assertThat(accepted).isLessThan(40);
        callers.shutdownNow(); registry.close();
    }

    @Test void companionMetadataClinicalMarkerAndZLayersArePublishedOnCatalogEntries() throws Exception {
        Path nested = Files.createDirectories(root.resolve("case_z"));
        Files.writeString(nested.resolve("labeled.tif"), "slide");
        Files.writeString(nested.resolve("labeled.metadata.json"), """
                {"clinicalMarker":"if.IgA","zPlanes":6,"depth":2,"zLayers":3,"ocrStatus":"ok","version":1}
                """);
        ImageRegistry registry = registry(true, new MutableClock(), Duration.ofSeconds(10));
        assertThat(registry.getImages()).hasSize(1);
        ImageRegistry.ImageEntry entry = registry.getImages().getFirst();
        assertThat(entry.clinicalMarker()).isEqualTo("if.IgA");
        assertThat(entry.zPlanes()).isEqualTo(6);
        assertThat(entry.depth()).isEqualTo(2);
        assertThat(entry.zLayers()).isEqualTo(3);
        assertThat(entry.folder()).isEqualTo("case_z");
        registry.close();
    }

    @Test void publishedSidecarsAreRestampedOnCatalogReadWithoutRestart() throws Exception {
        Files.writeString(root.resolve("slide.tif"), "x");
        ImageRegistry registry = registry(true, new MutableClock(), Duration.ofSeconds(10));
        assertThat(registry.getImages().getFirst().clinicalMarker()).isEmpty();

        Files.writeString(root.resolve("slide.metadata.json"), """
                {"clinicalMarker":"if.IgG","zPlanes":4}
                """);
        assertThat(registry.getImages().getFirst().clinicalMarker()).isEqualTo("if.IgG");
        assertThat(registry.getImages().getFirst().zPlanes()).isEqualTo(4);
        registry.close();
    }

    private ImageRegistry registry(boolean recursive, MutableClock clock, Duration stability) throws Exception {
        return new ImageRegistry(root.toString(), recursive, Duration.ZERO, stability, clock);
    }

    private static final class MutableClock extends Clock {
        private Instant now = Instant.parse("2026-01-01T00:00:00Z");
        void advance(Duration duration) { now = now.plus(duration); }
        public ZoneId getZone() { return ZoneOffset.UTC; }
        public Clock withZone(ZoneId zone) { return this; }
        public Instant instant() { return now; }
    }
}
