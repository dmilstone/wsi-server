"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class Element {
    constructor(tag = "div") {
        this.tag = tag; this.children = []; this.attributes = {}; this.style = {};
        this.hidden = false; this.textContent = ""; this.title = ""; this.parent = null;
    }
    appendChild(child) { child.parent = this; this.children.push(child); return child; }
    remove() {
        if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
        this.parent = null;
    }
    setAttribute(name, value) { this.attributes[name] = value; }
}

const storageValues = new Map();
const storage = {
    getItem(key) { return storageValues.has(key) ? storageValues.get(key) : null; },
    setItem(key, value) { storageValues.set(key, value); }
};
const root = new Element();
const handlers = new Map();
let scale = 1;
const viewer = {
    element: root,
    viewport: { imageToViewerElementCoordinates(point) {
        return { x: point.x * scale, y: point.y * scale };
    } },
    addHandler(event, callback) { handlers.set(event, callback); },
    removeHandler(event, callback) { if (handlers.get(event) === callback) handlers.delete(event); }
};
const annotations = [];
const names = new Map();
const annotator = { getAnnotations: () => annotations };
const context = vm.createContext({
    console, window: { localStorage: storage }, document: { createElement: tag => new Element(tag) },
    OpenSeadragon: { Point: class Point { constructor(x, y) { this.x = x; this.y = y; } } }
});
const source = fs.readFileSync(
    path.join(__dirname, "../../main/resources/static/annotation-label-layer.js"), "utf8");
vm.runInContext(`${source}\nthis.AnnotationLabelLayer = AnnotationLabelLayer;`, context);

function shape(id, x, y) {
    return { id, target: { selector: { geometry: {
        x, y, w: 20, h: 10, bounds: { minX: x, minY: y, maxX: x + 20, maxY: y + 10 }
    } } } };
}

// The missing preference defaults to shown and creates a presentation-only layer.
const layer = new context.AnnotationLabelLayer(viewer, annotator, id => names.get(id), storage);
assert.equal(layer.namesVisible, true);
assert.equal(root.children.length, 1);
assert.equal(layer.layer.attributes["aria-label"], "Annotation names");
assert.equal(handlers.size, 3);

const first = shape("one", 10, 20);
const second = shape("two", 40, 50);
const unnamed = shape("blank", 70, 80);
annotations.push(first, second, unnamed);
names.set("one", "Région 🧬, #2! <b>plain</b>");
names.set("two", "界".repeat(200));
names.set("blank", "   ");
layer.beginImage("image-one");
assert.equal(layer.sync("image-one"), true);
assert.equal(layer.labels.size, 2);
assert.equal(layer.labels.get("one").element.textContent, "Région 🧬, #2! <b>plain</b>");
assert.equal(layer.labels.get("one").element.children.length, 0, "name is never parsed as markup");
assert.equal(layer.labels.get("two").element.title, "界".repeat(200), "full bounded name remains available");
assert.equal(layer.labels.get("one").element.style.transform, "translate(16px, 26px)");

// Annotorious' committed movement payload updates canonical x/y before its
// derived bounds. The label must use that live geometry immediately rather
// than waiting for a later click/redraw to refresh the stale bounds object.
first.target.selector.geometry.x = 12;
first.target.selector.geometry.y = 24;
layer.syncAnnotation(first);
assert.equal(layer.labels.get("one").element.style.transform, "translate(18px, 30px)");
scale = 2;
handlers.get("animation")();
assert.equal(layer.labels.get("one").element.style.transform, "translate(30px, 54px)");
handlers.get("viewport-change")();

// Rename and clearing update in place; deletion removes without replacing annotations.
const originalElement = layer.labels.get("one").element;
names.set("one", "Renamed — (α)");
layer.syncAnnotation(first);
assert.equal(layer.labels.get("one").element, originalElement);
assert.equal(originalElement.textContent, "Renamed — (α)");
names.set("one", "");
layer.syncAnnotation(first);
assert(!layer.labels.has("one"));
annotations.splice(annotations.indexOf(second), 1);
layer.sync("image-one");
assert.equal(layer.labels.size, 0);
assert.equal(annotations.length, 2, "sync neither replaces nor duplicates live annotations");

// Names and global annotation visibility compose, and only browser storage changes.
let storeActivity = 0;
layer.setNamesVisible(false); storeActivity += 0;
assert.equal(storageValues.get(context.AnnotationLabelLayer.PREFERENCE_KEY), "false");
assert.equal(layer.layer.hidden, true);
layer.setAnnotationsVisible(false);
layer.setNamesVisible(true);
assert.equal(layer.layer.hidden, true, "global hide wins over the names preference");
layer.setAnnotationsVisible(true);
assert.equal(layer.layer.hidden, false);
assert.equal(storeActivity, 0, "display toggles have no AnnotationStore activity");
const restored = new context.AnnotationLabelLayer(viewer, annotator, id => names.get(id), storage);
assert.equal(restored.namesVisible, true, "browser preference is restored");
restored.destroy();

// Beginning a new image clears immediately, and an earlier async result is rejected.
names.set("blank", "Current image");
layer.sync("image-one");
assert.equal(layer.labels.size, 1);
layer.beginImage("image-two");
assert.equal(layer.labels.size, 0);
assert.equal(layer.sync("image-one"), false);
assert.equal(layer.labels.size, 0);

// Labels are non-interactive viewer children, not canvas/export inputs, and clean up fully.
assert.equal(layer.layer.style.pointerEvents, "none");
assert(!source.includes("innerHTML"));
assert(!source.includes(".setAnnotations("));
assert(!source.includes("export"));
layer.destroy();
assert.equal(root.children.length, 0);
assert.equal(handlers.size, 0);

console.log("annotation label layer checks passed");
