package wsi_server.annotation;

import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Resolves a stable annotation owner for filesystem partitioning.
 * Prefers the explicit {@code X-WSI-User} header, then the
 * {@code WSI-WORKSTATION-ID} cookie (always sent by the browser), and finally
 * the configured default (typically {@code local}).
 */
@Component
public class AnnotationUserResolver {
    public static final String USER_HEADER = "X-WSI-User";
    public static final String USER_COOKIE = "WSI-WORKSTATION-ID";

    private final String defaultUser;

    public AnnotationUserResolver(@Value("${wsi.annotations.default-user:local}") String defaultUser) {
        this.defaultUser = normalize(defaultUser, "local");
    }

    public String resolve(HttpServletRequest request) {
        String fromHeader = request.getHeader(USER_HEADER);
        if (hasText(fromHeader)) {
            return normalize(fromHeader, defaultUser);
        }
        String fromCookie = readCookie(request, USER_COOKIE);
        if (hasText(fromCookie)) {
            return normalize(fromCookie, defaultUser);
        }
        return defaultUser;
    }

    static String normalize(String value, String fallback) {
        String candidate = value == null ? "" : value.trim();
        if (candidate.isEmpty()) candidate = fallback;
        if (candidate.length() > 128) {
            throw new IllegalArgumentException("Annotation user id must be at most 128 characters.");
        }
        // Alphanumeric plus a small safe set for legacy ids (pathologist_1, emails).
        if (!candidate.matches("[A-Za-z0-9._@-]+")) {
            throw new IllegalArgumentException(
                    "Annotation user id may contain only letters, numbers, '.', '_', '@', and '-'."
            );
        }
        return candidate;
    }

    private static boolean hasText(String value) {
        return value != null && !value.trim().isEmpty();
    }

    private static String readCookie(HttpServletRequest request, String name) {
        Cookie[] cookies = request.getCookies();
        if (cookies == null) return null;
        for (Cookie cookie : cookies) {
            if (name.equals(cookie.getName())) {
                return cookie.getValue();
            }
        }
        return null;
    }
}
