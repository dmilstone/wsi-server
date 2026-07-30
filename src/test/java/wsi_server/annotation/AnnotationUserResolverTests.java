package wsi_server.annotation;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class AnnotationUserResolverTests {
    @Test
    void acceptsStableUserNames() {
        assertEquals("pathologist_1", AnnotationUserResolver.normalize(" pathologist_1 ", "local"));
        assertEquals("name@example.org", AnnotationUserResolver.normalize("name@example.org", "local"));
    }

    @Test
    void rejectsTraversalAndSeparators() {
        assertThrows(IllegalArgumentException.class,
                () -> AnnotationUserResolver.normalize("../other-user", "local"));
        assertThrows(IllegalArgumentException.class,
                () -> AnnotationUserResolver.normalize("team/user", "local"));
    }
}
