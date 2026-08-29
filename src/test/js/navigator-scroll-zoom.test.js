"use strict";

/**
 * Coverage for AnnotationAdapter.bindNavigatorScrollZoom(): OpenSeadragon's
 * built-in Navigator (the persistent bottom-right minimap) only ever raises a
 * "navigator-scroll" event and otherwise ignores it -- by default, scrolling
 * over it neither zooms the navigator itself (pointless, since it always
 * shows the whole slide) nor the main viewport. That left scroll-wheel zoom
 * feeling "dead" while the cursor was over the minimap, including while
 * click-dragging the navigator's viewport box to pan -- two independent,
 * simultaneously-usable gestures that should combine into one efficient
 * "drag with one hand, zoom with the other" workflow.
 *
 * These tests confirm the handler this app registers actually zooms the
 * *main* viewport (never the navigator's own, always-whole-slide viewport),
 * centered on whichever point of the slide is under the cursor inside the
 * navigator, using the same zoomPerScroll/scroll-sign convention as scrolling
 * over the main canvas -- and that it stays out of the way when scroll-to-zoom
 * is disabled, the navigator isn't present, or the viewer itself is missing.
 */

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

function makeFakeViewer(overrides = {}) {
    const handlers = {};
    const viewportCalls = [];
    const fakePoint = { x: 0.42, y: 0.17 };
    let addHandlerCallCount = 0;

    const viewer = {
        zoomPerScroll: 1.2,
        gestureSettingsMouse: { scrollToZoom: true },
        addHandler(name, fn) {
            addHandlerCallCount += 1;
            handlers[name] = fn;
        },
        viewport: {
            zoomBy(factor, refPoint) { viewportCalls.push(["zoomBy", factor, refPoint]); },
            applyConstraints() { viewportCalls.push(["applyConstraints"]); }
        },
        navigator: {
            viewport: {
                pointFromPixel(position, current) {
                    viewportCalls.push(["pointFromPixel", position, current]);
                    return fakePoint;
                }
            }
        },
        ...overrides
    };

    return {
        viewer,
        handlers,
        viewportCalls,
        fakePoint,
        get addHandlerCallCount() { return addHandlerCallCount; }
    };
}

// Scrolling "up" (positive scroll) while the cursor is over the navigator must
// zoom the *main* viewport in, centered on the point under the cursor inside
// the navigator -- translated via the navigator's own (whole-slide) viewport,
// never the navigator's own zoom (it has none worth using).
{
    const { viewer, handlers, viewportCalls, fakePoint } = makeFakeViewer();

    const bound = AnnotationAdapter.bindNavigatorScrollZoom(viewer);
    assert.equal(bound, true);
    assert.equal(typeof handlers["navigator-scroll"], "function",
        "must subscribe to OSD's navigator-scroll event");

    const event = { scroll: 1, position: { x: 120, y: 60 } };
    handlers["navigator-scroll"](event);

    const pointCall = viewportCalls.find(c => c[0] === "pointFromPixel");
    assert.ok(pointCall, "must translate the navigator-local pixel into a shared viewport point");
    assert.equal(pointCall[1], event.position);

    const zoomCall = viewportCalls.find(c => c[0] === "zoomBy");
    assert.ok(zoomCall, "must zoom the main viewport");
    assert.equal(zoomCall[1], Math.pow(1.2, 1), "zoom factor must match zoomPerScroll^scroll");
    assert.equal(zoomCall[2], fakePoint, "must zoom toward the translated navigator point");

    assert.ok(viewportCalls.some(c => c[0] === "applyConstraints"),
        "must clamp back into bounds just like ordinary scroll-to-zoom does");
    assert.equal(event.preventDefault, true);
}

// Scrolling "down" (negative scroll) must zoom out (factor < 1) -- the exact
// inverse of scrolling up, same sign convention as the main-canvas scroll --
// so behavior feels identical whether the cursor is over the slide or the
// minimap.
{
    const { viewer, handlers, viewportCalls } = makeFakeViewer();
    AnnotationAdapter.bindNavigatorScrollZoom(viewer);

    handlers["navigator-scroll"]({ scroll: -1, position: { x: 10, y: 10 } });

    const zoomCall = viewportCalls.find(c => c[0] === "zoomBy");
    assert.ok(zoomCall, "must still zoom on scroll-down");
    assert.ok(zoomCall[1] < 1, "negative scroll must produce a zoom-out factor (<1)");
    assert.equal(zoomCall[1], Math.pow(1.2, -1));
}

// Must respect the same scrollToZoom gesture toggle the main canvas honors --
// if scroll-to-zoom is disabled, the navigator must not silently keep zooming
// behind its back.
{
    const { viewer, handlers, viewportCalls } = makeFakeViewer({
        gestureSettingsMouse: { scrollToZoom: false }
    });
    AnnotationAdapter.bindNavigatorScrollZoom(viewer);

    handlers["navigator-scroll"]({ scroll: 1, position: { x: 10, y: 10 } });

    assert.equal(viewportCalls.length, 0, "must not zoom when scrollToZoom is disabled");
}

// Binding twice on the same viewer (e.g. setViewer() re-running after a slide
// switch) must not register a second, duplicate listener.
{
    const { viewer, addHandlerCallCount: _unused } = makeFakeViewer();

    const first = AnnotationAdapter.bindNavigatorScrollZoom(viewer);
    const second = AnnotationAdapter.bindNavigatorScrollZoom(viewer);

    assert.equal(first, true);
    assert.equal(second, false, "second bind on the same viewer must be a no-op");
}

// Rebinding must genuinely skip calling addHandler again, not just report
// false while still double-subscribing.
{
    const wrapper = makeFakeViewer();
    AnnotationAdapter.bindNavigatorScrollZoom(wrapper.viewer);
    AnnotationAdapter.bindNavigatorScrollZoom(wrapper.viewer);

    assert.equal(wrapper.addHandlerCallCount, 1,
        "must only register the navigator-scroll handler once per viewer");
}

// Defensive: a missing navigator (e.g. showNavigator: false) must never
// throw when the event fires -- it should simply skip zooming.
{
    const { viewer, handlers, viewportCalls } = makeFakeViewer({ navigator: undefined });

    const bound = AnnotationAdapter.bindNavigatorScrollZoom(viewer);
    assert.equal(bound, true, "still binds even if the navigator isn't ready yet");

    assert.doesNotThrow(() => handlers["navigator-scroll"]({ scroll: 1, position: { x: 5, y: 5 } }));
    assert.equal(viewportCalls.length, 0);
}

// Defensive: bindNavigatorScrollZoom itself must tolerate a missing/null
// viewer (e.g. called before openViewer() ever runs) without throwing.
{
    assert.doesNotThrow(() => AnnotationAdapter.bindNavigatorScrollZoom(null));
    assert.equal(AnnotationAdapter.bindNavigatorScrollZoom(null), false);
    assert.equal(AnnotationAdapter.bindNavigatorScrollZoom(undefined), false);
}

console.log("navigator-scroll-zoom.test.js: ok");
