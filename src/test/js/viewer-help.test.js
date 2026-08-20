"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const staticRoot = path.join(__dirname, "../../main/resources/static");
const index = fs.readFileSync(path.join(staticRoot, "index.html"), "utf8");
const directory = fs.readFileSync(path.join(staticRoot, "help/help-directory.html"), "utf8");
const guide = fs.readFileSync(path.join(staticRoot, "help/viewer-guide.html"), "utf8");
const pdf = fs.readFileSync(path.join(staticRoot, "help/WSI-Viewer-Quick-Guide.pdf"));
const userGuide = fs.readFileSync(path.join(staticRoot, "help/user-guide.html"), "utf8");
const userGuidePdf = fs.readFileSync(path.join(staticRoot, "help/WSI-User-Administration-Guide.pdf"));

assert.match(userGuide, /WSI Comprehensive User/);
assert.match(userGuide, /X-WSI-User/);
assert.match(userGuide, /com\.wsi\.ops-dashboard/);
assert.equal(userGuidePdf.subarray(0, 5).toString("ascii"), "%PDF-");

assert.match(index, /id="help-directory-link"/);
assert.match(index, /window\.open\("\/help\/help-directory\.html", "_blank"\)/);
assert.doesNotMatch(index, /id="user-guide-link"/);
assert.doesNotMatch(index, /window\.location\.assign\(url\)/);
assert.doesNotMatch(index, /if \(!opened\) window\.location\.assign/);

assert.match(directory, /id="dashboard-link"/);
assert.match(directory, /id="user-guide-link"/);
assert.match(directory, /href="\/help\?v=20260817"/);
assert.match(directory, /id="viewer-quick-guide-link"/);
assert.match(directory, /href="\/help\/viewer-guide\.html\?v=20260817"/);
assert.match(directory, /id="admin-ops-guide-link"/);
assert.match(directory, /href="\/help\/admin-ops-guide\.html\?v=20260817"/);
assert.match(directory, /id="local-operations"/);
assert.match(directory, />Admin</);
assert.match(directory, /target="_blank"/);
assert.match(directory, /rel="noopener noreferrer"/);

assert.match(guide, /<title>WSI Viewer Quick Guide<\/title>/);
assert.match(guide, /id="close-guide"/);
assert.ok(guide.includes(">Close guide</button>"));
assert.ok(guide.includes("window.close()"));
assert.ok(guide.includes('if (!window.closed) window.location.assign("/")'));
assert.ok(guide.includes('href="/help"'));
assert.ok(guide.includes('href="/help/WSI-Viewer-Quick-Guide.pdf"'));
assert.ok(guide.includes(">Printable PDF</a>"));
assert.doesNotMatch(guide, /https?:\/\//);
assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
assert.ok(pdf.length > 1000, "packaged PDF must be nonempty");

console.log("authenticated viewer help contract checks passed");
