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
    window: {
        setTimeout,
        clearTimeout,
        addEventListener() {},
        removeEventListener() {},
        currentActiveTool: "selection"
    },
    document: { getElementById() { return null; }, querySelectorAll() { return []; }, addEventListener() {} },
    fetch: null,
    WsiCsrf: { csrfFetch: async () => { throw new Error("unexpected save"); } }
});
vm.runInContext(`${storeSource}\nthis.AnnotationStore = AnnotationStore;`, context);
vm.runInContext(`${adapterSource}\nthis.AnnotationAdapter = AnnotationAdapter;`, context);
const { AnnotationAdapter } = context;

assert.match(adapterSource, /new OSD\.MouseTracker\(/);
assert.match(adapterSource, /window\.currentActiveTool !== "selection"/);
assert.match(adapterSource, /deltaPointsFromPixels\(event\.delta\)/);
assert.match(adapterSource, /static updateShapeGeometryPosition\(/);

const attrs = {};
const moved = AnnotationAdapter.updateShapeGeometryPosition({
    type: "ellipse",
    start: { overlayX: 10, overlayY: 20, viewportX: 0.1, viewportY: 0.2, image: { x: 1, y: 2 } },
    current: { overlayX: 30, overlayY: 50, viewportX: 0.3, viewportY: 0.5, image: { x: 5, y: 8 } },
    vertices: [],
    node: { setAttribute(name, value) { attrs[name] = value; } }
}, { x: 0.05, y: -0.02 }, { x: 4, y: 6 });

assert.equal(moved.start.overlayX, 14);
assert.equal(moved.start.overlayY, 26);
assert.equal(Number(moved.start.viewportX.toFixed(4)), 0.15);
assert.equal(moved.current.overlayX, 34);
assert.equal(Number(moved.current.viewportY.toFixed(4)), 0.48);

// Regression check: dragging an existing shape must actually reposition it while the
// default "move" tool is active, not only while the dedicated "selection" tool is active.
// (A prior version silently ignored drags whenever the tool wasn't exactly "selection".)
let capturedDragHandler = null;
context.window.OpenSeadragon = {
    MouseTracker: function(options) {
        capturedDragHandler = options.dragHandler;
    }
};
AnnotationAdapter.viewer = {
    viewport: {
        deltaPointsFromPixels(px) { return { x: (px.x || 0) / 100, y: (px.y || 0) / 100 }; }
    }
};
const draggedShape = {
    type: "rectangle",
    start: { overlayX: 10, overlayY: 20, viewportX: 0.1, viewportY: 0.2 },
    current: { overlayX: 30, overlayY: 50, viewportX: 0.3, viewportY: 0.5 },
    vertices: [],
    node: { setAttribute() {} }
};
AnnotationAdapter.bindQuPathShapeDragTracker({}, draggedShape);
assert.equal(typeof capturedDragHandler, "function");

context.window.currentActiveTool = "move";
capturedDragHandler({ delta: { x: 5, y: 5 } });
assert.equal(draggedShape.start.overlayX, 15, "drag must move the shape while the move tool is active");

context.window.currentActiveTool = "selection";
capturedDragHandler({ delta: { x: 5, y: 5 } });
assert.equal(draggedShape.start.overlayX, 20, "drag must also move the shape while the selection tool is active");

context.window.currentActiveTool = "rectangle";
capturedDragHandler({ delta: { x: 5, y: 5 } });
assert.equal(draggedShape.start.overlayX, 20, "drag must not move the shape while an unrelated drawing tool is active");

// Regression check: a single click/mousedown on an existing shape only selects it; the
// name popup must only open on double-click. (A prior version opened the popup on every click.)
let panelOpenedFor = null;
const previousOpenPanel = AnnotationAdapter.openAnnotationNamePanelForShape;
AnnotationAdapter.openAnnotationNamePanelForShape = function(id) { panelOpenedFor = id; return true; };
AnnotationAdapter.currentActiveTool = "move";
AnnotationAdapter.selectedNativeAnnotationId = null;

const shapeNodeStub = { getAttribute: () => "shape-1", classList: { add() {}, remove() {} } };
const fakeShapeEvent = {
    target: { closest: sel => (sel.includes("osd-annotation-shape") ? shapeNodeStub : null) },
    button: 0
};

const mousedownResult = AnnotationAdapter.onQuPathPointerDown(fakeShapeEvent);
assert.equal(mousedownResult, true);
assert.equal(AnnotationAdapter.selectedNativeAnnotationId, "shape-1", "mousedown on a shape must select it");
assert.equal(panelOpenedFor, null, "single click/mousedown must NOT open the name popup");

const dblclickResult = AnnotationAdapter.onQuPathDoubleClick(fakeShapeEvent);
assert.equal(dblclickResult, true);
assert.equal(panelOpenedFor, null, "double-click on a shape must not open the name popup");

AnnotationAdapter.openAnnotationNamePanelForShape = previousOpenPanel;

// Regression check: bindAnnotationShapeEditorLoop used to attach a "pointerup" listener that
// reopened the name popup on every mouse-up as long as any shape was selected, undoing the
// select-vs-double-click split above (popup would pop back open the instant a shape was
// selected, and again on every later click). It must no longer listen for pointerup at all.
const pointerupListeners = [];
const fakeHost = {
    addEventListener(type, handler) { pointerupListeners.push(type); }
};
const fakeViewerForLoop = { element: fakeHost, viewport: {} };
AnnotationAdapter.bindAnnotationShapeEditorLoop(fakeViewerForLoop);
assert.ok(!pointerupListeners.includes("pointerup"),
    "the popup must not auto-reopen on pointerup based on current selection");

// Regression check: clicking away in the viewer (but not on any shape) must revert the
// selection highlight — unless the "click" is really the mouseup tail end of a pan/drag.
// The highlight is tracked as a real class membership (a sweep via querySelectorAll(".is-
// annotation-selected"), not just an id-keyed lookup) so this also guards against the
// highlight ending up on a node the id-based lookup wouldn't find.
function makeClassList() {
    const classes = new Set();
    return { add(c) { classes.add(c); }, remove(c) { classes.delete(c); }, contains(c) { return classes.has(c); } };
}
const listenersByType = {};
context.document.addEventListener = function(type, handler) { (listenersByType[type] ||= []).push(handler); };
const shapeNodesById = { "shape-1": { classList: makeClassList() } };
context.document.querySelector = selector => {
    const match = /data-annotation-id="([^"]+)"/.exec(selector);
    return (match && shapeNodesById[match[1]]) || null;
};
context.document.querySelectorAll = selector => (selector === ".is-annotation-selected"
    ? Object.values(shapeNodesById).filter(node => node.classList.contains("is-annotation-selected"))
    : []);
context.document._wsiQuPathPointersBound = false;
AnnotationAdapter.bindQuPathToolPointers();
const clickListener = listenersByType.click?.[listenersByType.click.length - 1];
assert.equal(typeof clickListener, "function");

AnnotationAdapter.currentActiveTool = "move";
AnnotationAdapter.viewer = { element: { contains: () => true }, viewport: {} };

AnnotationAdapter.selectNativeAnnotationShape("shape-1");
assert.ok(shapeNodesById["shape-1"].classList.contains("is-annotation-selected"),
    "selecting a shape must add the highlight class");

AnnotationAdapter._qpMouseDownPoint = { x: 100, y: 100 };
clickListener({ target: { closest: () => null }, clientX: 101, clientY: 101, preventDefault() {}, stopPropagation() {} });
assert.equal(AnnotationAdapter.selectedNativeAnnotationId, null,
    "a clean click away from any shape must clear the selection");
assert.ok(!shapeNodesById["shape-1"].classList.contains("is-annotation-selected"),
    "clicking away must remove the highlight class from the previously selected shape");

AnnotationAdapter.selectNativeAnnotationShape("shape-1");
AnnotationAdapter._qpMouseDownPoint = { x: 100, y: 100 };
clickListener({ target: { closest: () => null }, clientX: 250, clientY: 100, preventDefault() {}, stopPropagation() {} });
assert.equal(AnnotationAdapter.selectedNativeAnnotationId, "shape-1",
    "releasing the mouse far from where it went down (a pan/drag) must not clear the selection");
assert.ok(shapeNodesById["shape-1"].classList.contains("is-annotation-selected"),
    "a pan/drag ending over empty canvas must not remove the highlight class either");

// A small amount of real-world pointer jitter (well under the old 6px threshold) on an
// intentional click must still be treated as a click, not a drag, and must deselect.
AnnotationAdapter._qpMouseDownPoint = { x: 100, y: 100 };
clickListener({ target: { closest: () => null }, clientX: 109, clientY: 100, preventDefault() {}, stopPropagation() {} });
assert.equal(AnnotationAdapter.selectedNativeAnnotationId, null,
    "up to ~15px of pointer jitter on a click must still count as a deliberate click-away");

// Regression check: "b" must activate the Brush tool (its own tooltip has always advertised
// "(B)"), not Brightness & Contrast — which used to silently shadow it. "c" now opens
// Brightness & Contrast (matching ITS tooltip's "(C)" claim) and "z" activates Zoom (matching
// its "(Z)" claim); neither had a working shortcut before.
const keydownListeners = [];
context.window.addEventListener = function(type, handler) { if (type === "keydown") keydownListeners.push(handler); };
context.window._wsiQuPathShortcutsBound = false;
const clickSpies = { "qp-tool-brush": 0, "qp-tool-zoom": 0, "toggle-detections-visibility-btn": 0 };
context.document.getElementById = id => (id in clickSpies ? { click() { clickSpies[id] += 1; } } : null);
context.document.activeElement = null;
let contrastLaunched = 0;
const previousLaunch = AnnotationAdapter.launchBrightnessContrastPalette;
AnnotationAdapter.launchBrightnessContrastPalette = function() { contrastLaunched += 1; };
AnnotationAdapter.viewer = null;

AnnotationAdapter.bindQuPathKeyboardShortcuts();
const keydownListener = keydownListeners[keydownListeners.length - 1];
assert.equal(typeof keydownListener, "function");

const fakeKeyEvent = key => ({ key, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, preventDefault() {} });
keydownListener(fakeKeyEvent("b"));
assert.equal(clickSpies["qp-tool-brush"], 1, "\"b\" must click the Brush tool button");
assert.equal(contrastLaunched, 0, "\"b\" must no longer open Brightness & Contrast");

keydownListener(fakeKeyEvent("c"));
assert.equal(contrastLaunched, 1, "\"c\" must open Brightness & Contrast");

keydownListener(fakeKeyEvent("z"));
assert.equal(clickSpies["qp-tool-zoom"], 1, "\"z\" must click the Zoom tool button");

// "d" must toggle the detections visibility button (works independently of the
// AI Labs panel — the button lives in the main toolbar, not inside that panel).
keydownListener(fakeKeyEvent("d"));
assert.equal(clickSpies["toggle-detections-visibility-btn"], 1,
    "\"d\" must click the detections visibility toggle button");

AnnotationAdapter.launchBrightnessContrastPalette = previousLaunch;

// Plain "F" (no Shift) toggles detection (nuclei) interior fill; Shift+F toggles
// annotation interior fill instead. These are distinct from "d" above, which
// hides/shows the whole detection marker rather than just its fill.
{
    let annotationFillCalls = 0;
    let detectionFillCalls = 0;
    const previousAnnotationFill = AnnotationAdapter.toggleAnnotationFill;
    const previousDetectionFill = AnnotationAdapter.toggleDetectionFill;
    AnnotationAdapter.toggleAnnotationFill = () => { annotationFillCalls += 1; };
    AnnotationAdapter.toggleDetectionFill = () => { detectionFillCalls += 1; };

    keydownListener(fakeKeyEvent("f"));
    assert.equal(detectionFillCalls, 1, "plain \"f\" must toggle detection fill");
    assert.equal(annotationFillCalls, 0, "plain \"f\" must not toggle annotation fill");

    keydownListener({ key: "F", ctrlKey: false, metaKey: false, altKey: false, shiftKey: true, isComposing: false, preventDefault() {} });
    assert.equal(annotationFillCalls, 1, "Shift+F must toggle annotation fill");
    assert.equal(detectionFillCalls, 1, "Shift+F must not also toggle detection fill");

    AnnotationAdapter.toggleAnnotationFill = previousAnnotationFill;
    AnnotationAdapter.toggleDetectionFill = previousDetectionFill;
}

{
    let deleteCalls = 0;
    const previousPrompt = AnnotationAdapter.promptDeleteSelectedAnnotations;
    AnnotationAdapter.promptDeleteSelectedAnnotations = function() { deleteCalls += 1; };
    keydownListener(fakeKeyEvent("Delete"));
    assert.equal(deleteCalls, 1, "Delete must prompt to remove the selected annotation(s)");
    keydownListener(fakeKeyEvent("Backspace"));
    assert.equal(deleteCalls, 2, "Backspace must prompt to remove the selected annotation(s)");
    AnnotationAdapter.qpDrawSession = { tool: "rectangle" };
    keydownListener(fakeKeyEvent("Delete"));
    assert.equal(deleteCalls, 2, "Delete must not remove annotations while a draw session is active");
    AnnotationAdapter.qpDrawSession = null;
    AnnotationAdapter.promptDeleteSelectedAnnotations = previousPrompt;
}

// Regression: the detections visibility button and the "Clear Detections" button must
// both work even when the AI Labs panel has never been opened/bound (no "ai-nuclei-visible"
// element in the DOM at all).
{
    const detButton = { dataset: {}, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, setAttribute() {} };
    const clearDetButton = { dataset: {}, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, setAttribute() {} };
    const idMap = {
        "toggle-detections-visibility-btn": detButton,
        "clear-detections-only-btn": clearDetButton
    };
    const doc = { getElementById: id => idMap[id] || null };
    AnnotationAdapter.bindLayerVisibilityAndSanitizeControls(doc);
    assert.equal(detButton.dataset.detVisBound, "1");
    assert.equal(clearDetButton.dataset.clearDetBound, "1");

    let toggledTo = null;
    const previousSetVisible = AnnotationAdapter.setNucleiOverlaysVisible;
    AnnotationAdapter.setNucleiOverlaysVisible = (visible) => { toggledTo = visible; };
    AnnotationAdapter.aiOverlayVisible = true;
    AnnotationAdapter.aiNucleusOverlayElements = [{ style: {} }];
    detButton.listeners.click({ preventDefault() {} });
    assert.equal(toggledTo, false, "clicking the toolbar Det button must flip current visibility off");
    AnnotationAdapter.setNucleiOverlaysVisible = previousSetVisible;

    let cleared = null;
    const previousClear = AnnotationAdapter.clearAiNucleiOverlay;
    AnnotationAdapter.clearAiNucleiOverlay = (opts) => { cleared = opts; };
    clearDetButton.listeners.click({ preventDefault() {} });
    assert.ok(cleared && cleared.remove === true,
        "Clear Detections button must call clearAiNucleiOverlay({ remove: true })");
    AnnotationAdapter.clearAiNucleiOverlay = previousClear;
}

// Clicking an existing rectangle with the rectangle tool must select it, not start a
// new rubber-band. A click-without-drag on empty canvas must not commit a shape.
// Viewport spans that look like mixed CSS-pixel units must not paint a whole-view wash.
{
    AnnotationAdapter.currentActiveTool = "rectangle";
    AnnotationAdapter.qpDrawSession = {
        tool: "rectangle",
        dragging: true,
        start: { viewportX: 0.1, viewportY: 0.1 },
        current: { viewportX: 400, viewportY: 300 }
    };
    const shapeNodeStub = { getAttribute: () => "shape-1", classList: { add() {}, remove() {} } };
    const fakeShapeEvent = {
        target: { closest: sel => (sel.includes("osd-annotation-shape") ? shapeNodeStub : null) },
        button: 0,
        clientX: 120,
        clientY: 80,
        preventDefault() {},
        stopPropagation() {},
        shiftKey: false
    };
    const selectedBefore = AnnotationAdapter.selectedNativeAnnotationId;
    const hitDown = AnnotationAdapter.onQuPathPointerDown(fakeShapeEvent);
    assert.equal(hitDown, true);
    assert.equal(AnnotationAdapter.qpDrawSession, null,
        "clicking a shape with a drawing tool must cancel any in-progress rubber-band");
    assert.equal(AnnotationAdapter.selectedNativeAnnotationId, "shape-1",
        "clicking a rectangle must select it even while the rectangle tool is active");
    void selectedBefore;

    const huge = AnnotationAdapter.buildQuPathSvgShape("rectangle", {
        start: { viewportX: 0.2, viewportY: 0.3, overlayX: 100, overlayY: 120 },
        current: { viewportX: 400, viewportY: 300, overlayX: 400, overlayY: 300 }
    });
    assert.equal(huge, null,
        "a viewport span that looks like mixed CSS pixels must not paint a whole-view rect");
    assert.equal(AnnotationAdapter.quPathViewportSpanValid(
        { viewportX: 50000, viewportY: 40000 },
        { viewportX: 50200, viewportY: 40100 }
    ), true, "image-pixel fallback pairs must still count as a consistent coordinate space");

    let committed = 0;
    const previousCommit = AnnotationAdapter.commitQuPathShape;
    AnnotationAdapter.commitQuPathShape = function() { committed += 1; return { id: "new" }; };
    AnnotationAdapter.viewer = {
        element: {
            contains: () => true,
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 })
        },
        viewport: {
            pointFromPixel(p) { return { x: Number(p.x) / 800, y: Number(p.y) / 600 }; }
        },
        setMouseNavEnabled() {},
        gestureSettingsMouse: { dragToPan: true, scrollToZoom: true }
    };
    const canvasEvent = (x, y) => ({
        target: { closest: () => null },
        button: 0,
        clientX: x,
        clientY: y,
        preventDefault() {},
        stopPropagation() {}
    });
    AnnotationAdapter.qpDrawSession = null;
    AnnotationAdapter.onQuPathPointerDown(canvasEvent(100, 100));
    assert.ok(AnnotationAdapter.qpDrawSession, "rectangle pointerdown must arm a draw session");
    assert.equal(AnnotationAdapter.qpDrawSession.dragging, false,
        "a click must not rubber-band until the pointer actually moves");
    AnnotationAdapter.onQuPathPointerUp(canvasEvent(102, 101));
    assert.equal(committed, 0, "click without a real drag must not commit a rectangle");
    assert.equal(AnnotationAdapter.qpDrawSession, null);

    AnnotationAdapter.onQuPathPointerDown(canvasEvent(100, 100));
    AnnotationAdapter.onQuPathPointerMove(canvasEvent(160, 180));
    assert.equal(AnnotationAdapter.qpDrawSession?.dragging, true,
        "moving past the arm threshold must start the rubber-band");
    AnnotationAdapter.onQuPathPointerUp(canvasEvent(160, 180));
    assert.equal(committed, 1, "a real rectangle drag must commit");
    AnnotationAdapter.commitQuPathShape = previousCommit;

    AnnotationAdapter.qpDrawSession = {
        tool: "rectangle",
        dragging: true,
        start: { viewportX: 0.1, viewportY: 0.1, overlayX: 10, overlayY: 10 },
        current: { viewportX: 400, viewportY: 300, overlayX: 400, overlayY: 300 }
    };
    let named = null;
    const previousOpen = AnnotationAdapter.openAnnotationNamePanelForShape;
    AnnotationAdapter.openAnnotationNamePanelForShape = function(id) { named = id; return true; };
    AnnotationAdapter.onQuPathDoubleClick(fakeShapeEvent);
    assert.equal(AnnotationAdapter.qpDrawSession, null,
        "double-click must clear a leftover rubber-band (the whole-view wash)");
    assert.equal(named, null, "double-click on an annotation must not open the name popup");
    AnnotationAdapter.openAnnotationNamePanelForShape = previousOpen;
}

// Document-capture pointers own dragging: Move/rectangle/etc. on an existing unlocked
// shape must translate it; locked shapes stay put; Chrome selection is cleared.
{
    AnnotationAdapter.qpShapeDragSession = null;
    AnnotationAdapter.currentActiveTool = "move";
    AnnotationAdapter._lockedAnnotationsLoaded = true;
    AnnotationAdapter.lockedAnnotationIds = new Set();
    const attrs = {};
    const shape = {
        id: "drag-1",
        type: "rectangle",
        start: { overlayX: 10, overlayY: 20, viewportX: 0.1, viewportY: 0.2, image: { x: 1, y: 2 } },
        current: { overlayX: 30, overlayY: 50, viewportX: 0.3, viewportY: 0.5, image: { x: 5, y: 8 } },
        vertices: [],
        node: { setAttribute(name, value) { attrs[name] = value; } }
    };
    AnnotationAdapter.setSavedAnnotations([shape]);
    AnnotationAdapter.viewer = {
        viewport: {
            deltaPointsFromPixels(px) { return { x: (px.x || 0) / 100, y: (px.y || 0) / 100 }; }
        },
        element: { contains: () => true }
    };
    const hit = {
        getAttribute: () => "drag-1",
        classList: { add() {}, remove() {} },
        closest(sel) { return sel.includes("osd-annotation-shape") ? this : null; }
    };
    const down = {
        target: { closest: sel => (sel.includes("osd-annotation-shape") ? hit : null) },
        button: 0,
        clientX: 40,
        clientY: 50,
        preventDefault() {},
        stopPropagation() {}
    };
    AnnotationAdapter.onQuPathPointerDown(down);
    assert.ok(AnnotationAdapter.qpShapeDragSession, "mousedown on a shape must start a drag session");
    AnnotationAdapter.onQuPathPointerMove({
        clientX: 50,
        clientY: 60,
        preventDefault() {},
        stopPropagation() {}
    });
    assert.equal(shape.start.overlayX, 20, "dragging must move an unlocked annotation");
    assert.equal(Number(shape.start.viewportX.toFixed(4)), 0.2);
    AnnotationAdapter.onQuPathPointerUp({ clientX: 50, clientY: 60 });
    assert.equal(AnnotationAdapter.qpShapeDragSession, null, "mouseup must end the drag session");

    AnnotationAdapter.lockedAnnotationIds.add("drag-1");
    shape.start.overlayX = 10;
    AnnotationAdapter.onQuPathPointerDown(down);
    assert.equal(AnnotationAdapter.qpShapeDragSession, null, "locked annotations must not start a drag");
    AnnotationAdapter.lockedAnnotationIds.delete("drag-1");
}

// Clicks land on child path/line/circle nodes for polygon, polyline, line, brush,
// points, and wand. Those children used to have the overlay class but not
// data-annotation-id, so only rectangle/ellipse (the host itself) were selectable.
{
    function makeShapeNode({ id = null, cls = "osd-annotation-shape", parent = null } = {}) {
        const node = {
            parentElement: parent,
            classList: {
                contains(name) { return String(cls).split(/\s+/).includes(name); },
                add() {},
                remove() {}
            },
            getAttribute(name) {
                if (name === "data-annotation-id") return id;
                return null;
            },
            closest(sel) {
                const selector = String(sel || "");
                if (selector.includes("[data-qp-preview]")) return null;
                let cur = this;
                while (cur) {
                    if (selector === "[data-annotation-id]" || selector.includes("[data-annotation-id]")) {
                        if (cur.getAttribute?.("data-annotation-id")) return cur;
                    } else if (selector.includes("osd-annotation-shape") || selector.includes("annotation-shape-overlay")) {
                        if (cur.classList?.contains("osd-annotation-shape")
                            || cur.classList?.contains("annotation-shape-overlay")) {
                            return cur;
                        }
                    }
                    cur = cur.parentElement;
                }
                return null;
            }
        };
        return node;
    }

    const group = makeShapeNode({ id: "poly-1", cls: "osd-annotation-shape annotation-shape-overlay" });
    const path = makeShapeNode({ id: null, cls: "osd-annotation-shape", parent: group });
    assert.equal(AnnotationAdapter.annotationIdFromNode(path), "poly-1");
    assert.equal(AnnotationAdapter.annotationShapeFromEvent({ target: path }), group);

    for (const tool of ["move", "selection"]) {
        AnnotationAdapter.currentActiveTool = tool;
        AnnotationAdapter.selectedNativeAnnotationId = null;
        AnnotationAdapter.selectedNativeAnnotationIds?.clear?.();
        const event = { target: path, button: 0, preventDefault() {}, stopPropagation() {} };
        assert.equal(AnnotationAdapter.onQuPathPointerDown(event), true, `${tool}: polygon path must be selectable`);
        assert.equal(AnnotationAdapter.selectedNativeAnnotationId, "poly-1", `${tool}: must select the host annotation id`);
    }

    const lineHost = makeShapeNode({ id: "line-1", cls: "osd-annotation-shape" });
    const lineChild = makeShapeNode({ id: null, cls: "osd-annotation-shape", parent: lineHost });
    AnnotationAdapter.currentActiveTool = "move";
    AnnotationAdapter.selectedNativeAnnotationId = null;
    assert.equal(AnnotationAdapter.onQuPathPointerDown({
        target: lineChild, button: 0, preventDefault() {}, stopPropagation() {}
    }), true);
    assert.equal(AnnotationAdapter.selectedNativeAnnotationId, "line-1");

    const pointsHost = makeShapeNode({ id: "pts-1", cls: "osd-annotation-shape" });
    const circle = makeShapeNode({ id: null, cls: "osd-annotation-shape", parent: pointsHost });
    AnnotationAdapter.selectedNativeAnnotationId = null;
    assert.equal(AnnotationAdapter.onQuPathPointerDown({
        target: circle, button: 0, preventDefault() {}, stopPropagation() {}
    }), true);
    assert.equal(AnnotationAdapter.selectedNativeAnnotationId, "pts-1");

    const committedPoly = AnnotationAdapter.buildQuPathSvgShape("polygon", {
        vertices: [
            { viewportX: 0.1, viewportY: 0.1 },
            { viewportX: 0.4, viewportY: 0.2 },
            { viewportX: 0.2, viewportY: 0.5 }
        ],
        start: { viewportX: 0.1, viewportY: 0.1 },
        current: { viewportX: 0.2, viewportY: 0.5 }
    });
    assert.equal(committedPoly.tagName, "g");
    const committedKids = committedPoly.children || [];
    assert.ok(committedKids.some(child => child.getAttribute?.("data-annotation-hit") === "1"),
        "committed polygon must include a click halo");
    assert.ok(!committedKids.some(child => child.getAttribute?.("stroke-dasharray") === "4 3"),
        "committed polygon must not keep the live-trace guide line");

    const livePoly = AnnotationAdapter.buildQuPathSvgShape("polygon", {
        preview: true,
        vertices: [
            { viewportX: 0.1, viewportY: 0.1 },
            { viewportX: 0.4, viewportY: 0.2 }
        ],
        start: { viewportX: 0.1, viewportY: 0.1 },
        current: { viewportX: 0.5, viewportY: 0.4 }
    });
    assert.ok((livePoly.children || []).some(child => child.getAttribute?.("stroke-dasharray") === "4 3"),
        "live polygon preview must still show the rubber-band guide");

    const lineShape = AnnotationAdapter.buildQuPathSvgShape("line", {
        start: { viewportX: 0.1, viewportY: 0.2 },
        current: { viewportX: 0.6, viewportY: 0.7 }
    });
    assert.equal(lineShape.tagName, "g");
    AnnotationAdapter.attachAnnotationShapeOverlay(lineShape, "line-host");
    assert.equal(lineShape.getAttribute("data-annotation-id"), "line-host");
    assert.ok((lineShape.children || []).some(child => child.getAttribute?.("data-annotation-id") === "line-host"),
        "child stroke/halo nodes must inherit the annotation id");
}

console.log("annotation movement checks passed");
