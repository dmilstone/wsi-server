package wsi_server.api;

import java.util.List;

public record DisplayUpdateRequest(List<ChannelDisplayDto> channels) {
}
