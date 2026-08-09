"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class FakeInput {
    constructor() {
        this.value = ""; this.disabled = true; this.listeners = {}; this.validity = "";
        this.hidden = false; this.focused = false; this.selectionStart = null; this.selectionEnd = null;
        this.parentElement = null;
    }
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
    setCustomValidity(value) { this.validity = value; }
    setAttribute(name, value) { this[name] = value; }
    focus() { this.focused = true; }
    select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
    remove() { this.parentElement = null; }
    blur() { this.dispatch("blur"); }
    dispatch(type, event = {}) {
        for (const listener of this.listeners[type] || []) listener({
            key: event.key, preventDefault() {}, stopPropagation() {}, target: this
        });
    }
}

class FakeHost {
    constructor() { this.className = ""; this.children = []; }
    get classList() {
        const host = this;
        return {
            add(name) { host.className = `${host.className} ${name}`.trim(); },
            remove(name) {
                host.className = host.className.split(/\s+/).filter(part => part && part !== name).join(" ");
            }
        };
    }
    replaceChildren(node) {
        this.children = [node];
        node.parentElement = this;
    }
}

const context = vm.createContext({ console, window: { setTimeout, clearTimeout }, fetch: null,
    WsiCsrf: { csrfFetch: null } });
for (const file of ["annotation-store.js", "annotation-adapter.js", "annotation-name-editor.js"]) {
    const className = file === "annotation-store.js" ? "AnnotationStore" :
        file === "annotation-adapter.js" ? "AnnotationAdapter" : "AnnotationNameEditor";
    const source = fs.readFileSync(path.join(__dirname, "../../main/resources/static", file), "utf8");
    vm.runInContext(`${source}\nthis.${className} = ${className};`, context);
}

const base = {
    id: "00000000-0000-4000-8000-000000000001", type: "rectangle", name: null,
    visible: true, locked: true, color: "#123456", lineWidth: 3,
    x: 10, y: 20, width: 30, height: 40, rotation: 0,
    createdAt: "2026-01-02T03:04:05Z", modifiedAt: "2026-01-03T03:04:05Z",
    bodies: [{ purpose: "commenting", value: "keep" }]
};
const second = { ...base, id: "00000000-0000-4000-8000-000000000002", name: "Second" };
const annotator = {
    annotations: [], getAnnotations() { return this.annotations; },
    async setAnnotations(values) { this.annotations = structuredClone(values); }
};
let putCount = 0;
context.fetch = async () => ({ ok: true, json: async () => ({
    version: 1, imageId: "one", slidePath: "one.svs", userId: "user", modifiedAt: null,
    annotations: [structuredClone(base), structuredClone(second)]
}) });
context.WsiCsrf.csrfFetch = async (_url, options) => {
    putCount += 1;
    return { ok: true, json: async () => JSON.parse(options.body) };
};

(async () => {
    context.AnnotationStore.collectionCache.clear();
    const adapter = new context.AnnotationAdapter(annotator);
    adapter.store.saveDelayMs = 10;
    await adapter.loadCurrentImage("one");
    const input = new FakeInput();
    const committedIds = [];
    const editor = new context.AnnotationNameEditor(input, adapter, id => committedIds.push(id));
    const firstShape = annotator.annotations[0];
    const original = structuredClone(adapter.toBackendCollection().annotations[0]);

    // Old unnamed data is blank in storage/UI, and exact-one selection enables editing.
    editor.setSelection([firstShape]);
    assert.equal(input.disabled, false);
    assert.equal(input.value, "");
    editor.setSelection([]);
    assert.equal(input.disabled, true);
    assert.equal(input.value, "");

    editor.setSelection([firstShape]);
    input.value = "Seed name";
    input.dispatch("blur");
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(adapter.getAnnotationName(firstShape.id), "Seed name");
    assert.equal(putCount, 1);
    const host = new FakeHost();
    assert.equal(editor.beginInlineEdit(host), true);
    assert.equal(input.focused, true);
    assert.equal(input.value, "Seed name");
    assert.equal(input.selectionStart, 0);
    assert.equal(input.selectionEnd, "Seed name".length);
    assert.match(host.className, /is-editing/);
    input.dispatch("keydown", { key: "Escape" });

    editor.setSelection([firstShape]);
    input.value = "  Région 🧬, #2!  ";
    input.dispatch("keydown", { key: "Enter" });
    assert.equal(adapter.getAnnotationName(firstShape.id), "Région 🧬, #2!");
    assert.equal(input.value, "Région 🧬, #2!");
    assert.deepEqual(committedIds, [firstShape.id, firstShape.id]);

    // Rapid input does not save; one actual commit follows the store debounce path.
    input.value = "Renamed once"; input.dispatch("input");
    input.value = "Renamed twice"; input.dispatch("input");
    input.dispatch("blur");
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(putCount, 2);
    assert.equal(adapter.getAnnotationName(firstShape.id), "Renamed twice");
    assert.equal(committedIds.length, 3);

    // Escape restores, unchanged blur does not save, and blank removes the field.
    input.value = "not saved";
    input.dispatch("keydown", { key: "Escape" });
    assert.equal(input.value, "Renamed twice");
    input.dispatch("blur");
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(putCount, 2);
    input.value = "   "; input.dispatch("blur");
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(adapter.getAnnotationName(firstShape.id), "");
    assert.equal(putCount, 3);
    assert.equal(committedIds.length, 4);

    // Code-point limit accepts 200 emoji and clearly rejects 201 without persistence.
    input.value = "🧬".repeat(200); input.dispatch("input"); assert.equal(input.validity, "");
    input.value += "a"; input.dispatch("input"); assert.match(input.validity, /200/);
    input.dispatch("blur"); await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(putCount, 3);

    // Selection/image transitions discard drafts; hidden/deleted state is unavailable.
    input.value = "wrong image";
    editor.setSelection([annotator.annotations[1]]);
    assert.equal(input.value, "Second");
    editor.setSelection([]); input.dispatch("blur");
    assert.equal(putCount, 3);
    editor.setSelection([firstShape]); editor.setVisible(false, [firstShape]);
    assert.equal(input.disabled, true);
    editor.setVisible(true, [firstShape]); assert.equal(input.disabled, false);
    editor.setSelection([]); assert.equal(input.value, "");

    // Naming never changes geometry, identity, timestamps, bodies, visibility or locking,
    // and Annotorious still contains exactly the two original shapes.
    const after = adapter.toBackendCollection().annotations[0];
    for (const key of ["id", "type", "visible", "locked", "color", "lineWidth", "x", "y",
        "width", "height", "rotation", "createdAt", "modifiedAt"]) assert.equal(after[key], original[key], key);
    assert.deepEqual(after.bodies, original.bodies);
    assert.equal(annotator.annotations.length, 2);

    console.log("annotation name checks passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
