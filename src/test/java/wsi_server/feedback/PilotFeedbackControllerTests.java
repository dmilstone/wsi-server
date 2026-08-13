package wsi_server.feedback;

import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class PilotFeedbackControllerTests {
    @Test
    void submitReturnsCreatedPayload() throws Exception {
        PilotFeedbackService service = mock(PilotFeedbackService.class);
        when(service.submit(any(), any())).thenReturn(new PilotFeedbackSubmitResponse(
                "abc", Instant.parse("2026-08-09T12:00:00Z"), "Pilot feedback submitted. Thank you."
        ));
        MockMvc mvc = standalone(service);

        mvc.perform(post("/api/pilot-feedback")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {
                                  "taskCompletion": {},
                                  "ratings": {}
                                }
                                """))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.responseId").value("abc"))
                .andExpect(jsonPath("$.message").value("Pilot feedback submitted. Thank you."));
    }

    @Test
    void summaryEndpointReturnsViewMode() throws Exception {
        PilotFeedbackService service = mock(PilotFeedbackService.class);
        when(service.summarize("deduplicated")).thenReturn(new PilotFeedbackSummaryResponse(
                "deduplicated", 1, 1, 1, 1, 0, "2026-08-09T12:00:00Z",
                List.of(), Map.of(), List.of(), List.of()
        ));
        MockMvc mvc = standalone(service);

        mvc.perform(get("/api/pilot-feedback/summary").param("view", "deduplicated"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.viewMode").value("deduplicated"))
                .andExpect(jsonPath("$.totalSubmissions").value(1));
    }

    @Test
    void exportCsvReturnsAttachment() throws Exception {
        PilotFeedbackService service = mock(PilotFeedbackService.class);
        when(service.exportCsv(false)).thenReturn("responseId,authenticatedUserId\n");
        MockMvc mvc = standalone(service);

        mvc.perform(get("/api/pilot-feedback/export.csv"))
                .andExpect(status().isOk())
                .andExpect(content().string("responseId,authenticatedUserId\n"));
        verify(service).exportCsv(false);
    }

    private static MockMvc standalone(PilotFeedbackService service) {
        SecurityContextHolder.getContext().setAuthentication(
                new UsernamePasswordAuthenticationToken("viewer", "n/a")
        );
        return MockMvcBuilders.standaloneSetup(new PilotFeedbackController(service))
                .setControllerAdvice(new PilotFeedbackExceptionHandler())
                .build();
    }
}
