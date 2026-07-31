package wsi_server;

import com.jayway.jsonpath.JsonPath;
import jakarta.servlet.http.Cookie;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import wsi_server.api.DisplayResponse;

import java.util.List;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.user;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest
@AutoConfigureMockMvc
class SecurityCsrfTests {

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
        when(imageService.updateDisplay(eq("sample"), any(), any()))
                .thenReturn(new DisplayResponse(1, List.of()));
        AcquiredCsrf csrf = acquireCsrfToken();

        mockMvc.perform(displayUpdate()
                        .with(user("viewer").roles("VIEWER"))
                        .cookie(csrf.cookie())
                        .header(csrf.headerName(), csrf.token()))
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
                JsonPath.read(body, "$.token"),
                JsonPath.read(body, "$.headerName"),
                cookie
        );
    }

    private record AcquiredCsrf(String token, String headerName, Cookie cookie) {
    }
}
