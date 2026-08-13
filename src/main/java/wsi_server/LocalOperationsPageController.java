package wsi_server;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

/**
 * Serves the local operations / dashboard gate page under clean URLs.
 * The gate explains loopback-only access to the ingestion dashboard on 127.0.0.1:8084.
 */
@Controller
public class LocalOperationsPageController {

    @GetMapping({"/dashboard", "/dashboard/"})
    public String dashboard() {
        return "forward:/local-operations/index.html";
    }

    @GetMapping({"/local-operations", "/local-operations/"})
    public String localOperations() {
        return "forward:/local-operations/index.html";
    }
}
