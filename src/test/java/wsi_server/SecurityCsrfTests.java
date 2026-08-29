package wsi_server;

import com.jayway.jsonpath.JsonPath;
import jakarta.servlet.http.Cookie;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MvcResult;
import wsi_server.api.DisplayResponse;

import java.util.List;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.user;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest
@AutoConfigureMockMvc
class SecurityCsrfTests {

    @DynamicPropertySource
    static void imageRoot(DynamicPropertyRegistry properties) {
        properties.add("wsi.image-directory", () -> TestImageRoot.ROOT.toString());
    }

    @Autowired
    private MockMvc mockMvc;

    @MockitoBean
    private BioFormatsTileService imageService;

    @Test
    void stateChangingRequestWithoutCsrfTokenIsRejected() throws Exception {
        mockMvc.perform(displayUpdate().with(user("viewer").roles("VIEWER")))
                .andExpect(status().isForbidden());
    }

    @Test
    void stateChangingRequestWithCsrfTokenSucceedsForAuthenticatedUser() throws Exception {
        when(imageService.updateDisplay(eq("sample"), anyInt(), any(), any()))
                .thenReturn(new DisplayResponse(1, List.of()));
        AcquiredCsrf csrf = acquireCsrfToken();

        mockMvc.perform(displayUpdate()
                        .with(user("viewer").roles("VIEWER"))
                        .cookie(csrf.cookie())
                        .header(csrf.headerName(), csrf.cookie().getValue()))
                .andExpect(status().isOk());
    }

    @Test
    void anonymousStateChangingAccessRemainsProtected() throws Exception {
        mockMvc.perform(displayUpdate())
                .andExpect(status().isForbidden());
    }

    @Test
    void csrfEndpointRequiresAuthentication() throws Exception {
        mockMvc.perform(get("/csrf"))
                .andExpect(status().is3xxRedirection());
    }

    @Test
    void authenticatedUserCanAcquireCsrfToken() throws Exception {
        mockMvc.perform(get("/csrf").with(user("viewer").roles("VIEWER")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.token").isNotEmpty())
                .andExpect(jsonPath("$.headerName").isNotEmpty())
                .andExpect(jsonPath("$.parameterName").isNotEmpty());
    }

    @Test
    void loopbackIngestRefreshDoesNotNeedSessionOrCsrf() throws Exception {
        mockMvc.perform(post("/api/images/refresh")
                        .with(request -> {
                            request.setRemoteAddr("127.0.0.1");
                            return request;
                        }))
                .andExpect(status().isOk());
    }

    @Test
    void remoteIngestRefreshWithoutAuthIsRejected() throws Exception {
        mockMvc.perform(post("/api/images/refresh")
                        .with(request -> {
                            request.setRemoteAddr("198.51.100.10");
                            return request;
                        }))
                .andExpect(status().isForbidden());
    }

    @Test
    void environmentEndpointRequiresAuthentication() throws Exception {
        mockMvc.perform(get("/api/environment"))
                .andExpect(status().is3xxRedirection());
    }

    @Test
    void authenticatedUserReceivesNormalizedEnvironment() throws Exception {
        mockMvc.perform(get("/api/environment").with(user("viewer").roles("VIEWER")))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith("text/plain"))
                .andExpect(content().string("production"));
    }

    @Test
    void helpGuideRequiresAuthentication() throws Exception {
        mockMvc.perform(get("/help"))
                .andExpect(status().is3xxRedirection());
        mockMvc.perform(get("/api/help/download-pdf"))
                .andExpect(status().is3xxRedirection());
        mockMvc.perform(get("/help/viewer-guide.html"))
                .andExpect(status().is3xxRedirection());
        mockMvc.perform(get("/help/WSI-Viewer-Quick-Guide.pdf"))
                .andExpect(status().is3xxRedirection());
    }

    @Test
    void authenticatedUserCanOpenHelpGuideAndPdf() throws Exception {
        mockMvc.perform(get("/help")
                        .with(user("viewer").roles("VIEWER")))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith("text/html"))
                .andExpect(content().string(org.hamcrest.Matchers.containsString("WSI Comprehensive User")));
        mockMvc.perform(get("/api/help/download-pdf")
                        .with(user("viewer").roles("VIEWER")))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith("application/pdf"));
        mockMvc.perform(get("/help/admin-ops-guide.html")
                        .with(user("viewer").roles("VIEWER")))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith("text/html"));
        mockMvc.perform(get("/help/user-guide.html")
                        .with(user("viewer").roles("VIEWER")))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith("text/html"))
                .andExpect(content().string(org.hamcrest.Matchers.containsString("WSI Comprehensive User")));
        mockMvc.perform(get("/help/WSI-Viewer-Quick-Guide.pdf")
                        .with(user("viewer").roles("VIEWER")))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith("application/pdf"));
    }

    private static org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder displayUpdate() {
        return put("/api/images/sample/display")
                .contentType("application/json")
                .content("{\"channels\":[]}");
    }

    private AcquiredCsrf acquireCsrfToken() throws Exception {
        MvcResult result = mockMvc.perform(get("/csrf").with(user("viewer").roles("VIEWER")))
                .andExpect(status().isOk())
                .andReturn();
        String body = result.getResponse().getContentAsString();
        Cookie cookie = result.getResponse().getCookie("XSRF-TOKEN");
        return new AcquiredCsrf(
                JsonPath.read(body, "$.headerName"),
                cookie
        );
    }

    private record AcquiredCsrf(String headerName, Cookie cookie) {
    }
}
