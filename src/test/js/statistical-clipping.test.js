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

assert.doesNotMatch(html, /id="viewing-options"/);
assert.doesNotMatch(html, /Enable Automated Statistical Clipping/);
assert.match(html, /id="statistical-clipping-checkbox"/);
assert.match(html, /class="auto-clip-toggle"/);
assert.match(
    html,
    /id="first-dapi-checkbox"[\s\S]{0,800}id="statistical-clipping-checkbox"[\s\S]{0,400}Auto Clip[\s\S]{0,200}<button id="classify-menu-button"/
);
assert.match(html, /<label class="auto-clip-toggle"[\s\S]*?>[\s\S]*?Auto Clip\s*<\/label>/);
assert.match(html, /id="statistical-clipping-checkbox"[^>]*class="floating-channel-cb"/);
assert.doesNotMatch(html, /id="statistical-clipping-checkbox"[^>]*\schecked/);
assert.match(html, /\.auto-clip-toggle/);
assert.match(html, /\.floating-channel-cb:checked::after[\s\S]*?content:\s*"\\00d7"/);
assert.doesNotMatch(html, /\.floating-channel-cb:not\(:checked\)::after/);

assert.match(html, /String\(suffix \|\| ""\)\.includes\("\/display"\)/);
assert.match(html, /AnnotationAdapter\.statisticalClippingQuery\(\)/);
assert.match(
    html,
    /resetButton\.addEventListener\("click"[\s\S]*applyDisplayResetChannelState\(display\?\.channels\)/
);
assert.match(
    html,
    /recomputeAutoButton\.addEventListener\("click"[\s\S]*applyDisplayResetChannelState\(display\?\.channels\)/
);

assert.match(adapterSource, /static lowEndBlackFromHistogram\(/);
assert.match(adapterSource, /static submedianFloorBlackFromHistogram\(/);
assert.match(adapterSource, /HIGH_CONTRAST_FLOOR_OFFSET = 300/);
assert.match(adapterSource, /SUBMEDIAN_PERCENTILE = 0\.25/);
assert.match(html, /id="fcp-min"[^>]*min="0"/);
assert.match(html, /id="fcp-min"[^>]*value="0"/);
assert.match(adapterSource, /static bindStatisticalClippingToggle\(/);
assert.match(adapterSource, /static applyDisplayResetChannelState\(/);
assert.match(adapterSource, /LEGACY_LOW_PERCENTILE = 0\.01/);
assert.match(adapterSource, /bindStatisticalClippingToggle\(root\)/);
assert.match(adapterSource, /getElementById\?\.\("statistical-clipping-checkbox"\)/);

assert.equal(AnnotationAdapter.statisticalClippingEnabled, false);
assert.equal(AnnotationAdapter.isStatisticalClippingEnabled(), false);
assert.equal(AnnotationAdapter.statisticalClippingQuery(), "");
assert.equal(AnnotationAdapter.lowEndBlackFromHistogram(null), 0);
assert.equal(AnnotationAdapter.lowEndBlackFromHistogram([]), 0);

{
    const histogram = new Array(4096).fill(0);
    histogram[0] = 50;
    histogram[80] = 200;
    histogram[1000] = 9750;
    assert.equal(AnnotationAdapter.submedianFloorBlackFromHistogram(histogram), 1300);
    assert.equal(AnnotationAdapter.lowEndBlackFromHistogram(histogram, false), 1300);
    assert.equal(AnnotationAdapter.lowEndBlackFromHistogram(histogram, true), 80);
}

{
    const backgroundHeavy = new Array(2048).fill(0);
    backgroundHeavy[0] = 8000;
    backgroundHeavy[40] = 1500;
    backgroundHeavy[1800] = 500;
    assert.equal(AnnotationAdapter.submedianFloorBlackFromHistogram(backgroundHeavy), 300);
    assert.equal(AnnotationAdapter.lowEndBlackFromHistogram(backgroundHeavy, false), 300);
}

{
    AnnotationAdapter.firstDapiEnabled = false;
    const channels = [
        { name: "DAPI", index: 0, visible: true },
        { name: "FITC", index: 1, visible: true }
    ];
    AnnotationAdapter.applyDisplayResetChannelState(channels);
    assert.equal(channels[0].visible, false);
    assert.equal(channels[1].visible, true);
}

{
    AnnotationAdapter.firstDapiEnabled = true;
    const channels = [
        { name: "Cyan (DAPI)", index: 0, visible: false },
        { name: "TRITC", index: 2, visible: true }
    ];
    AnnotationAdapter.applyDisplayResetChannelState(channels);
    assert.equal(channels[0].visible, true);
    assert.equal(channels[1].visible, true);
}

{
    const listeners = [];
    const box = {
        checked: false,
        dataset: {},
        addEventListener(type, handler) { listeners.push({ type, handler }); }
    };
    const doc = {
        getElementById(id) { return id === "statistical-clipping-checkbox" ? box : null; }
    };
    let recomputes = 0;
    AnnotationAdapter.setDisplayController({
        getSelectedImage: () => ({ id: "slide-1" }),
        recomputeAuto() { recomputes += 1; }
    });
    assert.equal(AnnotationAdapter.bindStatisticalClippingToggle(doc), true);
    assert.equal(AnnotationAdapter.statisticalClippingEnabled, false);
    assert.equal(box.dataset.statisticalClippingBound, "1");
    assert.equal(listeners.length, 1);
    box.checked = true;
    listeners[0].handler();
    assert.equal(AnnotationAdapter.statisticalClippingEnabled, true);
    assert.equal(AnnotationAdapter.statisticalClippingQuery(doc), "&statisticalClipping=true");
    assert.equal(recomputes, 1);
    box.checked = false;
    listeners[0].handler();
    assert.equal(AnnotationAdapter.statisticalClippingEnabled, false);
    assert.equal(AnnotationAdapter.statisticalClippingQuery(doc), "");
    assert.equal(recomputes, 2);
    AnnotationAdapter.setDisplayController(null);
}

AnnotationAdapter.firstDapiEnabled = false;
AnnotationAdapter.statisticalClippingEnabled = false;
AnnotationAdapter.setDisplayController(null);

console.log("statistical-clipping.test.js: ok");
