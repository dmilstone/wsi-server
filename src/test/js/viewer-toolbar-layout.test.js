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

function toolbarControlMarkup(id) {
    const match = html.match(new RegExp(`<(?:button|a)\\s[^>]*id="${id}"[^>]*>`));
    assert.ok(match, `missing toolbar control ${id}`);
    return match[0];
}

// Compact icon hit target: consistent 28px contract, icons only (no label chrome).
const button = rule(".toolbar-button, a.toolbar-button");
assert.match(button, /min-width:\s*28px/);
assert.match(button, /height:\s*28px/);
assert.match(button, /min-height:\s*28px/);
assert.match(button, /width:\s*28px/);
assert.match(button, /background:\s*transparent/);

// Inactive/active/disabled chrome is normalized in the compact toolbar.
assert.match(
    html,
    /\.viewer-toolbar \.toolbar-button\[aria-pressed="true"\]:not\(:disabled\)[^{]*\{[^}]*background:\s*rgba\(77,\s*148,\s*216,\s*\.22\)/
);
assert.match(html, /\.toolbar-button:disabled[^{]*\{[^}]*opacity:\s*\.38/);
assert.match(html, /\.toolbar-button:hover:not\(:disabled\)/);
assert.doesNotMatch(
    html,
    /\.viewer-toolbar \.toolbar-button\[aria-pressed="true"\]:not\(:disabled\)[^{]*\{[^}]*background:\s*var\(--accent\)/
);

// Header-row toolbar above the viewer stage — never overlays WSI pixels.
const viewerMain = rule(".viewer-main");
assert.match(viewerMain, /grid-template-rows:\s*minmax\(0,\s*1fr\)/);
assert.match(viewerMain, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
assert.match(rule(".viewer-stage"), /grid-row:\s*1/);
assert.match(html, /id="z-depth-controls"/);
assert.match(html, /id="channels-panel"[\s\S]*id="pilot-feedback-link"[\s\S]*id="series-select-control"[\s\S]*id="z-depth-controls"/);
assert.match(html, /class="right-stack-controls"/);
assert.match(html, /class="right-column-top"/);
assert.ok(
    html.indexOf('id="pilot-feedback-link"') < html.indexOf('id="series-select-control"')
        && html.indexOf('id="series-select-control"') < html.indexOf('id="z-depth-controls"')
        && html.indexOf('id="z-depth-controls"') < html.indexOf('<h2>Channels</h2>'),
    "feedback/ops, series, then Z controls must sit above the Channels header"
);
assert.match(html, />Pilot Feedback \(F\)</);
assert.doesNotMatch(html, /Choose visible channels and adjust how signal is displayed/);
assert.doesNotMatch(html, /Press F in the viewer to toggle the feedback panel/);
assert.doesNotMatch(
    html.slice(html.indexOf('id="channels-panel"'), html.indexOf('id="channels"')),
    /class="panel-kicker"/
);
assert.doesNotMatch(html, /id="z-movie-play"/);
assert.match(html, /id="z-movie-mode-loop"/);
assert.match(html, /id="z-movie-mode-pingpong"/);
assert.match(html, /id="z-movie-mode-loop"[^>]*>🔁</);
assert.match(html, /id="z-movie-mode-pingpong"[^>]*>↔️</);
assert.match(html, /id="z-stack-slider"[^>]*type="range"/);
assert.match(html, /Focal Depth \(Z\)/);
assert.match(html, /maxImageCacheCount:\s*500/);
assert.doesNotMatch(html, /Focal Animation Player/);
assert.doesNotMatch(html, /id="z-movie-control"/);
assert.doesNotMatch(html, /id="z-stack-control"/);
assert.doesNotMatch(html, /writing-mode:\s*vertical-lr/);
assert.match(html, /id="series-select-control"/);
assert.match(html, /id="series-select"/);
assert.match(html, /Select Scan Section \/ Series/);
assert.match(html, /function syncZStackControl\(/);
assert.match(html, /function syncSeriesSelectControl\(/);
assert.match(html, /function flushViewerTileCache\(/);
assert.match(html, /AnnotationAdapter\.appendTileDepthQuery/);
assert.match(html, /AnnotationAdapter\.bindZMovieModeButtons/);
assert.match(html, /zPlanes/);
assert.match(html, /seriesProfiles/);
assert.match(rule(".z-depth-controls"), /display:\s*flex/);
assert.doesNotMatch(rule(".z-depth-controls"), /position:\s*absolute/);
assert.match(rule(".series-select-control"), /position:\s*static/);
assert.doesNotMatch(rule(".series-select-control"), /position:\s*absolute/);
assert.match(
    html,
    /\.z-movie-icon\.is-active[\s\S]*?background:\s*rgba\(77,\s*148,\s*216,\s*\.42\)/
);
assert.match(html, /\.z-movie-icon\.z-movie-mode-active/);
assert.match(html, /class="app-header"/);
assert.match(html, /id="tools-tray"[^>]*class="tools-tray"/);
assert.ok(
    html.indexOf('id="tools-tray"') < html.indexOf('class="viewer-stage"'),
    "toolbar must appear before the viewer stage"
);
assert.match(rule(".tools-tray"), /justify-content:\s*safe center/);

// Removed toolbar controls and collapse persistence.
for (const removedId of [
    "open-image", "fit-view", "pan-mode", "select-mode", "toggle-tools", "reveal-tools"
]) {
    assert.doesNotMatch(html, new RegExp(`id="${removedId}"`));
}
assert.doesNotMatch(html, /function setToolsCollapsed\(collapsed\)/);
assert.doesNotMatch(html, /toolsCollapsed/);
assert.doesNotMatch(html, /tools-collapsed/);

// Header: current image beneath WSI Viewer; no fluorescence subtitle or competing context row.
assert.doesNotMatch(html, /Whole-slide fluorescence imaging/);
assert.doesNotMatch(html, /class="brand-subtitle"/);
assert.doesNotMatch(html, /class="header-context"/);
assert.match(html, /class="brand-current-image"/);
assert.match(html, /class="header-label">Current image</);
assert.match(html, /id="selected-name">No image selected/);
const brandCurrent = rule(".brand-current-image");
assert.match(brandCurrent, /overflow:\s*hidden/);
assert.match(rule("#selected-name"), /max-width:\s*100%/);
assert.match(rule("#selected-name"), /text-overflow:\s*ellipsis/);

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

// Annotation name editor is not a toolbar field; inline label editing is used.
assert.match(rule(".toolbar-group"), /flex:\s*0 0 auto/);
assert.doesNotMatch(html, /annotation-name-group/);
assert.doesNotMatch(html, /annotation-name-control/);
assert.match(html, /id="annotation-name-portal"/);
assert.match(html, /id="annotation-name"[^>]*class="annotation-name-inline-input"/);
assert.match(html, /id="annotation-name"[^>]*hidden/);
assert.match(rule("#annotation-name-portal"), /display:\s*none\s*!important/);
assert.doesNotMatch(
    html.slice(html.indexOf('class="app-header"'), html.indexOf("</header>")),
    /id="annotation-name"/,
    "annotation-name input must not sit in the header toolbar row"
);
assert.match(rule(".annotation-name-label.is-editable"), /pointer-events:\s*auto/);
const nameEditorSource = fs.readFileSync(
    path.join(__dirname, "../../main/resources/static/annotation-name-editor.js"), "utf8");
const spikeSource = fs.readFileSync(
    path.join(__dirname, "../../main/resources/static/annotorious-spike.js"), "utf8");
assert.match(spikeSource, /beginInlineEdit/);
assert.match(nameEditorSource, /beginEdit\(/);
assert.match(nameEditorSource, /this\.input\.select\?\.\(\)/);

// Narrow viewports keep stage full-height under the header toolbar.
const narrow = rule(".viewer-main", "max-width:\\s*820px");
assert.match(narrow, /grid-template-rows:\s*minmax\(0,\s*1fr\)/);
assert.match(rule(".viewer-stage", "max-width:\\s*820px"), /grid-row:\s*1/);
assert.match(rule(".brand-copy", "max-width:\\s*820px"), /max-width:\s*min\(52vw,\s*360px\)/);

// Exact retained toolbar order (left to right) for the scrolling tools tray.
const headerHtml = html.slice(
    html.indexOf('class="app-header"'),
    html.indexOf("</header>")
);
assert.match(headerHtml, /id="header-app-nav"/);
assert.match(headerHtml, /class="header-app-nav"/);
const toolsTrayHtml = headerHtml.slice(
    headerHtml.indexOf('id="tools-tray"'),
    headerHtml.indexOf('id="header-app-nav"')
);
const appNavHtml = headerHtml.slice(headerHtml.indexOf('id="header-app-nav"'));
const orderedIds = [
    "home-view", "toggle-left",
    "zoom-in", "zoom-out",
    "annotation-mode",
    "annotation-visibility", "annotation-names",
    "export-visible-region", "export-selected-annotation",
    "slide-overview-button", "full-screen", "presentation"
];
let cursor = -1;
for (const id of orderedIds) {
    const idx = toolsTrayHtml.indexOf(`id="${id}"`);
    assert.ok(idx > cursor, `tools tray order includes ${id} after prior controls`);
    cursor = idx;
}
assert.doesNotMatch(toolsTrayHtml, /id="dashboard-link"/);
assert.doesNotMatch(toolsTrayHtml, /id="viewer-quick-guide-link"/);
assert.doesNotMatch(toolsTrayHtml, /id="admin-ops-guide-link"/);
assert.doesNotMatch(toolsTrayHtml, /id="toggle-right"/);

// Home leftmost among tool controls in the scrolling tray.
const firstToolId = toolsTrayHtml.search(/id="(home-view|toggle-left|zoom-in)"/);
assert.ok(firstToolId >= 0);
assert.equal(toolsTrayHtml.indexOf('id="home-view"'), firstToolId);
const homeIdx = toolsTrayHtml.indexOf('id="home-view"');
const imagesIdx = toolsTrayHtml.indexOf('id="toggle-left"');
const settingsIdx = appNavHtml.indexOf('id="toggle-right"');
const dashboardIdx = appNavHtml.indexOf('id="dashboard-link"');
const viewerGuideIdx = appNavHtml.indexOf('id="viewer-quick-guide-link"');
const adminGuideIdx = appNavHtml.indexOf('id="admin-ops-guide-link"');
assert.ok(imagesIdx > homeIdx, "Images immediately follows Home");
assert.ok(settingsIdx >= 0 && dashboardIdx > settingsIdx, "Settings precedes Dashboard");
assert.ok(dashboardIdx < viewerGuideIdx, "Dashboard precedes Viewer Quick Guide");
assert.ok(viewerGuideIdx < adminGuideIdx, "Viewer Quick Guide precedes Admin & Ops Guide");
assert.ok(adminGuideIdx === Math.max(settingsIdx, dashboardIdx, viewerGuideIdx, adminGuideIdx), "Admin & Ops Guide is the rightmost app-nav control");

// Pan/select modes removed; default OSD drag-pan and Annotorious selection remain.
assert.doesNotMatch(html, /navigateMode/);
assert.doesNotMatch(html, /syncNavigateModeButtons/);
assert.match(spikeSource, /setDrawingEnabled/);
assert.match(spikeSource, /selectionChanged/);

// Local operations stays available, but never as primary header/toolbar chrome.
assert.doesNotMatch(headerHtml, /id="local-operations"/);
assert.doesNotMatch(headerHtml, /header-actions/);
assert.doesNotMatch(headerHtml, /Local operations/);
assert.doesNotMatch(headerHtml, /class="header-nav"/);
// Conditionally rendered Dashboard link lives next to Help in the pinned app nav.
assert.match(
    appNavHtml,
    /id="dashboard-link"[^>]*href="http:\/\/127\.0\.0\.1:8084\/"/
);
assert.match(
    appNavHtml,
    /id="dashboard-link"[^>]*target="_blank"/
);
assert.match(
    appNavHtml,
    /id="dashboard-link"[^>]*rel="noopener"/
);
assert.match(
    appNavHtml,
    /id="dashboard-link"[^>]*aria-label="Dashboard"/
);
assert.match(
    appNavHtml,
    /id="dashboard-link"[^>]*data-tooltip="Dashboard&#10;Open the local operations dashboard on 127\.0\.0\.1:8084"/
);
assert.match(
    appNavHtml,
    /id="viewer-quick-guide-link"[^>]*href="\/help\/viewer-guide\.html"/
);
assert.match(
    appNavHtml,
    /id="viewer-quick-guide-link"[^>]*aria-label="Viewer Quick Guide"/
);
assert.match(appNavHtml, />Viewer Quick Guide</);
assert.match(
    appNavHtml,
    /id="admin-ops-guide-link"[^>]*href="\/help"/
);
assert.match(
    appNavHtml,
    /id="admin-ops-guide-link"[^>]*aria-label="Admin &amp; Ops Guide"/
);
assert.match(appNavHtml, />Admin &amp; Ops Guide</);
assert.doesNotMatch(html, /Select one annotation/);
assert.doesNotMatch(appNavHtml, /id="viewer-help"/);
assert.doesNotMatch(appNavHtml, /id="user-guide-link"/);
assert.match(html, /#dashboard-link\.toolbar-button\.is-env-allowed/);
assert.match(html, /isDevelopmentEnvironment/);
assert.match(html, /syncDashboardLinkVisibility/);
assert.match(html, /bindDashboardOutboundNavigation/);
assert.match(html, /localOpsDashboardIsListening/);
assert.match(html, /DASHBOARD_ABSOLUTE_URL = "http:\/\/127\.0\.0\.1:8084\/"/);
assert.match(html, /\/api\/local-ops\/status/);
assert.match(html, /window\.open\(DASHBOARD_ABSOLUTE_URL/);
assert.match(html, /DASHBOARD_GATE_URL/);
assert.match(html, /isDevelopmentEnvironment\(environment\)/);
assert.doesNotMatch(
    appNavHtml,
    /id="dashboard-link"[^>]*href="\/dashboard"/
);
const channelsPanelHtml = html.slice(
    html.indexOf('id="channels-panel"'),
    html.indexOf('id="channels"')
);
assert.match(
    channelsPanelHtml,
    /id="local-operations"[^>]*href="\/local-operations\/"/
);
assert.match(channelsPanelHtml, /class="panel-secondary-link"/);
assert.match(channelsPanelHtml, />Local operations</);
assert.match(channelsPanelHtml, />Pilot Feedback \(F\)</);
assert.ok(
    channelsPanelHtml.indexOf('id="pilot-feedback-link"')
        < channelsPanelHtml.indexOf('id="series-select-control"'),
    "pilot feedback must sit above series select in the channels panel"
);
assert.doesNotMatch(channelsPanelHtml, /Press F in the viewer to toggle the feedback panel/);
assert.doesNotMatch(channelsPanelHtml, /Choose visible channels and adjust how signal is displayed/);
assert.doesNotMatch(channelsPanelHtml, />Display</);

const localOpsGate = fs.readFileSync(
    path.join(__dirname, "../../main/resources/static/local-operations/index.html"),
    "utf8"
);
assert.match(localOpsGate, /Local operations unavailable on this computer/);
assert.match(localOpsGate, /Recovery:/);
assert.match(localOpsGate, /http:\/\/127\.0\.0\.1:8084\//);
assert.match(localOpsGate, /host === "127\.0\.0\.1"/);
assert.match(localOpsGate, /host === "localhost"/);
// Hover/focus tooltips and accessible labels on every retained toolbar control.
for (const id of [...orderedIds, "toggle-right", "dashboard-link", "viewer-quick-guide-link", "admin-ops-guide-link"]) {
    const markup = toolbarControlMarkup(id);
    assert.match(markup, /aria-label="/, `${id} needs aria-label`);
    assert.match(markup, /data-tooltip="/, `${id} needs data-tooltip`);
    assert.match(markup, /\stitle="/, `${id} needs title fallback`);
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

// No floating export palette; exports are direct adjacent icon buttons.
assert.match(
    html,
    /id="export-visible-region"[^>]*aria-label="Export visible region"/
);
assert.match(
    html,
    /id="export-selected-annotation"[^>]*aria-label="Export selected annotation"/
);
assert.match(
    html,
    /id="export-visible-region"[^>]*data-tooltip="Export visible region&#10;Export the area currently visible in the viewer at native resolution"/
);
assert.match(
    html,
    /id="export-selected-annotation"[^>]*data-tooltip="Export selected annotation&#10;Export the selected annotation region"/
);
assert.doesNotMatch(html, /id="export-menu"/);
assert.doesNotMatch(html, /function positionExportMenu/);
assert.match(html, /function normalizeExportBounds\(/);
assert.match(html, /function exportScaleForRegion\(/);
assert.match(html, /function sanitizeExportFilenamePart\(/);
assert.match(html, /function buildExportDownloadName\(/);
assert.match(html, /function exportVisibleRegion\(/);
assert.match(html, /function exportSelectedAnnotation\(/);
assert.match(html, /zoomBy\(1\.25,\s*null\)/);
assert.match(html, /zoomBy\(0\.8,\s*null\)/);
assert.match(html, /function withReadyViewport\(/);

// Unimplemented drawing tools must not appear as normal toolbar controls.
assert.doesNotMatch(html, /id="polygon-mode"/);
assert.doesNotMatch(html, /id="freehand-mode"/);
assert.doesNotMatch(headerHtml, /not available yet/);

// Stage overlays and environment banner contracts stay intact.
assert.match(toolbar, /z-index:\s*16/);
assert.match(rule(".annotation-overlay"), /z-index:\s*10/);
assert.match(rule(".annotation-name-layer"), /z-index:\s*11/);
assert.match(rule(".image-lightbox"), /z-index:\s*40/);
assert.match(rule(".export-error-dialog"), /z-index:\s*50/);
assert.match(html, /id="export-error-dialog"/);
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
    "Home and images", "Export actions", "Viewer actions", "Settings, dashboard, and manuals", "Zoom"
]) {
    assert.match(html, new RegExp(`role="group" aria-label="${label}"`));
}
assert.doesNotMatch(html, /role="group" aria-label="Selected annotation name"/);
assert.doesNotMatch(html, /role="group" aria-label="Open and images"/);
assert.doesNotMatch(html, /role="group" aria-label="Zoom and navigation"/);
assert.match(rule("button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible"), /outline:\s*3px solid/);

console.log("viewer compact header-toolbar layout checks passed at 1440px, 1024px, and 768px");
