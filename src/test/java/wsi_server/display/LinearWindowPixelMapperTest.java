package wsi_server.display;

import org.junit.jupiter.api.Test;
import wsi_server.model.LutType;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class LinearWindowPixelMapperTest {

    @Test
    void linearWindowUsesTheFull16BitRange() {
        LinearWindowPixelMapper mapper = new LinearWindowPixelMapper(0, 65535, LutType.GRAY, 1.0);
        assertEquals(0x000000, mapper.map(0));
        assertEquals(0xFFFFFF, mapper.map(65535));
        assertEquals(0x808080, mapper.map(32896));
    }

    @Test
    void gammaIsAppliedBefore8BitQuantization() {
        LinearWindowPixelMapper quantizedThenGamma = new LinearWindowPixelMapper(0, 65535, LutType.GRAY, 1.0);
        int linearMid = quantizedThenGamma.map(16384) & 0xFF;
        LinearWindowPixelMapper gammaFirst = new LinearWindowPixelMapper(0, 65535, LutType.GRAY, 2.0);
        int gammaMid = gammaFirst.map(16384) & 0xFF;
        assertTrue(gammaMid > linearMid, "gamma > 1 must lift midtones on the 16-bit value");
        assertEquals(Math.round(Math.pow(16384 / 65535.0, 0.5) * 255.0), gammaMid);
    }

    @Test
    void nonDestructiveBlackUsesActualMinimumIncludingZero() {
        long[] histogram = new long[4096];
        histogram[0] = 50;
        histogram[80] = 200;
        histogram[1000] = 9750;
        assertEquals(0, LinearWindowPixelMapper.nonDestructiveBlack(histogram));
        assertEquals(1300, LinearWindowPixelMapper.submedianFloorBlack(histogram));
        assertEquals(1300, LinearWindowPixelMapper.lowEndBlack(histogram, false));
        assertEquals(80, LinearWindowPixelMapper.statisticalClipBlack(histogram));
        assertEquals(80, LinearWindowPixelMapper.lowEndBlack(histogram, true));
    }

    @Test
    void submedianFloorBlackMatchesVisualHighContrastOffset() {
        long[] backgroundHeavy = new long[2048];
        backgroundHeavy[0] = 8000;
        backgroundHeavy[40] = 1500;
        backgroundHeavy[1800] = 500;
        assertEquals(0, LinearWindowPixelMapper.nonDestructiveBlack(backgroundHeavy));
        assertEquals(300, LinearWindowPixelMapper.submedianFloorBlack(backgroundHeavy));
        assertEquals(300, LinearWindowPixelMapper.lowEndBlack(backgroundHeavy, false));

        long[] dcOffset = new long[1024];
        dcOffset[80] = 8000;
        dcOffset[90] = 1500;
        dcOffset[900] = 500;
        assertEquals(80, LinearWindowPixelMapper.nonDestructiveBlack(dcOffset));
        assertEquals(380, LinearWindowPixelMapper.submedianFloorBlack(dcOffset));
    }

    @Test
    void highContrastDefaultHidesTailUntilManualMinIsZero() {
        LinearWindowPixelMapper firstView = new LinearWindowPixelMapper(300, 4000, LutType.GRAY, 1.0);
        LinearWindowPixelMapper fullTail = new LinearWindowPixelMapper(0, 4000, LutType.GRAY, 1.0);
        assertEquals(0x000000, firstView.map(0));
        assertEquals(0x000000, firstView.map(300));
        assertTrue((firstView.map(400) & 0xFF) > 0);
        assertEquals(0x000000, fullTail.map(0));
        assertTrue((fullTail.map(150) & 0xFF) > 0, "Channel min 0 must restore the raw tail");
        assertTrue((fullTail.map(150) & 0xFF) < (fullTail.map(300) & 0xFF));
    }

    @Test
    void nonDestructiveWindowPreservesLowEndGradientToRawZero() {
        LinearWindowPixelMapper clipped = new LinearWindowPixelMapper(80, 1000, LutType.GRAY, 1.0);
        LinearWindowPixelMapper full = new LinearWindowPixelMapper(0, 1000, LutType.GRAY, 1.0);
        assertEquals(0x000000, clipped.map(0));
        assertEquals(0x000000, clipped.map(80));
        assertEquals(0x000000, full.map(0));
        int dim = full.map(40) & 0xFF;
        assertTrue(dim > 0, "raw values between 0 and the old 1% floor must stay on the gradient");
        assertTrue(dim < (full.map(80) & 0xFF));
    }

    @Test
    void statisticalClipBlackIsLegacyOnePercent() {
        long[] histogram = new long[16];
        histogram[2] = 1;
        histogram[10] = 199;
        assertEquals(2, LinearWindowPixelMapper.nonDestructiveBlack(histogram));
        assertEquals(10, LinearWindowPixelMapper.statisticalClipBlack(histogram));
        assertEquals(0, LinearWindowPixelMapper.nonDestructiveBlack(null));
        assertEquals(0, LinearWindowPixelMapper.statisticalClipBlack(new long[8]));
    }
}
