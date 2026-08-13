"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const adapterSource = fs.readFileSync(
    path.join(__dirname, "../../main/resources/static/annotation-adapter.js"),
    "utf8"
);
const html = fs.readFileSync(
    path.join(__dirname, "../../main/resources/static/index.html"),
    "utf8"
);

function loadAnnotationAdapter() {
    const sandbox = {
        console,
        setInterval(fn, _ms) { return 1; },
        clearInterval(_id) {},
        localStorage: {
            store: Object.create(null),
            getItem(key) { return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null; },
            setItem(key, value) { this.store[key] = String(value); },
            removeItem(key) { delete this.store[key]; }
        },
        fetch: async () => ({ ok: true, json: async () => ({}) }),
        WsiCsrf: { csrfFetch: async () => ({ ok: true }) },
        AnnotationStore: class {
            constructor() {}
            subscribe() {}
            async load() {}
            updateCollection() {}
        }
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.runInNewContext(`${adapterSource}\nthis.AnnotationAdapter = AnnotationAdapter;`, sandbox);
    return sandbox.AnnotationAdapter;
}

const AnnotationAdapter = loadAnnotationAdapter();

assert.equal(AnnotationAdapter.currentZ, 0);
assert.equal(AnnotationAdapter.currentSeries, 0);
AnnotationAdapter.setCurrentZ(4);
AnnotationAdapter.setCurrentSeries(2);
assert.equal(AnnotationAdapter.currentZ, 4);
assert.equal(AnnotationAdapter.currentSeries, 2);

assert.equal(
    AnnotationAdapter.appendTileDepthQuery("/tile/img/composite/1/0/0.png?revision=3"),
    "/tile/img/composite/1/0/0.png?revision=3&z=4&series=2"
);
assert.equal(
    AnnotationAdapter.appendTileDepthQuery("/tile/img/composite/1/0/0.png"),
    "/tile/img/composite/1/0/0.png?z=4&series=2"
);
assert.equal(
    AnnotationAdapter.appendTileDepthQuery("/tile/img/composite/1/0/0.png?revision=3&z=9&series=1"),
    "/tile/img/composite/1/0/0.png?revision=3&z=4&series=2"
);
assert.equal(
    AnnotationAdapter.appendTileDepthQuery("/api/images/abc/annotations"),
    "/api/images/abc/annotations"
);

assert.match(html, /let currentZ = 0/);
assert.match(html, /let currentSeries = 0/);
assert.match(html, /id="series-select-control"/);
assert.match(html, /Select Scan Section \/ Series/);
assert.match(html, /function syncSeriesSelectControl\(/);
assert.match(html, /function chooseDefaultSeries\(/);
assert.match(html, /onSeriesSelectChange/);
assert.match(html, /syncZStackControl\(metadata\)/);
assert.match(html, /zDepthControls\.hidden = true/);
assert.match(html, /planes <= 1/);
assert.match(html, /flushViewerTileCache\(/);
assert.match(html, /viewer\.tileCache\.clearCache/);
assert.match(html, /onZStackSliderInput/);
assert.match(html, /AnnotationAdapter\.stopZMovie/);
assert.match(html, /AnnotationAdapter\.activateModeAndPlay|AnnotationAdapter\.bindZMovieModeButtons/);
assert.doesNotMatch(html, /id="z-movie-play"/);
assert.match(html, /id="z-movie-mode-loop"/);
assert.match(html, /id="z-movie-mode-pingpong"/);
assert.match(html, /id="z-movie-mode-loop"[^>]*>🔁</);
assert.match(html, /id="z-movie-mode-pingpong"[^>]*>↔️</);
assert.match(html, /maxImageCacheCount:\s*500/);
assert.match(html, /AnnotationAdapter\.bindZMovieModeButtons/);
assert.match(html, /class="right-stack-controls"/);
assert.doesNotMatch(html, /Focal Animation Player/);
assert.doesNotMatch(html, /id="z-movie-interval"/);
assert.match(adapterSource, /static zMovieTimer = null/);
assert.match(adapterSource, /static zDirection = 1/);
assert.match(adapterSource, /static animationMode = "LOOP"/);
assert.match(adapterSource, /static tickZMovie\(/);
assert.match(adapterSource, /static stopZMovie\(/);
assert.match(adapterSource, /static setAnimationMode\(/);
assert.match(adapterSource, /static activateModeAndPlay\(/);
assert.match(adapterSource, /static bindZMovieModeButtons\(/);
assert.match(adapterSource, /PING_PONG/);
assert.match(adapterSource, /is-active/);
assert.match(adapterSource, /current >= maxZ \? 0 : current \+ 1/);

assert.equal(AnnotationAdapter.zMovieTimer, null);
AnnotationAdapter.configureZMovie({
    getMaxZ: () => 3,
    applyZ: () => {},
    onStateChange: () => {}
});
AnnotationAdapter.setCurrentZ(0);
AnnotationAdapter.setAnimationMode("LOOP");
assert.equal(AnnotationAdapter.animationMode, "LOOP");
AnnotationAdapter.tickZMovie();
assert.equal(AnnotationAdapter.currentZ, 1);
AnnotationAdapter.setCurrentZ(3);
AnnotationAdapter.tickZMovie();
assert.equal(AnnotationAdapter.currentZ, 0);
AnnotationAdapter.setCurrentZ(3);
AnnotationAdapter.zDirection = -1;
AnnotationAdapter.setAnimationMode("LOOP");
assert.equal(AnnotationAdapter.zDirection, 1);
AnnotationAdapter.tickZMovie();
assert.equal(AnnotationAdapter.currentZ, 0);
AnnotationAdapter.setCurrentZ(2);
AnnotationAdapter.setAnimationMode("PING_PONG");
assert.equal(AnnotationAdapter.animationMode, "PING_PONG");
AnnotationAdapter.zDirection = 1;
AnnotationAdapter.tickZMovie();
assert.equal(AnnotationAdapter.currentZ, 3);
AnnotationAdapter.tickZMovie();
assert.equal(AnnotationAdapter.currentZ, 2);
assert.equal(AnnotationAdapter.zDirection, -1);
AnnotationAdapter.stopZMovie();
assert.equal(AnnotationAdapter.activateModeAndPlay("LOOP", { intervalMs: 50 }), true);
assert.equal(AnnotationAdapter.zMoviePlaying, true);
assert.equal(AnnotationAdapter.animationMode, "LOOP");
assert.equal(AnnotationAdapter.activateModeAndPlay("LOOP", { intervalMs: 50 }), false);
assert.equal(AnnotationAdapter.zMoviePlaying, false);
assert.equal(AnnotationAdapter.activateModeAndPlay("PING_PONG", { intervalMs: 50 }), true);
assert.equal(AnnotationAdapter.animationMode, "PING_PONG");
assert.equal(AnnotationAdapter.zMoviePlaying, true);
AnnotationAdapter.stopZMovie();
assert.equal(AnnotationAdapter.zMovieTimer, null);
assert.equal(AnnotationAdapter.zMoviePlaying, false);
assert.match(html, /AnnotationAdapter\.diagnosticSpecimenProfiles/);
assert.match(html, /AnnotationAdapter\.shouldShowSeriesSelector/);
assert.match(adapterSource, /isDiagnosticSpecimen === true/);
assert.match(adapterSource, /static diagnosticSpecimenProfiles\(/);
assert.match(adapterSource, /static shouldShowSeriesSelector\(/);

assert.deepEqual(
    AnnotationAdapter.diagnosticSpecimenProfiles([
        { index: 0, isDiagnosticSpecimen: false },
        { index: 1, isDiagnosticSpecimen: false },
        { index: 2, isDiagnosticSpecimen: true },
        { index: 3, isDiagnosticSpecimen: true }
    ]).map(p => p.index),
    [2, 3]
);
assert.equal(AnnotationAdapter.shouldShowSeriesSelector([
    { index: 0, isDiagnosticSpecimen: false },
    { index: 2, isDiagnosticSpecimen: true }
]), false);
assert.equal(AnnotationAdapter.shouldShowSeriesSelector([
    { index: 2, isDiagnosticSpecimen: true },
    { index: 3, isDiagnosticSpecimen: true }
]), true);

console.log("z-stack-viewer.test.js: ok");
