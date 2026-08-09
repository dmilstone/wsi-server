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

// Compact icon hit target: consistent 28px contract, icons only (no label chrome).
const button = rule(".toolbar-button, a.toolbar-button");
assert.match(button, /min-width:\s*28px/);
assert.match(button, /height:\s*28px/);
assert.match(button, /min-height:\s*28px/);
assert.match(button, /width:\s*28px/);

// Header-row toolbar above the viewer stage — never overlays WSI pixels.
const viewerMain = rule(".viewer-main");
assert.match(viewerMain, /grid-template-rows:\s*minmax\(0,\s*1fr\)/);
assert.match(viewerMain, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
assert.match(rule(".viewer-stage"), /grid-row:\s*1/);
assert.match(html, /class="app-header"/);
assert.match(html, /id="tools-tray"[^>]*class="tools-tray"/);
assert.ok(
    html.indexOf('id="tools-tray"') < html.indexOf('class="viewer-stage"'),
    "toolbar must appear before the viewer stage"
);
assert.match(rule(".tools-tray"), /justify-content:\s*center/);
assert.match(rule(".tools-tray.tools-collapsed"), /visibility:\s*hidden/);
assert.match(html, /id="collapse-tools"/);
assert.match(html, /id="toggle-tools"/);
assert.match(html, /id="reveal-tools"/);
assert.match(html, /function setToolsCollapsed\(collapsed\)/);
assert.match(html, /tools-tray"\)\.classList\.toggle\("tools-collapsed"/);
assert.match(html, /localStorage\.setItem\(`\$\{STORAGE_PREFIX\}\.toolsCollapsed`/);

// Toolbar is a single horizontal in-flow row in the header (not over #viewer).
const toolbar = rule(".viewer-toolbar");
assert.match(toolbar, /flex-direction:\s*row/);
assert.match(toolbar, /flex-wrap:\s*nowrap/);
assert.match(toolbar, /min-height:\s*32px/);
assert.doesNotMatch(toolbar, /position:\s*absolute/);
assert.doesNotMatch(html, /toolbar-palette/);
assert.doesNotMatch(html, /tools-tray-title/);

// Compact height leaves nearly full stage height at common desktop widths.
for (const [width, height] of [[1440, 900], [1024, 768], [768, 1024]]) {
    const chrome = 58 + 30; // header (includes toolbar) + status
    const stageHeight = height - chrome;
    assert.ok(stageHeight > 480, `header toolbar leaves usable stage at ${width}x${height} (${stageHeight}px)`);
}

// Groups remain atomic; name editor stays compact in the toolbar row.
assert.match(rule(".toolbar-group"), /flex:\s*0 0 auto/);
assert.match(rule(".annotation-name-group"), /flex:\s*0 1 160px/);
assert.match(rule(".annotation-name-control input"), /height:\s*28px/);

// Narrow viewports keep stage full-height under the header toolbar.
const narrow = rule(".viewer-main", "max-width:\\s*820px");
assert.match(narrow, /grid-template-rows:\s*minmax\(0,\s*1fr\)/);
assert.match(rule(".viewer-stage", "max-width:\\s*820px"), /grid-row:\s*1/);

// Reference tool order (primary controls), then preserved extras.
const toolbarHtml = html.slice(
    html.indexOf('class="viewer-toolbar"'),
    html.indexOf('class="header-actions"')
);
const orderedIds = [
    "open-image", "toggle-left",
    "zoom-in", "zoom-out", "fit-view", "pan-mode", "select-mode",
    "annotation-mode", "polygon-mode", "freehand-mode",
    "annotation-visibility",
    "export-visible-region", "export-selected-annotation",
    "viewer-help", "toggle-right"
];
let cursor = -1;
for (const id of orderedIds) {
    const idx = toolbarHtml.indexOf(`id="${id}"`);
    assert.ok(idx > cursor, `toolbar order includes ${id}`);
    cursor = idx;
}

// Hover/focus tooltips and accessible labels on every toolbar control.
const extraIds = [
    "home-view", "annotation-names", "slide-overview-button",
    "full-screen", "toggle-tools", "collapse-tools", "presentation"
];
for (const id of [...orderedIds, ...extraIds]) {
    const controlMatch = html.match(new RegExp(`id="${id}"[^>]*`));
    assert.ok(controlMatch, `missing control ${id}`);
    assert.match(controlMatch[0], /aria-label="/);
    assert.match(controlMatch[0], /data-tooltip="/);
}
assert.match(html, /id="annotation-name"[^>]*aria-label="Annotation name"/);
assert.match(rule(".toolbar-button[data-tooltip]::after"), /content:\s*attr\(data-tooltip\)/);
assert.match(html, /\.toolbar-button\[data-tooltip\]:hover::after/);
assert.match(html, /\.toolbar-button\[data-tooltip\]:focus-visible::after/);
assert.match(html, /white-space:\s*pre-line/);

// Icon-only visibility controls keep API textContent contract but hide glyphs via CSS.
assert.match(html, /id="annotation-visibility"[^>]*aria-label="Hide annotations"[^>]*aria-pressed="true"[^>]*>Annotations</);
assert.match(html, /id="annotation-names"[^>]*aria-label="Hide annotation names"[^>]*aria-pressed="true"[^>]*>Names</);
assert.match(rule(".annotation-visibility,\n        .annotation-names"), /font-size:\s*0/);

// No floating export palette; exports are direct icon buttons.
assert.match(html, /id="export-visible-region"[^>]*aria-label="Export view"/);
assert.match(html, /id="export-selected-annotation"[^>]*aria-label="Export annotations"/);
assert.doesNotMatch(html, /id="export-menu"/);
assert.doesNotMatch(html, /function positionExportMenu/);

// Polygon/freehand remain present but disabled (not implemented).
assert.match(html, /id="polygon-mode"[^>]*disabled/);
assert.match(html, /id="freehand-mode"[^>]*disabled/);

// Stage overlays and environment banner contracts stay intact.
assert.match(toolbar, /z-index:\s*16/);
assert.match(rule(".annotation-overlay"), /z-index:\s*10/);
assert.match(rule(".annotation-name-layer"), /z-index:\s*11/);
assert.match(rule(".image-lightbox"), /z-index:\s*40/);
assert.match(rule(".environment-banner"), /z-index:\s*2147483647/);
assert.match(html, /id="environment-banner"/);

// Presentation mode hides the header toolbar; stage stays full-bleed in viewer-main.
assert.match(rule(".presentation-mode .tools-tray"), /visibility:\s*hidden/);
assert.match(rule(".presentation-mode .workspace"), /grid-template-columns:\s*0 0 minmax\(0,1fr\) 0 0/);

// Toolbar must not sit inside the viewer stage / #viewer.
const stageIdx = html.indexOf('class="viewer-stage"');
const viewerIdx = html.indexOf('id="viewer"');
const mainEnd = html.indexOf("</main>");
assert.ok(stageIdx >= 0 && viewerIdx > stageIdx);
assert.doesNotMatch(
    html.slice(stageIdx, mainEnd),
    /class="viewer-toolbar"/,
    "toolbar must not sit over the viewer stage"
);

for (const label of [
    "Annotation drawing and editing tools", "Annotation visibility",
    "Selected annotation name", "Zoom and navigation", "Export actions",
    "Open and images"
]) {
    assert.match(html, new RegExp(`role="group" aria-label="${label}"`));
}
assert.match(html, /\.toolbar-button\[aria-pressed="true"\][^{]*\{[^}]*background:\s*var\(--accent\)/);
assert.match(rule("button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible"), /outline:\s*3px solid/);

console.log("viewer compact header-toolbar layout checks passed at 1440px, 1024px, and 768px");
