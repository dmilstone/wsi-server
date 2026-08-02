"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const context = vm.createContext({
    console: { info() {}, warn() {}, error() {} },
    window: { setTimeout, clearTimeout },
    fetch: null,
    WsiCsrf: { csrfFetch: async () => { throw new Error("unexpected save"); } }
});
for (const file of ["annotation-store.js", "annotation-adapter.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "../../main/resources/static", file), "utf8");
    vm.runInContext(`${source}\nthis.${file.startsWith("annotation-store") ? "AnnotationStore" : "AnnotationAdapter"} = ${file.startsWith("annotation-store") ? "AnnotationStore" : "AnnotationAdapter"};`, context);
}

const { AnnotationAdapter, AnnotationStore } = context;

function response(document) {
    return { ok: true, json: async () => structuredClone(document) };
}

function collection(imageId, annotations = []) {
    return { version: 1, imageId, slidePath: `${imageId}.svs`, userId: "user", modifiedAt: null, annotations };
}

function rectangle(id, overrides = {}) {
    return {
        id, type: "rectangle", name: "Tumor", visible: true, locked: true,
        color: "#112233", lineWidth: 3, x: 10, y: 20, width: 30, height: 40,
        rotation: 0, createdAt: "2024-01-02T03:04:05Z", modifiedAt: null,
        bodies: [{ id: "body-1", value: "note", purpose: "commenting" }], ...overrides
    };
}

class FakeAnnotator {
    constructor() {
        this.annotations = [];
        this.replacements = 0;
        this.events = 0;
    }
    getAnnotations() { return this.annotations; }
    async setAnnotations(annotations) {
        await Promise.resolve();
        this.annotations = structuredClone(annotations);
        this.replacements += 1;
    }
}

async function loadWithDocuments(documents) {
    AnnotationStore.collectionCache.clear();
    context.fetch = async url => {
        const imageId = decodeURIComponent(url.split("/")[3]);
        const value = documents[imageId];
        return value instanceof Promise ? response(await value) : response(value);
    };
    const annotator = new FakeAnnotator();
    const adapter = new AnnotationAdapter(annotator);
    return { annotator, adapter };
}

(async () => {
    // First load is awaitable even when there is nothing to render.
    let fixture = await loadWithDocuments({ empty: collection("empty") });
    await fixture.adapter.loadCurrentImage("empty");
    assert.deepEqual(fixture.annotator.annotations, []);
    assert.equal(fixture.adapter.store.dirty, false);

    // Stored metadata is preserved, while missing optional creation metadata is
    // not fabricated for Annotorious or persistence.
    const withoutCreated = rectangle("00000000-0000-4000-8000-000000000001", { createdAt: null });
    fixture = await loadWithDocuments({ valid: collection("valid", [withoutCreated]) });
    await fixture.adapter.loadCurrentImage("valid");
    assert.equal(fixture.annotator.annotations.length, 1);
    assert.deepEqual(fixture.annotator.annotations[0].bodies, withoutCreated.bodies);
    const roundTrip = fixture.adapter.toBackendCollection().annotations[0];
    for (const key of ["id", "name", "visible", "locked", "x", "y", "width", "height", "createdAt"]) {
        assert.equal(roundTrip[key], withoutCreated[key], key);
    }
    assert.deepEqual(roundTrip.bodies, withoutCreated.bodies);

    // Null annotations and bodies never reach Annotorious, but remain in the
    // untouched backend document so a partial read cannot erase stored data.
    const malformed = rectangle("00000000-0000-4000-8000-000000000002", { bodies: [null, { value: "kept" }] });
    fixture = await loadWithDocuments({ malformed: collection("malformed", [null, malformed]) });
    await fixture.adapter.loadCurrentImage("malformed");
    assert.equal(fixture.annotator.annotations.length, 1);
    assert.deepEqual(fixture.annotator.annotations[0].bodies, [{ value: "kept" }]);
    assert.equal(fixture.adapter.nonDisplayedAnnotations[0], null);

    // Repeated loads replace atomically rather than append and do not mark the
    // store dirty or generate persistence/event loops.
    await fixture.adapter.loadCurrentImage("malformed");
    assert.equal(fixture.annotator.annotations.length, 1);
    assert.equal(fixture.adapter.store.dirty, false);
    assert.equal(fixture.annotator.events, 0);

    // A slow earlier image cannot render after a rapidly selected later image.
    let releaseSlow;
    const slow = new Promise(resolve => { releaseSlow = resolve; });
    fixture = await loadWithDocuments({
        slow,
        fast: collection("fast", [rectangle("00000000-0000-4000-8000-000000000003", { name: "Fast" })])
    });
    const slowLoad = fixture.adapter.loadCurrentImage("slow");
    const fastLoad = fixture.adapter.loadCurrentImage("fast");
    await fastLoad;
    releaseSlow(collection("slow", [rectangle("00000000-0000-4000-8000-000000000004", { name: "Slow" })]));
    await slowLoad;
    assert.equal(fixture.annotator.annotations[0].id, "00000000-0000-4000-8000-000000000003");
    assert.equal(fixture.adapter.store.currentImageId, "fast");

    console.log("annotation initialization checks passed");
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
