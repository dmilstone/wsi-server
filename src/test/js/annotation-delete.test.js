"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const staticRoot = path.join(__dirname, "../../main/resources/static");
const adapterSource = fs.readFileSync(path.join(staticRoot, "annotation-adapter.js"), "utf8");
const storeSource = fs.readFileSync(path.join(staticRoot, "annotation-store.js"), "utf8");
const html = fs.readFileSync(path.join(staticRoot, "index.html"), "utf8");

const context = vm.createContext({
    console: { info() {}, warn() {}, error() {} },
    window: {
        setTimeout,
        clearTimeout,
        addEventListener() {},
        removeEventListener() {},
        currentActiveTool: "selection"
    },
    document: {
        getElementById() { return null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener() {}
    },
    fetch: null,
    WsiCsrf: { csrfFetch: async () => { throw new Error("unexpected save"); } }
});
vm.runInContext(`${storeSource}\nthis.AnnotationStore = AnnotationStore;`, context);
vm.runInContext(`${adapterSource}\nthis.AnnotationAdapter = AnnotationAdapter;`, context);
const { AnnotationAdapter } = context;

assert.match(html, /id="delete-selected-annotations-btn"[^>]*>Delete</);
assert.match(html, /id="annotation-context-menu-delete"/);
assert.match(html, /<b>Delete \/ Backspace<\/b>/);
assert.match(html, /Lock\/Unlock Position or Delete the selected annotation\(s\)/);
assert.match(adapterSource, /Delete this annotation\? This cannot be undone\./);
assert.match(adapterSource, /Delete \$\{n\} selected annotations\? This cannot be undone\./);
assert.match(adapterSource, /static promptDeleteSelectedAnnotations\(/);
assert.match(adapterSource, /static promptDeleteAnnotations\(/);
assert.match(adapterSource, /case "delete":/);
assert.match(adapterSource, /case "backspace":/);

assert.equal(
    AnnotationAdapter.deleteAnnotationsWarning(1),
    "Delete this annotation? This cannot be undone."
);
assert.equal(
    AnnotationAdapter.deleteAnnotationsWarning(3),
    "Delete 3 selected annotations? This cannot be undone."
);

function seedShapes() {
    AnnotationAdapter.setSavedAnnotations([
        { id: "a1", type: "rectangle" },
        { id: "a2", type: "ellipse" },
        { id: "a3", type: "polygon" }
    ]);
    if (!AnnotationAdapter.selectedNativeAnnotationIds || typeof AnnotationAdapter.selectedNativeAnnotationIds.clear !== "function") {
        AnnotationAdapter.selectedNativeAnnotationIds = new Set();
    }
    AnnotationAdapter.selectedNativeAnnotationIds.clear();
    AnnotationAdapter.selectedNativeAnnotationId = null;
}

{
    seedShapes();
    AnnotationAdapter.selectedNativeAnnotationIds.add("a2");
    AnnotationAdapter.selectedNativeAnnotationId = "a2";
    const persisted = [];
    AnnotationAdapter.annotationEngine = {
        adapter: { collectionEdited() { persisted.push("edit"); } },
        labelLayer: { sync() {} },
        getCurrentImageId() { return "img-1"; }
    };

    const cancelled = AnnotationAdapter.promptDeleteSelectedAnnotations(() => false);
    assert.equal(cancelled, 0);
    assert.equal(AnnotationAdapter.savedAnnotationsArray.length, 3,
        "Cancel must leave every annotation in place");
    assert.deepEqual(AnnotationAdapter.savedAnnotationsArray.map(item => item.id), ["a1", "a2", "a3"]);
    assert.equal(persisted.length, 0, "Cancel must not persist a collection edit");

    const removed = AnnotationAdapter.promptDeleteSelectedAnnotations(message => {
        assert.match(message, /Delete this annotation\? This cannot be undone\./);
        return true;
    });
    assert.equal(removed, 1);
    assert.deepEqual(AnnotationAdapter.savedAnnotationsArray.map(item => item.id), ["a1", "a3"]);
    assert.equal(AnnotationAdapter.selectedNativeAnnotationId, null);
    assert.equal(persisted.length, 1, "confirming delete must persist the remaining collection");
}

{
    seedShapes();
    AnnotationAdapter.selectedNativeAnnotationIds.add("a1");
    AnnotationAdapter.selectedNativeAnnotationIds.add("a3");
    AnnotationAdapter.selectedNativeAnnotationId = "a1";
    const persisted = [];
    AnnotationAdapter.annotationEngine = {
        adapter: { collectionEdited() { persisted.push("edit"); } },
        labelLayer: { sync() {} },
        getCurrentImageId() { return "img-1"; }
    };

    const cancelled = AnnotationAdapter.promptDeleteAnnotations(["a1", "a3"], () => false);
    assert.equal(cancelled, 0);
    assert.equal(AnnotationAdapter.savedAnnotationsArray.length, 3);

    const removed = AnnotationAdapter.promptDeleteSelectedAnnotations(message => {
        assert.match(message, /Delete 2 selected annotations\? This cannot be undone\./);
        return true;
    });
    assert.equal(removed, 2);
    assert.deepEqual(AnnotationAdapter.savedAnnotationsArray.map(item => item.id), ["a2"]);
    assert.equal(persisted.length, 1);
}

{
    seedShapes();
    const none = AnnotationAdapter.promptDeleteSelectedAnnotations(() => {
        assert.fail("confirm must not appear when nothing is selected");
    });
    assert.equal(none, 0);
    assert.equal(AnnotationAdapter.savedAnnotationsArray.length, 3);
}

{
    const deleteBtn = {
        dataset: {},
        listeners: {},
        addEventListener(type, fn) { this.listeners[type] = fn; }
    };
    const doc = { getElementById: id => (id === "delete-selected-annotations-btn" ? deleteBtn : null) };
    let prompted = 0;
    const previous = AnnotationAdapter.promptDeleteSelectedAnnotations;
    AnnotationAdapter.promptDeleteSelectedAnnotations = () => { prompted += 1; };
    AnnotationAdapter.bindLayerVisibilityAndSanitizeControls(doc);
    assert.equal(deleteBtn.dataset.deleteSelectedBound, "1");
    deleteBtn.listeners.click({ preventDefault() {} });
    assert.equal(prompted, 1, "toolbar Delete must ask before removing the selection");
    AnnotationAdapter.promptDeleteSelectedAnnotations = previous;
}

{
    const lockBtn = { addEventListener() {} };
    const deleteBtn = {
        listeners: {},
        addEventListener(type, fn) { this.listeners[type] = fn; }
    };
    const menu = {
        dataset: { targetAnnotationIds: JSON.stringify(["a1", "a2"]) },
        style: { display: "block" }
    };
    const idMap = {
        "annotation-context-menu": menu,
        "annotation-context-menu-lock-toggle": lockBtn,
        "annotation-context-menu-delete": deleteBtn
    };
    const listeners = [];
    const doc = {
        getElementById: id => idMap[id] || null,
        addEventListener(type, fn) { listeners.push([type, fn]); }
    };
    let asked = null;
    const previous = AnnotationAdapter.promptDeleteAnnotations;
    AnnotationAdapter.promptDeleteAnnotations = (ids) => { asked = ids; return ids.length; };
    AnnotationAdapter.bindAnnotationContextMenu(doc);
    deleteBtn.listeners.click({ preventDefault() {}, stopPropagation() {} });
    assert.equal(JSON.stringify(asked), JSON.stringify(["a1", "a2"]));
    assert.equal(menu.style.display, "none", "Delete on the context menu must close the menu first");
    AnnotationAdapter.promptDeleteAnnotations = previous;
}

console.log("annotation-delete.test.js: ok");
