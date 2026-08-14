package wsi_server.ui;

import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.ResponseBody;

/**
 * Serves the Comprehensive User &amp; Administration Guide HTML and styled PDF download.
 * PDF compilation is delegated to {@link UserAdministrationGuidePdf}, which renders
 * OpenPDF Paragraph/Phrase components with native bold/header hierarchy.
 */
@Controller
public class HelpController {

    public static final String PDF_FILENAME = "WSI-User-Administration-Guide.pdf";

    @GetMapping(value = {"/help", "/help/"}, produces = MediaType.TEXT_HTML_VALUE)
    @ResponseBody
    public String help() {
        return UserAdministrationGuideHtml.render();
    }

    @GetMapping(value = "/api/help/download-pdf", produces = MediaType.APPLICATION_PDF_VALUE)
    public ResponseEntity<byte[]> downloadPdf() {
        byte[] pdf = UserAdministrationGuidePdf.render();
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_PDF)
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        "inline; filename=\"" + PDF_FILENAME + "\"")
                .contentLength(pdf.length)
                .body(pdf);
    }
}
