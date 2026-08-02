#!/usr/bin/env python3
"""Render the versioned WSI release cheat sheet as a two-page Letter PDF."""

from pathlib import Path
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate, Frame, KeepTogether, PageBreak, PageTemplate, Paragraph,
    Spacer, Table, TableStyle,
)

ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "WSI-Release-Cheat-Sheet.pdf"

NAVY = colors.HexColor("#0B1724")
BLUE = colors.HexColor("#2374B9")
GREEN = colors.HexColor("#16764A")
AMBER = colors.HexColor("#9A6500")
RED = colors.HexColor("#A42D2D")
LIGHT_BLUE = colors.HexColor("#EDF5FB")
LIGHT_GREEN = colors.HexColor("#EEF8F3")
LIGHT_AMBER = colors.HexColor("#FFF7E4")
LIGHT_RED = colors.HexColor("#FFF0F0")
LINE = colors.HexColor("#CBD7E2")

pdfmetrics.registerFont(TTFont("DVSans", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"))
pdfmetrics.registerFont(TTFont("DVSans-Bold", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"))
pdfmetrics.registerFont(TTFont("DVMono", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"))


def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(LINE)
    canvas.line(0.43 * inch, 0.34 * inch, 8.07 * inch, 0.34 * inch)
    canvas.setFont("DVSans", 7)
    canvas.setFillColor(colors.HexColor("#667581"))
    canvas.drawString(0.43 * inch, 0.20 * inch, "WSI Viewer release operations")
    canvas.drawRightString(8.07 * inch, 0.20 * inch, f"Page {doc.page}")
    canvas.restoreState()


styles = getSampleStyleSheet()
title = ParagraphStyle("Title", parent=styles["Title"], fontName="DVSans-Bold",
                       fontSize=20, leading=22, textColor=NAVY, spaceAfter=2)
subtitle = ParagraphStyle("Subtitle", parent=styles["Normal"], fontName="DVSans-Bold",
                          fontSize=8.5, leading=10, textColor=colors.HexColor("#526270"), spaceAfter=8)
h2 = ParagraphStyle("H2", parent=styles["Heading2"], fontName="DVSans-Bold",
                    fontSize=11.5, leading=13, textColor=NAVY, spaceBefore=7, spaceAfter=4,
                    borderColor=BLUE, borderWidth=0, borderPadding=0)
h3 = ParagraphStyle("H3", parent=styles["Heading3"], fontName="DVSans-Bold",
                    fontSize=9.3, leading=11, textColor=BLUE, spaceBefore=5, spaceAfter=2)
body = ParagraphStyle("Body", parent=styles["BodyText"], fontName="DVSans",
                      fontSize=8.0, leading=9.7, textColor=colors.HexColor("#17212B"), spaceAfter=3)
small = ParagraphStyle("Small", parent=body, fontSize=7.2, leading=8.6)
table_header = ParagraphStyle("TableHeader", parent=small, fontName="DVSans-Bold", textColor=colors.white)
code = ParagraphStyle("Code", parent=body, fontName="DVMono", fontSize=6.8, leading=8.2,
                      textColor=colors.white, backColor=colors.HexColor("#101A25"),
                      borderPadding=5, spaceAfter=4)


def P(text, style=body):
    return Paragraph(text, style)


def codebox(lines):
    return P("<br/>".join(line.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                            for line in lines), code)


def callout(text, color=GREEN, background=LIGHT_GREEN):
    table = Table([[P(text, small)]], colWidths=[3.56 * inch])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), background),
        ("BOX", (0, 0), (0, 0), 0.4, background),
        ("LINEBEFORE", (0, 0), (0, 0), 3, color),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return table


def environment_table():
    data = [
        [P("Environment", table_header), P("Port", table_header), P("Runtime / identity", table_header), P("Data boundary", table_header)],
        [P("Development", small), P("8081", small), P("Live source; red banner", small), P("Deidentified development images and annotations", small)],
        [P("Staging", small), P("8082", small), P("Candidate JAR; yellow banner", small), P("Deidentified staging images and annotations", small)],
        [P("Rehearsal", small), P("8083", small), P("Exact staging JAR; production mode; loopback only", small), P("Deidentified production-marked images; rehearsal annotations", small)],
        [P("Production", small), P("8080", small), P("Frozen validated JAR; no banner", small), P("Authorized clinical images and production annotations", small)],
    ]
    t = Table(data, colWidths=[1.02*inch, .43*inch, 2.55*inch, 3.54*inch], repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("GRID", (0, 0), (-1, -1), .35, LINE), ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    return t


def page_one():
    left = [
        P("1. Development gate", h3),
        codebox(["cd /Users/dm026/Downloads/wsi-server_works", "git status --short", "./mvnw clean test", "node --test src/test/js/*.test.js", "./ops/tests/run.sh", "git push origin feature/multichannel-viewer"]),
        callout("<b>STOP:</b> Git must be clean and every required test must pass.", RED, LIGHT_RED),
        P("2. Build and install staging", h3),
        codebox(["./ops/wsi-release stage --dry-run", "./ops/wsi-release stage --step", "./ops/wsi-release verify staging", "wsi staging status"]),
        callout("<b>Browser 8082:</b> yellow banner; deidentified slides; viewer, channels, annotations and exports; no 403, 500 or unhandled JavaScript errors."),
    ]
    right = [
        P("3. Rehearse production mode", h3),
        codebox(["./ops/wsi-release rehearse --dry-run", "./ops/wsi-release rehearse --step", "./ops/wsi-release verify rehearsal", "wsi rehearsal status"]),
        callout("<b>Browser 8083:</b> no banner; production layout; exact staging artifact; deidentified rehearsal data only. Port 8080 remains available."),
        P("4. Promote exact rehearsed candidate", h3),
        codebox(["./ops/wsi-release verify staging", "./ops/wsi-release verify rehearsal", "./ops/wsi-release promote --dry-run", "./ops/wsi-release promote --step", "./ops/wsi-release verify production"]),
        callout("Type <b>PROMOTE</b> only when staging and rehearsal commit/SHA-256 match and the rollback backup verifies.", AMBER, LIGHT_AMBER),
        P("5. Tag after production validation", h3),
        codebox(["./ops/wsi-release tag production-YYYY-MM-DD-description"]),
    ]
    columns = Table([[left, right]], colWidths=[3.68*inch, 3.68*inch], hAlign="LEFT")
    columns.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"),
                                 ("LEFTPADDING", (0, 0), (-1, -1), 0),
                                 ("RIGHTPADDING", (0, 0), (0, -1), 8),
                                 ("LEFTPADDING", (1, 0), (1, -1), 8),
                                 ("RIGHTPADDING", (1, 0), (1, -1), 0)]))
    return [P("WSI Viewer Release Cheat Sheet", title),
            P("Development -> Staging -> Production rehearsal -> Production -> Tag", subtitle),
            P("Environments", h2), environment_table(),
            P("Normal release", h2), columns,
            Spacer(1, 5),
            callout("<b>Browser 8080:</b> normal production layout/title; authorized slides; viewer, channels, annotations and exports; no security, layout or persistence regression; other environments remain isolated.")]


def page_two():
    left = [P("Status and verification", h2),
            codebox(["wsi production status", "wsi staging status", "wsi rehearsal status", "wsi development status", "./ops/wsi-release status", "./ops/wsi-release verify staging", "./ops/wsi-release verify rehearsal", "./ops/wsi-release verify production"]),
            P("Logs", h2),
            codebox(["wsi production logs", "wsi staging logs", "wsi rehearsal logs", "wsi development logs"]),
            P("Press <b>Control-C</b> to stop following a log.", small),
            P("Rollback", h2),
            codebox(["./ops/wsi-release history", "./ops/wsi-release rollback --step", "./ops/wsi-release verify production"]),
            callout("Rollback restores the prior JAR, metadata, checksum and configuration. It <b>never restores or overwrites annotations</b>.", AMBER, LIGHT_AMBER)]
    right = [P("Troubleshooting modes", h2),
             codebox(["./ops/wsi-release stage --dry-run", "./ops/wsi-release stage --step --verbose", "./ops/wsi-release rehearse --dry-run", "./ops/wsi-release promote --dry-run", "./ops/wsi-release history"]),
             P("<b>--dry-run</b>: plan only. <b>--step</b>: Enter runs, p repeats, q exits safely. Use ./ops/wsi-release if the installed command is missing. Never bypass PROMOTE or ROLLBACK.", small),
             P("Stop conditions", h2),
             P("- Dirty Git tree or failed required test<br/>- Git HEAD differs from staging commit<br/>- Recorded/calculated SHA-256 differ<br/>- Staging and rehearsal differ<br/>- Environment identity, marker, root or port mismatch<br/>- Production backup validation fails<br/>- New 403, 500, unhandled JavaScript error, lost annotation, blank image or routine delay", small),
             callout("Do not repair a mismatch by editing build metadata or checksum files.", RED, LIGHT_RED),
             P("Marker rule", h2)]
    marker = Table([[P("Identity", table_header), P("Required marker", table_header)],
                    [P("development", small), P(".wsi-environment-development", small)],
                    [P("staging", small), P(".wsi-environment-staging", small)],
                    [P("production / rehearsal", small), P(".wsi-environment-production", small)]],
                   colWidths=[1.2*inch, 2.36*inch])
    marker.setStyle(TableStyle([("BACKGROUND", (0,0), (-1,0), NAVY), ("TEXTCOLOR", (0,0), (-1,0), colors.white),
                                ("GRID", (0,0), (-1,-1), .35, LINE), ("LEFTPADDING", (0,0), (-1,-1), 4),
                                ("RIGHTPADDING", (0,0), (-1,-1), 4), ("TOPPADDING", (0,0), (-1,-1), 3),
                                ("BOTTOMPADDING", (0,0), (-1,-1), 3)]))
    right.append(marker)
    columns = Table([[left, right]], colWidths=[3.68*inch, 3.68*inch])
    columns.setStyle(TableStyle([("VALIGN", (0,0), (-1,-1), "TOP"), ("LEFTPADDING", (0,0), (-1,-1), 0),
                                 ("RIGHTPADDING", (0,0), (0,-1), 8), ("LEFTPADDING", (1,0), (1,-1), 8),
                                 ("RIGHTPADDING", (1,0), (1,-1), 0)]))
    return [P("Troubleshooting and Recovery", title), columns, Spacer(1, 5),
            callout("<b>Timing:</b> Image-switch total ends at OpenSeadragon open and may not include all visible tiles. Use browser Network timing and server logs for repeatable delays.", AMBER, LIGHT_AMBER),
            Spacer(1, 4),
            callout("<b>Privacy:</b> Never copy production slides into development, staging or rehearsal. Verify filenames, metadata, embedded labels, thumbnails, macro images and associated files. Never synthesize a missing embedded label/thumbnail from diagnostic pixels.", RED, LIGHT_RED),
            Spacer(1, 4), P("Exactly one environment marker must exist. A missing, multiple or cross-environment marker prevents startup before the server accepts requests.", small)]


def build():
    doc = BaseDocTemplate(str(OUTPUT), pagesize=letter,
                          leftMargin=.43*inch, rightMargin=.43*inch,
                          topMargin=.38*inch, bottomMargin=.42*inch,
                          title="WSI Viewer Release Cheat Sheet",
                          author="WSI Viewer Operations")
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="normal")
    doc.addPageTemplates(PageTemplate(id="sheet", frames=[frame], onPage=footer))
    story = page_one() + [PageBreak()] + page_two()
    doc.build(story)
    print(OUTPUT)


if __name__ == "__main__":
    build()
