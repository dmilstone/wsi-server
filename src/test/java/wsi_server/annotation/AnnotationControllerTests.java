package wsi_server.annotation;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import tools.jackson.databind.json.JsonMapper;
import wsi_server.ImageRegistry;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class AnnotationControllerTests {
    @TempDir Path temporaryDirectory;

    @Test
    void saveWithWorkstationHeaderWritesToMatchingUserFolder() throws Exception {
        Path images = temporaryDirectory.resolve("images");
        Files.createDirectories(images);
        Files.writeString(images.resolve("sample.svs"), "test");
        ImageRegistry registry = new ImageRegistry(images.toString(), true);
        Path annotationsRoot = temporaryDirectory.resolve("annotations");
        AnnotationStorage storage = new AnnotationStorage(
                annotationsRoot.toString(), JsonMapper.builder().findAndAddModules().build());
        AnnotationService service = new AnnotationService(registry, storage);
        AnnotationUserResolver resolver = new AnnotationUserResolver("local");
        MockMvc mvc = MockMvcBuilders
                .standaloneSetup(new AnnotationController(service, resolver))
                .setControllerAdvice(new AnnotationExceptionHandler())
                .build();

        String workstationId = "wsworkstationa1b2c3d4e5f6";
        String imageId = registry.getFirst().id();
        String body = """
                {
                  "version": 1,
                  "imageId": "%s",
                  "slidePath": "sample.svs",
                  "userId": "ignored",
                  "modifiedAt": "2026-01-04T03:04:05Z",
                  "annotations": []
                }
                """.formatted(imageId);

        mvc.perform(put("/api/images/{imageId}/annotations", imageId)
                        .header(AnnotationUserResolver.USER_HEADER, workstationId)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.userId").value(workstationId));

        Path workstationDirectory = annotationsRoot.resolve(workstationId);
        assertTrue(Files.isDirectory(workstationDirectory), "expected workstation folder " + workstationDirectory);
        assertTrue(Files.list(workstationDirectory).findAny().isPresent(), "expected annotation json under workstation");
    }

    @Test
    void loadUsesWorkstationCookieWhenHeaderMissing() throws Exception {
        Path images = temporaryDirectory.resolve("images");
        Files.createDirectories(images);
        Files.writeString(images.resolve("sample.svs"), "test");
        ImageRegistry registry = new ImageRegistry(images.toString(), true);
        AnnotationStorage storage = new AnnotationStorage(
                temporaryDirectory.resolve("annotations").toString(),
                JsonMapper.builder().findAndAddModules().build());
        AnnotationService service = new AnnotationService(registry, storage);
        MockMvc mvc = MockMvcBuilders
                .standaloneSetup(new AnnotationController(service, new AnnotationUserResolver("local")))
                .setControllerAdvice(new AnnotationExceptionHandler())
                .build();

        String workstationId = "wscookieonly999";
        String imageId = registry.getFirst().id();

        mvc.perform(get("/api/images/{imageId}/annotations", imageId)
                        .cookie(new jakarta.servlet.http.Cookie(
                                AnnotationUserResolver.USER_COOKIE, workstationId)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.userId").value(workstationId));
    }
}
