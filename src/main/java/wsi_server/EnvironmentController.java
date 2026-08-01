package wsi_server;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Locale;
import java.util.Set;

@RestController
public class EnvironmentController {

    private static final String PRODUCTION = "production";
    private static final Set<String> SUPPORTED_ENVIRONMENTS =
            Set.of(PRODUCTION, "staging", "development");

    private final String environment;

    public EnvironmentController(@Value("${wsi.environment:production}") String configuredEnvironment) {
        this.environment = normalize(configuredEnvironment);
    }

    @GetMapping(value = "/api/environment", produces = MediaType.TEXT_PLAIN_VALUE)
    String environment() {
        return environment;
    }

    static String normalize(String configuredEnvironment) {
        if (configuredEnvironment == null) {
            return PRODUCTION;
        }
        String normalized = configuredEnvironment.strip().toLowerCase(Locale.ROOT);
        return SUPPORTED_ENVIRONMENTS.contains(normalized) ? normalized : PRODUCTION;
    }
}
