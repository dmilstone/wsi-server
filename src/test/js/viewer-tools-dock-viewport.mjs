"use strict";

/**
 * Terminal-native docked-tools viewport contract check.
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

// Chrome headless clamps very narrow windows (~500px floor). Safari has no
// headless shell here, so Safari-class narrow/stacked contracts are validated
// at the shared 820px CSS breakpoint using achievable Chrome window sizes.
const viewports = [
    { name: "chrome-desktop", width: 1440, height: 900, expectTrayBeside: true },
    { name: "chrome-laptop", width: 1280, height: 800, expectTrayBeside: true },
    { name: "safari-ipad-portrait-contract", width: 768, height: 1024, expectTrayBeside: false },
    { name: "safari-narrow-stack-contract", width: 520, height: 900, expectTrayBeside: false }
];

const styleMatch = indexHtml.match(/<style>([\s\S]*?)<\/style>/);
assert.ok(styleMatch, "index.html must contain a style block");

const fixture = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
${styleMatch[1]}
body { display:block !important; margin:0; width:100vw; height:100vh; overflow:hidden; }
.workspace {
  display:grid !important;
  grid-template-columns: minmax(0, 1fr) !important;
  height:100vh;
}
</style>
</head>
<body>
<div class="workspace">
  <main class="viewer-main" aria-label="Whole-slide image viewer">
    <div class="viewer-stage"><div id="viewer"></div></div>
    <aside id="tools-tray" class="tools-tray"><div class="viewer-toolbar"></div></aside>
  </main>
</div>
<pre id="out">pending</pre>
<script>
(() => {
  const stage = document.querySelector(".viewer-stage").getBoundingClientRect();
  const tray = document.querySelector(".tools-tray").getBoundingClientRect();
  const main = document.querySelector(".viewer-main").getBoundingClientRect();
  const overlap = !(stage.right <= tray.left + 0.5 || tray.right <= stage.left + 0.5 ||
                    stage.bottom <= tray.top + 0.5 || tray.bottom <= stage.top + 0.5);
  const beside = Math.abs(stage.top - tray.top) < 2 && stage.right <= tray.left + 1;
  const below = Math.abs(stage.left - tray.left) < 2 && stage.bottom <= tray.top + 1;
  document.getElementById("out").textContent = JSON.stringify({
    vw: window.innerWidth,
    vh: window.innerHeight,
    stage: { width: stage.width, height: stage.height, left: stage.left, top: stage.top, right: stage.right, bottom: stage.bottom },
    tray: { width: tray.width, height: tray.height, left: tray.left, top: tray.top, right: tray.right, bottom: tray.bottom },
    main: { width: main.width, height: main.height },
    overlap,
    beside,
    below
  });
})();
</script>
</body>
</html>`;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wsi-dock-viewport-"));
const fixturePath = path.join(tmpDir, "dock-fixture.html");
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
    assert.equal(measured.overlap, false, `${viewport.name} stage/tray must not overlap`);
    if (viewport.expectTrayBeside) {
        assert.equal(measured.beside, true, `${viewport.name} tray should dock beside stage`);
        assert.ok(measured.tray.width >= 240, `${viewport.name} tray width`);
        assert.ok(measured.stage.width >= 360, `${viewport.name} usable stage width`);
    } else {
        assert.equal(measured.below, true, `${viewport.name} tray should stack under stage`);
        assert.ok(measured.stage.height > 0, `${viewport.name} stage height`);
        assert.ok(measured.vw <= 820, `${viewport.name} must exercise the 820px stack breakpoint`);
    }
    reports.push({ name: viewport.name, ...measured });
}

// Collapsed tray must leave stage occupying the full main width on desktop.
const collapsedFixture = fixture.replace(
    'class="viewer-main"',
    'class="viewer-main tools-collapsed"'
);
const collapsedPath = path.join(tmpDir, "dock-collapsed.html");
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
assert.ok(collapsed.stage.width >= 1400, "collapsed tray restores nearly full stage width");
assert.ok(collapsed.tray.width <= 1, "collapsed tray width is ~0");

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log("viewer tools dock viewport contracts passed");
for (const report of reports) {
    console.log(`- ${report.name}: stage ${Math.round(report.stage.width)}x${Math.round(report.stage.height)}, tray ${Math.round(report.tray.width)}x${Math.round(report.tray.height)}, overlap=${report.overlap}`);
}
console.log(`- chrome-desktop-collapsed: stage ${Math.round(collapsed.stage.width)}x${Math.round(collapsed.stage.height)}, tray ${Math.round(collapsed.tray.width)}`);
console.log("Safari: no headless binary; safari-* sizes validated via Chrome engine against shared CSS breakpoints (820px stack).");
