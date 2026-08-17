package wsi_server.plugin;

import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/plugins")
public class PluginController {

    private final PluginRegistry registry;

    public PluginController(PluginRegistry registry) {
        this.registry = registry;
    }

    @PostMapping(value = "/execute", consumes = MediaType.APPLICATION_JSON_VALUE,
            produces = MediaType.APPLICATION_JSON_VALUE)
    public PluginResult execute(@RequestBody PluginExecuteRequest request) throws Exception {
        if (request == null || request.imageId() == null || request.imageId().isBlank()) {
            throw new IllegalArgumentException("imageId is required.");
        }
        if (request.width() <= 0 || request.height() <= 0) {
            throw new IllegalArgumentException("width and height must be positive.");
        }
        return registry.require(request.pluginId()).execute(request);
    }
}
