package wsi_server;

import jakarta.servlet.http.HttpSession;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ExportServiceTests {
    private final BioFormatsTileService imageService = mock(BioFormatsTileService.class);
    private final HttpSession session = mock(HttpSession.class);
    private final ExportService service = new ExportService(imageService);

    @Test
    void delegatesExportToSharedImagePipeline() throws Exception {
        byte[] expected = {1, 2, 3};
        when(imageService.exportRegion("slide", 10, 20, 30, 40, 0.5, session))
                .thenReturn(expected);

        byte[] actual = service.export("slide", 10, 20, 30, 40, 0.5, session);

        assertArrayEquals(expected, actual);
        verify(imageService).exportRegion("slide", 10, 20, 30, 40, 0.5, session);
    }

    @Test
    void rejectsInvalidScaleBeforeReadingImage() {
        assertThrows(IllegalArgumentException.class,
                () -> service.export("slide", 0, 0, 10, 10, Double.NaN, session));
        assertThrows(IllegalArgumentException.class,
                () -> service.export("slide", 0, 0, 10, 10, 0, session));
    }
}
