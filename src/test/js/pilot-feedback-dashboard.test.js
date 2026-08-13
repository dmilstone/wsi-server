"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const staticRoot = path.join(__dirname, "../../main/resources/static");
const resultsPage = fs.readFileSync(path.join(staticRoot, "pilot-feedback/results/index.html"), "utf8");
const resultsJs = fs.readFileSync(path.join(staticRoot, "pilot-feedback-results.js"), "utf8");

assert.match(resultsPage, /Pilot Feedback Results/);
assert.match(resultsPage, /id="view-all"/);
assert.match(resultsPage, /id="view-dedup"/);
assert.match(resultsPage, /id="summary-cards"/);
assert.match(resultsPage, /id="task-charts"/);
assert.match(resultsPage, /id="rating-charts"/);
assert.match(resultsPage, /id="responder-table"/);
assert.match(resultsPage, /id="free-text"/);
assert.match(resultsPage, /\/api\/pilot-feedback\/export\.json/);
assert.match(resultsJs, /REFRESH_MS = 4000/);
assert.match(resultsJs, /inFlight/);
assert.match(resultsJs, /deduplicated/);

console.log("pilot feedback dashboard checks passed");
