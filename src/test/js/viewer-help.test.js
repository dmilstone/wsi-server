"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const staticRoot = path.join(__dirname, "../../main/resources/static");
const index = fs.readFileSync(path.join(staticRoot, "index.html"), "utf8");
const guide = fs.readFileSync(path.join(staticRoot, "help/viewer-guide.html"), "utf8");
const pdf = fs.readFileSync(path.join(staticRoot, "help/WSI-Viewer-Quick-Guide.pdf"));

assert.match(index, /id="viewer-help"/);
assert.match(index, /href="\/help\/viewer-guide\.html"/);
assert.match(index, /target="_blank"/);
assert.match(index, /rel="noopener"/);
assert.match(index, /id="viewer-help"[^>]*aria-label="Help"/);
assert.match(index, /id="viewer-help"[^>]*data-tooltip="Help&#10;Open the WSI Viewer quick guide"/);
assert.match(index, /<span class="visually-hidden">Help<\/span>/);
assert.match(index, /id="viewer-help"[^>]*class="toolbar-button"/);
assert.match(index, /button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible/);

assert.match(guide, /<title>WSI Viewer Quick Guide<\/title>/);
assert.match(guide, /id="close-guide"/);
assert.ok(guide.includes(">Close guide</button>"));
assert.ok(guide.includes("window.close()"));assert.ok(guide.includes('if (!window.closed) window.location.assign("/")'));
assert.ok(guide.includes('href="/help/WSI-Viewer-Quick-Guide.pdf"'));
assert.ok(guide.includes(">Printable PDF</a>"));
assert.doesNotMatch(guide, /https?:\/\//);
assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
assert.ok(pdf.length > 1000, "packaged PDF must be nonempty");

console.log("authenticated viewer help contract checks passed");
