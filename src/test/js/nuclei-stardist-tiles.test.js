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

{
    // Regression: a full reset (e.g. returning to the empty-viewport / slide switch)
    // must also drop the "last detected nuclei" cache, otherwise re-enabling the
    // visibility toggle afterwards can repaint a previous slide's stale contours.
    const viewer = {
        overlays: [],
        currentOverlays: [],
        removeOverlay() {},
        addOverlay() {}
    };
    AnnotationAdapter.lastNucleiCircles = [{ centerX: 5, centerY: 5, radius: 3 }];
    AnnotationAdapter.aiNucleusOverlayElements = [];
    AnnotationAdapter.clearAiNucleiOverlay({ remove: true, viewer });
    assert.equal(AnnotationAdapter.lastNucleiCircles.length, 0);
    assert.equal(AnnotationAdapter.localizedCellObjects.length, 0);
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
assert.match(html, /id="ai-heatmap-toggle"/);
assert.match(adapterSource, /static async toggleHeatMap\(/);
assert.match(adapterSource, /static resetNucleusOverlayColors\(/);

// "Expose, edit and use all StarDist parameters" — the advanced controls must exist
// in the AI Labs panel markup, not just theoretically wired in JS.
assert.match(html, /id="ai-max-nucleus-radius"/);
assert.match(html, /id="ai-ray-count"/);
assert.match(html, /id="ai-boundary-tightness"/);
assert.match(html, /id="ai-model-override"/);
assert.match(html, /Force Fluorescence model/);
assert.match(html, /Force H&amp;E \/ brightfield model/);

(async () => {
    // Regression: the probability/NMS sliders must be read live (not cached) and
    // actually reach the backend StarDist plugin call, otherwise a second click
    // with different slider values silently produces identical results.
    let capturedBody = null;
    context.WsiCsrf.csrfFetch = async (_url, options) => {
        capturedBody = JSON.parse(options.body);
        return { ok: true, json: async () => ({ nuclei: [] }) };
    };
    AnnotationAdapter.currentImageId = "slide-1";
    const root = {
        getElementById: (id) => {
            if (id === "ai-prob-threshold") return { value: "0.77" };
            if (id === "ai-nms-threshold") return { value: "0.55" };
            if (id === "ai-max-nucleus-radius") return { value: "12" };
            if (id === "ai-ray-count") return { value: "48" };
            if (id === "ai-boundary-tightness") return { value: "0.6" };
            if (id === "ai-model-override") return { value: "he" };
            return null;
        }
    };
    await AnnotationAdapter.runStarDistSegmentation({ root, viewer: null });
    assert.ok(capturedBody, "expected runStarDistSegmentation to send a plugin request");
    assert.equal(capturedBody.probability, 0.77);
    assert.equal(capturedBody.nms, 0.55);
    assert.equal(capturedBody.pluginId, "stardist-segmentation");

    // Regression: "expose all StarDist parameters" — the advanced knobs (max nucleus
    // radius, ray count/shape smoothness, boundary tightness, model override) must
    // reach the backend exactly like probability/NMS, not silently drop on the floor.
    assert.equal(capturedBody.maxNucleusRadius, 12);
    assert.equal(capturedBody.rayCount, 48);
    assert.equal(capturedBody.boundaryTightness, 0.6);
    assert.equal(capturedBody.modelOverride, "he");

    // Defaults apply when the advanced controls aren't present in the DOM.
    const defaultsRoot = {
        getElementById: (id) => {
            if (id === "ai-prob-threshold") return { value: "0.5" };
            if (id === "ai-nms-threshold") return { value: "0.4" };
            return null;
        }
    };
    await AnnotationAdapter.runStarDistSegmentation({ root: defaultsRoot, viewer: null });
    assert.equal(capturedBody.maxNucleusRadius, AnnotationAdapter.AI_DEFAULT_MAX_NUCLEUS_RADIUS);
    assert.equal(capturedBody.rayCount, AnnotationAdapter.AI_DEFAULT_RAY_COUNT);
    assert.equal(capturedBody.boundaryTightness, AnnotationAdapter.AI_DEFAULT_BOUNDARY_TIGHTNESS);
    assert.equal(capturedBody.modelOverride, AnnotationAdapter.AI_DEFAULT_MODEL_OVERRIDE);

    // Regression: the "Segmentation Channel" dropdown (#ai-seg-channel) was read into
    // config.channel but never actually reached the backend request -- the payload
    // always sent whatever channels happened to be visible in the Brightness &
    // Contrast panel, silently ignoring the dropdown entirely. Choosing a specific
    // channel must now restrict detection to only that channel; "default" must keep
    // the prior visible-channels behavior unchanged.
    const channelRoot = {
        getElementById: (id) => {
            if (id === "ai-prob-threshold") return { value: "0.5" };
            if (id === "ai-nms-threshold") return { value: "0.4" };
            if (id === "ai-seg-channel") return { value: "1" };
            return null;
        }
    };
    await AnnotationAdapter.runStarDistSegmentation({ root: channelRoot, viewer: null });
    // Arrays crossing the VM-context boundary aren't `instanceof` the same realm's
    // Array, which trips up assert/strict's deepEqual; compare joined content instead.
    assert.equal(capturedBody.channels.join(","), "DAPI",
        "choosing Channel 1 (DAPI/Blue) must restrict segmentation to only that channel");

    const greenChannelRoot = {
        getElementById: (id) => {
            if (id === "ai-prob-threshold") return { value: "0.5" };
            if (id === "ai-nms-threshold") return { value: "0.4" };
            if (id === "ai-seg-channel") return { value: "2" };
            return null;
        }
    };
    await AnnotationAdapter.runStarDistSegmentation({ root: greenChannelRoot, viewer: null });
    assert.equal(capturedBody.channels.join(","), "FITC",
        "choosing Channel 2 (Green) must restrict segmentation to only that channel");

    const defaultChannelRoot = {
        getElementById: (id) => {
            if (id === "ai-prob-threshold") return { value: "0.5" };
            if (id === "ai-nms-threshold") return { value: "0.4" };
            if (id === "ai-seg-channel") return { value: "default" };
            return null;
        }
    };
    await AnnotationAdapter.runStarDistSegmentation({ root: defaultChannelRoot, viewer: null });
    assert.equal(capturedBody.channels.join(","), AnnotationAdapter.visiblePluginChannels().join(","),
        "\"Default Viewport\" must keep segmenting on whatever channels are visible in Brightness & Contrast");

    // Regression: there was no dedicated Heat Map button — only a dropdown + "Run"
    // combo that silently no-oped without nuclei segmented first, and no way to
    // revert the color-coding once applied. The toggle must: skip re-segmenting when
    // nuclei already exist, color every nucleus polygon, and cleanly revert on a
    // second click without ever calling the network-backed segmentation path again.
    {
        const polygonA = { attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } };
        const polygonB = { attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } };
        AnnotationAdapter.aiNucleusOverlayParts = [polygonA, polygonB];
        AnnotationAdapter.lastNucleiCircles = [{ centerX: 1, centerY: 1, radius: 2 }, { centerX: 5, centerY: 5, radius: 2 }];
        AnnotationAdapter.heatMapActive = false;

        let segmentCalls = 0;
        const previousSegment = AnnotationAdapter.segmentCellNuclei;
        AnnotationAdapter.segmentCellNuclei = async () => { segmentCalls += 1; };
        const previousQuantify = AnnotationAdapter.runPerObjectPixelQuantifier;
        AnnotationAdapter.runPerObjectPixelQuantifier = async () => ({
            objects: [{ index: 0, key: 0.1 }, { index: 1, key: 0.9 }]
        });

        const heatMapButton = { attrs: {}, setAttribute(name, value) { this.attrs[name] = value; }, textContent: "" };
        const fakeRoot = { getElementById: (id) => (id === "ai-heatmap-toggle" ? heatMapButton : null) };

        const turnedOn = await AnnotationAdapter.toggleHeatMap({ root: fakeRoot, viewer: null });
        assert.equal(turnedOn, true, "toggling on with existing nuclei must report active");
        assert.equal(segmentCalls, 0, "must not re-segment when nuclei already exist");
        assert.notEqual(polygonA.attrs.fill, AnnotationAdapter.AI_NUCLEUS_DEFAULT_FILL,
            "each nucleus must be recolored away from the default green fill");
        assert.equal(heatMapButton.attrs["aria-pressed"], "true");
        assert.equal(heatMapButton.textContent, "🌡️ Heat Map: ON");

        const turnedOff = await AnnotationAdapter.toggleHeatMap({ root: fakeRoot, viewer: null });
        assert.equal(turnedOff, false, "a second click must turn the heat map off");
        assert.equal(polygonA.attrs.fill, AnnotationAdapter.AI_NUCLEUS_DEFAULT_FILL,
            "turning off must restore the original default fill");
        assert.equal(polygonA.attrs.stroke, AnnotationAdapter.AI_NUCLEUS_DEFAULT_STROKE,
            "turning off must restore the original default stroke");
        assert.equal(heatMapButton.attrs["aria-pressed"], "false");
        assert.equal(heatMapButton.textContent, "🌡️ Heat Map");

        AnnotationAdapter.aiNucleusOverlayParts = [];
        AnnotationAdapter.lastNucleiCircles = [];
        AnnotationAdapter.segmentCellNuclei = previousSegment;
        AnnotationAdapter.runPerObjectPixelQuantifier = previousQuantify;
    }

    console.log("nuclei-stardist-tiles.test.js: ok");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
