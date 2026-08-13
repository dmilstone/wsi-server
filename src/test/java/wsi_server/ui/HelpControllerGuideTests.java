package wsi_server.ui;

import com.lowagie.text.pdf.PdfReader;
import com.lowagie.text.pdf.parser.PdfTextExtractor;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class HelpControllerGuideTests {

    @Test
    void htmlIncludesWorkflowsDownloadButtonAndDisclaimer() {
        String html = UserAdministrationGuideHtml.render();
        assertTrue(html.contains("Web Dashboard Image Ingestion Workflow"));
        assertTrue(html.contains("X-WSI-User"));
        assertTrue(html.contains("com.wsi.ops-dashboard"));
        assertTrue(html.contains("Execution Protocol"));
        assertTrue(html.contains("Approve and Seal") || html.contains("Seal &amp; ingest") || html.contains("<strong>Yes</strong>"));
        assertTrue(html.contains("/api/help/download-pdf"));
        assertTrue(html.contains("Download PDF"));
        assertTrue(html.contains("authorized research and image-server administration only"));
        assertTrue(html.contains("Legal disclaimer"));
    }

    @Test
    void pdfRendersStyledTextWithoutRawMarkupTokens() throws IOException {
        byte[] pdf = UserAdministrationGuidePdf.render();
        String header = new String(pdf, 0, Math.min(8, pdf.length), StandardCharsets.ISO_8859_1);
        assertTrue(header.startsWith("%PDF"));
        assertTrue(pdf.length > 500);

        String extracted = extractText(pdf);
        assertTrue(extracted.contains("Standalone WSI Workspace Administration"));
        assertTrue(extracted.contains("X-WSI-User"));
        assertTrue(extracted.contains("LEGAL DISCLAIMER") || extracted.toLowerCase().contains("legal disclaimer"));
        assertTrue(extracted.contains("authorized research"));
        assertFalse(extracted.contains("**"));
        assertFalse(extracted.contains("<b>"));
        assertFalse(extracted.contains("</b>"));
        assertFalse(extracted.contains("<strong>"));
    }

    @Test
    void richChunksInterpretMarkdownBoldWithoutLeavingMarkers() {
        var chunks = UserAdministrationGuidePdf.richChunks(
                "Choose **Yes** then type <b>PROMOTE</b>.",
                com.lowagie.text.FontFactory.getFont(com.lowagie.text.FontFactory.HELVETICA, 10),
                com.lowagie.text.FontFactory.getFont(com.lowagie.text.FontFactory.HELVETICA_BOLD, 10)
        );
        String joined = chunks.stream().map(com.lowagie.text.Chunk::getContent).reduce("", String::concat);
        assertTrue(joined.contains("Yes"));
        assertTrue(joined.contains("PROMOTE"));
        assertFalse(joined.contains("**"));
        assertFalse(joined.contains("<b>"));
    }

    @Test
    void stripMarkupRemovesMarkdownAndHtmlTokens() {
        String cleaned = UserAdministrationGuidePdf.stripMarkup(
                "Type <b>SEAL</b> then **PROMOTE** and observe."
        );
        assertTrue(cleaned.contains("SEAL"));
        assertTrue(cleaned.contains("PROMOTE"));
        assertFalse(cleaned.contains("**"));
        assertFalse(cleaned.contains("<b>"));
        assertFalse(cleaned.contains("</b>"));
    }

    private static String extractText(byte[] pdf) throws IOException {
        PdfReader reader = new PdfReader(pdf);
        try {
            PdfTextExtractor extractor = new PdfTextExtractor(reader);
            StringBuilder text = new StringBuilder();
            for (int page = 1; page <= reader.getNumberOfPages(); page++) {
                text.append(extractor.getTextFromPage(page)).append('\n');
            }
            return text.toString();
        } finally {
            reader.close();
        }
    }
}
