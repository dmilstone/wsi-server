package wsi_server.feedback;

import jakarta.servlet.ServletException;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

class BrowserProfileCookieFilterTests {
    @Test
    void createsCookieWhenMissing() throws ServletException, java.io.IOException {
        BrowserProfileCookieFilter filter = new BrowserProfileCookieFilter("");
        MockHttpServletRequest request = new MockHttpServletRequest();
        MockHttpServletResponse response = new MockHttpServletResponse();

        filter.doFilter(request, response, new MockFilterChain());

        assertNotNull(response.getCookie(BrowserProfileCookieFilter.COOKIE_NAME));
        assertNotNull(BrowserProfileCookieFilter.resolveDeviceId(request));
    }

    @Test
    void reusesExistingValidCookie() throws ServletException, java.io.IOException {
        BrowserProfileCookieFilter filter = new BrowserProfileCookieFilter("");
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setCookies(new jakarta.servlet.http.Cookie(
                BrowserProfileCookieFilter.COOKIE_NAME,
                "00000000-0000-4000-8000-000000000099"
        ));
        MockHttpServletResponse response = new MockHttpServletResponse();

        filter.doFilter(request, response, new MockFilterChain());

        assertNull(response.getCookie(BrowserProfileCookieFilter.COOKIE_NAME));
        assertEquals(
                "00000000-0000-4000-8000-000000000099",
                BrowserProfileCookieFilter.resolveDeviceId(request)
        );
    }
}
