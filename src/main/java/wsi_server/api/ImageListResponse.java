package wsi_server.api;

import java.util.List;

public record ImageListResponse(String directory, List<ImageSummary> images) {
}
