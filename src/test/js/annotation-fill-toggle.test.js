"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const staticRoot = path.join(__dirname, "../../main/resources/static");
const adapterSource = fs.readFileSync(path.join(staticRoot, "annotation-adapter.js"), "utf8");
const storeSource = fs.readFileSync(path.join(staticRoot, "annotation-store.js"), "utf8");

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

function fakeShape() {
    return {
        attrs: {},
        style: {},
        getAttribute(name) { return this.attrs[name]; },
        setAttribute(name, value) { this.attrs[name] = String(value); }
    };
}

// Defaults: annotations and detections must both start unfilled (outline-only) so drawn
// regions never obscure the underlying image on first view.
assert.equal(AnnotationAdapter.annotationFillEnabled, false);
assert.equal(AnnotationAdapter.detectionFillEnabled, false);

// applyOsdAnnotationStyle: fill-opacity tracks annotationFillEnabled independently of the
// "fill" color attribute itself (which still tracks the filled/not-fillable distinction).
{
    AnnotationAdapter.annotationFillEnabled = false;
    const node = fakeShape();
    AnnotationAdapter.applyOsdAnnotationStyle(node, { filled: true });
    assert.equal(node.attrs.fill, AnnotationAdapter.OSD_ANNOTATION_FILL,
        "fill color must still be set even while fill-opacity is 0");
    assert.equal(node.attrs["fill-opacity"], "0",
        "fill-opacity must be 0 while annotationFillEnabled is false");

    AnnotationAdapter.annotationFillEnabled = true;
    const node2 = fakeShape();
    AnnotationAdapter.applyOsdAnnotationStyle(node2, { filled: true });
    assert.equal(node2.attrs["fill-opacity"], "1",
        "fill-opacity must be 1 while annotationFillEnabled is true");

    // Shapes that are never fillable (filled: false, e.g. lines/open polylines) keep
    // fill: none regardless of the global toggle.
    const node3 = fakeShape();
    AnnotationAdapter.applyOsdAnnotationStyle(node3, { filled: false });
    assert.equal(node3.attrs.fill, "none");

    AnnotationAdapter.annotationFillEnabled = false;
}

// toggleAnnotationFill: flips state, updates fill-opacity on every tracked annotation
// shape node, and mirrors state onto an optional toolbar button's aria-pressed.
{
    const shapes = [fakeShape(), fakeShape()];
    const button = fakeShape();
    const doc = {
        querySelectorAll(selector) {
            assert.equal(selector, ".osd-annotation-shape");
            return shapes;
        },
        getElementById(id) { return id === "toggle-annotation-fill-btn" ? button : null; }
    };
    AnnotationAdapter.annotationFillEnabled = false;

    const turnedOn = AnnotationAdapter.toggleAnnotationFill(doc);
    assert.equal(turnedOn, true);
    assert.equal(AnnotationAdapter.annotationFillEnabled, true);
    for (const shape of shapes) assert.equal(shape.attrs["fill-opacity"], "1");
    assert.equal(button.attrs["aria-pressed"], "true");

    const turnedOff = AnnotationAdapter.toggleAnnotationFill(doc);
    assert.equal(turnedOff, false);
    for (const shape of shapes) assert.equal(shape.attrs["fill-opacity"], "0");
    assert.equal(button.attrs["aria-pressed"], "false");
}

// toggleDetectionFill: flips state, updates fill-opacity on every tracked nucleus overlay
// part, forces a canvas redraw (so already-visible circle detections pick up the new
// state immediately instead of waiting for the next pan/zoom), and mirrors state onto its
// own optional toolbar button.
{
    const parts = [fakeShape(), fakeShape()];
    const button = fakeShape();
    const doc = { getElementById(id) { return id === "toggle-detection-fill-btn" ? button : null; } };
    AnnotationAdapter.aiNucleusOverlayParts = parts;
    AnnotationAdapter.detectionFillEnabled = false;

    let redraws = 0;
    const previousRedraw = AnnotationAdapter.renderSynchronizedCellObjects;
    AnnotationAdapter.renderSynchronizedCellObjects = () => { redraws += 1; };

    const turnedOn = AnnotationAdapter.toggleDetectionFill(doc);
    assert.equal(turnedOn, true);
    for (const part of parts) assert.equal(part.attrs["fill-opacity"], "1");
    assert.equal(redraws, 1, "toggling must force a canvas redraw of circle detections");
    assert.equal(button.attrs["aria-pressed"], "true");

    const turnedOff = AnnotationAdapter.toggleDetectionFill(doc);
    assert.equal(turnedOff, false);
    for (const part of parts) assert.equal(part.attrs["fill-opacity"], "0");
    assert.equal(redraws, 2);
    assert.equal(button.attrs["aria-pressed"], "false");

    AnnotationAdapter.renderSynchronizedCellObjects = previousRedraw;
    AnnotationAdapter.aiNucleusOverlayParts = [];
}

// paintStarConvexNucleiLayer: freshly painted nuclei polygons must respect whatever
// detectionFillEnabled is at the moment they're created (e.g. re-running "Segment
// Nuclei" while fill is off must not silently turn fill back on).
{
    function makeSvgDoc() {
        return {
            createElementNS(_ns, tag) {
                return {
                    tagName: tag,
                    attrs: {},
                    style: {},
                    children: [],
                    setAttribute(name, value) { this.attrs[name] = String(value); },
                    getAttribute(name) { return this.attrs[name]; },
                    appendChild(child) { this.children.push(child); return child; }
                };
            }
        };
    }
    const doc = makeSvgDoc();
    const viewer = {
        world: {
            getItemCount: () => 1,
            getItemAt: () => ({ imageToViewportRectangle: (x, y, w, h) => ({ x, y, width: w, height: h }) })
        },
        addOverlay() {}
    };
    const nucleus = { vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 10 }] };

    AnnotationAdapter.detectionFillEnabled = false;
    AnnotationAdapter.paintStarConvexNucleiLayer(viewer, [nucleus], doc);
    assert.equal(AnnotationAdapter.aiNucleusOverlayParts.length, 1);
    assert.equal(AnnotationAdapter.aiNucleusOverlayParts[0].attrs["fill-opacity"], "0",
        "nuclei painted while detectionFillEnabled=false must start with fill hidden");

    AnnotationAdapter.detectionFillEnabled = true;
    AnnotationAdapter.paintStarConvexNucleiLayer(viewer, [nucleus], doc);
    assert.equal(AnnotationAdapter.aiNucleusOverlayParts[0].attrs["fill-opacity"], "1",
        "nuclei painted while detectionFillEnabled=true must start with fill shown");

    AnnotationAdapter.detectionFillEnabled = false;
    AnnotationAdapter.aiNucleusOverlayParts = [];
}

// renderSynchronizedCellObjects: the canvas-drawn circle-detection path must only call
// ctx.fill() (interior) when detectionFillEnabled is true; the outline stroke must always
// be drawn either way.
{
    function makeCtx() {
        return {
            calls: [],
            clearRect() {}, beginPath() {}, arc() {}, moveTo() {}, lineTo() {}, closePath() {},
            fill() { this.calls.push("fill"); },
            stroke() { this.calls.push("stroke"); }
        };
    }
    const ctx = makeCtx();
    const canvas = { style: {}, width: 100, height: 100, getContext: () => ctx };
    AnnotationAdapter.aiNucleiOverlayEl = canvas;
    AnnotationAdapter.aiOverlayVisible = true;
    AnnotationAdapter.replaceLocalizedCellObjects([{ type: "Circle", cx: 10, cy: 10, r: 5 }]);

    AnnotationAdapter.detectionFillEnabled = false;
    AnnotationAdapter.renderSynchronizedCellObjects({});
    assert.ok(!ctx.calls.includes("fill"), "circle must not be filled when detectionFillEnabled is false");
    assert.ok(ctx.calls.includes("stroke"), "circle outline must still be drawn when fill is off");

    ctx.calls = [];
    AnnotationAdapter.detectionFillEnabled = true;
    AnnotationAdapter.renderSynchronizedCellObjects({});
    assert.ok(ctx.calls.includes("fill"), "circle must be filled when detectionFillEnabled is true");
    assert.ok(ctx.calls.includes("stroke"), "circle outline must still be drawn when fill is on");

    AnnotationAdapter.detectionFillEnabled = false;
    AnnotationAdapter.aiNucleiOverlayEl = null;
    AnnotationAdapter.replaceLocalizedCellObjects([]);
}

// The "?" keyboard shortcuts legend must document all three new shortcuts.
const html = fs.readFileSync(path.join(staticRoot, "index.html"), "utf8");
assert.match(html, /<b>F<\/b><\/td><td>Toggle Detection \(Nuclei\) Interior Fill Color/);
assert.match(html, /<b>Shift\+F<\/b><\/td><td>Toggle Annotation Interior Fill Color/);
assert.match(html, /<td>Ctrl\+Shift\+F<\/td><td>Open\/Close Pilot Feedback Panel/);
assert.match(html, /<b style="color:#FFCC00;">Ctrl\+Shift\+T<\/b>/);

console.log("annotation-fill-toggle.test.js: ok");
