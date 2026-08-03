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
const pointerHandlers = new Map();
let pendingCommitted = null;
const annotator = {
    annotations: [],
    selected: [],
    setDrawingTool() {},
    on(event, handler) { eventHandlers.set(event, handler); },
    getAnnotations() { return this.annotations; },
    getSelected() { return this.selected; },
    setDrawingEnabled() {},
    async setSelected(id) {
        if (id === undefined) {
            const previous = this.annotations[0];
            if (pendingCommitted) {
                this.annotations = [pendingCommitted];
                eventHandlers.get("updateAnnotation")(pendingCommitted, previous);
                pendingCommitted = null;
            }
            this.selected = [];
            eventHandlers.get("selectionChanged")();
        } else {
            this.selected = this.annotations.filter(annotation => annotation.id === id);
            eventHandlers.get("selectionChanged")();
        }
    }
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
    OpenSeadragon: { Point: class Point { constructor(x, y) { this.x = x; this.y = y; } } },
    AnnotationAdapter: FakeAdapter,
    AnnotationLabelLayer: FakeLabelLayer,
    AnnotationNameEditor: FakeNameEditor
});
const source = fs.readFileSync(
    path.join(__dirname, "../../main/resources/static/annotorious-spike.js"), "utf8");
vm.runInContext(`${source}\nthis.AnnotoriousSpike = AnnotoriousSpike;`, context);

(async () => {
const spike = Object.create(context.AnnotoriousSpike.prototype);
spike.viewer = {
    element: {
        addEventListener(event, handler) { pointerHandlers.set(event, handler); },
        getBoundingClientRect() { return { left: 0, top: 0 }; }
    },
    viewport: { viewerElementToImageCoordinates(point) { return point; } }
};
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
const committed = at(80, 90);
annotator.annotations = [beforeMove];
annotator.selected = [beforeMove];

// Model the observed browser ordering: select, drag, and release produce no
// updateAnnotation from Annotorious itself. Pointer finalization uses the public
// selection lifecycle, which commits once and restores the effective selection.
pendingCommitted = committed;
pointerHandlers.get("pointerdown")({ button: 0, pointerId: 7, clientX: 15, clientY: 25 });
pointerHandlers.get("pointermove")({ pointerId: 7, clientX: 45, clientY: 55 });
pointerHandlers.get("pointerup")({ pointerId: 7, clientX: 45, clientY: 55 });
await new Promise(resolve => setImmediate(resolve));
assert.equal(persistenceUpdates, 1, "release finalizes exactly one annotation update");
assert.equal(animationFrames.length, 1);
animationFrames.shift()();
assert.equal(labelUpdates, 1);
assert.equal(lastLabelAnnotation, committed, "post-commit geometry is re-read by ID");
assert.equal(annotator.annotations.length, 1, "movement neither replaces nor duplicates annotations");
assert.deepEqual(annotator.selected, [committed], "moved annotation remains selected");

// Panning outside the selected geometry, drawing mode, and cancellation do not
// finalize an annotation or produce persistence activity.
pointerHandlers.get("pointerdown")({ button: 0, pointerId: 8, clientX: 2, clientY: 2 });
pointerHandlers.get("pointermove")({ pointerId: 8, clientX: 30, clientY: 30 });
pointerHandlers.get("pointerup")({ pointerId: 8, clientX: 30, clientY: 30 });
spike.drawingEnabled = true;
pointerHandlers.get("pointerdown")({ button: 0, pointerId: 9, clientX: 85, clientY: 95 });
pointerHandlers.get("pointerup")({ pointerId: 9, clientX: 100, clientY: 110 });
spike.drawingEnabled = false;
pointerHandlers.get("pointerdown")({ button: 0, pointerId: 10, clientX: 85, clientY: 95 });
pointerHandlers.get("pointermove")({ pointerId: 10, clientX: 100, clientY: 110 });
pointerHandlers.get("pointercancel")({ pointerId: 10 });
pointerHandlers.get("pointerup")({ pointerId: 10, clientX: 100, clientY: 110 });
await new Promise(resolve => setImmediate(resolve));
assert.equal(persistenceUpdates, 1);

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
})().catch(error => { console.error(error); process.exitCode = 1; });
