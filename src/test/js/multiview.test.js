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
assert.match(html, /annotation-adapter\.js\?v=20260911-ai-plugins-fix/);
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
assert.match(html, /Open Z-stack controller/);
assert.match(html, /data-mv="z-stack-controller"/);
assert.match(html, />Multi-view </);
assert.match(html, />Cell display </);
assert.match(html, />Display </);
assert.match(html, />Set tool </);
assert.match(html, />Show analysis</);
assert.match(html, />Brightness\/Contrast</);
assert.match(html, />400%</);
assert.match(html, />100%</);
assert.match(html, />50%</);
assert.match(html, />10%</);
assert.match(html, />1%</);
assert.match(html, /data-mv="set-tool"/);
assert.match(html, /data-tool="move"/);
assert.match(html, /data-tool="wand"/);
assert.match(html, /Nuclei &amp; cell boundaries/);
assert.match(html, />Nuclei only</);
assert.match(html, />Cell boundaries only</);
assert.match(html, />Cell centroids only</);
assert.match(html, /data-mv="cell-display"/);
assert.match(html, /data-mode="nuclei-boundaries"/);
assert.match(adapterSource, /static setCellDisplayMode\(/);
assert.match(adapterSource, /static expandDetectionRing\(/);
assert.match(adapterSource, /case "cell-display":/);
assert.match(html, /id="channel-viewer"/);
assert.match(html, />Channel viewer</);
assert.match(html, /id="channel-viewer"/);
assert.match(html, /class="palette-resize-handle" data-edge="se"/);
assert.match(html, /\.channel-viewer \.palette-resize-handle\[data-edge="n"\]/);
assert.match(adapterSource, /static toggleChannelViewer\(/);
assert.match(adapterSource, /static openZStackController\(/);
assert.match(adapterSource, /case "z-stack-controller":/);
assert.match(adapterSource, /static bindPaletteEdgeResize\(/);
assert.match(adapterSource, /static bindChannelViewerResize\(/);
assert.match(adapterSource, /static ensurePaletteResizeHandles\(/);
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
const edgeCrop = AnnotationAdapter.channelViewerCropRect(10, 10, 200, 100, 1, 1000, 800);
assert.equal(edgeCrop.x, -90);
assert.equal(edgeCrop.y, -40);
assert.equal(edgeCrop.width, 200);
assert.equal(edgeCrop.height, 100);

{
    const viewer = {
        viewport: {
            getZoom() { return 1; },
            viewportToImageZoom() { return 4; }
        },
        world: {
            getItemAt() {
                return { viewportToImageZoom() { return 4; } };
            }
        }
    };
    AnnotationAdapter.channelViewer.downsample = 1;
    assert.equal(AnnotationAdapter.channelViewerEffectiveDownsample(viewer), 0.25);
    AnnotationAdapter.channelViewer.downsample = 0.5;
    assert.equal(AnnotationAdapter.channelViewerEffectiveDownsample(viewer), 0.125);
    AnnotationAdapter.channelViewer.downsample = 1;
    assert.equal(AnnotationAdapter.channelViewerEffectiveDownsample(null), 1);
}
assert.match(adapterSource, /channelViewerEffectiveDownsample/);
assert.match(html, /Zoom relative to the main window/);
assert.match(adapterSource, /static channelViewerActiveZ\(/);
assert.match(adapterSource, /static channelViewerCachedImage\(/);
assert.match(adapterSource, /static enqueueChannelViewerTiles\(/);
assert.match(adapterSource, /globalCompositeOperation = "multiply"/);
assert.match(adapterSource, /scheduleChannelViewerRefresh\(\{ immediate: true \}\)/);
assert.match(adapterSource, /const z = AnnotationAdapter\.channelViewerActiveZ\(pane\)/);

{
    const url = AnnotationAdapter.channelViewerTileUrl("slide", 2, 1, 0, {
        channelIndex: 3,
        z: 5,
        series: 1,
        revision: 9
    });
    assert.match(url, /[?&]z=5/);
    assert.match(url, /[?&]channel=3/);
    assert.match(url, /[?&]series=1/);
    const zero = AnnotationAdapter.channelViewerTileUrl("slide", 0, 0, 0, { composite: true, z: 0 });
    assert.match(zero, /[?&]z=0/);
}

{
    AnnotationAdapter.currentZ = 7;
    AnnotationAdapter.ensureMultiviewState();
    AnnotationAdapter.multiview.activeIndex = 0;
    AnnotationAdapter.multiview.panes = [
        { index: 0, currentZ: 0, imageId: "a" },
        { index: 1, currentZ: 2, imageId: "b" }
    ];
    assert.equal(AnnotationAdapter.channelViewerActiveZ(AnnotationAdapter.multiview.panes[0]), 7);
    assert.equal(AnnotationAdapter.channelViewerActiveZ(AnnotationAdapter.multiview.panes[1]), 2);
    AnnotationAdapter.channelViewer.open = false;
    AnnotationAdapter.setCurrentZ(4);
    assert.equal(AnnotationAdapter.currentZ, 4);
    assert.equal(AnnotationAdapter.multiview.panes[0].currentZ, 4);
    AnnotationAdapter.currentZ = 0;
}

{
    const metadata = { width: 2048, height: 2048, tileSize: 512, resolutionCount: 3 };
    const rect = { x: 0, y: 0, width: 512, height: 512, imageWidth: 2048, imageHeight: 2048 };
    const auto = AnnotationAdapter.channelViewerTileCover(metadata, rect, 4);
    const forced = AnnotationAdapter.channelViewerTileCover(metadata, rect, 4, 0);
    assert.equal(forced.level, 0);
    assert.notEqual(auto.level, undefined);
}

{
    let opened = false;
    const original = AnnotationAdapter.openZStackController;
    AnnotationAdapter.openZStackController = () => {
        opened = true;
        return true;
    };
    assert.equal(AnnotationAdapter.runMultiViewCommand("z-stack-controller"), true);
    assert.equal(opened, true);
    AnnotationAdapter.openZStackController = original;
    assert.equal(AnnotationAdapter.openZStackController(), false);
}

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

{
    const square = [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 }
    ];
    const expanded = AnnotationAdapter.expandDetectionRing(square, 2);
    assert.equal(expanded.length, 4);
    assert.equal(expanded[0].x, -5);
    assert.equal(expanded[0].y, -5);
    assert.equal(expanded[2].x, 15);
    assert.equal(expanded[2].y, 15);
    assert.equal(AnnotationAdapter.normalizeCellExpansionMode("perimeter"), "offset");
    const offset = AnnotationAdapter.expandDetectionRingOffset(square, 2, 3);
    assert.equal(offset.length, 4);
    assert.ok(offset[0].x < square[0].x);
    assert.ok(offset[2].x > square[2].x);
    assert.equal(AnnotationAdapter.expandDetectionCell(square, "none", 2).length, 0);
    assert.equal(AnnotationAdapter.normalizeCellDisplayMode("Nuclei only"), "nuclei");
    assert.equal(AnnotationAdapter.normalizeCellDisplayMode("cell-centroids"), "centroids");
    assert.equal(AnnotationAdapter.setCellDisplayMode("boundaries"), "boundaries");
    assert.equal(AnnotationAdapter.cellDisplayShowsBoundaries(), true);
    assert.equal(AnnotationAdapter.cellDisplayShowsNuclei(), false);
    assert.equal(AnnotationAdapter.runMultiViewCommand("cell-display", { mode: "centroids" }), "centroids");
    assert.equal(AnnotationAdapter.cellDisplayMode, "centroids");
    AnnotationAdapter.setCellDisplayMode("nuclei");
}

{
    const previous = AnnotationAdapter.overlayOpacity;
    assert.equal(AnnotationAdapter.setOverlayOpacity(0.5), 0.5);
    assert.equal(AnnotationAdapter.cssOverlayOpacity(), 0.5);
    assert.equal(AnnotationAdapter.setOverlayOpacity(4), 4);
    assert.equal(AnnotationAdapter.cssOverlayOpacity(), 1);
    AnnotationAdapter.setOverlayOpacity(previous);
    const pans = [];
    const viewer = {
        viewport: {
            deltaPointsFromPixels(point) { return { x: Number(point.x) / 10, y: Number(point.y) / 10 }; },
            panBy(delta, immediate) { pans.push([delta.x, delta.y, immediate]); }
        }
    };
    AnnotationAdapter.viewer = viewer;
    assert.equal(AnnotationAdapter.panViewportByPixels(20, -10, viewer), true);
    assert.deepEqual(pans[0], [-2, 1, true]);
    AnnotationAdapter.lockedAnnotationIds = new Set(["locked-1"]);
    AnnotationAdapter._lockedAnnotationsLoaded = true;
    const started = AnnotationAdapter.beginLockedAnnotationPan(
        { button: 0, clientX: 10, clientY: 20 },
        { getAttribute: (name) => (name === "data-annotation-id" ? "locked-1" : null) }
    );
    assert.equal(started, true);
    assert.equal(AnnotationAdapter.onLockedAnnotationPanMove({ clientX: 30, clientY: 10 }), true);
    assert.ok(pans.length >= 2);
    AnnotationAdapter.finishLockedAnnotationPan();
    assert.equal(AnnotationAdapter.qpLockedPanSession, null);
    AnnotationAdapter.viewer = null;
}

assert.equal(AnnotationAdapter.preferredFlyoutSideFromPoint(100, 1000), "right");
assert.equal(AnnotationAdapter.preferredFlyoutSideFromPoint(800, 1000), "left");
assert.equal(
    AnnotationAdapter.chooseFlyoutSide({ left: 40, right: 200 }, { width: 220 }, "right", 8, { w: 1280 }),
    "right"
);
assert.equal(
    AnnotationAdapter.chooseFlyoutSide({ left: 1100, right: 1260 }, { width: 220 }, "right", 8, { w: 1280 }),
    "left",
    "right-edge click must flip the flyout left so items stay on screen"
);
assert.equal(
    AnnotationAdapter.chooseFlyoutSide({ left: 20, right: 180 }, { width: 220 }, "left", 8, { w: 1280 }),
    "right",
    "left-edge menu must flip the flyout right"
);
{
    const placed = AnnotationAdapter.placeFlyout(
        { left: 1100, right: 1260, top: 700 },
        { width: 240, height: 200 },
        "left",
        8,
        { w: 1280, h: 800 }
    );
    assert.equal(placed.side, "left");
    assert.ok(placed.left >= 8);
    assert.ok(placed.left + 240 <= 1272);
    assert.ok(placed.top + 200 <= 792);
}

assert.match(html, /#multiview-menu \.multiview-submenu \{[\s\S]*?position:\s*fixed/);
assert.match(html, /#multiview-menu \.multiview-item\.is-flyout-open > \.multiview-submenu \{\s*display:\s*block\s*!important/);
assert.match(adapterSource, /static chooseFlyoutSide\(/);
assert.match(adapterSource, /static layoutMultiViewSubmenu\(/);
assert.match(adapterSource, /static setMultiViewFlyoutPath\(/);
assert.match(adapterSource, /static clearMultiViewFlyouts\(/);

{
    const classSet = (initial) => {
        const set = new Set(initial || []);
        return {
            contains: (name) => set.has(name),
            add: (name) => { set.add(name); },
            remove: (...names) => names.forEach(name => set.delete(name)),
            toggle: (name, on) => {
                if (on) set.add(name);
                else set.delete(name);
            }
        };
    };
    const makeItem = (name, submenu) => {
        const item = {
            name,
            classList: classSet(["multiview-item"]),
            children: [
                { classList: { contains: (cls) => cls === "multiview-submenu-label" }, getBoundingClientRect: () => ({ left: 100, right: 280, top: 40, bottom: 64 }) },
                submenu
            ],
            querySelector(sel) {
                if (String(sel).includes("submenu-label")) return this.children[0];
                if (String(sel).includes("submenu")) return submenu;
                return null;
            },
            parentElement: null
        };
        return item;
    };
    const subA = { style: {}, offsetWidth: 220, offsetHeight: 80, classList: { contains: (cls) => cls === "multiview-submenu" } };
    const subB = { style: {}, offsetWidth: 220, offsetHeight: 80, classList: { contains: (cls) => cls === "multiview-submenu" } };
    const itemA = makeItem("a", subA);
    const itemB = makeItem("b", subB);
    const menu = {
        contains(node) { return node === itemA || node === itemB; },
        querySelectorAll() { return [itemA, itemB]; }
    };
    itemA.parentElement = menu;
    itemB.parentElement = menu;
    AnnotationAdapter.setMultiViewFlyoutPath(menu, itemA);
    assert.equal(itemA.classList.contains("is-flyout-open"), true);
    assert.equal(itemB.classList.contains("is-flyout-open"), false);
    assert.equal(subB.style.display, "none");
    assert.equal(subA.style.display, "block");
    AnnotationAdapter.setMultiViewFlyoutPath(menu, itemB);
    assert.equal(itemA.classList.contains("is-flyout-open"), false);
    assert.equal(itemB.classList.contains("is-flyout-open"), true);
    assert.equal(subA.style.display, "none");
}

console.log("multiview.test.js: ok");
