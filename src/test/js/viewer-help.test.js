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
assert.match(index, /aria-label="Open WSI Viewer quick guide in a new tab"/);
assert.match(index, /<span>Help<\/span>/);
assert.match(index, /\.help-link\s*\{[^}]*min-height:\s*36px[^}]*text-decoration:\s*none/s);
assert.match(index, /\.help-link:focus-visible/);

assert.match(guide, /<title>WSI Viewer Quick Guide<\/title>/);
assert.match(guide, /href="\/"/);
assert.match(guide, /href="\/help\/WSI-Viewer-Quick-Guide\.pdf"/);
assert.match(guide, />Back to viewer<\/a>/);
assert.match(guide, />Printable PDF<\/a>/);
assert.doesNotMatch(guide, /https?:\/\//);
assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
assert.ok(pdf.length > 1000, "packaged PDF must be nonempty");

console.log("authenticated viewer help contract checks passed");
