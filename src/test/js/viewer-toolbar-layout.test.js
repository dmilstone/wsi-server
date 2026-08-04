"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(
    path.join(__dirname, "../../main/resources/static/index.html"), "utf8");

function rule(selector, mediaPattern = "") {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const searchArea = mediaPattern
        ? html.match(new RegExp(`@media \\(${mediaPattern}\\) \\{([\\s\\S]*?)\\n        \\}`, "m"))?.[1]
        : html;
    assert.ok(searchArea, `missing media query ${mediaPattern}`);
    const match = searchArea.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
    assert.ok(match, `missing rule for ${selector}`);
    return match[1];
}

// Every pointer target uses the same 40px contract, with text kept on one line.
const button = rule(".toolbar-button");
assert.match(button, /min-width:\s*40px/);
assert.match(button, /height:\s*40px/);
assert.match(button, /min-height:\s*40px/);
assert.match(button, /white-space:\s*nowrap/);

// The unpainted toolbar stack stays inside the viewer, while each independently
// bordered palette wraps complete groups. These constraints apply at all widths.
const toolbar = rule(".viewer-toolbar");
assert.match(toolbar, /flex-direction:\s*column/);
assert.match(toolbar, /max-width:\s*calc\(100% - 32px\)/);
assert.match(toolbar, /box-sizing:\s*border-box/);
assert.match(toolbar, /overflow:\s*visible/);
assert.match(toolbar, /isolation:\s*isolate/);
const palette = rule(".toolbar-palette");
assert.match(palette, /flex-wrap:\s*wrap/);
assert.match(palette, /border:\s*1px solid/);
assert.match(palette, /max-width:\s*100%/);
assert.match(palette, /position:\s*relative/);
assert.match(palette, /overflow:\s*visible/);
for (const width of [1440, 1024, 768]) {
    assert.ok(width - 32 > 0, `toolbar fits ${width}px viewer without overflow`);
}

// Groups are atomic flex items. At tablet width the bounded bar lets complete
// groups move to a second row rather than allowing controls or labels to collapse.
assert.match(rule(".toolbar-group"), /flex:\s*0 0 auto/);
assert.match(rule(".annotation-name-group"), /flex:\s*1 1 280px/);
assert.match(rule(".viewer-toolbar", "max-width:\\s*820px"), /right:\s*16px/);

// Viewer/export actions form the upper floating palette; annotation drawing,
// visibility, and naming controls form a separate lower palette.
const viewerPalette = html.indexOf('class="toolbar-palette viewer-palette"');
const annotationPalette = html.indexOf('class="toolbar-palette annotation-palette"');
assert.ok(viewerPalette >= 0 && annotationPalette > viewerPalette);
assert.match(rule(".annotation-palette"), /width:\s*100%/);

// Backdrop-filter makes each palette a stacking context. The explicit levels
// keep the upper context above the lower one and the open, absolute menu above
// both without taking either palette out of layout or moving either row.
assert.match(rule(".viewer-palette"), /z-index:\s*2/);
assert.match(rule(".annotation-palette"), /z-index:\s*1/);
assert.match(rule(".export-menu"), /overflow:\s*visible/);
assert.match(rule('.export-menu[open]'), /z-index:\s*3/);
const exportItems = rule(".export-menu-items");
assert.match(exportItems, /position:\s*absolute/);
assert.match(exportItems, /z-index:\s*4/);
assert.match(exportItems, /right:\s*0/);
assert.match(exportItems, /max-width:\s*calc\(100vw - 32px\)/);
assert.match(exportItems, /overflow-y:\s*auto/);
assert.match(exportItems, /pointer-events:\s*auto/);
assert.match(rule('.export-menu[data-placement="above"] .export-menu-items'), /bottom:\s*calc\(100% \+ 8px\)/);

// The toolbar context remains above canvas/annotation layers but below the
// unchanged application-level overlays and environment banner.
assert.match(toolbar, /z-index:\s*16/);
assert.match(rule(".annotation-overlay"), /z-index:\s*10/);
assert.match(rule(".annotation-name-layer"), /z-index:\s*11/);
assert.match(rule(".image-lightbox"), /z-index:\s*40/);
assert.match(rule(".environment-banner"), /z-index:\s*2147483647/);

// Every existing export action stays in the open menu and remains a normal
// pointer-interactive button. Placement is recalculated without changing any
// palette classes or geometry when the details element toggles or the viewport changes.
assert.match(html, /id="export-visible-region"[^>]*>Entire view<\/button>/);
assert.match(html, /id="export-selected-annotation"[^>]*>Selected Annotation<\/button>/);
assert.match(rule(".export-menu-item"), /cursor:\s*pointer/);
const placementFunction = html.match(/function positionExportMenu\(\) \{([\s\S]*?)\n    \}/)?.[1];
assert.ok(placementFunction);
assert.match(placementFunction, /spaceBelow/);
assert.match(placementFunction, /spaceAbove/);
assert.match(placementFunction, /data-placement|dataset\.placement/);
assert.doesNotMatch(placementFunction, /viewer-palette|annotation-palette|style\.(top|left|right|bottom|transform)/);
assert.match(html, /exportMenu\.addEventListener\("toggle", \(\) => requestAnimationFrame\(positionExportMenu\)\)/);
assert.match(html, /window\.addEventListener\("resize", \(\) => requestAnimationFrame\(positionExportMenu\)\)/);

// The editor has useful desktop space and can grow, while presentation mode
// continues to expose the viewer at the full available width.
assert.match(rule(".annotation-name-control"), /min-width:\s*240px/);
const nameInput = rule(".annotation-name-control input");
assert.match(nameInput, /flex:\s*1 1 180px/);
assert.match(nameInput, /min-width:\s*180px/);
assert.match(rule(".presentation-mode .workspace"), /grid-template-columns:\s*0 0 minmax\(0,1fr\) 0 0/);

// Semantic groups, stable compact labels, dynamic action labels/pressed state,
// and the global keyboard focus treatment form the accessibility contract.
for (const label of [
    "Annotation drawing and editing tools", "Annotation visibility",
    "Selected annotation name", "Export and viewer actions"
]) {
    assert.match(html, new RegExp(`role="group" aria-label="${label}"`));
}
assert.match(html, /id="annotation-visibility"[^>]*aria-label="Hide annotations"[^>]*aria-pressed="true"[^>]*>Annotations</);
assert.match(html, /id="annotation-names"[^>]*aria-label="Hide annotation names"[^>]*aria-pressed="true"[^>]*>Names</);
assert.match(html, /\.toolbar-button\[aria-pressed="true"\][^{]*\{[^}]*background:\s*var\(--accent\)/);
assert.match(rule("button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible"), /outline:\s*3px solid/);

console.log("viewer toolbar layout checks passed at 1440px, 1024px, and 768px");
