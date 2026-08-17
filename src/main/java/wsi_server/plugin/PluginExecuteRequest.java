package wsi_server.plugin;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

import java.util.List;

/**
 * Spatial footprint contract for {@code POST /api/plugins/execute}.
 * {@code channels} may be empty to analyze every active color band.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record PluginExecuteRequest(
        String imageId,
        int x,
        int y,
        int width,
        int height,
        List<String> channels,
        String pluginId,
        Integer series,
        Integer z,
        List<NucleusFootprint> nuclei
) {
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record NucleusFootprint(
            @JsonAlias({"centerX", "x"}) double cx,
            @JsonAlias({"centerY", "y"}) double cy,
            @JsonAlias({"radius"}) double r
    ) {
    }
}
