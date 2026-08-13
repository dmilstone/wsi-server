package wsi_server.feedback;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.UUID;

/**
 * Ensures every authenticated browser has a long-lived first-party browser/profile
 * identifier cookie. Clearing cookies creates a new identifier on the next request.
 */
@Component
public class BrowserProfileCookieFilter extends OncePerRequestFilter {
    public static final String COOKIE_NAME = "WSI-PILOT-PROFILE-ID";
    static final int MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

    private final String cookiePath;

    public BrowserProfileCookieFilter(@Value("${server.servlet.context-path:}") String contextPath) {
        this.cookiePath = contextPath.isBlank() ? "/" : contextPath;
    }

    @Override
    protected void doFilterInternal(
            HttpServletRequest request,
            HttpServletResponse response,
            FilterChain filterChain
    ) throws ServletException, IOException {
        String deviceId = readCookie(request);
        if (deviceId == null || !isValidUuid(deviceId)) {
            deviceId = UUID.randomUUID().toString();
            Cookie cookie = new Cookie(COOKIE_NAME, deviceId);
            cookie.setPath(cookiePath);
            cookie.setMaxAge(MAX_AGE_SECONDS);
            cookie.setHttpOnly(true);
            cookie.setSecure(request.isSecure());
            response.addCookie(cookie);
        }
        request.setAttribute(BrowserProfileCookieFilter.class.getName() + ".deviceId", deviceId);
        filterChain.doFilter(request, response);
    }

    static String readCookie(HttpServletRequest request) {
        if (request.getCookies() == null) return null;
        for (Cookie cookie : request.getCookies()) {
            if (COOKIE_NAME.equals(cookie.getName())) return cookie.getValue();
        }
        return null;
    }

    static String resolveDeviceId(HttpServletRequest request) {
        Object attribute = request.getAttribute(BrowserProfileCookieFilter.class.getName() + ".deviceId");
        if (attribute instanceof String deviceId && isValidUuid(deviceId)) return deviceId;
        String cookie = readCookie(request);
        if (cookie != null && isValidUuid(cookie)) return cookie;
        return null;
    }

    private static boolean isValidUuid(String value) {
        try {
            UUID.fromString(value);
            return true;
        } catch (IllegalArgumentException ignored) {
            return false;
        }
    }
}
