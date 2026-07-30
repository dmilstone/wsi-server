package wsi_server.api;

public record AssociatedImageSeriesDto(
        int series,
        String name,
        int width,
        int height,
        int channels,
        int resolutionCount,
        boolean rgb,
        boolean thumbnail,
        boolean selectedAsLabel,
        boolean selectedAsMacro
) {}
