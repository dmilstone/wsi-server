package wsi_server.ui;

import com.lowagie.text.Chunk;
import com.lowagie.text.Document;
import com.lowagie.text.DocumentException;
import com.lowagie.text.Element;
import com.lowagie.text.Font;
import com.lowagie.text.FontFactory;
import com.lowagie.text.PageSize;
import com.lowagie.text.Paragraph;
import com.lowagie.text.Phrase;
import com.lowagie.text.pdf.PdfWriter;

import java.awt.Color;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Stylesheet-aware Admin Guide PDF renderer (OpenPDF Paragraph / Phrase / Chunk).
 * Markdown {@code **bold**} and simple HTML emphasis are interpreted as real bold runs,
 * not emitted as raw markup characters.
 */
final class UserAdministrationGuidePdf {

    private static final Pattern HTML_BOLD = Pattern.compile("(?is)</?(?:b|strong)\\s*>");
    private static final Pattern HTML_TAG = Pattern.compile("(?is)<[^>]+>");
    private static final Pattern MARKDOWN_BOLD = Pattern.compile("\\*\\*(.+?)\\*\\*");
    private static final Color TITLE_COLOR = new Color(14, 27, 42);
    private static final Color HEADING_COLOR = new Color(23, 75, 120);
    private static final Color SUBHEAD_COLOR = new Color(47, 128, 200);
    private static final Color BODY_COLOR = new Color(36, 52, 71);
    private static final Color MUTED_COLOR = new Color(82, 101, 121);

    private UserAdministrationGuidePdf() {
    }

    static byte[] render() {
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            Document document = new Document(PageSize.LETTER, 54, 54, 54, 54);
            PdfWriter.getInstance(document, out);
            document.open();

            Font titleFont = FontFactory.getFont(FontFactory.HELVETICA_BOLD, 16, TITLE_COLOR);
            Font subtitleFont = FontFactory.getFont(FontFactory.HELVETICA_OBLIQUE, 11, MUTED_COLOR);
            Font h2Font = FontFactory.getFont(FontFactory.HELVETICA_BOLD, 13, HEADING_COLOR);
            Font h3Font = FontFactory.getFont(FontFactory.HELVETICA_BOLD, 11, SUBHEAD_COLOR);
            Font bodyFont = FontFactory.getFont(FontFactory.HELVETICA, 10.5f, BODY_COLOR);
            Font bodyBold = FontFactory.getFont(FontFactory.HELVETICA_BOLD, 10.5f, BODY_COLOR);
            Font disclaimerFont = FontFactory.getFont(FontFactory.HELVETICA, 9.5f, BODY_COLOR);
            Font disclaimerBold = FontFactory.getFont(FontFactory.HELVETICA_BOLD, 9.5f, BODY_COLOR);

            Paragraph title = new Paragraph(plain(UserAdministrationGuideContent.TITLE), titleFont);
            title.setAlignment(Element.ALIGN_CENTER);
            title.setSpacingAfter(6f);
            document.add(title);

            Paragraph subtitle = new Paragraph(plain(UserAdministrationGuideContent.SUBTITLE), subtitleFont);
            subtitle.setAlignment(Element.ALIGN_CENTER);
            subtitle.setSpacingAfter(16f);
            document.add(subtitle);

            for (UserAdministrationGuideContent.Section section : UserAdministrationGuideContent.sections()) {
                Paragraph heading = new Paragraph(plain(section.heading()), h2Font);
                heading.setSpacingBefore(10f);
                heading.setSpacingAfter(6f);
                document.add(heading);

                if (section.intro() != null && !section.intro().isBlank()) {
                    document.add(richParagraph(section.intro(), bodyFont, bodyBold, 0f, 6f, 0f));
                }

                for (UserAdministrationGuideContent.Bullet bullet : section.bullets()) {
                    Phrase phrase = new Phrase();
                    phrase.add(new Chunk("• ", bodyFont));
                    phrase.add(new Chunk(plain(bullet.label()) + ": ", bodyBold));
                    phrase.addAll(richChunks(bullet.body(), bodyFont, bodyBold));
                    Paragraph item = new Paragraph(phrase);
                    item.setSpacingAfter(4f);
                    item.setIndentationLeft(12f);
                    document.add(item);
                }

                if (section.protocolHeading() != null && !section.protocolSteps().isEmpty()) {
                    Paragraph protocolHeading = new Paragraph(plain(section.protocolHeading()), h3Font);
                    protocolHeading.setSpacingBefore(8f);
                    protocolHeading.setSpacingAfter(4f);
                    document.add(protocolHeading);
                    int step = 1;
                    for (String protocolStep : section.protocolSteps()) {
                        Phrase phrase = new Phrase();
                        phrase.add(new Chunk(step + ". ", bodyBold));
                        phrase.addAll(richChunks(protocolStep, bodyFont, bodyBold));
                        Paragraph item = new Paragraph(phrase);
                        item.setSpacingAfter(3f);
                        item.setIndentationLeft(16f);
                        document.add(item);
                        step += 1;
                    }
                }
            }

            Paragraph disclaimerHeading = new Paragraph("Legal disclaimer", h3Font);
            disclaimerHeading.setSpacingBefore(14f);
            disclaimerHeading.setSpacingAfter(4f);
            document.add(disclaimerHeading);
            document.add(richParagraph(
                    UserAdministrationGuideContent.LEGAL_DISCLAIMER,
                    disclaimerFont,
                    disclaimerBold,
                    0f,
                    0f,
                    0f
            ));

            document.close();
            return out.toByteArray();
        } catch (DocumentException ex) {
            throw new IllegalStateException("Unable to render administration guide PDF", ex);
        }
    }

    private static Paragraph richParagraph(
            String text,
            Font regular,
            Font bold,
            float spacingBefore,
            float spacingAfter,
            float indent
    ) {
        Paragraph paragraph = new Paragraph();
        paragraph.addAll(richChunks(text, regular, bold));
        paragraph.setSpacingBefore(spacingBefore);
        paragraph.setSpacingAfter(spacingAfter);
        paragraph.setIndentationLeft(indent);
        paragraph.setLeading(regular.getSize() * 1.35f);
        return paragraph;
    }

    static List<Chunk> richChunks(String text, Font regular, Font bold) {
        String normalized = normalizeMarkup(text);
        List<Chunk> chunks = new ArrayList<>();
        Matcher matcher = MARKDOWN_BOLD.matcher(normalized);
        int cursor = 0;
        while (matcher.find()) {
            if (matcher.start() > cursor) {
                chunks.add(new Chunk(normalized.substring(cursor, matcher.start()), regular));
            }
            chunks.add(new Chunk(matcher.group(1), bold));
            cursor = matcher.end();
        }
        if (cursor < normalized.length()) {
            chunks.add(new Chunk(normalized.substring(cursor), regular));
        }
        if (chunks.isEmpty()) {
            chunks.add(new Chunk("", regular));
        }
        return chunks;
    }

    /** Convert simple HTML emphasis to markdown bold markers; drop other tags. */
    static String normalizeMarkup(String value) {
        if (value == null || value.isEmpty()) {
            return "";
        }
        String text = value;
        text = HTML_BOLD.matcher(text).replaceAll("**");
        text = HTML_TAG.matcher(text).replaceAll("");
        text = text.replace('\n', ' ');
        return text.trim();
    }

    static String plain(String value) {
        String normalized = normalizeMarkup(value);
        return MARKDOWN_BOLD.matcher(normalized).replaceAll("$1").replace("**", "").trim();
    }

    /** Test helper: flatten styled text without markup tokens. */
    static String stripMarkup(String value) {
        return plain(value);
    }
}
