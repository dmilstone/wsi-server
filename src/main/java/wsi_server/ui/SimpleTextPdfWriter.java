package wsi_server.ui;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Minimal PDF 1.4 writer for multi-page Helvetica text (no external PDF dependency).
 */
final class SimpleTextPdfWriter {

    private static final int PAGE_WIDTH = 612;
    private static final int PAGE_HEIGHT = 792;
    private static final int MARGIN = 54;
    private static final int FONT_SIZE = 11;
    private static final int LINE_HEIGHT = 14;
    private static final int CHARS_PER_LINE = 86;

    private SimpleTextPdfWriter() {
    }

    static byte[] write(String title, List<String> bodyLines) {
        List<String> wrapped = new ArrayList<>();
        wrapped.add(stripMarkup(title));
        wrapped.add("");
        for (String line : bodyLines) {
            wrapped.addAll(wrap(stripMarkup(line), CHARS_PER_LINE));
        }

        int linesPerPage = (PAGE_HEIGHT - (2 * MARGIN)) / LINE_HEIGHT;
        List<List<String>> pages = new ArrayList<>();
        for (int i = 0; i < wrapped.size(); i += linesPerPage) {
            pages.add(wrapped.subList(i, Math.min(i + linesPerPage, wrapped.size())));
        }
        if (pages.isEmpty()) {
            pages.add(List.of(title));
        }

        List<String> objects = new ArrayList<>();
        int firstPageObj = 3;
        int fontObj = firstPageObj + (pages.size() * 2);
        StringBuilder kids = new StringBuilder("[");
        for (int p = 0; p < pages.size(); p++) {
            if (p > 0) {
                kids.append(' ');
            }
            kids.append(firstPageObj + (p * 2)).append(" 0 R");
        }
        kids.append(']');
        objects.add("<< /Type /Catalog /Pages 2 0 R >>");
        objects.add("<< /Type /Pages /Kids " + kids + " /Count " + pages.size() + " >>");

        for (int p = 0; p < pages.size(); p++) {
            int pageObjNum = firstPageObj + (p * 2);
            int contentObjNum = pageObjNum + 1;
            objects.add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + PAGE_WIDTH + " " + PAGE_HEIGHT
                    + "] /Contents " + contentObjNum + " 0 R /Resources << /Font << /F1 " + fontObj + " 0 R >> >> >>");
            String stream = contentStream(pages.get(p));
            objects.add("<< /Length " + stream.getBytes(StandardCharsets.US_ASCII).length + " >>\nstream\n"
                    + stream + "\nendstream");
        }
        objects.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

        StringBuilder pdf = new StringBuilder();
        pdf.append("%PDF-1.4\n");
        List<Integer> offsets = new ArrayList<>();
        offsets.add(0);
        for (int i = 0; i < objects.size(); i++) {
            offsets.add(pdf.length());
            pdf.append(i + 1).append(" 0 obj\n").append(objects.get(i)).append("\nendobj\n");
        }
        int xrefAt = pdf.length();
        pdf.append("xref\n0 ").append(objects.size() + 1).append('\n');
        pdf.append("0000000000 65535 f \n");
        for (int i = 1; i < offsets.size(); i++) {
            pdf.append(String.format("%010d 00000 n \n", offsets.get(i)));
        }
        pdf.append("trailer\n<< /Size ").append(objects.size() + 1).append(" /Root 1 0 R >>\n");
        pdf.append("startxref\n").append(xrefAt).append("\n%%EOF\n");
        return pdf.toString().getBytes(StandardCharsets.US_ASCII);
    }

    static String stripMarkup(String value) {
        if (value == null || value.isEmpty()) {
            return "";
        }
        return value.replace("**", "").replace("<b>", "").replace("</b>", "")
                .replace("<strong>", "").replace("</strong>", "").trim();
    }

    private static String contentStream(List<String> lines) {
        StringBuilder stream = new StringBuilder();
        stream.append("BT\n/F1 ").append(FONT_SIZE).append(" Tf\n");
        int y = PAGE_HEIGHT - MARGIN;
        stream.append(MARGIN).append(" ").append(y).append(" Td\n");
        boolean first = true;
        for (String line : lines) {
            if (!first) {
                stream.append("0 -").append(LINE_HEIGHT).append(" Td\n");
            }
            first = false;
            stream.append('(').append(escapePdf(line)).append(") Tj\n");
        }
        stream.append("ET");
        return stream.toString();
    }

    private static String escapePdf(String value) {
        StringBuilder out = new StringBuilder(value.length() + 8);
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '\\' || c == '(' || c == ')') {
                out.append('\\').append(c);
            } else if (c < 32 || c > 126) {
                out.append('?');
            } else {
                out.append(c);
            }
        }
        return out.toString();
    }

    private static List<String> wrap(String text, int width) {
        String normalized = text.replace('\n', ' ').trim();
        if (normalized.isEmpty()) {
            return List.of("");
        }
        List<String> lines = new ArrayList<>();
        String remaining = normalized;
        while (remaining.length() > width) {
            int split = remaining.lastIndexOf(' ', width);
            if (split <= 0) {
                split = width;
            }
            lines.add(remaining.substring(0, split).trim());
            remaining = remaining.substring(split).trim();
        }
        if (!remaining.isEmpty()) {
            lines.add(remaining);
        }
        return lines;
    }
}
