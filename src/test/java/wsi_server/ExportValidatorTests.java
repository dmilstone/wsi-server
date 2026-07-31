package wsi_server;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class ExportValidatorTests {
    private final ExportValidator validator = new ExportValidator(100);

    @Test
    void acceptsContainedRegionAtPixelLimit() {
        assertDoesNotThrow(() -> validator.validate(5, 10, 10, 10, 1.0, 15, 20));
    }

    @Test
    void rejectsInvalidOrOutOfBoundsRegions() {
        assertThrows(IllegalArgumentException.class,
                () -> validator.validate(-1, 0, 1, 1, 1.0, 10, 10));
        assertThrows(IllegalArgumentException.class,
                () -> validator.validate(0, 0, 0, 1, 1.0, 10, 10));
        IllegalArgumentException error = assertThrows(IllegalArgumentException.class,
                () -> validator.validate(9, 0, 2, 1, 1.0, 10, 10));
        assertEquals("Export region must be contained within the image.", error.getMessage());
    }

    @Test
    void rejectsSourceOrScaledOutputOverPixelLimit() {
        assertThrows(IllegalArgumentException.class,
                () -> validator.validate(0, 0, 11, 10, 0.5, 20, 20));
        IllegalArgumentException error = assertThrows(IllegalArgumentException.class,
                () -> validator.validate(0, 0, 5, 5, 3.0, 20, 20));
        assertEquals("Export exceeds the configured maximum of 100 pixels.", error.getMessage());
    }
}
