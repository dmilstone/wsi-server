package wsi_server.ui;

import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

import java.nio.charset.StandardCharsets;

/**
 * Serves the Comprehensive User &amp; Administration Guide HTML and PDF download.
 */
@Controller
public class HelpController {

    public static final String PDF_FILENAME = "WSI-User-Administration-Guide.pdf";

    @GetMapping(value = {"/help", "/help/", "/help/user-guide.html"}, produces = MediaType.TEXT_HTML_VALUE)
    public ResponseEntity<String> help() {
        return ResponseEntity.ok()
                .contentType(new MediaType("text", "html", StandardCharsets.UTF_8))
                .header(HttpHeaders.CACHE_CONTROL, "no-store")
                .header(HttpHeaders.PRAGMA, "no-cache")
                .body(UserAdministrationGuideHtml.render());
    }

    @GetMapping(value = "/api/help/download-pdf", produces = MediaType.APPLICATION_PDF_VALUE)
    public ResponseEntity<byte[]> downloadPdf() {
        byte[] pdf = UserAdministrationGuidePdf.render();
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_PDF)
                .header(HttpHeaders.CACHE_CONTROL, "no-store")
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        "inline; filename=\"" + PDF_FILENAME + "\"")
                .contentLength(pdf.length)
                .body(pdf);
    }
}
