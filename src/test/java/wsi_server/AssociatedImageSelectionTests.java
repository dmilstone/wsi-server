package wsi_server;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class AssociatedImageSelectionTests {
    @Test
    void explicitLabelAndBarcodeNamesAreSelected() {
        assertEquals(0, select(identity(0, "Slide Label", false)).labelSeries());
        assertEquals(1, select(identity(0, "diagnostic", false),
                identity(1, "BARCODE image", false)).labelSeries());
    }

    @Test
    void explicitOverviewNamesAreSelected() {
        for (String name : List.of("Macro", "OVERVIEW", "slide thumbnail", "Preview image")) {
            assertEquals(3, select(identity(3, name, false)).overviewSeries(), name);
        }
    }

    @Test
    void bioFormatsThumbnailDesignationIdentifiesOverview() {
        assertEquals(4, select(identity(4, "", true)).overviewSeries());
    }

    @Test
    void labelCanNeverBeOverviewEvenWhenThumbnailDesignated() {
        AssociatedImageSelection selection = select(identity(2, "Barcode Label", true));
        assertEquals(2, selection.labelSeries());
        assertEquals(AssociatedImageSelection.MISSING, selection.overviewSeries());
    }

    @Test
    void arbitrarySmallUnnamedSeriesIsNeverSubstituted() {
        AssociatedImageSelection selection = AssociatedImageSelection.select(List.of(
                new AssociatedImageSelection.SeriesIdentity(0, "", 32, 16, false),
                new AssociatedImageSelection.SeriesIdentity(1, null, 8, 8, false)));
        assertEquals(AssociatedImageSelection.MISSING, selection.labelSeries());
        assertEquals(AssociatedImageSelection.MISSING, selection.overviewSeries());
    }

    @Test
    void absenceRetainsSafeMissingImageFailures() {
        AssociatedImageSelection selection = AssociatedImageSelection.select(List.of());
        assertEquals("This slide does not contain a readable label associated image.",
                assertThrows(IllegalStateException.class, selection::requireLabelSeries).getMessage());
        assertEquals("This slide does not contain a macro/overview associated image.",
                assertThrows(IllegalStateException.class, selection::requireOverviewSeries).getMessage());
    }

    @Test
    void catalogFlagsAndExtractionIndexesUseTheSameSelection() {
        AssociatedImageSelection selection = select(
                identity(0, "Label", false), identity(1, "Macro overview", false));
        assertTrue(selection.isLabel(selection.labelSeries()));
        assertTrue(selection.isOverview(selection.overviewSeries()));
        assertFalse(selection.isOverview(selection.labelSeries()));
        assertFalse(selection.isLabel(selection.overviewSeries()));
    }

    @Test
    void diagnosticSpecimenFlagUsesAuthoritativeLabelMacroOverviewRules() {
        assertFalse(AssociatedImageSelection.isDiagnosticSpecimen("Slide Label", false));
        assertFalse(AssociatedImageSelection.isDiagnosticSpecimen("BARCODE image", false));
        assertFalse(AssociatedImageSelection.isDiagnosticSpecimen("Macro", false));
        assertFalse(AssociatedImageSelection.isDiagnosticSpecimen("OVERVIEW", false));
        assertFalse(AssociatedImageSelection.isDiagnosticSpecimen("slide thumbnail", false));
        assertFalse(AssociatedImageSelection.isDiagnosticSpecimen("Preview image", false));
        assertFalse(AssociatedImageSelection.isDiagnosticSpecimen("", true));
        // Size is never used: tiny unnamed non-thumbnail series remain diagnostic specimens.
        assertTrue(AssociatedImageSelection.isDiagnosticSpecimen("", false));
        assertTrue(AssociatedImageSelection.isDiagnosticSpecimen("Scan region A", false));
        assertTrue(AssociatedImageSelection.isDiagnosticSpecimen(null, false));
    }

    private static AssociatedImageSelection select(AssociatedImageSelection.SeriesIdentity... series) {
        return AssociatedImageSelection.select(List.of(series));
    }

    private static AssociatedImageSelection.SeriesIdentity identity(int index, String name, boolean thumbnail) {
        return new AssociatedImageSelection.SeriesIdentity(index, name, 640, 480, thumbnail);
    }
}
