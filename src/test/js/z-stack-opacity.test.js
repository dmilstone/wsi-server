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
    document: { getElementById() { return null; }, addEventListener() {} },
    fetch: null,
    WsiCsrf: { csrfFetch: async () => { throw new Error("unexpected save"); } }
});
vm.runInContext(
    `${fs.readFileSync(path.join(staticRoot, "annotation-store.js"), "utf8")}\nthis.AnnotationStore = AnnotationStore;`,
    context
);
vm.runInContext(`${adapterSource}\nthis.AnnotationAdapter = AnnotationAdapter;`, context);
const { AnnotationAdapter } = context;

function fakeWorld(items) {
    return {
        getItemCount() { return items.length; },
        getItemAt(index) { return items[index]; },
        getIndexOfItem(item) { return items.indexOf(item); },
        addHandler() {}
    };
}

function fakeItem(index, extra = {}) {
    return {
        opacity: index === 0 ? 1 : 0,
        preload: false,
        position: null,
        width: null,
        source: extra.source || null,
        options: extra.options || undefined,
        setOpacity(value) { this.opacity = value; },
        setPreload(value) { this.preload = value; },
        setPosition(point) { this.position = point; },
        setWidth(value) { this.width = value; },
        getBounds() {
            return { width: 1, getTopLeft() { return { x: 0, y: 0 }; } };
        }
    };
}

{
    const specs = AnnotationAdapter.buildZStackLayerSpecs({
        planeCount: 5,
        activeZ: 2,
        tileSourceForPlane: z => ({ plane: z })
    });
    assert.equal(specs.length, 5);
    assert.equal(specs[2].opacity, 1);
    assert.equal(specs.filter(spec => spec.opacity === 0).length, 4);
    assert.ok(specs.every(spec => spec.preload === true));
    assert.ok(specs.every(spec => spec.x === 0 && spec.y === 0 && spec.width === 1));
    assert.equal(specs[0].showInNavigator, true);
    assert.equal(specs[1].showInNavigator, false);
    assert.equal(specs[2].tileSource.plane, 2);
    assert.equal(specs[4].index, undefined);
    assert.ok(specs.every(spec => !Object.prototype.hasOwnProperty.call(spec, "index")));
    assert.ok(specs.every(spec => spec.compositeOperation == null));
    assert.ok(specs.every((spec, z) => spec.zIndexProperty === z && spec.zIndices === z));
    assert.equal(specs[0].channelName, "composite");
}

{
    const opened = [];
    const openHandlers = [];
    const items = [];
    const viewer = {
        open(source) {
            opened.push(source);
            if (Array.isArray(source)) {
                items.splice(0, items.length, ...source.map((_, index) => fakeItem(index)));
            }
        },
        addOnceHandler(name, handler) {
            if (name === "open") openHandlers.push(handler);
        },
        world: fakeWorld(items)
    };
    const ok = AnnotationAdapter.openMultiPlaneZStack(viewer, {
        planeCount: 4,
        activeZ: 1,
        tileSourceForPlane: z => ({ plane: z })
    });
    assert.equal(ok, true);
    assert.equal(opened.length, 1);
    assert.ok(Array.isArray(opened[0]));
    assert.equal(opened[0].length, 4);
    assert.equal(opened[0][1].opacity, 1);
    assert.equal(opened[0][0].opacity, 0);
    assert.ok(opened[0].every(spec => spec.preload === true));
    assert.equal(opened[0][2].x, 0);
    assert.equal(AnnotationAdapter.currentZ, 1);
    openHandlers.forEach(handler => handler());
    assert.deepEqual(items.map(item => item.opacity), [0, 1, 0, 0]);
}

{
    const items = [0, 1, 2, 3].map(index => fakeItem(index));
    const viewer = {
        openCalls: 0,
        open() { this.openCalls += 1; },
        world: fakeWorld(items)
    };
    AnnotationAdapter.zStackPlaneCount = 4;
    AnnotationAdapter.setCurrentZ(0);
    const openBefore = viewer.openCalls;
    const count = AnnotationAdapter.applyZStackLayerOpacities(viewer, 3);
    assert.equal(count, 4);
    assert.equal(viewer.openCalls, openBefore);
    assert.deepEqual(items.map(item => item.opacity), [0, 0, 0, 1]);
    assert.deepEqual(items.map(item => item.preload), [true, true, true, true]);
    AnnotationAdapter.applyZStackLayerOpacities(viewer, 1);
    assert.deepEqual(items.map(item => item.opacity), [0, 1, 0, 0]);
}

{
    const channels = AnnotationAdapter.FLUORESCENT_CHANNEL_NAMES;
    const specs = AnnotationAdapter.buildZStackLayerSpecs({
        planeCount: 3,
        activeZ: 1,
        channels,
        tileSourceForPlane: (z, channel) => ({ plane: z, channel: channel.name })
    });
    assert.equal(specs.length, 9);
    assert.equal(AnnotationAdapter.fluorescentChannelAssets({ channelCount: 3 }).map(c => c.name).join(","), "DAPI,FITC,TRITC");
    assert.deepEqual(specs.filter(spec => spec.zIndexProperty === 1).map(spec => spec.channelName), channels);
    assert.ok(specs.filter(spec => spec.zIndexProperty === 1).every(spec => spec.opacity === 1));
    assert.ok(specs.filter(spec => spec.zIndexProperty !== 1).every(spec => spec.opacity === 0));
}

{
    const items = [];
    for (const z of [2, 0, 1]) {
        for (const name of ["DAPI", "FITC", "TRITC"]) {
            items.push(fakeItem(items.length, {
                options: { zIndexProperty: z, zIndices: z, channelName: name }
            }));
        }
    }
    const viewer = { open() { throw new Error("must not reopen"); }, world: fakeWorld(items) };
    AnnotationAdapter.zStackPlaneCount = 3;
    const count = AnnotationAdapter.changeFocalDepth(viewer, 1);
    assert.equal(count, 9);
    assert.deepEqual(items.map(item => item.opacity), [0, 0, 0, 0, 0, 0, 1, 1, 1]);
    AnnotationAdapter.changeFocalDepth(viewer, 2);
    assert.deepEqual(items.map(item => item.opacity), [1, 1, 1, 0, 0, 0, 0, 0, 0]);
}

{
    // OSD TiledImage often has an empty options bag without our tag.
    // Must not blank every layer (the frozen-transition regression).
    const items = [0, 1, 2].map(index => fakeItem(index, { options: {} }));
    const viewer = { open() { throw new Error("must not reopen"); }, world: fakeWorld(items) };
    AnnotationAdapter.zStackPlaneCount = 3;
    const count = AnnotationAdapter.applyZStackLayerOpacities(viewer, 2);
    assert.equal(count, 3);
    assert.deepEqual(items.map(item => item.opacity), [0, 0, 1]);
}

{
    // String tags from OSD must still match a numeric targetZIndex.
    const items = [];
    for (const z of [0, 1]) {
        for (const name of ["DAPI", "FITC", "TRITC"]) {
            items.push(fakeItem(items.length, {
                options: { zIndexProperty: String(z), zIndices: String(z), channelName: name }
            }));
        }
    }
    const viewer = { open() { throw new Error("must not reopen"); }, world: fakeWorld(items) };
    AnnotationAdapter.zStackPlaneCount = 2;
    AnnotationAdapter.changeFocalDepth(viewer, 1);
    assert.deepEqual(items.map(item => item.opacity), [0, 0, 0, 1, 1, 1]);
}

{
    // Source-only tags (OSD dropped spec fields from item.options).
    const items = [0, 1, 2].map(z => fakeItem(z, {
        options: {},
        source: { zIndexProperty: z, zIndices: z }
    }));
    const viewer = { open() { throw new Error("must not reopen"); }, world: fakeWorld(items) };
    AnnotationAdapter.zStackPlaneCount = 3;
    AnnotationAdapter.applyZStackLayerOpacities(viewer, 0);
    assert.deepEqual(items.map(item => item.opacity), [1, 0, 0]);
    assert.equal(items[0].options.zIndexProperty, 0);
}

{
    const applied = [];
    AnnotationAdapter.setCurrentZ(2);
    AnnotationAdapter.isMeasurementModeActive = false;
    const hooks = {
        getMaxZ: () => 4,
        getZ: () => AnnotationAdapter.currentZ,
        onZChange: z => {
            AnnotationAdapter.setCurrentZ(z);
            applied.push(z);
        }
    };

    const wheelPlain = {
        altKey: false,
        deltaY: 80,
        prevented: false,
        stopped: false,
        preventDefault() { this.prevented = true; },
        stopPropagation() { this.stopped = true; }
    };
    assert.equal(AnnotationAdapter.handleZStackWheel(wheelPlain, hooks), false);
    assert.equal(wheelPlain.prevented, false);
    assert.equal(wheelPlain.stopped, false);
    assert.deepEqual(applied, []);

    const wheelAlt = {
        altKey: true,
        deltaY: 80,
        prevented: false,
        stopped: false,
        preventDefault() { this.prevented = true; },
        stopPropagation() { this.stopped = true; }
    };
    assert.equal(AnnotationAdapter.handleZStackWheel(wheelAlt, hooks), true);
    assert.equal(wheelAlt.prevented, true);
    assert.equal(wheelAlt.stopped, true);
    assert.deepEqual(applied, [3]);

    const keyUp = {
        key: "ArrowUp",
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        target: { tagName: "DIV" },
        prevented: false,
        preventDefault() { this.prevented = true; }
    };
    assert.equal(AnnotationAdapter.handleZStackKeyDown(keyUp, hooks), true);
    assert.equal(keyUp.prevented, true);
    assert.deepEqual(applied, [3, 2]);

    const keyInInput = {
        key: "ArrowDown",
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        target: { tagName: "INPUT" },
        prevented: false,
        preventDefault() { this.prevented = true; }
    };
    assert.equal(AnnotationAdapter.handleZStackKeyDown(keyInInput, hooks), false);
    assert.equal(keyInInput.prevented, false);
    assert.deepEqual(applied, [3, 2]);
}

{
    const listeners = [];
    const viewer = {
        gestureSettingsMouse: { scrollToZoom: true },
        element: {
            addEventListener(type, handler, opts) {
                listeners.push({ type, handler, opts });
            }
        },
        addHandler() {
            throw new Error("must not bind canvas-scroll");
        }
    };
    assert.equal(AnnotationAdapter.bindZStackWheel(viewer, { getMaxZ: () => 3 }), true);
    assert.equal(viewer.gestureSettingsMouse.scrollToZoom, true);
    assert.equal(listeners.length, 1);
    assert.equal(listeners[0].type, "wheel");
    assert.equal(listeners[0].opts.capture, true);
    assert.equal(listeners[0].opts.passive, false);
}

{
    const channels = [
        { name: "DAPI", index: 0, visible: true, opacity: 1 },
        { name: "FITC", index: 1, visible: false, opacity: 1 },
        { name: "TRITC", index: 2, visible: true, opacity: 0.5 }
    ];
    const specs = AnnotationAdapter.buildZStackLayerSpecs({
        planeCount: 2,
        activeZ: 1,
        channels,
        tileSourceForPlane: (z, channel) => ({ plane: z, channel: channel.index })
    });
    assert.equal(specs.length, 6);
    assert.ok(specs.every(spec => spec.compositeOperation === "lighter"));
    const active = specs.filter(spec => spec.zIndexProperty === 1);
    assert.equal(active.map(spec => spec.opacity).join(","), "1,0,0.5");
    assert.equal(active.map(spec => spec.channelIndex).join(","), "0,1,2");
    assert.equal(specs.map(spec => spec.preload).join(","), "true,false,true,true,false,true");
}

{
    const items = [];
    for (const z of [0, 1]) {
        for (const channel of [
            { name: "DAPI", index: 0 },
            { name: "FITC", index: 1 },
            { name: "TRITC", index: 2 }
        ]) {
            items.push(fakeItem(items.length, {
                options: {
                    zIndexProperty: z,
                    zIndices: z,
                    channelName: channel.name,
                    channelIndex: channel.index
                }
            }));
        }
    }
    const viewer = { open() { throw new Error("must not reopen"); }, world: fakeWorld(items), forceRedraw() {} };
    AnnotationAdapter.zStackPlaneCount = 2;
    AnnotationAdapter.applyChannelLayerOpacities(viewer, [
        { name: "DAPI", index: 0, visible: true, opacity: 1 },
        { name: "FITC", index: 1, visible: false, opacity: 1 },
        { name: "TRITC", index: 2, visible: true, opacity: 1 }
    ], 1);
    assert.deepEqual(items.map(item => item.opacity), [0, 0, 0, 1, 0, 1]);
    assert.deepEqual(items.map(item => item.preload), [true, false, true, true, false, true]);
    AnnotationAdapter.changeFocalDepth(viewer, 0);
    assert.deepEqual(items.map(item => item.opacity), [1, 0, 1, 0, 0, 0]);
    assert.deepEqual(items.map(item => item.preload), [true, false, true, true, false, true]);
    AnnotationAdapter.rememberChannelLayerState([]);
}

{
    assert.equal(AnnotationAdapter.zIndexFromTileUrl("/tile/slide/0/0_0.png?z=4&channel=1"), 4);
    assert.equal(AnnotationAdapter.neighborZTileUrl("/tile/slide/0/0_0.png?z=4&channel=1", 5), "/tile/slide/0/0_0.png?z=5&channel=1");
    AnnotationAdapter.resetZTilePrefetchCache("stack");
    const queued = AnnotationAdapter.prefetchAdjacentZPlaneTiles({
        url: "/tile/slide/0/0_0.png?z=2&channel=0",
        z: 2,
        maxZ: 8
    });
    assert.equal(queued, 2);
    assert.ok(AnnotationAdapter.zTilePrefetchUrls.has("/tile/slide/0/0_0.png?z=1&channel=0"));
    assert.ok(AnnotationAdapter.zTilePrefetchUrls.has("/tile/slide/0/0_0.png?z=3&channel=0"));
}

assert.match(adapterSource, /static applyChannelLayerOpacities\(/);
assert.match(adapterSource, /static openMultiPlaneZStack\(/);
assert.match(adapterSource, /channels \? "lighter" : null/);
assert.match(adapterSource, /spec\.compositeOperation = blend/);
assert.match(html, /scheduleDisplayUpdate\(\{\s*reopen:\s*false\s*\}\)/);
assert.match(html, /applyChannelLayerOpacities\(viewer, display\.channels/);
assert.doesNotMatch(
    html,
    /field === "visible"[\s\S]{0,400}openViewer\(true\)/
);
assert.match(adapterSource, /static applyZStackLayerOpacities\(/);
assert.match(adapterSource, /static bindZStackWheel\(/);
assert.match(adapterSource, /static handleZStackWheel\(/);
assert.match(adapterSource, /preload:\s*visible/);
assert.match(adapterSource, /setPreload\(channelOn\)/);
assert.match(adapterSource, /viewer\.open\(stamped\)/);
assert.match(adapterSource, /zIndexProperty/);
assert.match(adapterSource, /static changeFocalDepth\(/);
assert.match(adapterSource, /static onZScroll\(/);
assert.match(adapterSource, /FLUORESCENT_CHANNEL_NAMES/);
assert.match(adapterSource, /getElementById\(['"]ai-labs-panel['"]\)/);
assert.match(adapterSource, /classList\.remove\(['"]show['"]\)/);
assert.match(adapterSource, /static enforceDefaultClosedPanelState\(/);
assert.match(adapterSource, /zIndexProperty === targetZIndex|tagged === targetZIndex/);
assert.doesNotMatch(adapterSource, /addHandler\("canvas-scroll"/);
assert.match(html, /AnnotationAdapter\.openMultiPlaneZStack/);
assert.match(html, /AnnotationAdapter\.isRgbSeriesView/);
assert.match(html, /AnnotationAdapter\.chooseDefaultSeries/);
assert.match(adapterSource, /static isRgbSeriesView\(/);
assert.match(adapterSource, /static chooseDefaultSeries\(/);
assert.doesNotMatch(adapterSource, /index:\s*specs\.length/);
assert.match(html, /AnnotationAdapter\.bindZStackWheel/);
assert.match(html, /AnnotationAdapter\.applyZStackLayerOpacities/);
assert.match(html, /scrollToZoom:\s*true/);
assert.match(html, /annotation-adapter\.js\?v=/);
assert.match(html, /id="z-controls-card"/);
assert.match(html, /id="floating-zstack-palette"/);
assert.match(html, /id="ai-labs-panel"/);
assert.match(html, /id="ai-analytics-panel"/);
assert.doesNotMatch(html, /<details[^>]*id="ai-analytics-panel"[^>]*\sopen/);
assert.match(adapterSource, /static isMultiLayerSlide\(/);
assert.match(adapterSource, /static onSlideClicked\(/);
assert.match(adapterSource, /static cacheCatalogSidecarMetadata\(/);
assert.match(adapterSource, /static mapSidecarProperties\(/);
assert.match(adapterSource, /getElementById\(['"]z-controls-card['"]\)/);
assert.match(adapterSource, /setFloatingZStackPaletteVisible\(/);
assert.match(adapterSource, /style\.display = ['"]block['"]/);
assert.match(adapterSource, /Force reset and hide the floating Z-stack controller/);
assert.match(adapterSource, /getElementById\(["']floating-zstack-palette["']\)/);
assert.match(adapterSource, /folder\.includes\(["']_z["']\)/);
assert.doesNotMatch(html, /onZStackSliderInput[\s\S]{0,240}openViewer\(true\)/);
assert.doesNotMatch(html, /function applyZMovieFrame[\s\S]{0,240}openViewer\(true\)/);

console.log("z-stack-opacity.test.js: ok");
