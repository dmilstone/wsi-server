package wsi_server.annotation;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.json.JsonMapper;
import wsi_server.ImageRegistry;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

class AnnotationNameTests {
    @TempDir Path temporaryDirectory;

    @Test
    void oldUnnamedDocumentLoadsWithoutInventingAStoredName() throws Exception {
        Fixture fixture = fixture();
        Path file = fixture.storage.fileFor("user", fixture.registry.getFirst());
        Files.createDirectories(file.getParent());
        Files.writeString(file, documentJson(""));

        Annotation loaded = fixture.service.load(fixture.registry.getFirst().id(), "user").annotations().getFirst();
        assertNull(loaded.name());
    }

    @Test
    void namesRoundTripWithTrimmingUnicodeAndAllOtherMetadataPreserved() throws Exception {
        Fixture fixture = fixture();
        Annotation original = annotation("  Région 🧬, #2!  ");
        AnnotationCollection saved = fixture.service.save(fixture.registry.getFirst().id(), "user", collection(original));
        Annotation roundTrip = fixture.service.load(fixture.registry.getFirst().id(), "user").annotations().getFirst();

        assertEquals("Région 🧬, #2!", roundTrip.name());
        assertEquals(saved.annotations().getFirst(), roundTrip);
        assertEquals(original.id(), roundTrip.id());
        assertEquals(original.type(), roundTrip.type());
        assertEquals(original.visible(), roundTrip.visible());
        assertEquals(original.locked(), roundTrip.locked());
        assertEquals(original.bodies(), roundTrip.bodies());
        assertEquals(original.createdAt(), roundTrip.createdAt());
        assertEquals(original.x(), roundTrip.x());
    }

    @Test
    void blankClearsNameAndLimitCountsUnicodeCodePoints() throws Exception {
        Fixture fixture = fixture();
        String twoHundredEmoji = "🧬".repeat(200);
        Annotation accepted = fixture.service.save(fixture.registry.getFirst().id(), "user",
                collection(annotation(twoHundredEmoji))).annotations().getFirst();
        assertEquals(200, accepted.name().codePointCount(0, accepted.name().length()));
        assertNull(fixture.service.save(fixture.registry.getFirst().id(), "user",
                collection(annotation("   "))).annotations().getFirst().name());
        assertThrows(IllegalArgumentException.class, () -> fixture.service.save(
                fixture.registry.getFirst().id(), "user", collection(annotation("a".repeat(201)))));
    }

    private Fixture fixture() throws Exception {
        Path images = temporaryDirectory.resolve("images");
        Files.createDirectories(images);
        Files.writeString(images.resolve("sample.svs"), "test");
        ImageRegistry registry = new ImageRegistry(images.toString(), true);
        AnnotationStorage storage = new AnnotationStorage(
                temporaryDirectory.resolve("annotations").toString(), JsonMapper.builder().findAndAddModules().build());
        return new Fixture(registry, storage, new AnnotationService(registry, storage));
    }

    private static Annotation annotation(String name) {
        return new Annotation("00000000-0000-4000-8000-000000000001", AnnotationShape.RECTANGLE, name,
                true, true, "#123456", 3, 10, 20, 30, 40, 0,
                Instant.parse("2026-01-02T03:04:05Z"), Instant.parse("2026-01-03T03:04:05Z"),
                List.of(Map.of("purpose", "commenting", "value", "body stays")),
                List.of());
    }

    private static AnnotationCollection collection(Annotation annotation) {
        return new AnnotationCollection(1, "ignored", "ignored", "ignored",
                Instant.parse("2026-01-04T03:04:05Z"), List.of(annotation));
    }

    private static String documentJson(String nameProperty) {
        String name = nameProperty.isEmpty() ? "" : ",\"name\":\"" + nameProperty + "\"";
        return """
                {"version":1,"imageId":"old","slidePath":"sample.svs","userId":"user",
                 "modifiedAt":"2026-01-04T03:04:05Z","annotations":[{
                 "id":"00000000-0000-4000-8000-000000000001","type":"rectangle"%s,
                 "visible":true,"locked":true,"color":"#123456","lineWidth":3,
                 "x":10,"y":20,"width":30,"height":40,"rotation":0,
                 "createdAt":"2026-01-02T03:04:05Z","modifiedAt":"2026-01-03T03:04:05Z",
                 "bodies":[{"purpose":"commenting","value":"body stays"}]}]}
                """.formatted(name);
    }

    private record Fixture(ImageRegistry registry, AnnotationStorage storage, AnnotationService service) {}
}
