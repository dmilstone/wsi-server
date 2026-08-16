package wsi_server;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;

class WsiCatalogScannerTests {
    @TempDir
    Path dir;

    @Test
    void readsClinicalMarkerAndZLayerAliasesFromCompanionMetadata() throws Exception {
        Path slide = dir.resolve("BA26-041340_A1.vsi");
        Files.writeString(slide, "placeholder");
        Files.writeString(dir.resolve("BA26-041340_A1.metadata.json"), """
                {
                  "clinicalMarker": "if.IgG",
                  "zPlanes": 5,
                  "depth": 3,
                  "zLayers": 4,
                  "ocrStatus": "ok",
                  "version": 1
                }
                """);

        WsiCatalogScanner.SidecarMetadata sidecar = WsiCatalogScanner.read(slide);
        assertEquals("if.IgG", sidecar.clinicalMarker());
        assertEquals(5, sidecar.zPlanes());
        assertEquals(3, sidecar.depth());
        assertEquals(4, sidecar.zLayers());
        assertEquals(dir.resolve("BA26-041340_A1.metadata.json"),
                WsiCatalogScanner.metadataPathForSlide(slide));
    }

    @Test
    void normalizesGapVariantsAndMissingFiles() throws Exception {
        Path slide = dir.resolve("slide.vsi");
        Files.writeString(slide, "x");
        assertEquals("", WsiCatalogScanner.readClinicalMarker(slide));

        Files.writeString(dir.resolve("slide.metadata.json"), """
                {"clinical_marker":"if IgG4","z_planes":2}
                """);
        WsiCatalogScanner.SidecarMetadata sidecar = WsiCatalogScanner.read(slide);
        assertEquals("if.IgG4", sidecar.clinicalMarker());
        assertEquals(2, sidecar.zPlanes());
    }

    @Test
    void publishedZPlanesUseReaderSizeZNotSidecarInflation() {
        assertEquals(1, BioFormatsTileService.zPlaneCount(0));
        assertEquals(1, BioFormatsTileService.zPlaneCount(1));
        assertEquals(10, BioFormatsTileService.zPlaneCount(10));
    }
}
