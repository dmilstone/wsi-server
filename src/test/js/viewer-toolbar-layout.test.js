"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(
    path.join(__dirname, "../../main/resources/static/index.html"), "utf8");

function rule(selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = html.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
    assert.ok(match, `missing rule for ${selector}`);
    return match[1];
}

// The toolbar redesign replaced fixed 40x40px square buttons with auto-sized, content-driven
// buttons (padding/font-size keep them a comfortable pointer target without a hardcoded box),
// and text never wraps onto a second line.
const button = rule(".toolbar-button, a.toolbar-button");
assert.match(button, /display:\s*inline-grid/);
assert.match(button, /place-items:\s*center/);
assert.match(button, /padding:\s*0\.4em 0\.8em/);
assert.match(button, /white-space:\s*nowrap/);
assert.match(button, /cursor:\s*pointer/);

// The toolbar itself is a single-row flex bar (not the old floating multi-palette layout) that
// stays visible/interactive above the canvas and annotation layers.
const toolbar = rule(".viewer-toolbar");
assert.match(toolbar, /display:\s*flex/);
assert.match(toolbar, /flex-direction:\s*row/);
assert.match(toolbar, /overflow:\s*visible/);
assert.match(toolbar, /isolation:\s*isolate/);
assert.match(toolbar, /z-index:\s*16/);

// Tool groups are atomic flex items with a visible divider between adjacent groups.
assert.match(rule(".toolbar-group"), /flex:\s*0 0 auto/);
assert.match(html, /\.toolbar-group \+ \.toolbar-group\s*\{[^}]*border-left:\s*1px solid/);

// The real, current semantic groups (drawing tools, visibility, export, viewer actions,
// display adjustments) must each be reachable via role="group" + aria-label, independent of
// exactly how many groups there are or what markup wraps them.
for (const label of [
    "Annotation drawing and editing tools", "Annotation visibility",
    "Export actions", "Viewer actions"
]) {
    assert.match(html, new RegExp(`role="group" aria-label="${label}"`));
}

// Visibility/name toggles expose their pressed state for both styling and accessibility.
assert.match(html, /id="annotation-visibility"[^>]*aria-label="Hide annotations"[^>]*aria-pressed="true"[^>]*>Annotations</);
assert.match(html, /id="annotation-names"[^>]*aria-label="Hide annotation names"[^>]*aria-pressed="true"[^>]*>Names</);
assert.match(html, /\.toolbar-button\[aria-pressed="true"\][^{]*\{[^}]*background:\s*var\(--accent\)/);

// The global keyboard focus treatment still applies to every interactive control.
assert.match(rule("button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible"),
    /outline:\s*3px solid/);

console.log("viewer toolbar layout checks passed");
