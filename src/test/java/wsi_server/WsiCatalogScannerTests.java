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
    void placeholderPendingMarkersAreNotPublished() throws Exception {
        Path slide = dir.resolve("pending.vsi");
        Files.writeString(slide, "x");
        Files.writeString(dir.resolve("pending.metadata.json"), """
                {"clinicalMarker":"if.Pending","zPlanes":1}
                """);
        assertEquals("", WsiCatalogScanner.readClinicalMarker(slide));
        assertEquals("", WsiCatalogScanner.normalizeClinicalMarker("if.Pending"));
        assertEquals("if.IgG", WsiCatalogScanner.normalizeClinicalMarker("if IgG"));
        assertEquals(false, WsiCatalogScanner.read(slide).fluorescentArrays());
        WsiCatalogScanner.SlideInspection inspection = WsiCatalogScanner.inspect(slide);
        assertEquals(WsiCatalogScanner.MODALITY_FLUORESCENCE, inspection.modality());
        assertEquals(WsiCatalogScanner.ENGINE_BIOFORMATS, inspection.engine());
    }

    @Test
    void readsNestedAndAliasEpitopeFields() throws Exception {
        Path slide = dir.resolve("alias.vsi");
        Files.writeString(slide, "x");
        Files.writeString(dir.resolve("alias.metadata.json"), """
                {"if_epitope":"if.CD3","ocr":{"clinicalMarker":"if.IgA"}}
                """);
        assertEquals("if.CD3", WsiCatalogScanner.readClinicalMarker(slide));
    }

    @Test
    void publishedZPlanesUseReaderSizeZNotSidecarInflation() {
        assertEquals(1, BioFormatsTileService.zPlaneCount(0));
        assertEquals(1, BioFormatsTileService.zPlaneCount(1));
        assertEquals(10, BioFormatsTileService.zPlaneCount(10));
        assertEquals(0, BioFormatsTileService.clampRgbZ(-3, 1));
        assertEquals(0, BioFormatsTileService.clampRgbZ(1, 1));
        assertEquals(2, BioFormatsTileService.clampRgbZ(2, 3));
    }

    @Test
    void svsAndNdpiRouteToOpenSlideBrightfield() throws Exception {
        Path svs = dir.resolve("tumor.svs");
        Files.writeString(svs, "x");
        WsiCatalogScanner.SlideInspection svsRoute = WsiCatalogScanner.inspect(svs);
        assertEquals(WsiCatalogScanner.MODALITY_BRIGHTFIELD, svsRoute.modality());
        assertEquals(WsiCatalogScanner.ENGINE_OPENSLIDE, svsRoute.engine());

        Path ndpi = dir.resolve("scan.ndpi");
        Files.writeString(ndpi, "x");
        WsiCatalogScanner.SlideInspection ndpiRoute = WsiCatalogScanner.inspect(ndpi);
        assertEquals(WsiCatalogScanner.ENGINE_OPENSLIDE, ndpiRoute.engine());
    }

    @Test
    void sidecarWithoutFluorescentArraysRoutesBrightfield() throws Exception {
        Path slide = dir.resolve("ihc.tif");
        Files.writeString(slide, "x");
        Files.writeString(dir.resolve("ihc.metadata.json"), """
                {"modality":"brightfield","channels":3,"rgb":true}
                """);
        WsiCatalogScanner.SlideInspection inspection = WsiCatalogScanner.inspect(slide);
        assertEquals(WsiCatalogScanner.MODALITY_BRIGHTFIELD, inspection.modality());
        assertEquals(WsiCatalogScanner.ENGINE_OPENSLIDE, inspection.engine());
    }

    @Test
    void fluorescentSidecarStaysOnBioFormats() throws Exception {
        Path slide = dir.resolve("if.vsi");
        Files.writeString(slide, "x");
        Files.writeString(dir.resolve("if.metadata.json"), """
                {"clinicalMarker":"if.IgG","channels":3}
                """);
        WsiCatalogScanner.SlideInspection inspection = WsiCatalogScanner.inspect(slide);
        assertEquals(WsiCatalogScanner.MODALITY_FLUORESCENCE, inspection.modality());
        assertEquals(WsiCatalogScanner.ENGINE_BIOFORMATS, inspection.engine());
    }
}
