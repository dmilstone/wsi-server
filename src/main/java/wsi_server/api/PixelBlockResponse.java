package wsi_server.api;

import java.util.List;

/**
 * Raw full-resolution UINT16 values for a rectangular image region.
 * Values are channel-major: channel 0 pixels, then channel 1 pixels, etc.
 */
public record PixelBlockResponse(
        int x,
        int y,
        int width,
        int height,
        int channels,
        List<Integer> values
) {
}
