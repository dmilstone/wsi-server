package wsi_server.annotation;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** Resolves a stable annotation owner without requiring Spring Security yet. */
@Component
public class AnnotationUserResolver {
    public static final String USER_HEADER = "X-WSI-User";

    private final String defaultUser;

    public AnnotationUserResolver(@Value("${wsi.annotations.default-user:local}") String defaultUser) {
        this.defaultUser = normalize(defaultUser, "local");
    }

    public String resolve(HttpServletRequest request) {
        return normalize(request.getHeader(USER_HEADER), defaultUser);
    }

    static String normalize(String value, String fallback) {
        String candidate = value == null ? "" : value.trim();
        if (candidate.isEmpty()) candidate = fallback;
        if (candidate.length() > 128) {
            throw new IllegalArgumentException("Annotation user id must be at most 128 characters.");
        }
        if (!candidate.matches("[A-Za-z0-9._@-]+")) {
            throw new IllegalArgumentException(
                    "Annotation user id may contain only letters, numbers, '.', '_', '@', and '-'."
            );
        }
        return candidate;
    }
}
