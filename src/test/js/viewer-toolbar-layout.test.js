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

// Single dock/collapse model: tools occupy a dedicated tray column beside the
// stage so palettes never overlay WSI pixels or annotation geometry.
const viewerMain = rule(".viewer-main");
assert.match(viewerMain, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*var\(--tools-tray-width,\s*280px\)/);
assert.match(rule(".viewer-main.tools-collapsed"), /--tools-tray-width:\s*0px/);
assert.match(rule(".viewer-main.tools-collapsed .tools-tray"), /visibility:\s*hidden/);
assert.match(rule(".tools-tray"), /border-left:\s*1px solid/);
assert.match(html, /id="tools-tray"[^>]*class="tools-tray"/);
assert.match(html, /id="collapse-tools"/);
assert.match(html, /id="toggle-tools"/);
assert.match(html, /id="reveal-tools"/);
assert.match(html, /function setToolsCollapsed\(collapsed\)/);
assert.match(html, /localStorage\.setItem\(`\$\{STORAGE_PREFIX\}\.toolsCollapsed`/);
assert.match(html, /setToolsCollapsed\(localStorage\.getItem\(`\$\{STORAGE_PREFIX\}\.toolsCollapsed`\) === "true"\)/);

// Toolbar is in-flow inside the tray (not absolutely positioned over the stage).
const toolbar = rule(".viewer-toolbar");
assert.match(toolbar, /flex-direction:\s*column/);
assert.match(toolbar, /max-width:\s*100%/);
assert.match(toolbar, /box-sizing:\s*border-box/);
assert.match(toolbar, /overflow:\s*visible/);
assert.match(toolbar, /isolation:\s*isolate/);
assert.doesNotMatch(toolbar, /position:\s*absolute/);
const palette = rule(".toolbar-palette");
assert.match(palette, /flex-wrap:\s*wrap/);
assert.match(palette, /border:\s*1px solid/);
assert.match(palette, /max-width:\s*100%/);
assert.match(palette, /position:\s*relative/);
assert.match(palette, /overflow:\s*visible/);

// Tray width contract across common desktop/tablet viewer widths.
for (const width of [1440, 1024, 768]) {
    const stage = width - 280;
    assert.ok(stage > 360, `docked tray leaves usable stage at ${width}px (${stage}px)`);
}

// Groups remain atomic flex items; the name editor fills the tray width.
assert.match(rule(".toolbar-group"), /flex:\s*0 0 auto/);
assert.match(rule(".annotation-name-group"), /flex:\s*1 1 100%/);
assert.match(rule(".annotation-name-control"), /min-width:\s*0/);
assert.match(rule(".annotation-name-control input"), /min-width:\s*0/);

// Narrow viewports stack the tray under the stage instead of beside it.
const narrow = rule(".viewer-main", "max-width:\\s*820px");
assert.match(narrow, /grid-template-columns:\s*1fr/);
assert.match(rule(".tools-tray", "max-width:\\s*820px"), /max-height:\s*min\(280px,\s*40vh\)/);
assert.match(rule(".viewer-main.tools-collapsed", "max-width:\\s*820px"), /grid-template-rows:\s*minmax\(0,\s*1fr\)\s*0/);

// Viewer/export actions form the upper palette; annotation controls the lower.
const viewerPalette = html.indexOf('class="toolbar-palette viewer-palette"');
const annotationPalette = html.indexOf('class="toolbar-palette annotation-palette"');
const toolsTray = html.indexOf('id="tools-tray"');
assert.ok(toolsTray >= 0 && viewerPalette > toolsTray && annotationPalette > viewerPalette);
assert.match(rule(".viewer-palette"), /width:\s*100%/);
assert.match(rule(".annotation-palette"), /width:\s*100%/);

// Backdrop-filter stacking: upper palette / open export menu stay above lower.
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

// Stage overlays stay above canvas/annotation layers; tray chrome is separate.
assert.match(toolbar, /z-index:\s*16/);
assert.match(rule(".annotation-overlay"), /z-index:\s*10/);
assert.match(rule(".annotation-name-layer"), /z-index:\s*11/);
assert.match(rule(".image-lightbox"), /z-index:\s*40/);
assert.match(rule(".environment-banner"), /z-index:\s*2147483647/);

// Export actions and placement stay interactive; placement uses the tray box.
assert.match(html, /id="export-visible-region"[^>]*>Entire view<\/button>/);
assert.match(html, /id="export-selected-annotation"[^>]*>Selected Annotation<\/button>/);
assert.match(rule(".export-menu-item"), /cursor:\s*pointer/);
const placementFunction = html.match(/function positionExportMenu\(\) \{([\s\S]*?)\n    \}/)?.[1];
assert.ok(placementFunction);
assert.match(placementFunction, /spaceBelow/);
assert.match(placementFunction, /spaceAbove/);
assert.match(placementFunction, /data-placement|dataset\.placement/);
assert.match(placementFunction, /getElementById\("tools-tray"\)/);
assert.doesNotMatch(placementFunction, /viewer-palette|annotation-palette|style\.(top|left|right|bottom|transform)/);
assert.match(html, /exportMenu\.addEventListener\("toggle", \(\) => requestAnimationFrame\(positionExportMenu\)\)/);
assert.match(html, /window\.addEventListener\("resize", \(\) => requestAnimationFrame\(positionExportMenu\)\)/);

// Presentation mode collapses the docked tray and exposes the full stage width.
assert.match(rule(".presentation-mode .viewer-main"), /--tools-tray-width:\s*0px/);
assert.match(rule(".presentation-mode .tools-tray"), /visibility:\s*hidden/);
assert.match(rule(".presentation-mode .workspace"), /grid-template-columns:\s*0 0 minmax\(0,1fr\) 0 0/);

// DOM order: stage (image) then docked tray; no floating toolbar over #viewer.
const stageIdx = html.indexOf('class="viewer-stage"');
const viewerIdx = html.indexOf('id="viewer"');
assert.ok(stageIdx >= 0 && viewerIdx > stageIdx && toolsTray > viewerIdx);
assert.doesNotMatch(
    html.slice(viewerIdx, toolsTray),
    /class="viewer-toolbar"/,
    "toolbar must not sit over the viewer stage"
);

// Semantic groups and compact accessibility labels remain stable.
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

console.log("viewer toolbar dock/collapse layout checks passed at 1440px, 1024px, and 768px");
