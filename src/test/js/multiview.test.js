"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const staticRoot = path.join(__dirname, "../../main/resources/static");
const html = fs.readFileSync(path.join(staticRoot, "index.html"), "utf8");
const adapterSource = fs.readFileSync(path.join(staticRoot, "annotation-adapter.js"), "utf8");
const storeSource = fs.readFileSync(path.join(staticRoot, "annotation-store.js"), "utf8");

const context = vm.createContext({
    console: { info() {}, warn() {}, error() {} },
    window: { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {}, innerWidth: 1200, innerHeight: 800 },
    document: {
        getElementById() { return null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener() {}
    },
    fetch: null,
    WsiCsrf: { csrfFetch: async () => { throw new Error("unexpected save"); } }
});
vm.runInContext(`${storeSource}\nthis.AnnotationStore = AnnotationStore;`, context);
vm.runInContext(`${adapterSource}\nthis.AnnotationAdapter = AnnotationAdapter;`, context);
const { AnnotationAdapter } = context;

assert.match(html, /id="viewer-grid"/);
assert.match(html, /id="view-menu-button"/);
assert.match(html, /id="multiview-menu"/);
assert.match(html, /Grid 1 x 1 \(single viewer\)/);
assert.match(html, /Grid 1 x 2 \(horizontal\)/);
assert.match(html, /Grid 2 x 1 \(vertical\)/);
assert.match(html, /Grid 2 x 2/);
assert.match(html, /Grid 3 x 3/);
assert.match(html, />Add row</);
assert.match(html, />Add column</);
assert.match(html, />Remove row</);
assert.match(html, />Remove column</);
assert.match(html, />Reset viewer sizes</);
assert.match(html, />Synchronize viewers</);
assert.match(html, />Match viewer resolutions</);
assert.match(html, />Close viewer</);
assert.match(html, />Detach viewer from grid</);
assert.match(html, />Attach viewer to grid</);
assert.match(html, /annotation-adapter\.js\?v=20260910-help-fix/);
assert.match(html, /Synchronize multi-view pan and zoom/);

assert.match(adapterSource, /static setGridSize\(/);
assert.match(adapterSource, /static addRow\(/);
assert.match(adapterSource, /static addColumn\(/);
assert.match(adapterSource, /static removeRow\(/);
assert.match(adapterSource, /static removeColumn\(/);
assert.match(adapterSource, /static resetViewerSizes\(/);
assert.match(adapterSource, /static toggleSynchronizeViewers\(/);
assert.match(adapterSource, /static matchViewerResolutions\(/);
assert.match(adapterSource, /static closeActiveViewer\(/);
assert.match(adapterSource, /static detachActiveViewer\(/);
assert.match(adapterSource, /static attachActiveViewer\(/);
assert.match(adapterSource, /static bindViewerMultiViewContextMenu\(/);
assert.match(adapterSource, /static isMultiViewSyncShortcut\(/);
assert.match(adapterSource, /static shortcutsLegendLayout\(/);

{
    const layout = AnnotationAdapter.shortcutsLegendLayout({ innerWidth: 1440, innerHeight: 900 });
    assert.equal(layout.top, 12);
    assert.equal(layout.left, 16);
    assert.equal(layout.height, 876);
    assert.ok(layout.width >= 300 && layout.width <= 440);
}

const twoByThree = AnnotationAdapter.normalizeGridSize(2, 3);
assert.equal(twoByThree.rows, 2);
assert.equal(twoByThree.cols, 3);
const clamped = AnnotationAdapter.normalizeGridSize(0, 99);
assert.equal(clamped.rows, 1);
assert.equal(clamped.cols, 4);

const remapped = AnnotationAdapter.remapMultiviewPanes([
    { index: 0, imageId: "a", hostId: "viewer" },
    { index: 1, imageId: "b", hostId: "wsi-viewer-pane-1" }
], 2, 2);
assert.equal(remapped.panes.length, 4);
assert.equal(remapped.panes[0].imageId, "a");
assert.equal(remapped.panes[1].imageId, "b");
assert.equal(remapped.panes[2].imageId, null);
assert.equal(remapped.discarded.length, 0);

const shrunk = AnnotationAdapter.remapMultiviewPanes(remapped.panes, 1, 1);
assert.equal(shrunk.panes.length, 1);
assert.equal(shrunk.panes[0].imageId, "a");
assert.equal(shrunk.discarded.length, 3);

assert.equal(AnnotationAdapter.canRemoveRow(1), false);
assert.equal(AnnotationAdapter.canRemoveColumn(1), false);
assert.equal(AnnotationAdapter.canRemoveRow(2), true);

const blocked = AnnotationAdapter.removeRowLayout({
    rows: 2,
    cols: 1,
    activeIndex: 1,
    panes: [
        { index: 0, row: 0, col: 0, imageId: null },
        { index: 1, row: 1, col: 0, imageId: "still-open" }
    ]
});
assert.equal(blocked.ok, false);
assert.equal(blocked.reason, "close-first");

const removed = AnnotationAdapter.removeRowLayout({
    rows: 2,
    cols: 2,
    activeIndex: 2,
    panes: [
        { index: 0, row: 0, col: 0, imageId: "keep" },
        { index: 1, row: 0, col: 1, imageId: null },
        { index: 2, row: 1, col: 0, imageId: null },
        { index: 3, row: 1, col: 1, imageId: null }
    ]
});
assert.equal(removed.ok, true);
assert.equal(removed.rows, 1);
assert.equal(removed.cols, 2);
assert.equal(removed.panes.length, 2);
assert.equal(removed.panes[0].imageId, "keep");

assert.equal(AnnotationAdapter.matchedImageZoom(2, 0.25, 0.5), 1);
assert.equal(AnnotationAdapter.matchedImageZoom(2, 0, 0.5), 2);

const payload = AnnotationAdapter.syncViewportPayload({ x: 100, y: 50 }, 200, 100, 4);
assert.equal(payload.fracX, 0.5);
assert.equal(payload.fracY, 0.5);
assert.equal(payload.imageZoom, 4);
const applied = AnnotationAdapter.applySyncPayload(payload, 400, 200);
assert.equal(applied.x, 200);
assert.equal(applied.y, 100);
assert.equal(applied.imageZoom, 4);

const model = AnnotationAdapter.multiViewMenuModel({
    rows: 2,
    cols: 2,
    activeIndex: 0,
    synchronizeViewers: true,
    panes: [{ imageId: "slide", detached: false }]
});
assert.equal(model.canDetach, true);
assert.equal(model.canAttach, false);
assert.equal(model.canClose, true);
assert.equal(model.synchronizeViewers, true);

assert.equal(AnnotationAdapter.isMultiViewSyncShortcut({ key: "s", ctrlKey: true, shiftKey: true }), true);
assert.equal(AnnotationAdapter.isMultiViewSyncShortcut({ key: "s", metaKey: true, shiftKey: true }), true);
assert.equal(AnnotationAdapter.isMultiViewSyncShortcut({ key: "s", ctrlKey: true, altKey: true }), true);
assert.equal(AnnotationAdapter.isMultiViewSyncShortcut({ key: "s" }), false);
assert.equal(AnnotationAdapter.isMultiViewSyncShortcut({ key: "t", ctrlKey: true, shiftKey: true }), false);

{
    const calls = [];
    const viewer = {
        container: { clientWidth: 640, clientHeight: 400 },
        viewport: {
            getContainerSize: () => ({ x: 640, y: 400 }),
            getZoom: () => 1,
            resize(size, maintain) { calls.push({ size, maintain }); },
            goHome() { calls.push("home"); }
        },
        forceRedraw() { calls.push("redraw"); }
    };
    assert.equal(AnnotationAdapter.resizeOpenSeadragonViewer(viewer), true);
    assert.equal(calls[0].size.x, 640);
    assert.equal(calls[0].size.y, 400);
    assert.equal(calls[0].maintain, true);
    assert.equal(calls.includes("redraw"), true);
    assert.equal(calls.includes("home"), false);

    const recovered = [];
    AnnotationAdapter.resizeOpenSeadragonViewer({
        container: { clientWidth: 800, clientHeight: 600 },
        viewport: {
            getContainerSize: () => ({ x: 0, y: 0 }),
            getZoom: () => Infinity,
            resize(size) { recovered.push(size); },
            goHome() { recovered.push("home"); }
        },
        forceRedraw() {}
    });
    assert.equal(recovered[0].x, 800);
    assert.equal(recovered.includes("home"), true);
    assert.equal(AnnotationAdapter.resizeOpenSeadragonViewer({
        container: { clientWidth: 0, clientHeight: 0 },
        viewport: { resize() { throw new Error("must not resize a zero-size container"); } }
    }), false);

    const pane = {
        clientWidth: 900,
        clientHeight: 700,
        style: {},
        closest(sel) { return sel === ".viewer-pane" ? this : null; }
    };
    const host = {
        clientWidth: 0,
        clientHeight: 0,
        style: {},
        closest(sel) { return pane.closest(sel); }
    };
    const recoveredFromPane = [];
    AnnotationAdapter.resizeOpenSeadragonViewer({
        element: host,
        container: { clientWidth: 0, clientHeight: 0 },
        viewport: {
            getContainerSize: () => ({ x: 0, y: 0 }),
            getZoom: () => Infinity,
            resize(size) { recoveredFromPane.push(size); },
            goHome() { recoveredFromPane.push("home"); }
        },
        forceRedraw() {}
    });
    assert.equal(recoveredFromPane[0].x, 900);
    assert.equal(recoveredFromPane[0].y, 700);
    assert.equal(host.style.width, "900px");
    assert.equal(host.style.height, "700px");
    assert.equal(recoveredFromPane.includes("home"), true);

    const wideHost = {
        clientWidth: 1200,
        clientHeight: 800,
        style: {},
        closest(sel) { return sel === ".viewer-pane" ? pane : null; }
    };
    const paneSized = [];
    AnnotationAdapter.resizeOpenSeadragonViewer({
        element: wideHost,
        container: { clientWidth: 1200, clientHeight: 800 },
        viewport: {
            getContainerSize: () => ({ x: 1200, y: 800 }),
            getZoom: () => 1,
            resize(size, maintain) { paneSized.push({ size, maintain }); },
            goHome() { paneSized.push("home"); }
        },
        forceRedraw() {}
    }, { fit: true });
    assert.equal(paneSized[0].size.x, 900);
    assert.equal(paneSized[0].size.y, 700);
    assert.equal(paneSized[0].maintain, false);
    assert.equal(paneSized.includes("home"), true);
}

{
    const grid = {
        clientWidth: 802,
        clientHeight: 400,
        closest(sel) { return sel === ".viewer-grid" ? this : null; }
    };
    const half = {
        dataset: { col: "1", row: "0" },
        closest(sel) { return sel === ".viewer-grid" ? grid : null; }
    };
    AnnotationAdapter.ensureMultiviewState();
    AnnotationAdapter.multiview.rows = 1;
    AnnotationAdapter.multiview.cols = 2;
    AnnotationAdapter.multiview.columnFractions = [1, 1];
    AnnotationAdapter.multiview.rowFractions = [1];
    const cell = AnnotationAdapter.computedPaneCellSize(half);
    assert.equal(cell.x, 400);
    assert.equal(cell.y, 400);
}

assert.equal(AnnotationAdapter.niceScaleLength(30), 20);
assert.equal(AnnotationAdapter.scaleBarModel(null, { micronsPerPixelX: 0.25 }).hidden, true);
{
    const model = AnnotationAdapter.scaleBarModel({
        viewport: { getZoom: () => 1, viewportToImageZoom: z => z },
        world: {
            getItemCount: () => 1,
            getItemAt: () => ({ viewportToImageZoom: z => z })
        }
    }, { micronsPerPixelX: 0.25 });
    assert.equal(model.hidden, false);
    assert.equal(model.label, "20 µm");
    assert.equal(model.width, 80);
    const line = { style: {} };
    const label = { textContent: "" };
    const el = {
        hidden: true,
        querySelector(sel) { return sel === ".scale-bar-line" ? line : label; }
    };
    assert.equal(AnnotationAdapter.applyScaleBarModel(el, model), true);
    assert.equal(el.hidden, false);
    assert.equal(line.style.width, "80px");
    assert.equal(label.textContent, "20 µm");
}

assert.match(adapterSource, /viewport\.resize\(size, !fit\)/);
assert.doesNotMatch(adapterSource, /viewport\.resize\(width, height/);
assert.doesNotMatch(adapterSource, /command !== "sync"/);

assert.match(html, /class="viewer-pane is-active"/);
assert.match(html, /Select a slide, or drag one here/);
assert.match(html, /viewer-pane-scalebar/);
assert.match(html, /\.viewer-grid\s*\{[^}]*position:\s*absolute/);
assert.match(html, /position:\s*absolute\s*!important/);
assert.match(html, /#viewer,\s*\n\s*\.viewer-pane-osd/);
assert.match(adapterSource, /index === AnnotationAdapter\.multiview\.activeIndex\) return/);
assert.ok(adapterSource.includes('host?.closest?.(".viewer-pane")'));
assert.match(adapterSource, /static updateMultiviewScaleBars\(/);
assert.match(html, /Show channel viewer/);
assert.match(html, /id="channel-viewer"/);
assert.match(html, />Channel viewer</);
assert.match(adapterSource, /static toggleChannelViewer\(/);
assert.match(adapterSource, /static enableSynchronizeIfMultipleImages\(/);

{
    const one = AnnotationAdapter.channelViewerGridSize(1);
    assert.equal(one.cols, 1);
    assert.equal(one.rows, 1);
    const four = AnnotationAdapter.channelViewerGridSize(4);
    assert.equal(four.cols, 2);
    assert.equal(four.rows, 2);
    const five = AnnotationAdapter.channelViewerGridSize(5);
    assert.equal(five.cols, 3);
    assert.equal(five.rows, 2);
}

const rgbCells = AnnotationAdapter.channelViewerCells({
    channels: [
        { index: 0, name: "Red", lut: "RED", visible: true },
        { index: 1, name: "Green", lut: "GREEN", visible: true },
        { index: 2, name: "Blue", lut: "BLUE", visible: true }
    ]
}, { rgb: true });
assert.equal(rgbCells.length, 4);
assert.equal(rgbCells[0].rgbBand, "r");
assert.equal(rgbCells[3].composite, true);

const hiddenCells = AnnotationAdapter.channelViewerCells({
    channels: [
        { index: 0, name: "DAPI", visible: true },
        { index: 23, name: "GL7", visible: false }
    ]
}, { rgb: false, modality: "FLUORESCENCE" });
assert.equal(hiddenCells.some(cell => cell.channelIndex === 23), false);
assert.equal(hiddenCells.at(-1).composite, true);
const allCells = AnnotationAdapter.channelViewerCells({
    channels: [
        { index: 0, name: "DAPI", visible: true },
        { index: 23, name: "GL7", visible: false }
    ]
}, { rgb: false, modality: "FLUORESCENCE" }, { showAllChannels: true });
assert.equal(allCells.some(cell => cell.channelIndex === 23), true);
assert.match(AnnotationAdapter.channelViewerLabel({ name: "GL7", index: 23 }, 23), /\(C24\)/);

const crop = AnnotationAdapter.channelViewerCropRect(100, 80, 200, 100, 1, 1000, 800);
assert.equal(crop.x, 0);
assert.equal(crop.y, 30);
assert.equal(crop.width, 200);
assert.equal(crop.height, 100);

AnnotationAdapter.ensureMultiviewState();
AnnotationAdapter.multiview.synchronizeViewers = false;
AnnotationAdapter.multiview.activeIndex = 0;
AnnotationAdapter.multiview.panes = [
    { imageId: "a", viewer: null, metadata: null },
    { imageId: null, viewer: null, metadata: null }
];
assert.equal(AnnotationAdapter.enableSynchronizeIfMultipleImages(), false);
assert.equal(AnnotationAdapter.multiview.synchronizeViewers, false);
AnnotationAdapter.multiview.panes[1].imageId = "b";
assert.equal(AnnotationAdapter.enableSynchronizeIfMultipleImages(), true);
assert.equal(AnnotationAdapter.multiview.synchronizeViewers, true);

console.log("multiview.test.js: ok");
