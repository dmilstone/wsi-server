"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const staticRoot = path.join(__dirname, "../../main/resources/static");
const feedbackSource = fs.readFileSync(path.join(staticRoot, "pilot-feedback.js"), "utf8");

const context = vm.createContext({
    window: {},
    console: { info() {}, warn() {}, error() {} }
});
vm.runInContext(feedbackSource, context);
const { WsiPilotFeedback } = context.window;

function keyEvent(overrides = {}) {
    return {
        key: "f",
        altKey: false,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        target: null,
        ...overrides
    };
}

assert.equal(typeof WsiPilotFeedback.shouldHandleShortcut, "function");
assert.equal(WsiPilotFeedback.SHORTCUT_KEY, "F");

// Bare "f"/"F" and Shift+F alone must NOT open feedback any more -- those keys are now
// reserved for the detection/annotation interior-fill toggles (annotation-adapter.js
// toggleDetectionFill / toggleAnnotationFill).
assert.equal(WsiPilotFeedback.shouldHandleShortcut(keyEvent({ key: "f" })), false,
    "plain \"f\" must no longer open feedback");
assert.equal(WsiPilotFeedback.shouldHandleShortcut(keyEvent({ key: "F" })), false,
    "bare \"F\" (e.g. caps lock, no modifiers) must no longer open feedback");
assert.equal(WsiPilotFeedback.shouldHandleShortcut(keyEvent({ key: "f", shiftKey: true })), false,
    "Shift+F alone must no longer open feedback (reserved for annotation fill toggle)");
assert.equal(WsiPilotFeedback.shouldHandleShortcut(keyEvent({ key: "f", ctrlKey: true })), false,
    "Ctrl+F alone (no Shift) must not open feedback");

// Ctrl+Shift+F (exactly) must open/close feedback.
assert.equal(
    WsiPilotFeedback.shouldHandleShortcut(keyEvent({ key: "f", ctrlKey: true, shiftKey: true })),
    true,
    "Ctrl+Shift+F must open/close feedback"
);
assert.equal(
    WsiPilotFeedback.shouldHandleShortcut(keyEvent({ key: "F", ctrlKey: true, shiftKey: true })),
    true,
    "Ctrl+Shift+F must open/close feedback regardless of reported key case"
);

// Extra modifiers (Alt/Meta) alongside Ctrl+Shift+F must still be rejected.
assert.equal(
    WsiPilotFeedback.shouldHandleShortcut(keyEvent({ key: "f", ctrlKey: true, shiftKey: true, altKey: true })),
    false
);
assert.equal(
    WsiPilotFeedback.shouldHandleShortcut(keyEvent({ key: "f", ctrlKey: true, shiftKey: true, metaKey: true })),
    false
);

// Typing in an editable field must still suppress the shortcut even with the right modifiers.
assert.equal(
    WsiPilotFeedback.shouldHandleShortcut(keyEvent({
        key: "f", ctrlKey: true, shiftKey: true, target: { tagName: "INPUT" }
    })),
    false
);
assert.equal(
    WsiPilotFeedback.shouldHandleShortcut(keyEvent({
        key: "f", ctrlKey: true, shiftKey: true, target: { isContentEditable: true }
    })),
    false
);

console.log("pilot-feedback.test.js: ok");
