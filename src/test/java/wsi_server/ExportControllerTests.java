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
    void returnsPngAsDownloadableAttachmentWithDefaultScale() throws Exception {
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
                        "attachment; filename=\"region-1-2-30x40.png\""))
                .andExpect(content().bytes(png));

        verify(service).export(org.mockito.ArgumentMatchers.eq("slide"),
                org.mockito.ArgumentMatchers.eq(1), org.mockito.ArgumentMatchers.eq(2),
                org.mockito.ArgumentMatchers.eq(30), org.mockito.ArgumentMatchers.eq(40),
                org.mockito.ArgumentMatchers.eq(1.0), any());
    }
}
