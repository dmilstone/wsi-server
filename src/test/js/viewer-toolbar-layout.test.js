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
const palette = rule(".toolbar-palette");
assert.match(palette, /flex-wrap:\s*wrap/);
assert.match(palette, /border:\s*1px solid/);
assert.match(palette, /max-width:\s*100%/);
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
