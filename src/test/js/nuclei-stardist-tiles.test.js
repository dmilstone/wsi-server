"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const staticRoot = path.join(__dirname, "../../main/resources/static");
const adapterSource = fs.readFileSync(path.join(staticRoot, "annotation-adapter.js"), "utf8");
const html = fs.readFileSync(path.join(staticRoot, "index.html"), "utf8");
const spikeSource = fs.readFileSync(path.join(staticRoot, "annotorious-spike.js"), "utf8");

const context = vm.createContext({
    console: { info() {}, warn() {}, error() {} },
    window: { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} },
    document: { getElementById() { return null; }, addEventListener() {}, createElement() { return {}; } },
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
    const tiles = AnnotationAdapter.tileImageBounds(
        { x: 0, y: 0, width: 1500, height: 1500 },
        1024,
        96
    );
    assert.equal(tiles.length, 4);
    assert.equal(tiles[0].width, 1024);
    assert.equal(tiles[0].edgeLeft, true);
    assert.equal(tiles[0].edgeTop, true);
    assert.equal(tiles[1].x, 1024 - 96);
    assert.equal(tiles[1].edgeRight, true);
}

{
    const plan = AnnotationAdapter.planNucleusTiles({ x: 10, y: 20, width: 800, height: 600 });
    assert.equal(plan.tiles.length, 1);
    assert.equal(plan.fullRes, true);
    assert.equal(plan.tiles[0].x, 10);
    assert.equal(plan.tiles[0].y, 20);
}

{
    const tile = { x: 100, y: 100, width: 1024, height: 1024, edgeLeft: false, edgeTop: false, edgeRight: false, edgeBottom: false };
    assert.equal(AnnotationAdapter.nucleusInTileInterior({ x: 110, y: 200 }, tile, 48), false);
    assert.equal(AnnotationAdapter.nucleusInTileInterior({ x: 200, y: 200 }, tile, 48), true);
}

{
    const gray = new Float32Array(64 * 64);
    for (let y = 20; y <= 28; y += 1) {
        for (let x = 20; x <= 28; x += 1) {
            const dx = x - 24;
            const dy = y - 24;
            gray[y * 64 + x] = Math.max(0, 1 - Math.hypot(dx, dy) / 6);
        }
    }
    const nuclei = AnnotationAdapter.localizeNucleiFromIntensity(gray, 64, 64, {
        probability: 0.4,
        maxSide: 64
    });
    assert.ok(nuclei.length >= 1);
    assert.ok((nuclei[0].polygon || []).length >= 3);
}

{
    const viewer = {
        overlays: [],
        currentOverlays: [],
        clearOverlays() { throw new Error("clearOverlays must not run"); },
        removeOverlay(element) {
            this.overlays = this.overlays.filter((item) => item !== element);
            this.currentOverlays = this.currentOverlays.filter((item) => item.element !== element);
        },
        addOverlay() {}
    };
    const svg = { classList: { contains: (name) => name === "nucleus-stardist-layer" }, remove() {} };
    viewer.currentOverlays.push({ element: svg });
    AnnotationAdapter.aiNucleusOverlayElements = [svg];
    AnnotationAdapter.clearNucleiCircleOverlays(viewer);
    assert.equal(AnnotationAdapter.aiNucleusOverlayElements.length, 0);
}

assert.match(adapterSource, /static planNucleusTiles\(/);
assert.match(adapterSource, /static setNucleiOverlaysVisible\(/);
assert.match(adapterSource, /static findStarDistPeaks\(/);
assert.doesNotMatch(adapterSource, /host\.clearOverlays\(\)/);
assert.match(adapterSource, /startDisabled:\s*true/);
assert.match(adapterSource, /static setMeasureTracking\(/);
assert.match(html, /id="ai-nuclei-visible"/);
assert.match(html, />Nuclei</);
assert.match(html, /id="ai-seg-target"/);
assert.doesNotMatch(html, />Target</);
assert.doesNotMatch(html, /Display Segmentation Mask Overlays/);
assert.match(html, /#ai-nuclei-visible\[aria-pressed="true"\]/);
assert.doesNotMatch(html, /Hide Segmented Nuclei/);
assert.match(spikeSource, /setDrawingTool\("rectangle"\)/);
assert.match(spikeSource, /setMeasureTracking\(false\)/);

console.log("nuclei-stardist-tiles.test.js: ok");
