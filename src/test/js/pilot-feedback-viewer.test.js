"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const staticRoot = path.join(__dirname, "../../main/resources/static");
const index = fs.readFileSync(path.join(staticRoot, "index.html"), "utf8");
const guide = fs.readFileSync(path.join(staticRoot, "help/viewer-guide.html"), "utf8");

assert.match(index, /id="pilot-feedback-panel"/);
assert.match(index, /class="pilot-feedback-panel"/);
assert.match(index, /Pilot Feedback \(F\)/);
assert.match(index, /id="pilot-feedback-link"/);
assert.match(index, /href="\/pilot-feedback"/);
assert.match(index, /src="\/pilot-feedback\.js"/);
assert.match(index, /WsiPilotFeedback\.SHORTCUT_KEY/);
assert.match(index, /togglePilotFeedbackPanel/);
assert.doesNotMatch(index, /id="pilot-feedback-toolbar"/);

assert.match(guide, /Pilot feedback/);
assert.match(guide, /press <b>F<\/b>/i);

console.log("viewer pilot feedback integration checks passed");
