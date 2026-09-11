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
}
