"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const staticRoot = path.join(__dirname, "../../main/resources/static");
const moduleCode = fs.readFileSync(path.join(staticRoot, "pilot-feedback.js"), "utf8");
const storage = new Map();
const context = {
    window: {},
    sessionStorage: {
        getItem: (key) => storage.get(`s:${key}`) ?? null,
        setItem: (key, value) => storage.set(`s:${key}`, value),
        removeItem: (key) => storage.delete(`s:${key}`)
    },
    localStorage: {
        getItem: (key) => storage.get(`l:${key}`) ?? null,
        setItem: (key, value) => storage.set(`l:${key}`, value),
        removeItem: (key) => storage.delete(`l:${key}`)
    },
    console
};
context.window = context;
context.document = {activeElement: {tagName: "BODY"}};
vm.createContext(context);
vm.runInContext(`${moduleCode}; this.WsiPilotFeedback = window.WsiPilotFeedback;`, context);
const WsiPilotFeedback = context.WsiPilotFeedback;

assert.equal(WsiPilotFeedback.SHORTCUT_KEY, "F");
assert.equal(WsiPilotFeedback.TASKS.length, 17);
assert.equal(WsiPilotFeedback.RATINGS.length, 9);

const validationError = WsiPilotFeedback.validateClient({
    taskCompletion: {},
    ratings: {}
});
assert.ok(validationError.includes("Find/open image"));

const draft = {
    evaluatorAlias: "pilot-a",
    role: "RESEARCHER",
    wsiExperience: "LIMITED",
    taskCompletion: Object.fromEntries(WsiPilotFeedback.TASKS.map(task => [task.id, "DID_NOT_TRY"])),
    ratings: Object.fromEntries(WsiPilotFeedback.RATINGS.map(rating => [rating.id, 3])),
    mostUseful: "navigation",
    mostConfusing: null,
    expectedMissing: null,
    otherComments: null
};
assert.equal(WsiPilotFeedback.validateClient(draft), null);

WsiPilotFeedback.writeDraft(draft);
assert.equal(JSON.stringify(WsiPilotFeedback.readDraft()), JSON.stringify(draft));
WsiPilotFeedback.clearDraft();
assert.equal(WsiPilotFeedback.readDraft(), null);

assert.equal(WsiPilotFeedback.shouldHandleShortcut({key: "f", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, defaultPrevented: false}), true);
assert.equal(WsiPilotFeedback.shouldHandleShortcut({key: "f", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, defaultPrevented: false}), false);

console.log("pilot feedback form module checks passed");
