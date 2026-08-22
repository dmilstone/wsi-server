"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(
    path.join(__dirname, "../../main/resources/static/index.html"),
    "utf8"
);

function hasRule(selector, declarations) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rule = new RegExp(`${escapedSelector}\\s*\\{[^}]*${declarations}[^}]*\\}`);
    assert.match(html, rule);
}

// Production keeps a flexible (auto-sized) header row so header content can wrap/grow,
// plus a fixed viewer row and a fixed footer row — same three-row structure as before
// environment identification, just no longer hard-pixel-locked on the header.
hasRule("body", "grid-template-rows:\\s*auto minmax\\(0, 1fr\\) 1\\.875rem");

// The sidebar/viewer/right-panel split is now driven by CSS custom properties (to support
// the resizable side-panel feature) rather than hardcoded pixel widths, plus an explicit
// resizer-handle column between the left sidebar and the main viewer area.
hasRule(".workspace", "grid-template-columns:\\s*var\\(--left-panel, var\\(--sidebar-width\\)\\) var\\(--workspace-resizer\\) minmax\\(0, 1fr\\)");

// Only a nonproduction class adds a real banner row, including presentation mode.
hasRule("body.nonproduction-environment", "grid-template-rows:\\s*2\\.375rem auto minmax\\(0, 1fr\\) 1\\.875rem");
hasRule(".presentation-mode", "grid-template-rows:\\s*0 minmax\\(0,1fr\\) 0");
hasRule(".nonproduction-environment.presentation-mode", "grid-template-rows:\\s*38px 0 minmax\\(0,1fr\\) 0");

// The hidden state wins over every banner display declaration and fullscreen has no hiding rule.
hasRule(".environment-banner[hidden]", "display:\\s*none !important");
assert.doesNotMatch(html, /:fullscreen[^}]*environment-banner|fullscreen[^}]*display:\s*none/);

// The environment banner always sits above every other layer, including the viewer/annotation
// overlays and any lightbox, regardless of how tall the (now auto-sized) header grows.
hasRule(".environment-banner", "z-index:\\s*2147483647");

console.log("environment layout checks passed");
