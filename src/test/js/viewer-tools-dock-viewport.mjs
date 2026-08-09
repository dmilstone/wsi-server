"use strict";

/**
 * Terminal-native header-toolbar viewport contract check.
 * Uses local Google Chrome headless when available. Safari has no stable
 * headless shell here; Safari-relevant breakpoints are asserted via the same
 * CSS contracts exercised for Chrome window sizes below.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexHtml = fs.readFileSync(
    path.join(__dirname, "../../main/resources/static/index.html"),
    "utf8"
);

const chromeCandidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "google-chrome",
    "chromium",
    "chromium-browser"
];
const chrome = chromeCandidates.find((candidate) => {
    if (candidate.startsWith("/")) return fs.existsSync(candidate);
    return spawnSync("command", ["-v", candidate], { encoding: "utf8" }).status === 0;
});

const viewports = [
    { name: "chrome-desktop", width: 1440, height: 900 },
    { name: "chrome-laptop", width: 1024, height: 768 },
    { name: "safari-ipad-portrait-contract", width: 768, height: 1024 }
];

const styleMatch = indexHtml.match(/<style>([\s\S]*?)<\/style>/);
assert.ok(styleMatch, "index.html must contain a style block");

const fixture = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
${styleMatch[1]}
body { display:grid !important; grid-template-rows: 58px minmax(0,1fr) 30px !important; margin:0; width:100vw; height:100vh; overflow:hidden; }
.workspace {
  display:grid !important;
  grid-template-columns: minmax(0, 1fr) !important;
  grid-template-rows: minmax(0, 1fr) !important;
  min-height:0;
  height:100%;
}
.viewer-main, .viewer-stage, #viewer, .annotation-overlay {
  min-height:0 !important;
  height:100% !important;
}
</style>
</head>
<body>
<header class="app-header">
  <div class="brand"><div class="brand-title">WSI Viewer</div></div>
  <div class="header-context"><div class="header-label">Current image</div><div id="selected-name">Sample_Slide_Long_Name_ABCDEFG.vsi</div></div>
  <div id="tools-tray" class="tools-tray"><div class="viewer-toolbar" role="toolbar">
    <button id="open-image" class="toolbar-button" type="button" data-tooltip="Open" aria-label="Open"></button>
    <button id="toggle-left" class="toolbar-button" type="button" data-tooltip="Images" aria-label="Images" aria-pressed="true"></button>
    <button id="zoom-in" class="toolbar-button" type="button" data-tooltip="Zoom in" aria-label="Zoom in"></button>
  </div></div>
</header>
<div class="workspace">
  <main class="viewer-main" aria-label="Whole-slide image viewer">
    <div class="viewer-stage"><div id="viewer"></div><div class="annotation-overlay"></div></div>
  </main>
</div>
<footer class="status-bar"></footer>
<pre id="out">pending</pre>
<script>
(() => {
  const stage = document.querySelector(".viewer-stage").getBoundingClientRect();
  const tray = document.querySelector(".tools-tray").getBoundingClientRect();
  const ctx = document.querySelector(".header-context").getBoundingClientRect();
  const viewer = document.getElementById("viewer").getBoundingClientRect();
  const annotation = document.querySelector(".annotation-overlay").getBoundingClientRect();
  const buttons = [...document.querySelectorAll(".toolbar-button")].map((button) => {
    const rect = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    return {
      id: button.id,
      left: rect.left,
      right: rect.right,
      bg: style.backgroundColor,
      ariaPressed: button.getAttribute("aria-pressed"),
      overlapsContext: !(rect.right <= ctx.left + 0.5 || rect.left >= ctx.right - 0.5 ||
                        rect.bottom <= ctx.top + 0.5 || rect.top >= ctx.bottom - 0.5)
    };
  });
  const overlapTrayStage = !(stage.right <= tray.left + 0.5 || tray.right <= stage.left + 0.5 ||
                            stage.bottom <= tray.top + 0.5 || tray.bottom <= stage.top + 0.5);
  const overlapTrayViewer = !(viewer.right <= tray.left + 0.5 || tray.right <= viewer.left + 0.5 ||
                              viewer.bottom <= tray.top + 0.5 || tray.bottom <= viewer.top + 0.5);
  const above = tray.bottom <= stage.top + 1;
  document.getElementById("out").textContent = JSON.stringify({
    vw: window.innerWidth,
    vh: window.innerHeight,
    stage: { width: stage.width, height: stage.height, top: stage.top, bottom: stage.bottom },
    tray: { width: tray.width, height: tray.height, top: tray.top, bottom: tray.bottom },
    ctx: { left: ctx.left, right: ctx.right, width: ctx.width },
    viewer: { width: viewer.width, height: viewer.height },
    annotation: { width: annotation.width, height: annotation.height },
    overlapTrayStage,
    overlapTrayViewer,
    above,
    overlappingContextButtons: buttons.filter((button) => button.overlapsContext),
    pressedBg: buttons.filter((button) => button.ariaPressed === "true").map((button) => button.bg),
    inactiveBg: buttons.filter((button) => button.ariaPressed !== "true").map((button) => button.bg)
  });
})();
</script>
</body>
</html>`;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wsi-toolbar-viewport-"));
const fixturePath = path.join(tmpDir, "toolbar-fixture.html");
fs.writeFileSync(fixturePath, fixture);

function runChrome(width, height) {
    assert.ok(chrome, "Google Chrome binary not found for headless viewport checks");
    const result = spawnSync(chrome, [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        `--window-size=${width},${height}`,
        "--virtual-time-budget=2000",
        "--dump-dom",
        `file://${fixturePath}`
    ], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    if (result.status !== 0) {
        throw new Error(`Chrome headless failed (${result.status}): ${result.stderr || result.stdout}`);
    }
    const dom = `${result.stdout}\n${result.stderr}`;
    const match = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/);
    assert.ok(match, "Chrome dump-dom missing #out payload");
    return JSON.parse(match[1]);
}

const reports = [];
for (const viewport of viewports) {
    const measured = runChrome(viewport.width, viewport.height);
    assert.ok(Math.abs(measured.vw - viewport.width) <= 40,
        `${viewport.name} width ~${viewport.width} (got ${measured.vw})`);
    assert.equal(measured.overlapTrayStage, false, `${viewport.name} toolbar/stage must not overlap`);
    assert.equal(measured.overlapTrayViewer, false, `${viewport.name} toolbar/viewer must not overlap`);
    assert.equal(measured.above, true, `${viewport.name} toolbar should sit above stage`);
    assert.equal(measured.overlappingContextButtons.length, 0,
        `${viewport.name} CURRENT IMAGE must not overlap toolbar controls`);
    assert.ok(measured.ctx.width <= 220 + 1, `${viewport.name} CURRENT IMAGE stays bounded`);
    for (const bg of measured.inactiveBg) {
        assert.equal(bg, "rgba(0, 0, 0, 0)", `${viewport.name} inactive toolbar chrome is transparent`);
    }
    for (const bg of measured.pressedBg) {
        assert.notEqual(bg, "rgba(0, 0, 0, 0)", `${viewport.name} pressed toolbar chrome is visible`);
        assert.notEqual(bg, "rgb(77, 148, 216)", `${viewport.name} pressed chrome is subtle, not solid accent fill`);
    }
    assert.ok(measured.stage.height >= 400, `${viewport.name} usable stage height`);
    assert.ok(measured.tray.height > 0 && measured.tray.height <= 64, `${viewport.name} compact toolbar height`);
    assert.ok(Math.abs(measured.annotation.height - measured.viewer.height) < 2,
        `${viewport.name} annotation overlay matches viewer`);
    reports.push({ name: viewport.name, ...measured });
}

const collapsedFixture = fixture.replace(
    'id="tools-tray" class="tools-tray"',
    'id="tools-tray" class="tools-tray tools-collapsed"'
).replace(
    'class="viewer-main"',
    'class="viewer-main tools-collapsed"'
);
const collapsedPath = path.join(tmpDir, "toolbar-collapsed.html");
fs.writeFileSync(collapsedPath, collapsedFixture);
const collapsed = (() => {
    const result = spawnSync(chrome, [
        "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
        "--window-size=1440,900", "--virtual-time-budget=2000", "--dump-dom",
        `file://${collapsedPath}`
    ], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, "collapsed Chrome run");
    const match = `${result.stdout}\n${result.stderr}`.match(/<pre id="out">([\s\S]*?)<\/pre>/);
    assert.ok(match, "collapsed dump-dom missing #out payload");
    return JSON.parse(match[1]);
})();
assert.ok(collapsed.stage.height >= 640, "collapsed toolbar restores tall stage");
assert.ok(collapsed.tray.width <= 1, "collapsed tray width is ~0");

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log("viewer header toolbar viewport contracts passed");
for (const report of reports) {
    console.log(`- ${report.name}: stage ${Math.round(report.stage.width)}x${Math.round(report.stage.height)}, tray ${Math.round(report.tray.width)}x${Math.round(report.tray.height)}, overlap=${report.overlapTrayStage}`);
}
console.log(`- chrome-desktop-collapsed: stage ${Math.round(collapsed.stage.width)}x${Math.round(collapsed.stage.height)}`);
