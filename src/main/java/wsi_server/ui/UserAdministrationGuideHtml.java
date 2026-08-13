package wsi_server.ui;

final class UserAdministrationGuideHtml {

    private UserAdministrationGuideHtml() {
    }

    static String render() {
        StringBuilder sections = new StringBuilder();
        for (UserAdministrationGuideContent.Section section : UserAdministrationGuideContent.sections()) {
            sections.append("<section class=\"card\">")
                    .append("<h2>").append(escape(section.heading())).append("</h2>");
            if (section.intro() != null && !section.intro().isBlank()) {
                sections.append("<p class=\"intro\">").append(escape(section.intro())).append("</p>");
            }
            if (!section.bullets().isEmpty()) {
                sections.append("<ul>");
                for (UserAdministrationGuideContent.Bullet bullet : section.bullets()) {
                    sections.append("<li><strong>")
                            .append(escape(bullet.label()))
                            .append(":</strong> ")
                            .append(formatInline(bullet.body()))
                            .append("</li>");
                }
                sections.append("</ul>");
            }
            if (section.protocolHeading() != null && !section.protocolSteps().isEmpty()) {
                sections.append("<h3>").append(escape(section.protocolHeading())).append("</h3>");
                sections.append("<ol class=\"protocol\">");
                for (String step : section.protocolSteps()) {
                    sections.append("<li>").append(formatInline(step)).append("</li>");
                }
                sections.append("</ol>");
            }
            sections.append("</section>");
        }

        return """
                <!doctype html>
                <html lang="en">
                <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width,initial-scale=1">
                <title>%s</title>
                <style>
                :root{font-family:Arial,Helvetica,sans-serif;color:#0e1b2a;background:#eef3f8}
                *{box-sizing:border-box}
                body{margin:0;padding:24px}
                .page{max-width:980px;margin:auto;background:#fff;padding:28px 32px;border:1px solid #c9d5e2;box-shadow:0 8px 28px #17324d22}
                h1{text-align:center;margin:0;color:#0e1b2a;font-size:26px;line-height:1.25}
                .sub{text-align:center;color:#526579;margin:8px 0 20px;font-style:italic}
                .guide-actions{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;margin:0 0 16px}
                .guide-actions a,.guide-actions button{display:inline-flex;align-items:center;min-height:40px;padding:8px 14px;border:1px solid #2f80c8;border-radius:7px;color:#155f9d;background:#fff;text-decoration:none;font:700 14px Arial,Helvetica,sans-serif;cursor:pointer}
                .guide-actions a.primary{background:#1769aa;border-color:#174b78;color:#fff}
                .guide-actions a:hover,.guide-actions a:focus-visible,.guide-actions button:hover,.guide-actions button:focus-visible{outline:3px solid #2f80c855;outline-offset:2px}
                .guide-actions a.primary:hover,.guide-actions a.primary:focus-visible{background:#0e578f}
                .grid{display:grid;grid-template-columns:1fr;gap:14px}
                .card{border:1px solid #c9d5e2;padding:16px 18px;border-radius:8px}
                h2{font-size:17px;color:#174b78;margin:0 0 10px;letter-spacing:.01em}
                h3{font-size:14px;color:#2f80c8;margin:14px 0 8px}
                .intro{margin:0 0 10px;line-height:1.45;color:#243447}
                ul{margin:0;padding-left:19px}
                ol.protocol{margin:0;padding-left:22px}
                li{margin:7px 0;line-height:1.4}
                li strong{color:#0e1b2a}
                code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.95em}
                .disclaimer{margin-top:18px;padding:12px 14px;background:#fff4d6;border:1px solid #e3b341;font-size:13px;line-height:1.4}
                .foot{font-size:12px;color:#526579;margin:10px 0 0}
                @media(max-width:720px){body{padding:0}.page{border:0;padding:18px;border-radius:0}}
                </style>
                </head>
                <body>
                <main class="page">
                <nav class="guide-actions" aria-label="Guide actions">
                  <a class="primary" href="/api/help/download-pdf" download="WSI-User-Administration-Guide.pdf">Download PDF</a>
                  <a href="/help/viewer-guide.html" target="_blank" rel="noopener">Viewer quick guide</a>
                  <button id="close-guide" type="button">Close</button>
                </nav>
                <h1>%s</h1>
                <p class="sub">%s</p>
                <div class="grid">%s</div>
                <p class="disclaimer" role="note"><strong>Legal disclaimer.</strong> %s</p>
                <p class="foot">Authenticated operators only. Loopback administration endpoints must remain host-local.</p>
                </main>
                <script>
                document.getElementById("close-guide").addEventListener("click", () => {
                  window.close();
                  window.setTimeout(() => { if (!window.closed) window.location.assign("/"); }, 100);
                });
                </script>
                </body>
                </html>
                """.formatted(
                escape(UserAdministrationGuideContent.TITLE),
                escape(UserAdministrationGuideContent.TITLE),
                escape(UserAdministrationGuideContent.SUBTITLE),
                sections,
                escape(UserAdministrationGuideContent.LEGAL_DISCLAIMER)
        );
    }

    /** Escape HTML, then apply lightweight **bold** markers from guide copy. */
    private static String formatInline(String value) {
        String escaped = escape(value);
        StringBuilder out = new StringBuilder(escaped.length() + 16);
        int i = 0;
        while (i < escaped.length()) {
            int start = escaped.indexOf("**", i);
            if (start < 0) {
                out.append(escaped, i, escaped.length());
                break;
            }
            int end = escaped.indexOf("**", start + 2);
            if (end < 0) {
                out.append(escaped, i, escaped.length());
                break;
            }
            out.append(escaped, i, start);
            out.append("<strong>").append(escaped, start + 2, end).append("</strong>");
            i = end + 2;
        }
        return out.toString();
    }

    private static String escape(String value) {
        return value
                .replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;");
    }
}
