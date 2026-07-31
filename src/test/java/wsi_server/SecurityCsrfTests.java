package wsi_server;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import wsi_server.api.DisplayResponse;

import java.util.List;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.user;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.cookie;
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

        mockMvc.perform(displayUpdate()
                        .with(user("viewer").roles("VIEWER"))
                        .with(csrf().asHeader()))
                .andExpect(status().isOk());
    }

    @Test
    void anonymousStateChangingAccessRemainsProtected() throws Exception {
        mockMvc.perform(displayUpdate().with(csrf().asHeader()))
                .andExpect(status().is3xxRedirection());
    }

    @Test
    void authenticatedViewerLoadReceivesReadableCsrfCookie() throws Exception {
        mockMvc.perform(get("/index.html").with(user("viewer").roles("VIEWER")))
                .andExpect(status().isOk())
                .andExpect(cookie().exists("XSRF-TOKEN"))
                .andExpect(cookie().httpOnly("XSRF-TOKEN", false));
    }

    private static org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder displayUpdate() {
        return put("/api/images/sample/display")
                .contentType("application/json")
                .content("{\"channels\":[]}");
    }
}
