package wsi_server.api;

import java.util.List;

/** Raw full-resolution intensity values for one image pixel, ordered by channel. */
public record PixelSampleResponse(int x, int y, List<Integer> values) {
}
