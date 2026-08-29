package wsi_server;

import org.junit.jupiter.api.Test;

import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class WsiReaderEngineTests {

    @Test
    void factoryRoutesSvsToOpenSlideStub() {
        ImageRegistry.ImageEntry entry = new ImageRegistry.ImageEntry(
                "id",
                "tumor.svs",
                "tumor.svs",
                "",
                Path.of("/tmp/tumor.svs"),
                "",
                0,
                0,
                0,
                WsiCatalogScanner.MODALITY_BRIGHTFIELD,
                WsiCatalogScanner.ENGINE_OPENSLIDE,
                false
        );
        WsiReaderEngine engine = new WsiReaderEngineFactory().open(entry);
        assertEquals(WsiCatalogScanner.ENGINE_OPENSLIDE, engine.getMetadata().engine());
        assertEquals(WsiCatalogScanner.MODALITY_BRIGHTFIELD, engine.getMetadata().modality());
        assertThrows(UnsupportedOperationException.class, () -> engine.getTile(0, 0, 0));
    }

    @Test
    void bioFormatsEngineReportsBioFormatsMetadata() {
        ImageRegistry.ImageEntry entry = new ImageRegistry.ImageEntry(
                "id",
                "slide.vsi",
                "slide.vsi",
                "",
                Path.of("/tmp/slide.vsi"),
                "if.IgG",
                1,
                0,
                0,
                WsiCatalogScanner.MODALITY_FLUORESCENCE,
                WsiCatalogScanner.ENGINE_BIOFORMATS,
                false
        );
        WsiReaderEngine engine = new BioFormatsEngine(entry);
        assertEquals(WsiCatalogScanner.ENGINE_BIOFORMATS, engine.getMetadata().engine());
        assertEquals("id", engine.getMetadata().imageId());
    }
}
