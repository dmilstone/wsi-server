"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const eventHandlers = new Map();
const pointerHandlers = new Map();
const animationFrames = [];
let persistenceUpdates = 0;
let setSelectedCalls = 0;

const annotator = {
    annotations: [],
    selected: [],
    setDrawingTool() {},
    setDrawingEnabled() {},
    setSelected() { setSelectedCalls += 1; },
    on(event, handler) { eventHandlers.set(event, handler); },
    getAnnotations() { return this.annotations; },
    getSelected() { return this.selected; }
};

class FakeAdapter {
    constructor() { this.store = { setSelectedAnnotationId() {} }; }
    annotationUpdated() { persistenceUpdates += 1; }
    annotationCreated() {}
    annotationDeleted() {}
    getAnnotationName() { return "Moved"; }
}

class FakeLabelLayer {
    constructor() {
        this.namesVisible = true;
        this.displacements = new Map();
        this.synced = [];
        this.positionUpdates = 0;
        this.selectedId = null;
        this.editingId = null;
    }
    syncAnnotation(annotation) { this.synced.push(annotation); }
    setTemporaryDisplacement(id, x, y) { this.displacements.set(id, { x, y }); }
    getTemporaryDisplacement(id) { return this.displacements.get(id) || { x: 0, y: 0 }; }
    clearTemporaryDisplacement(id) { this.displacements.delete(id); }
    clearTemporaryDisplacements() { this.displacements.clear(); }
    updatePositions() { this.positionUpdates += 1; }
    beginImage() { this.displacements.clear(); }
    remove(id) { this.displacements.delete(id); }
    setAnnotationsVisible() {}
    setSelectedAnnotationId(id) { this.selectedId = id || null; }
    setEditingAnnotationId(id) { this.editingId = id || null; }
    refreshSelectionPresentation() {}
}

class FakeNameEditor {
    setSelection() {}
    beginInlineEdit() { return false; }
    endInlineEdit() {}
}
const button = () => ({ disabled: true, addEventListener() {}, setAttribute() {} });
const context = vm.createContext({
    console,
    queueMicrotask,
    document: { addEventListener() {} },
    window: {
        AnnotoriousOSD: { createOSDAnnotator: () => annotator },
        requestAnimationFrame(callback) { animationFrames.push(callback); },
        localStorage: { getItem() { return null; }, setItem() {} }
    },
    OpenSeadragon: { Point: class Point { constructor(x, y) { this.x = x; this.y = y; } } },
    AnnotationAdapter: FakeAdapter,
    AnnotationLabelLayer: FakeLabelLayer,
    AnnotationNameEditor: FakeNameEditor
});
const source = fs.readFileSync(
    path.join(__dirname, "../../main/resources/static/annotorious-spike.js"), "utf8");
vm.runInContext(`${source}\nthis.AnnotoriousSpike = AnnotoriousSpike;`, context);

const spike = Object.create(context.AnnotoriousSpike.prototype);
let viewportScale = 1;
spike.viewer = {
    element: {
        addEventListener(event, handler) { pointerHandlers.set(event, handler); },
        getBoundingClientRect() { return { left: 0, top: 0 }; },
        classList: { toggle() {} }
    },
    viewport: {
        viewerElementToImageCoordinates(point) {
            return { x: point.x / viewportScale, y: point.y / viewportScale };
        }
    }
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

const at = (id, x, y) => ({ id, target: { selector: { geometry: {
    x, y, w: 20, h: 30,
    bounds: { minX: x, minY: y, maxX: x + 20, maxY: y + 30 }
} } } });
const moved = at("moved", 10, 20);
const other = at("other", 160, 170);
annotator.annotations = [moved, other];
annotator.selected = [moved];

// Match the browser lifecycle: dragging and releasing emits no update event.
// The label follows a presentation-only image-coordinate displacement and the
// integration never asks Annotorious to alter or finalize its selection.
pointerHandlers.get("pointerdown")({ button: 0, pointerId: 7, clientX: 15, clientY: 25 });
pointerHandlers.get("pointermove")({ pointerId: 7, clientX: 45, clientY: 55 });
assert.deepEqual(spike.labelLayer.displacements.get("moved"), { x: 30, y: 30 });
pointerHandlers.get("pointerup")({ pointerId: 7, clientX: 45, clientY: 55 });
assert.deepEqual(spike.labelLayer.displacements.get("moved"), { x: 30, y: 30 },
    "release retains the visual move until the native commit");
assert.equal(setSelectedCalls, 0, "label movement never manipulates selection");
assert.equal(persistenceUpdates, 0, "presentation movement never persists");
assert.deepEqual(annotator.selected, [moved], "native selection state is untouched");

// A later native commit follows the one existing persistence path. Its guarded
// post-commit read reconciles the label and removes the temporary displacement.
const committed = at("moved", 40, 50);
annotator.annotations = [committed, other];
eventHandlers.get("updateAnnotation")(committed, moved);
assert.equal(persistenceUpdates, 1);
assert.equal(animationFrames.length, 1);
animationFrames.shift()();
assert.equal(spike.labelLayer.displacements.has("moved"), false);
assert.equal(spike.labelLayer.synced.at(-1), committed);
assert.equal(annotator.annotations.length, 2, "annotations are neither replaced nor duplicated");

// Native selection remains entirely usable after movement. This models clicks
// performed by Annotorious itself; no integration setSelected call is involved.
annotator.selected = [other];
eventHandlers.get("selectionChanged")();
assert.deepEqual(annotator.selected, [other]);
annotator.selected = [committed];
eventHandlers.get("selectionChanged")();
assert.deepEqual(annotator.selected, [committed]);
assert.equal(setSelectedCalls, 0);

// Repeated moves accumulate from the retained displacement and respect current
// viewport conversion (e.g. after zoom), while producing no extra saves.
viewportScale = 2;
pointerHandlers.get("pointerdown")({ button: 0, pointerId: 8, clientX: 85, clientY: 105 });
pointerHandlers.get("pointermove")({ pointerId: 8, clientX: 105, clientY: 125 });
pointerHandlers.get("pointerup")({ pointerId: 8, clientX: 105, clientY: 125 });
assert.deepEqual(spike.labelLayer.displacements.get("moved"), { x: 10, y: 10 });
assert.equal(persistenceUpdates, 1);
assert.equal(setSelectedCalls, 0);

// Pointer cancellation, drawing, and an outside-image pan do not retain label
// motion or invoke persistence/selection APIs.
pointerHandlers.get("pointerdown")({ button: 0, pointerId: 9, clientX: 85, clientY: 105 });
pointerHandlers.get("pointermove")({ pointerId: 9, clientX: 125, clientY: 145 });
pointerHandlers.get("pointercancel")({ pointerId: 9 });
assert.equal(spike.labelLayer.displacements.has("moved"), false);
assert.equal(spike.labelLayer.positionUpdates, 1);
spike.drawingEnabled = true;
pointerHandlers.get("pointerdown")({ button: 0, pointerId: 10, clientX: 85, clientY: 105 });
pointerHandlers.get("pointermove")({ pointerId: 10, clientX: 125, clientY: 145 });
pointerHandlers.get("pointerup")({ pointerId: 10 });
spike.drawingEnabled = false;
pointerHandlers.get("pointerdown")({ button: 0, pointerId: 11, clientX: 2, clientY: 2 });
pointerHandlers.get("pointermove")({ pointerId: 11, clientX: 20, clientY: 20 });
pointerHandlers.get("pointerup")({ pointerId: 11 });
assert.equal(spike.labelLayer.displacements.size, 0);
assert.equal(persistenceUpdates, 1);
assert.equal(setSelectedCalls, 0);

// Deletion, visibility changes, and image switches clear transient presentation
// state; stale deferred commits cannot restore a label on another image.
spike.labelLayer.setTemporaryDisplacement("moved", 4, 5);
eventHandlers.get("deleteAnnotation")(committed);
assert.equal(spike.labelLayer.displacements.size, 0);
eventHandlers.get("updateAnnotation")(committed, moved);
spike.beginLabelImage("image-two");
animationFrames.shift()();
assert.equal(spike.labelLayer.synced.length, 1);
spike.labelLayer.setTemporaryDisplacement("other", 2, 3);
spike.setAnnotationsVisible(false);
assert.equal(spike.labelLayer.displacements.size, 0);
assert.equal(setSelectedCalls, 0);

assert(!source.includes("finalizeAnnotationPointerEdit"));
assert(!/setSelected\s*\(/.test(source), "movement integration contains no setSelected call");
console.log("annotation presentation-only movement checks passed");
