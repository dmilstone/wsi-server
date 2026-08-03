"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const eventHandlers = new Map();
let persistenceUpdates = 0;
let labelUpdates = 0;
let lastLabelAnnotation = null;
const animationFrames = [];
const annotator = {
    annotations: [],
    setDrawingTool() {},
    on(event, handler) { eventHandlers.set(event, handler); },
    getAnnotations() { return this.annotations; },
    getSelected() { return []; },
    setDrawingEnabled() {}
};
class FakeAdapter {
    constructor() { this.store = { setSelectedAnnotationId() {} }; }
    annotationUpdated() { persistenceUpdates += 1; }
    annotationCreated() {}
    annotationDeleted() {}
    getAnnotationName() { return "Moved"; }
}
class FakeLabelLayer {
    constructor() { this.namesVisible = true; }
    syncAnnotation(annotation) { labelUpdates += 1; lastLabelAnnotation = annotation; }
    beginImage() {}
    remove() {}
    setAnnotationsVisible() {}
}
class FakeNameEditor { setSelection() {} }
const button = () => ({
    disabled: true,
    addEventListener() {},
    setAttribute() {}
});
const context = vm.createContext({
    console,
    queueMicrotask,
    document: { addEventListener() {} },
    window: {
        AnnotoriousOSD: { createOSDAnnotator: () => annotator },
        requestAnimationFrame(callback) { animationFrames.push(callback); }
    },
    AnnotationAdapter: FakeAdapter,
    AnnotationLabelLayer: FakeLabelLayer,
    AnnotationNameEditor: FakeNameEditor
});
const source = fs.readFileSync(
    path.join(__dirname, "../../main/resources/static/annotorious-spike.js"), "utf8");
vm.runInContext(`${source}\nthis.AnnotoriousSpike = AnnotoriousSpike;`, context);

const spike = Object.create(context.AnnotoriousSpike.prototype);
spike.viewer = {};
spike.toggleButton = button();
spike.visibilityButton = button();
spike.namesButton = button();
spike.nameInput = {};
spike.timingCallbacks = {};
spike.annotationsVisible = true;
spike.drawingEnabled = false;
spike.getCurrentImageId = () => "image-one";
spike.labelGeneration = 0;
spike.labelRefreshVersions = new Map();
spike.installKeyboardShortcuts = () => {};
spike.createAnnotator();

const at = (x, y) => ({ id: "moved", target: { selector: { geometry: {
    x, y, w: 20, h: 30,
    bounds: { minX: x, minY: y, maxX: x + 20, maxY: y + 30 }
} } } });
const beforeMove = at(10, 20);
const eventPayload = at(10, 20);
const committed = at(80, 90);
annotator.annotations = [beforeMove];

// Model the browser ordering: updateAnnotation fires while both its payload and
// getAnnotations still expose pre-drag geometry, then the collection commits.
eventHandlers.get("updateAnnotation")(eventPayload, beforeMove);
assert.equal(labelUpdates, 0, "stale event geometry is not rendered");
assert.equal(animationFrames.length, 1);
annotator.annotations = [committed];
animationFrames.shift()();
assert.equal(labelUpdates, 1);
assert.equal(lastLabelAnnotation, committed, "post-commit geometry is re-read by ID");
assert.equal(persistenceUpdates, 1, "only the existing geometry persistence path runs");
assert.equal(annotator.annotations.length, 1, "movement neither replaces nor duplicates annotations");

// Consecutive moves coalesce label work to the latest committed collection.
eventHandlers.get("updateAnnotation")(committed, beforeMove);
eventHandlers.get("updateAnnotation")(committed, beforeMove);
assert.equal(animationFrames.length, 2);
annotator.annotations = [at(120, 130)];
animationFrames.shift()();
assert.equal(labelUpdates, 1, "superseded move cannot refresh the label");
animationFrames.shift()();
assert.equal(labelUpdates, 2);
assert.equal(lastLabelAnnotation, annotator.annotations[0]);
assert.equal(persistenceUpdates, 3, "label scheduling adds no persistence calls");

// Image changes and deletion invalidate already queued post-commit callbacks.
eventHandlers.get("updateAnnotation")(annotator.annotations[0], committed);
spike.beginLabelImage("image-two");
animationFrames.shift()();
assert.equal(labelUpdates, 2, "an old image callback is rejected");

spike.getCurrentImageId = () => "image-two";
eventHandlers.get("updateAnnotation")(annotator.annotations[0], committed);
eventHandlers.get("deleteAnnotation")(annotator.annotations[0]);
annotator.annotations = [];
animationFrames.shift()();
assert.equal(labelUpdates, 2, "a deleted annotation cannot be restored by deferred work");
assert.equal(annotator.annotations.length, 0);

console.log("annotation committed movement checks passed");
