package wsi_server;

import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class ExportControllerTests {
    @Test
    void returnsPngInlineWithNativeFilename() throws Exception {
        ExportService service = mock(ExportService.class);
        byte[] png = {(byte) 0x89, 0x50, 0x4e, 0x47};
        when(service.export(org.mockito.ArgumentMatchers.eq("slide"),
                org.mockito.ArgumentMatchers.eq(1), org.mockito.ArgumentMatchers.eq(2),
                org.mockito.ArgumentMatchers.eq(30), org.mockito.ArgumentMatchers.eq(40),
                org.mockito.ArgumentMatchers.eq(1.0), any())).thenReturn(png);
        MockMvc mvc = MockMvcBuilders.standaloneSetup(new ExportController(service)).build();

        mvc.perform(get("/export")
                        .param("image", "slide").param("x", "1").param("y", "2")
                        .param("width", "30").param("height", "40"))
                .andExpect(status().isOk())
                .andExpect(content().contentType("image/png"))
                .andExpect(header().string("Content-Disposition",
                        org.hamcrest.Matchers.allOf(
                                org.hamcrest.Matchers.containsString("inline"),
                                org.hamcrest.Matchers.containsString("filename"),
                                org.hamcrest.Matchers.containsString("region-1-2-30x40.png")
                        )))
                .andExpect(content().bytes(png));

        verify(service).export(org.mockito.ArgumentMatchers.eq("slide"),
                org.mockito.ArgumentMatchers.eq(1), org.mockito.ArgumentMatchers.eq(2),
                org.mockito.ArgumentMatchers.eq(30), org.mockito.ArgumentMatchers.eq(40),
                org.mockito.ArgumentMatchers.eq(1.0), any());
    }

    @Test
    void returnsBadRequestProblemForPixelLimitViolation() throws Exception {
        ExportService service = mock(ExportService.class);
        when(service.export(org.mockito.ArgumentMatchers.eq("slide"),
                org.mockito.ArgumentMatchers.anyInt(), org.mockito.ArgumentMatchers.anyInt(),
                org.mockito.ArgumentMatchers.anyInt(), org.mockito.ArgumentMatchers.anyInt(),
                org.mockito.ArgumentMatchers.anyDouble(), any()))
                .thenThrow(new ExportTooLargeException(
                        "Export exceeds the configured maximum of 16000000 pixels."));
        MockMvc mvc = MockMvcBuilders.standaloneSetup(new ExportController(service))
                .setControllerAdvice(new ExportExceptionHandler()).build();

        mvc.perform(get("/export").param("image", "slide")
                        .param("x", "0").param("y", "0")
                        .param("width", "5000").param("height", "5000"))
                .andExpect(status().isBadRequest())
                .andExpect(content().contentType("application/problem+json"))
                .andExpect(content().string(org.hamcrest.Matchers.containsString(
                        "Export exceeds the configured maximum")))
                .andExpect(content().string(org.hamcrest.Matchers.containsString(
                        "\"code\":\"EXPORT_TOO_LARGE\"")))
                .andExpect(content().string(org.hamcrest.Matchers.containsString(
                        "Export region too large")));
    }

    @Test
    void returnsGenericInvalidExportProblemForOtherValidationErrors() throws Exception {
        ExportService service = mock(ExportService.class);
        when(service.export(org.mockito.ArgumentMatchers.eq("slide"),
                org.mockito.ArgumentMatchers.anyInt(), org.mockito.ArgumentMatchers.anyInt(),
                org.mockito.ArgumentMatchers.anyInt(), org.mockito.ArgumentMatchers.anyInt(),
                org.mockito.ArgumentMatchers.anyDouble(), any()))
                .thenThrow(new IllegalArgumentException(
                        "Export region must be contained within the image."));
        MockMvc mvc = MockMvcBuilders.standaloneSetup(new ExportController(service))
                .setControllerAdvice(new ExportExceptionHandler()).build();

        mvc.perform(get("/export").param("image", "slide")
                        .param("x", "0").param("y", "0")
                        .param("width", "30").param("height", "40"))
                .andExpect(status().isBadRequest())
                .andExpect(content().contentType("application/problem+json"))
                .andExpect(content().string(org.hamcrest.Matchers.containsString(
                        "Export region must be contained within the image.")))
                .andExpect(content().string(org.hamcrest.Matchers.containsString(
                        "Invalid export request")))
                .andExpect(content().string(org.hamcrest.Matchers.not(org.hamcrest.Matchers.containsString(
                        "EXPORT_TOO_LARGE"))));
    }
}
