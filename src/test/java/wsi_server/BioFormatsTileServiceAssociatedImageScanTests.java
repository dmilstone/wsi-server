package wsi_server;

import loci.formats.IFormatReader;
import loci.formats.gui.BufferedImageReader;
import loci.formats.meta.MetadataRetrieve;
import org.junit.jupiter.api.Test;
import wsi_server.api.PyramidLevelDimensions;

import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Regression coverage for the bug where {@link BioFormatsTileService#selectAssociatedImages}
 * capped its series scan at {@link ImageContext#FLUORESCENCE_SERIES} (a constant that means a
 * specific series *index* elsewhere in this class, not a series *count*), which silently hid
 * any label/macro associated image sitting at or beyond that index -- exactly the layout many
 * Aperio .svs files use (baseline=0, label=1, macro=2).
 */
class BioFormatsTileServiceAssociatedImageScanTests {

    @Test
    void macroSeriesBeyondTheOldCapIsStillFound() {
        // Mirrors a real Aperio .svs's associated-image layout: baseline pyramid
        // at series 0, then a label and a macro image past ImageContext.FLUORESCENCE_SERIES (2).
        String[] names = {"", "label image", "macro image"};
        int[] widths = {163242, 667, 1469};
        int[] heights = {78011, 714, 596};
        boolean[] thumbnailFlags = {false, true, true};

        BufferedImageReader reader = mock(BufferedImageReader.class);
        MetadataRetrieve metadata = mock(MetadataRetrieve.class);
        AtomicInteger current = new AtomicInteger(0);

        when(reader.getSeriesCount()).thenReturn(names.length);
        doAnswer(invocation -> {
            current.set(invocation.getArgument(0));
            return null;
        }).when(reader).setSeries(anyInt());
        when(reader.getSizeX()).thenAnswer(invocation -> widths[current.get()]);
        when(reader.getSizeY()).thenAnswer(invocation -> heights[current.get()]);
        when(reader.isThumbnailSeries()).thenAnswer(invocation -> thumbnailFlags[current.get()]);
        when(metadata.getImageName(anyInt())).thenAnswer(invocation -> names[(int) invocation.getArgument(0)]);

        AssociatedImageSelection selection = BioFormatsTileService.selectAssociatedImages(reader, metadata);

        assertEquals(1, selection.labelSeries());
        assertEquals(2, selection.overviewSeries());
    }

    @Test
    void seriesAtOrBeyondOldCapWithoutAssociatedNamingIsIgnored() {
        // A slide with no recognizable label/macro naming anywhere (e.g. a plain
        // multi-series fluorescence stack) must still resolve to "none found" --
        // widening the scan must not start guessing at arbitrary series.
        String[] names = {"", "", "", ""};
        BufferedImageReader reader = mock(BufferedImageReader.class);
        MetadataRetrieve metadata = mock(MetadataRetrieve.class);
        AtomicInteger current = new AtomicInteger(0);

        when(reader.getSeriesCount()).thenReturn(names.length);
        doAnswer(invocation -> {
            current.set(invocation.getArgument(0));
            return null;
        }).when(reader).setSeries(anyInt());
        when(reader.getSizeX()).thenReturn(512);
        when(reader.getSizeY()).thenReturn(512);
        when(reader.isThumbnailSeries()).thenReturn(false);
        when(metadata.getImageName(anyInt())).thenAnswer(invocation -> names[(int) invocation.getArgument(0)]);

        AssociatedImageSelection selection = BioFormatsTileService.selectAssociatedImages(reader, metadata);

        assertEquals(AssociatedImageSelection.MISSING, selection.labelSeries());
        assertEquals(AssociatedImageSelection.MISSING, selection.overviewSeries());
    }

    /**
     * Regression coverage for the bug where the viewer's OpenSeadragon tile source assumed
     * every pyramid level is exactly half the resolution of the next. Aperio .svs (and many
     * other Bio-Formats-backed pyramids) commonly downsample by 4x per level instead, so a
     * naive 2x assumption makes the browser request tiles for pixel regions that don't exist
     * at the lowest levels -- exactly what {@link BioFormatsTileService#pyramidLevelDimensions}
     * exists to prevent, by reporting each level's *real* native pixel size.
     */
    @Test
    void pyramidLevelDimensionsReportsRealPerLevelSizeNotAssumed2xSteps() {
        // A real Aperio .svs layout, indexed by native Bio-Formats resolution index
        // (0 = full baseline, increasing index = smaller): each sub-resolution is a 4x
        // downsample of the previous -- not the 2x OpenSeadragon assumes by default.
        int[] widths = {163242, 40810, 10202, 2550};
        int[] heights = {78011, 19502, 4875, 1218};
        IFormatReader reader = mock(IFormatReader.class);
        AtomicInteger currentResolution = new AtomicInteger(0);

        when(reader.getResolutionCount()).thenReturn(widths.length);
        doAnswer(invocation -> {
            currentResolution.set(invocation.getArgument(0));
            return null;
        }).when(reader).setResolution(anyInt());
        when(reader.getSizeX()).thenAnswer(invocation -> widths[currentResolution.get()]);
        when(reader.getSizeY()).thenAnswer(invocation -> heights[currentResolution.get()]);

        List<PyramidLevelDimensions> levels = BioFormatsTileService.pyramidLevelDimensions(reader);

        assertEquals(4, levels.size());
        // viewerLevel 0 (lowest resolution) must map to the smallest Bio-Formats
        // resolution index (widths[0]/heights[0]), not an assumed baseline/8 size.
        assertEquals(new PyramidLevelDimensions(0, 2550, 1218), levels.get(0));
        assertEquals(new PyramidLevelDimensions(1, 10202, 4875), levels.get(1));
        assertEquals(new PyramidLevelDimensions(2, 40810, 19502), levels.get(2));
        assertEquals(new PyramidLevelDimensions(3, 163242, 78011), levels.get(3));
    }
}
