package wsi_server;

import loci.formats.FormatTools;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;

class ImageContextRgbClassificationTests {

    @Test
    void fluorescenceIsNeverClassifiedAsRgbEvenWhenReaderReportsJpegRgb() {
        assertEquals(false, ImageContext.classifyRgb(true, FormatTools.UINT8, true, 3));
        assertEquals(true, ImageContext.classifyRgb(false, FormatTools.UINT8, true, 3));
        assertEquals(false, ImageContext.classifyRgb(false, FormatTools.UINT16, true, 3));
    }

    @Test
    void expandUint8ToUint16LeKeeps8BitValuesInLowByte() {
        assertArrayEquals(new byte[] {80, 0, (byte) 200, 0},
                BioFormatsTileService.expandUint8ToUint16Le(new byte[] {80, (byte) 200}));
    }
}
