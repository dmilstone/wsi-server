"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const staticRoot = path.join(__dirname, "../../main/resources/static");
const adapterSource = fs.readFileSync(path.join(staticRoot, "annotation-adapter.js"), "utf8");
const html = fs.readFileSync(path.join(staticRoot, "index.html"), "utf8");

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
    const mapped = AnnotationAdapter.mapPluginNucleiToOverlays({
        nuclei: [{
            index: 0,
            cx: 10,
            cy: 12,
            vertices: [{ x: 8, y: 10 }, { x: 12, y: 10 }, { x: 11, y: 14 }]
        }]
    });
    assert.equal(mapped.length, 1);
    assert.equal(mapped[0].type, "Polygon");
    assert.equal(mapped[0].vertices.length, 3);
    assert.equal(AnnotationAdapter.verticesToPointsString(mapped[0].vertices), "8,10 12,10 11,14");
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

assert.match(adapterSource, /static primaryTiledImage\(/);
assert.doesNotMatch(adapterSource, /viewport\.viewportToImageCoordinates/);
assert.doesNotMatch(adapterSource, /viewport\.imageToViewportWidth\(/);

{
    const viewer = {
        world: {
            getItemCount: () => 2,
            getItemAt: () => ({
                imageToViewportWidth: (span) => span / 1000,
                viewportToImageCoordinates: (point) => ({ x: point.x * 10, y: point.y * 10 })
            })
        },
        viewport: {
            imageToViewportWidth() { throw new Error("viewport.imageToViewportWidth must not run"); },
            viewportToImageCoordinates() { throw new Error("viewport.viewportToImageCoordinates must not run"); }
        }
    };
    assert.equal(AnnotationAdapter.imageToViewportWidth(viewer, 200), 0.2);
    const mapped = AnnotationAdapter.primaryTiledImage(viewer).viewportToImageCoordinates({ x: 2, y: 3 });
    assert.equal(mapped.x, 20);
    assert.equal(mapped.y, 30);
}

assert.match(adapterSource, /static planNucleusTiles\(/);
assert.match(adapterSource, /static setNucleiOverlaysVisible\(/);
assert.match(adapterSource, /static findStarDistPeaks\(/);
assert.match(adapterSource, /static async runStarDistSegmentation\(/);
assert.match(adapterSource, /stardist-segmentation/);
assert.match(adapterSource, /static nucleusVertexList\(/);
assert.match(adapterSource, /static verticesToPointsString\(/);
assert.match(adapterSource, /static mapPluginNucleiToOverlays\(/);
assert.match(adapterSource, /fill", "rgba\(0,255,0,\.15\)"/);
assert.doesNotMatch(adapterSource, /style\.borderRadius = "50%"/);
assert.doesNotMatch(adapterSource, /host\.clearOverlays\(\)/);
assert.match(adapterSource, /startDisabled:\s*true/);
assert.match(adapterSource, /static setMeasureTracking\(/);
assert.match(html, /id="ai-nuclei-visible"/);
assert.match(html, />1\. Segment Nuclei</);
assert.doesNotMatch(html, /Segment Cell Nuclei/);
assert.match(html, /id="plugin-selector"/);
assert.match(html, /<option value="quantify-nuclei-pixel">Run Pixel Intensity Plugin</);
assert.match(html, /<option value="per-object-pixel-quantifier">Quantify Individual Objects \(Color Code\)</);
assert.match(html, /<option value="ihc-pixel-quantifier">Run IHC Color Deconvolution Plugin</);
assert.match(adapterSource, /static async runIhcColorDeconvolution\(/);
assert.match(adapterSource, /ihc-pixel-quantifier/);
assert.doesNotMatch(adapterSource, /runIhcColorDeconvolution[\s\S]{0,1200}renderPluginStatsTable/);
assert.equal(AnnotationAdapter.ihcRgbFromNormalized(0), "rgb(255, 255, 0)");
assert.equal(AnnotationAdapter.ihcRgbFromNormalized(1), "rgb(128, 0, 0)");
assert.equal(AnnotationAdapter.isBrightfieldSlide({ modality: "BRIGHTFIELD" }), true);
assert.equal(AnnotationAdapter.isBrightfieldSlide({ engine: "OPENSLIDE" }), true);
assert.equal(AnnotationAdapter.isBrightfieldSlide({ modality: "FLUORESCENCE" }), false);
assert.equal(AnnotationAdapter.isRgbSeriesView({ rgb: true, modality: "FLUORESCENCE" }, 2), true);
assert.equal(AnnotationAdapter.isRgbSeriesView({
    modality: "FLUORESCENCE",
    series: 2,
    seriesProfiles: [{ index: 2, rgb: true, isDiagnosticSpecimen: true }]
}, 2), true);
assert.equal(AnnotationAdapter.isRgbSeriesView({
    modality: "FLUORESCENCE",
    seriesProfiles: [{ index: 2, rgb: false, isDiagnosticSpecimen: true }]
}, 2), false);
assert.equal(AnnotationAdapter.chooseDefaultSeries([
    { index: 0, width: 1024, height: 1024, rgb: false, isDiagnosticSpecimen: true },
    { index: 2, width: 8000, height: 6000, rgb: true, isDiagnosticSpecimen: true }
]), 2);
assert.equal(AnnotationAdapter.chooseDefaultSeries([
    { index: 0, width: 9000, height: 7000, rgb: true, isDiagnosticSpecimen: true },
    { index: 2, width: 8000, height: 6000, rgb: false, isDiagnosticSpecimen: true }
]), 2);
assert.match(html, /<summary>System Diagnostic Disclaimer<\/summary>/);
assert.match(html, /Experimental viewport simulation on this browser only/);
assert.match(adapterSource, /static async runPerObjectPixelQuantifier\(/);
assert.match(adapterSource, /per-object-pixel-quantifier/);
assert.match(adapterSource, /rainbowRgbFromNormalized/);
assert.match(adapterSource, /2px solid \$\{computedObjectColor\}/);
assert.doesNotMatch(adapterSource, /runPerObjectPixelQuantifier[\s\S]{0,1200}renderPluginStatsTable/);
assert.match(adapterSource, /\/api\/plugins\/execute/);
assert.equal(AnnotationAdapter.rainbowRgbFromNormalized(0), "rgb(0, 0, 255)");
assert.equal(AnnotationAdapter.rainbowRgbFromNormalized(1 / 3), "rgb(0, 255, 0)");
assert.equal(AnnotationAdapter.rainbowRgbFromNormalized(2 / 3), "rgb(255, 255, 0)");
assert.equal(AnnotationAdapter.rainbowRgbFromNormalized(1), "rgb(255, 0, 0)");

{
    const cold = { style: {}, tagName: "DIV" };
    const hot = { style: {}, tagName: "DIV" };
    AnnotationAdapter.aiNucleusOverlayParts = [cold, hot];
    AnnotationAdapter.applyObjectRainbowColors([
        { index: 0, key: 10 },
        { index: 1, key: 40 }
    ]);
    assert.equal(cold.style.border, "2px solid rgb(0, 0, 255)");
    assert.equal(cold.style.background, "rgba(0, 0, 255, 0.25)");
    assert.equal(hot.style.border, "2px solid rgb(255, 0, 0)");
    assert.equal(hot.style.background, "rgba(255, 0, 0, 0.25)");
    assert.equal(cold.style.innerHTML, undefined);
    assert.equal(hot.textContent, undefined);
}

{
    const button = {
        textContent: "Show",
        title: "Show",
        attrs: {},
        setAttribute(name, value) { this.attrs[name] = String(value); }
    };
    const root = { getElementById: (id) => (id === "ai-nuclei-visible" ? button : null) };
    AnnotationAdapter.aiOverlayVisible = true;
    AnnotationAdapter.aiNucleusOverlayElements = [{ style: {} }];
    AnnotationAdapter.syncNucleiVisibilityButton(root);
    assert.equal(button.textContent, "Hide");
    assert.equal(button.attrs["aria-pressed"], "true");
    AnnotationAdapter.aiOverlayVisible = false;
    AnnotationAdapter.syncNucleiVisibilityButton(root);
    assert.equal(button.textContent, "Show");
    assert.equal(button.attrs["aria-pressed"], "false");
    AnnotationAdapter.aiNucleusOverlayElements = [];
}

assert.match(html, /id="ai-seg-target"/);
assert.doesNotMatch(html, />Target</);
assert.doesNotMatch(html, /Display Segmentation Mask Overlays/);
assert.match(html, /#ai-nuclei-visible\[aria-pressed="true"\]/);
assert.match(adapterSource, /button\.textContent = label/);
assert.match(adapterSource, /showing \? "Hide" : "Show"/);
assert.doesNotMatch(html, /Hide Segmented Nuclei/);
assert.doesNotMatch(html, />Nuclei</);
assert.match(adapterSource, /activateQuPathTool\("rectangle"\)/);
assert.match(adapterSource, /setMeasureTracking\(false\)/);

console.log("nuclei-stardist-tiles.test.js: ok");
