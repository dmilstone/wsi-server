"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const staticRoot = path.join(__dirname, "../../main/resources/static");
const adapterSource = fs.readFileSync(path.join(staticRoot, "annotation-adapter.js"), "utf8");

function element(id = "") {
    const removed = [];
    return {
        id,
        hidden: true,
        style: { display: "none" },
        open: false,
        className: "",
        textContent: "",
        dataset: {},
        children: [],
        removedClasses: removed,
        classList: {
            add() {},
            remove(name) { removed.push(name); },
            contains() { return false; }
        },
        removeAttribute(name) {
            if (name === "open") this.open = false;
        },
        querySelector() { return null; },
        addEventListener() {}
    };
}

const nodes = {
    "z-controls-card": element("z-controls-card"),
    "z-depth-controls": element("z-depth-controls"),
    "ai-analytics-panel": element("ai-analytics-panel"),
    "ai-labs-panel": element("ai-labs-panel")
};
const stack = { hidden: true, style: { display: "none" } };

const context = vm.createContext({
    console: { info() {}, warn() {}, error() {} },
    window: { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} },
    document: {
        getElementById(id) { return nodes[id] || null; },
        querySelector(sel) { return sel === ".right-stack-controls" ? stack : null; },
        addEventListener() {},
        createElement() { return element(); }
    },
    fetch: null,
    WsiCsrf: { csrfFetch: async () => { throw new Error("unexpected save"); } }
});
vm.runInContext(
    `${fs.readFileSync(path.join(staticRoot, "annotation-store.js"), "utf8")}\nthis.AnnotationStore = AnnotationStore;`,
    context
);
vm.runInContext(`${adapterSource}\nthis.AnnotationAdapter = AnnotationAdapter;`, context);
const { AnnotationAdapter } = context;

{
    assert.equal(AnnotationAdapter.isMultiLayerSlide({ zPlanes: 4 }), true);
    assert.equal(AnnotationAdapter.isMultiLayerSlide({ depth: 3 }), true);
    assert.equal(AnnotationAdapter.isMultiLayerSlide({ zLayers: 2 }), true);
    assert.equal(AnnotationAdapter.isMultiLayerSlide({ folder: "case_z/stack" }), true);
    assert.equal(AnnotationAdapter.isMultiLayerSlide({ z_planes: 5 }), true);
    assert.equal(AnnotationAdapter.isMultiLayerSlide({ zPlanes: 1, folder: "routine" }), false);
    assert.equal(AnnotationAdapter.zPlaneCountFromSlide({ zPlanes: 1, folder: "case_z" }), 2);
    assert.equal(AnnotationAdapter.zPlaneCountFromSlide({ depth: 7 }), 7);
}

{
    const mapped = AnnotationAdapter.mapSidecarProperties({
        id: "slide-1",
        clinical_marker: "if IgG",
        z_planes: 6,
        directory: "ba26_z"
    });
    assert.equal(mapped.clinicalMarker, "if.IgG");
    assert.equal(mapped.zPlanes, 6);
    assert.equal(mapped.folder, "ba26_z");
    assert.equal(mapped.zPlanes > 1 || mapped.depth > 1 || mapped.zLayers > 1
        || (mapped.folder && mapped.folder.includes("_z")), true);
}

{
    const images = [
        { id: "a", name: "A.vsi", relativePath: "A.vsi", clinicalMarker: "if.IgA", folder: "std" },
        { id: "b", name: "B.vsi", relativePath: "B.vsi", epitope: "if.IgG", zLayers: 4, folder: "std" }
    ];
    const cache = AnnotationAdapter.cacheCatalogSidecarMetadata(images);
    assert.equal(cache.get("a").clinicalMarker, "if.IgA");
    assert.equal(cache.get("B.vsi").clinicalMarker, "if.IgG");
    assert.equal(cache.get("b").zLayers, 4);
    assert.equal(AnnotationAdapter.clinicalMarkerFromImage({ id: "a" }), "if.IgA");
    assert.equal(AnnotationAdapter.clinicalMarkerFromImage({ id: "missing" }), "");
}

{
    nodes["z-controls-card"].hidden = true;
    nodes["z-controls-card"].style.display = "none";
    nodes["z-depth-controls"].hidden = true;
    nodes["ai-analytics-panel"].hidden = true;
    nodes["ai-analytics-panel"].open = true;
    nodes["ai-labs-panel"].hidden = true;
    stack.hidden = true;

    AnnotationAdapter.onSlideClicked({ zPlanes: 1, folder: "routine" }, context.document);
    assert.equal(nodes["z-controls-card"].hidden, true);

    AnnotationAdapter.onSlideClicked({ folder: "stack_z" }, context.document);
    assert.equal(nodes["z-controls-card"].hidden, false);
    assert.equal(nodes["z-controls-card"].style.display, "block");
    assert.equal(nodes["z-depth-controls"].hidden, false);
    assert.equal(nodes["ai-analytics-panel"].hidden, false);
    assert.equal(nodes["ai-analytics-panel"].open, false);
    assert.equal(nodes["ai-labs-panel"].hidden, false);
    assert.ok(nodes["ai-labs-panel"].removedClasses.includes("show"));
    assert.ok(nodes["ai-analytics-panel"].removedClasses.includes("show"));
    assert.equal(stack.hidden, false);
}

{
    const missingDoc = { getElementById() { return null; } };
    assert.equal(AnnotationAdapter.collapseAiLabsPanel(missingDoc), false);
    nodes["ai-analytics-panel"].open = true;
    nodes["ai-labs-panel"].removedClasses.length = 0;
    assert.equal(AnnotationAdapter.collapseAiLabsPanel(context.document), true);
    assert.equal(nodes["ai-analytics-panel"].open, false);
    assert.ok(nodes["ai-labs-panel"].removedClasses.includes("show"));
}

{
    nodes["ai-analytics-panel"].open = true;
    nodes["ai-labs-panel"].removedClasses.length = 0;
    assert.equal(AnnotationAdapter.enforceDefaultClosedPanelState(context.document), true);
    assert.equal(nodes["ai-analytics-panel"].open, false);
    assert.ok(nodes["ai-labs-panel"].removedClasses.includes("show"));
}

assert.match(adapterSource, /static onSlideClicked\(/);
assert.match(adapterSource, /static selectSlideCase\(/);
assert.match(adapterSource, /static loadSlide\(/);
assert.match(adapterSource, /static collapseAiLabsPanel\(/);
assert.match(adapterSource, /static enforceDefaultClosedPanelState\(/);
assert.match(adapterSource, /ai-labs-panel/);
assert.match(adapterSource, /allowBrowserFallback === true/);
assert.doesNotMatch(
    adapterSource,
    /renderImageBrowser[\s\S]{0,1800}allowBrowserFallback:\s*true/
);

console.log("sidecar-metadata-maps.test.js: ok");
