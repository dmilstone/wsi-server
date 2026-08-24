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
assert.equal(panelOpenedFor, "shape-1", "double-click on a shape must open the name popup");

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
const clickSpies = { "qp-tool-brush": 0, "qp-tool-zoom": 0 };
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

AnnotationAdapter.launchBrightnessContrastPalette = previousLaunch;

console.log("annotation movement checks passed");
