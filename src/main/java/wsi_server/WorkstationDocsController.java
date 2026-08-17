package wsi_server;

import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.Resource;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Same-origin documentation frames. Directory URLs such as {@code /local-operations/}
 * do not always resolve to {@code index.html} through the default static handler.
 * {@code /help} is served by {@code wsi_server.ui.HelpController}.
 */
@RestController
public class WorkstationDocsController {

    @GetMapping(value = {"/local-operations", "/local-operations/"}, produces = MediaType.TEXT_HTML_VALUE)
    public ResponseEntity<Resource> localOperations() {
        return html("static/local-operations/index.html");
    }

    @GetMapping(value = {"/pilot-feedback", "/pilot-feedback/"}, produces = MediaType.TEXT_HTML_VALUE)
    public ResponseEntity<Resource> pilotFeedback() {
        return html("static/pilot-feedback/index.html");
    }

    private static ResponseEntity<Resource> html(String classpath) {
        Resource resource = new ClassPathResource(classpath);
        if (!resource.exists()) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok().contentType(MediaType.TEXT_HTML).body(resource);
    }
}
