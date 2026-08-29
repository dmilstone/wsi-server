package wsi_server.security;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SecurityConfigurationTests {

    @Test
    void loopbackPostToImageRefreshIsRecognized() {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/images/refresh");
        request.setRemoteAddr("127.0.0.1");
        assertTrue(SecurityConfiguration.isLoopbackImageRefresh(request));
        request.setRemoteAddr("::1");
        assertTrue(SecurityConfiguration.isLoopbackImageRefresh(request));
    }

    @Test
    void remoteOrNonRefreshRequestsAreNotExempt() {
        MockHttpServletRequest refresh = new MockHttpServletRequest("POST", "/api/images/refresh");
        refresh.setRemoteAddr("198.51.100.10");
        assertFalse(SecurityConfiguration.isLoopbackImageRefresh(refresh));

        MockHttpServletRequest get = new MockHttpServletRequest("GET", "/api/images/refresh");
        get.setRemoteAddr("127.0.0.1");
        assertFalse(SecurityConfiguration.isLoopbackImageRefresh(get));

        MockHttpServletRequest other = new MockHttpServletRequest("POST", "/api/images/sample/display");
        other.setRemoteAddr("127.0.0.1");
        assertFalse(SecurityConfiguration.isLoopbackImageRefresh(other));
    }
}
