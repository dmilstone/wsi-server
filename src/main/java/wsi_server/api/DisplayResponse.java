package wsi_server.api;

import java.util.List;

public record DisplayResponse(long revision, List<ChannelDisplayDto> channels) {
}
