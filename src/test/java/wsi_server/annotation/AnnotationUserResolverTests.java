package wsi_server.annotation;

import jakarta.servlet.http.Cookie;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class AnnotationUserResolverTests {
    @Test
    void acceptsStableUserNames() {
        assertEquals("pathologist_1", AnnotationUserResolver.normalize(" pathologist_1 ", "local"));
        assertEquals("name@example.org", AnnotationUserResolver.normalize("name@example.org", "local"));
        assertEquals(
                "wslocalhostabcdef0123456789",
                AnnotationUserResolver.normalize("wslocalhostabcdef0123456789", "local")
        );
    }

    @Test
    void rejectsTraversalAndSeparators() {
        assertThrows(IllegalArgumentException.class,
                () -> AnnotationUserResolver.normalize("../other-user", "local"));
        assertThrows(IllegalArgumentException.class,
                () -> AnnotationUserResolver.normalize("team/user", "local"));
    }

    @Test
    void usesHeaderWhenPresent() {
        AnnotationUserResolver resolver = new AnnotationUserResolver("local");
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.addHeader(AnnotationUserResolver.USER_HEADER, "wsworkstationa1b2c3d4");

        assertEquals("wsworkstationa1b2c3d4", resolver.resolve(request));
    }

    @Test
    void usesCookieWhenHeaderAbsent() {
        AnnotationUserResolver resolver = new AnnotationUserResolver("local");
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setCookies(new Cookie(AnnotationUserResolver.USER_COOKIE, "wsworkstationcookie99"));

        assertEquals("wsworkstationcookie99", resolver.resolve(request));
    }

    @Test
    void prefersHeaderOverCookie() {
        AnnotationUserResolver resolver = new AnnotationUserResolver("local");
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.addHeader(AnnotationUserResolver.USER_HEADER, "wsheaderid");
        request.setCookies(new Cookie(AnnotationUserResolver.USER_COOKIE, "wscookieid"));

        assertEquals("wsheaderid", resolver.resolve(request));
    }

    @Test
    void fallsBackToLocalWhenHeaderAndCookieAbsent() {
        AnnotationUserResolver resolver = new AnnotationUserResolver("local");
        assertEquals("local", resolver.resolve(new MockHttpServletRequest()));
    }
}
