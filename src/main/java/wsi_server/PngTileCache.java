package wsi_server;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Process-local LRU cache of rendered PNG tiles keyed by
 * {@code image/z/channel/level/x/y/revision} plus a display fingerprint.
 */
@Component
final class PngTileCache {
    private final int maxEntries;
    private final LinkedHashMap<String, byte[]> entries;

    PngTileCache(@Value("${wsi.tile-cache.max-entries:2048}") int maxEntries) {
        this.maxEntries = Math.max(64, maxEntries);
        this.entries = new LinkedHashMap<>(256, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<String, byte[]> eldest) {
                return size() > PngTileCache.this.maxEntries;
            }
        };
    }

    int maxEntries() {
        return maxEntries;
    }

    synchronized byte[] get(String key) {
        if (key == null) return null;
        byte[] value = entries.get(key);
        return value == null ? null : value.clone();
    }

    synchronized void put(String key, byte[] png) {
        if (key == null || png == null) return;
        entries.put(key, png.clone());
    }

    synchronized int size() {
        return entries.size();
    }

    static String key(String imageId, int z, String channel, int level, int x, int y,
                      long revision, String fingerprint) {
        return String.valueOf(imageId)
                + "/" + z
                + "/" + (channel == null || channel.isBlank() ? "composite" : channel)
                + "/" + level
                + "/" + x
                + "/" + y
                + "/" + revision
                + "/" + (fingerprint == null ? "" : fingerprint);
    }
}
