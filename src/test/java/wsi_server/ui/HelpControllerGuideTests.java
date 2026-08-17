package wsi_server.ui;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class HelpControllerGuideTests {

    @Test
    void htmlIncludesWorkflowsDownloadButtonAndDisclaimer() {
        String html = UserAdministrationGuideHtml.render();
        assertTrue(html.contains("WSI Comprehensive User &amp; Administration Guide"));
        assertTrue(html.contains("Web Dashboard Image Ingestion Workflow"));
        assertTrue(html.contains("X-WSI-User"));
        assertTrue(html.contains("com.wsi.ops-dashboard"));
        assertTrue(html.contains("Execution Protocol"));
        assertTrue(html.contains("SEAL"));
        assertTrue(html.contains("Observe"));
        assertTrue(html.contains("PROMOTE"));
        assertFalse(html.contains("Approve and Seal"));
        assertTrue(html.contains("/api/help/download-pdf"));
        assertTrue(html.contains("Download PDF"));
        assertTrue(html.contains("/help/viewer-guide.html"));
        assertTrue(html.contains("/help/admin-ops-guide.html"));
        assertTrue(html.contains("authorized research and image-server administration only"));
        assertTrue(html.contains("Legal disclaimer"));
    }

    @Test
    void pdfStartsWithHeaderAndContainsDisclaimerBytes() {
        byte[] pdf = UserAdministrationGuidePdf.render();
        String header = new String(pdf, 0, Math.min(8, pdf.length), StandardCharsets.ISO_8859_1);
        assertTrue(header.startsWith("%PDF"));
        assertTrue(pdf.length > 500);
        String extracted = new String(pdf, StandardCharsets.ISO_8859_1);
        assertTrue(extracted.contains("WSI Comprehensive User"));
        assertTrue(extracted.contains("X-WSI-User"));
        assertTrue(extracted.contains("LEGAL DISCLAIMER"));
        assertTrue(extracted.contains("authorized research"));
        assertFalse(extracted.contains("**"));
    }
}
