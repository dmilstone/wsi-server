"use strict";

/**
 * Regression coverage for: annotations from the previously viewed slide stayed
 * visible after switching the case-filter dropdown away from a slide (e.g. to
 * "All Slides", or to a different case) — and, since that dropdown path is the
 * only cleanup that ever runs during that transition, after switching between
 * slides that way too. applyZeroExposureWorkspace() used to only blank the OSD
 * viewport (tiles) and header text; it never purged the native annotation SVG
 * shapes, so they kept floating over the now-empty viewport until a *new*
 * concrete slide was opened.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const staticRoot = path.join(__dirname, "../../main/resources/static");
const adapterSource = fs.readFileSync(path.join(staticRoot, "annotation-adapter.js"), "utf8");
const storeSource = fs.readFileSync(path.join(staticRoot, "annotation-store.js"), "utf8");

function fakeShapeNode() {
    return {
        removed: false,
        closest() { return null; },
        remove() { this.removed = true; }
    };
}

function makeDocument(shapeNodes) {
    return {
        getElementById() { return null; },
        querySelector() { return null; },
        querySelectorAll(selector) {
            if (selector === ".osd-annotation-shape, .annotation-shape-overlay, .annotation-text-label, .annotation-marker-node") {
                return shapeNodes;
            }
            return [];
        },
        addEventListener() {}
    };
}

function makeViewer() {
    const calls = [];
    return {
        calls,
        close() { calls.push("close"); },
        clearOverlays() { calls.push("clearOverlays"); }
    };
}

const context = vm.createContext({
    console: { info() {}, warn() {}, error() {} },
    window: { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} },
    document: { getElementById() { return null; }, querySelectorAll() { return []; }, addEventListener() {} },
    fetch: null,
    WsiCsrf: { csrfFetch: async () => { throw new Error("unexpected save"); } }
});
vm.runInContext(`${storeSource}\nthis.AnnotationStore = AnnotationStore;`, context);
vm.runInContext(`${adapterSource}\nthis.AnnotationAdapter = AnnotationAdapter;`, context);
const { AnnotationAdapter } = context;

// applyZeroExposureWorkspace: closing/blanking the viewport must also purge every
// native annotation shape left over from the previously viewed slide, not just the
// OSD tiles and header text.
{
    const shapes = [fakeShapeNode(), fakeShapeNode()];
    const doc = makeDocument(shapes);
    const viewer = makeViewer();
    AnnotationAdapter.setSavedAnnotations([{ id: "stale-1" }, { id: "stale-2" }]);

    context.document = doc;
    AnnotationAdapter.applyZeroExposureWorkspace(doc, { viewer });

    assert.ok(viewer.calls.includes("close"), "must still close the OSD viewport (blank the tiles)");
    assert.ok(viewer.calls.includes("clearOverlays"), "must sweep OSD's own overlay nodes too");
    for (const shape of shapes) {
        assert.equal(shape.removed, true,
            "every leftover native annotation shape must be removed from the DOM");
    }
    assert.equal(AnnotationAdapter.savedAnnotationsArray.length, 0,
        "the in-memory annotation array must be cleared so nothing redraws the stale shapes");
}

// Same check when no viewer is supplied (e.g. very first page paint, before any
// slide was ever opened) — must not throw, and must still purge stray shapes.
{
    const shapes = [fakeShapeNode()];
    const doc = makeDocument(shapes);
    context.document = doc;

    assert.doesNotThrow(() => AnnotationAdapter.applyZeroExposureWorkspace(doc, {}));
    assert.equal(shapes[0].removed, true);
}

// forceCaseFilterViewportWipe is the thin wrapper actually wired to the
// #case-filter-select "change" listener (see bindCaseFilterChangeGuard) — confirm
// it forwards through to the same purge, since that is the exact code path the
// "switching to All Slides leaves annotations on screen" bug travels through.
{
    const shapes = [fakeShapeNode(), fakeShapeNode(), fakeShapeNode()];
    const doc = makeDocument(shapes);
    const viewer = makeViewer();
    context.document = doc;
    AnnotationAdapter.setSavedAnnotations([{ id: "still-stale" }]);

    AnnotationAdapter.forceCaseFilterViewportWipe(doc, { viewer });

    assert.ok(viewer.calls.includes("close"));
    for (const shape of shapes) assert.equal(shape.removed, true);
    assert.equal(AnnotationAdapter.savedAnnotationsArray.length, 0);
}

console.log("zero-exposure-annotation-clear.test.js: ok");
