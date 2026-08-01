package wsi_server;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class EnvironmentController {
    private final String environment;

    public EnvironmentController(@Value("${wsi.environment:production}") String configuredEnvironment) {
        this.environment = WsiEnvironment.normalize(configuredEnvironment);
    }

    @GetMapping(value = "/api/environment", produces = MediaType.TEXT_PLAIN_VALUE)
    String environment() {
        return environment;
    }
}
