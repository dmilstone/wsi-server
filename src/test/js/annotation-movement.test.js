"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const eventHandlers = new Map();
let persistenceUpdates = 0;
let labelUpdates = 0;
let lastLabelAnnotation = null;
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
    window: { AnnotoriousOSD: { createOSDAnnotator: () => annotator } },
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
spike.installKeyboardShortcuts = () => {};
spike.createAnnotator();

const moved = { id: "moved", target: { selector: { geometry: {
    x: 80, y: 90, w: 20, h: 30,
    // This is the stale pre-drag derived value observed in the update payload.
    bounds: { minX: 10, minY: 20, maxX: 30, maxY: 50 }
} } } };
annotator.annotations = [moved];

// Annotorious exposes updateAnnotation as the public committed movement event.
// Firing it must synchronously send the same live annotation to the label layer;
// no click, selection, viewport, or redraw event is involved.
eventHandlers.get("updateAnnotation")(moved, null);
assert.equal(labelUpdates, 1);
assert.equal(lastLabelAnnotation, moved);
assert.equal(persistenceUpdates, 1, "only the existing geometry persistence path runs");
assert.equal(annotator.annotations.length, 1, "movement neither replaces nor duplicates annotations");

console.log("annotation committed movement checks passed");
