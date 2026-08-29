package wsi_server;

import loci.formats.IFormatReader;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

class OpenSlideFormatReaderTests {

    @Test
    void handlesSvsNdpiAndBrightfieldMrxs() {
        assertTrue(OpenSlideFormatReader.handles(Path.of("/tmp/scan.ndpi")));
        assertTrue(OpenSlideFormatReader.handles(Path.of("/tmp/tumor.SVS")));
        assertTrue(OpenSlideFormatReader.handles(Path.of("/tmp/he.mrxs")));
        assertEquals(false, OpenSlideFormatReader.handles(Path.of("/tmp/slide.vsi")));
        assertEquals(false, OpenSlideFormatReader.handles(null));
    }

    @Test
    void candidateLibrariesPreferCurrentHomebrewAbi() {
        assertTrue(java.util.Arrays.asList(OpenSlideNative.LIBRARY_FILES).contains("libopenslide.1.dylib"));
        assertTrue(java.util.Arrays.asList(OpenSlideNative.SEARCH_DIRECTORIES).contains("/opt/homebrew/lib"));
    }

    @Test
    void level0CoordinateUsesOpenSlideDownsample() {
        assertEquals(0L, OpenSlideFormatReader.level0Coordinate(0, 4.0));
        assertEquals(2048L, OpenSlideFormatReader.level0Coordinate(512, 4.0));
        assertEquals(512L, OpenSlideFormatReader.level0Coordinate(512, 1.0));
    }

    @Test
    void argbToRgbFillsTransparentWithWhite() {
        int[] argb = {0x00000000, 0xFF112233};
        byte[] rgb = new byte[6];
        OpenSlideFormatReader.argbToRgb(argb, rgb);
        assertArrayEquals(new byte[]{(byte) 255, (byte) 255, (byte) 255, 0x11, 0x22, 0x33}, rgb);
    }

    @Test
    @EnabledIf("mrxsFixtureAvailable")
    void openDefaultUsesOpenSlideForBrightfieldMrxs() throws Exception {
        Path mrxs = mrxsFixture();
        try (IFormatReader reader = BioFormatsReaderPool.openDefault(mrxs)) {
            assertInstanceOf(OpenSlideFormatReader.class, reader);
            assertTrue(reader.getSizeX() > 2000);
            assertTrue(reader.getSizeY() > 2000);
            assertTrue(reader.getResolutionCount() >= 2);
            assertTrue(reader.isRGB());
            reader.setResolution(reader.getResolutionCount() - 1);
            byte[] tile = reader.openBytes(0, 0, 0, 16, 16);
            assertEquals(16 * 16 * 3, tile.length);
        }
    }

    @Test
    @EnabledIf("ndpiFixtureAvailable")
    void openDefaultUsesOpenSlideForNdpi() throws Exception {
        Path ndpi = ndpiFixture();
        try (IFormatReader reader = BioFormatsReaderPool.openDefault(ndpi)) {
            assertInstanceOf(OpenSlideFormatReader.class, reader);
            assertTrue(reader.getSizeX() > 0);
            assertTrue(reader.getSizeY() > 0);
            assertTrue(reader.getResolutionCount() >= 2);
            assertTrue(reader.isRGB());
            assertEquals(3, reader.getSizeC());
            reader.setResolution(reader.getResolutionCount() - 1);
            byte[] tile = reader.openBytes(0, 0, 0, 16, 16);
            assertEquals(16 * 16 * 3, tile.length);
        }
    }

    static boolean ndpiFixtureAvailable() {
        return OpenSlideNative.isAvailable() && Files.isRegularFile(ndpiFixture());
    }

    static boolean mrxsFixtureAvailable() {
        return OpenSlideNative.isAvailable() && Files.isRegularFile(mrxsFixture())
                && Files.isRegularFile(MrxsSlideInfo.slidedatPath(mrxsFixture()));
    }

    private static Path ndpiFixture() {
        return Path.of("/Users/dm026/wsi-slides/ndpi_01/330892159__2020-06-06_08.15.06.ndpi");
    }

    private static Path mrxsFixture() {
        return Path.of("/Users/dm026/wsi-slides/2020-02-10_BD2020_00000867_BF_mrxsiBf_01/BD2020_00000867.mrxs");
    }
}
