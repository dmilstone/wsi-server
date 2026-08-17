package wsi_server;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class PngTileCacheTests {

    @Test
    void keyFollowsImageZChannelLevelXYRevision() {
        assertEquals("slide-a/2/c1/3/4/5/7/fp",
                PngTileCache.key("slide-a", 2, "c1", 3, 4, 5, 7, "fp"));
        assertEquals("slide-a/0/composite/1/0/0/0/",
                PngTileCache.key("slide-a", 0, "", 1, 0, 0, 0, null));
    }

    @Test
    void getReturnsCloneAndPutDoesNotAliasCallerBuffer() {
        PngTileCache cache = new PngTileCache(64);
        String key = PngTileCache.key("img", 0, "c0", 0, 1, 2, 3, "lut");
        byte[] png = {1, 2, 3};
        cache.put(key, png);
        png[0] = 9;
        byte[] cached = cache.get(key);
        assertArrayEquals(new byte[] {1, 2, 3}, cached);
        cached[1] = 8;
        assertArrayEquals(new byte[] {1, 2, 3}, cache.get(key));
    }

    @Test
    void evictsEldestEntryPastMaxSize() {
        PngTileCache cache = new PngTileCache(64);
        for (int i = 0; i < 64; i++) {
            cache.put("k" + i, new byte[] {(byte) i});
        }
        assertEquals(64, cache.size());
        cache.put("k64", new byte[] {64});
        assertEquals(64, cache.size());
        assertNull(cache.get("k0"));
        assertArrayEquals(new byte[] {64}, cache.get("k64"));
    }
}
