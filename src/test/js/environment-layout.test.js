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

// Production retains the exact three-row structure used before environment identification.
hasRule("body", "grid-template-rows:\\s*58px minmax\\(0, 1fr\\) 30px");
hasRule(".workspace", "grid-template-columns:\\s*280px minmax\\(360px, 1fr\\) 360px");

// Only a nonproduction class adds a real banner row, including presentation mode.
hasRule("body.nonproduction-environment", "grid-template-rows:\\s*38px 58px minmax\\(0, 1fr\\) 30px");
hasRule(".presentation-mode", "grid-template-rows:\\s*0 minmax\\(0,1fr\\) 0");
hasRule(".nonproduction-environment.presentation-mode", "grid-template-rows:\\s*38px 0 minmax\\(0,1fr\\) 0");

// The hidden state wins over every banner display declaration and fullscreen has no hiding rule.
hasRule(".environment-banner[hidden]", "display:\\s*none !important");
assert.doesNotMatch(html, /:fullscreen[^}]*environment-banner|fullscreen[^}]*display:\s*none/);

for (const viewport of [
    {width: 1440, height: 900, productionViewer: 812, nonproductionViewer: 774, productionPresentation: 900},
    {width: 1920, height: 1080, productionViewer: 992, nonproductionViewer: 954, productionPresentation: 1080}
]) {
    assert.equal(viewport.height - 58 - 30, viewport.productionViewer,
        `production viewer height at ${viewport.width}x${viewport.height}`);
    assert.equal(viewport.height - 38 - 58 - 30, viewport.nonproductionViewer,
        `nonproduction viewer height at ${viewport.width}x${viewport.height}`);
    assert.equal(viewport.height, viewport.productionPresentation,
        `production presentation/fullscreen height at ${viewport.width}x${viewport.height}`);
    assert.equal(viewport.height - 38, viewport.nonproductionViewer + 88,
        `nonproduction presentation/fullscreen height at ${viewport.width}x${viewport.height}`);
}

console.log("environment layout checks passed at 1440x900 and 1920x1080");
