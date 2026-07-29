package wsi_server.api;

public record ChannelDisplayDto(
        int index,
        String name,
        boolean visible,
        String lut,
        int black,
        int white,
        double gamma,
        double opacity
) {
}
