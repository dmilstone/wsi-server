"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const listeners = new Map();
const fakeWindow = {
    setTimeout, clearTimeout,
    addEventListener(type, listener) { (listeners.get(type) || listeners.set(type, new Set()).get(type)).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); }
};
const context = vm.createContext({ console, window: fakeWindow, fetch: null,
    WsiCsrf: { csrfFetch: null } });
for (const file of ["annotation-store.js", "annotation-save-state-feedback.js"]) {
    const className = file.startsWith("annotation-store")
        ? "AnnotationStore" : "AnnotationSaveStateFeedback";
    const source = fs.readFileSync(path.join(__dirname, "../../main/resources/static", file), "utf8");
    vm.runInContext(`${source}\nthis.${className} = ${className};`, context);
}

class FakeElement {
    constructor() { this.hidden = false; this.textContent = ""; this.dataset = {}; this.listeners = {}; }
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
    click() { for (const listener of this.listeners.click || []) listener(); }
}

const annotation = {
    id: "00000000-0000-4000-8000-000000000001", type: "rectangle", name: "Preserved",
    visible: true, locked: true, color: "#123456", lineWidth: 3,
    x: 1, y: 2, width: 3, height: 4, rotation: 0,
    createdAt: "2026-01-02T03:04:05Z", modifiedAt: "2026-01-03T03:04:05Z",
    bodies: [{ purpose: "commenting", value: "metadata" }]
};
const collection = (imageId, name = annotation.name) => ({
    version: 1, imageId, slidePath: `${imageId}.svs`, userId: "user", modifiedAt: null,
    annotations: [{ ...structuredClone(annotation), name }]
});
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};
const ok = document => ({ ok: true, json: async () => structuredClone(document) });

(async () => {
    context.AnnotationStore.collectionCache.clear();
    const initialLoad = deferred();
    context.fetch = async url => decodeURIComponent(url.split("/")[3]) === "one"
        ? initialLoad.promise
        : ok(collection(decodeURIComponent(url.split("/")[3])));

    const store = new context.AnnotationStore({ saveDelayMs: 5 });
    const status = new FakeElement();
    const retry = new FakeElement();
    new context.AnnotationSaveStateFeedback(store, status, retry, fakeWindow);

    const loadPromise = store.load("one");
    await wait(0);
    assert.equal(status.textContent, "Loading");
    assert.equal(listeners.get("beforeunload")?.size || 0, 0, "loading has no warning");
    initialLoad.resolve(ok(collection("one")));
    await loadPromise;
    assert.equal(store.dirty, false, "clean load stays clean");
    assert.equal(status.hidden, true, "clean GET is not presented as a confirmed save");
    assert.equal(listeners.get("beforeunload")?.size || 0, 0, "loading/clean state has no warning");

    const firstSave = deferred();
    const requests = [];
    context.WsiCsrf.csrfFetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return firstSave.promise;
    };
    store.updateCollection(collection("one", "First edit"));
    assert.equal(status.textContent, "Unsaved");
    assert.equal(listeners.get("beforeunload").size, 1);
    await wait(10);
    assert.equal(status.textContent, "Saving…");
    assert.equal(requests.length, 1);
    firstSave.resolve(ok(collection("one", "First edit")));
    await store.activeSavePromise;
    assert.equal(status.textContent, "Saved");
    assert.equal(store.dirty, false);
    assert.equal(listeners.get("beforeunload")?.size || 0, 0, "successful PUT removes warning");

    // A failed PUT retains the exact document, exposes Retry, and does not spin
    // in a background retry loop.
    let attempts = 0;
    context.WsiCsrf.csrfFetch = async () => {
        attempts += 1;
        return { ok: false, text: async () => "failure" };
    };
    const failedDocument = collection("one", "Retry me");
    store.updateCollection(failedDocument);
    await wait(12);
    assert.equal(status.textContent, "Save failed");
    assert.equal(retry.hidden, false);
    assert.equal(store.dirty, true);
    assert.equal(attempts, 1);
    await wait(12);
    assert.equal(attempts, 1, "failure does not create an infinite retry loop");
    assert.deepEqual(store.currentCollection, failedDocument);

    context.WsiCsrf.csrfFetch = async (_url, options) => {
        attempts += 1;
        return ok(JSON.parse(options.body));
    };
    retry.click();
    await wait(0);
    await store.activeSavePromise;
    assert.equal(status.textContent, "Saved");
    assert.equal(attempts, 2);
    assert.equal(listeners.get("beforeunload")?.size || 0, 0);

    // An edit made during an active PUT is never reported Saved by the older
    // response. Each required version uses the one existing PUT path.
    const saves = [deferred(), deferred()];
    const bodies = [];
    context.WsiCsrf.csrfFetch = async (_url, options) => {
        bodies.push(JSON.parse(options.body));
        return saves[bodies.length - 1].promise;
    };
    store.updateCollection(collection("one", "Version one"));
    await wait(10);
    store.updateCollection(collection("one", "Version two"));
    saves[0].resolve(ok(collection("one", "Version one")));
    await wait(2);
    assert.notEqual(status.textContent, "Saved", "older response cannot confirm a newer edit");
    await wait(10);
    assert.equal(bodies.length, 2);
    saves[1].resolve(ok(collection("one", "Version two")));
    await store.activeSavePromise;
    assert.equal(status.textContent, "Saved");
    assert.equal(bodies[1].annotations[0].name, "Version two");
    assert.equal(bodies[1].annotations.length, 1, "retry/version saves do not duplicate annotations");
    for (const key of ["id", "type", "visible", "locked", "color", "lineWidth", "x", "y",
        "width", "height", "rotation", "createdAt", "modifiedAt", "bodies"]) {
        assert.deepEqual(bodies[1].annotations[0][key], annotation[key], key);
    }

    // A failed image-switch flush rejects once and leaves the original image and
    // collection active. A later successful retry permits the switch.
    context.WsiCsrf.csrfFetch = async () => ({ ok: false, text: async () => "failure" });
    store.updateCollection(collection("one", "Block switch"));
    await assert.rejects(store.load("two"), /could not be saved/);
    assert.equal(store.currentImageId, "one");
    assert.equal(store.currentCollection.annotations[0].name, "Block switch");
    assert.equal(status.textContent, "Save failed");

    context.WsiCsrf.csrfFetch = async (_url, options) => ok(JSON.parse(options.body));
    await store.retrySave();
    await store.load("two");
    assert.equal(store.currentImageId, "two");
    assert.equal(store.dirty, false);
    assert.equal(listeners.get("beforeunload")?.size || 0, 0);

    const adapterSource = fs.readFileSync(
        path.join(__dirname, "../../main/resources/static/annotation-adapter.js"), "utf8");
    const savedHandler = adapterSource.match(/event\.reason === "saved"([\s\S]*?)\n            \}/)?.[1];
    assert.ok(savedHandler);
    assert.doesNotMatch(savedHandler, /replaceAnnotoriousAnnotations|applyBackendCollection/,
        "save confirmation never replaces live Annotorious geometry");

    const pageSource = fs.readFileSync(
        path.join(__dirname, "../../main/resources/static/index.html"), "utf8");
    const imageSwitch = pageSource.match(/async function selectImage\(image\) \{([\s\S]*?)\n    \}/)?.[1];
    assert.ok(imageSwitch);
    assert.ok(imageSwitch.indexOf("await annotationSpike.flushPendingSave()")
        < imageSwitch.indexOf("selectedImage = image"), "flush completes before active-image mutation");
    assert.match(imageSwitch, /catch \{[\s\S]*?Save failed[\s\S]*?return;/);

    console.log("annotation save-state checks passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
