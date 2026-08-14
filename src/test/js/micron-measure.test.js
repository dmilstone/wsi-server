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

function makeFakeDom() {
    class FakeEl {
        constructor(name) {
            this.tagName = name;
            this.attrs = Object.create(null);
            this.children = [];
            this.style = { cssText: "", display: "none", position: "relative" };
            this.parentElement = null;
            this.isConnected = false;
            this.clientWidth = 800;
            this.clientHeight = 600;
        }
        setAttribute(key, value) { this.attrs[key] = String(value); }
        getAttribute(key) { return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null; }
        removeAttribute(key) { delete this.attrs[key]; }
        append(...kids) {
            for (const child of kids) {
                child.parentElement = this;
                child.isConnected = true;
                this.children.push(child);
            }
        }
        appendChild(child) {
            this.append(child);
            return child;
        }
        remove() {
            if (this.parentElement) {
                this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
            }
            this.parentElement = null;
            this.isConnected = false;
        }
        querySelector(sel) {
            const match = /data-measure="([^"]+)"/.exec(sel);
            if (!match) return null;
            return this.children.find((c) => c.attrs["data-measure"] === match[1]) || null;
        }
        getBoundingClientRect() {
            return { left: 0, top: 0, width: 800, height: 600 };
        }
    }

    const host = new FakeEl("div");
    return {
        host,
        document: {
            createElementNS(_ns, name) { return new FakeEl(name); },
            getElementById() { return null; }
        }
    };
}

function loadAnnotationAdapter(extra = {}) {
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
        },
        ...extra
    };
    sandbox.window = sandbox.window || sandbox;
    sandbox.globalThis = sandbox;
    vm.runInNewContext(`${adapterSource}\nthis.AnnotationAdapter = AnnotationAdapter;`, sandbox);
    return sandbox.AnnotationAdapter;
}

const AnnotationAdapter = loadAnnotationAdapter();

assert.match(html, /id="measure-mode"/);
assert.match(html, /id="measure-session-panel"/);
assert.match(html, /id="measure-session-list"/);
assert.match(html, /Session measurements/);
assert.match(html, /isMeasurementModeActive/);
assert.match(html, /cursor:\s*crosshair/);
assert.match(html, /AnnotationAdapter\.formatMicrons/);
assert.match(html, /AnnotationAdapter\.bindMeasureMouseTracker/);
assert.match(html, /onMeasurementComplete/);
assert.match(html, /renderMeasureSessionList/);
assert.match(html, /bindEnterToCommitOverlays/);
assert.match(html, /ensureMeasurementDefaults/);
assert.doesNotMatch(html, /openMeasureDialog/);
assert.doesNotMatch(html, /onMeasureTrackerPress/);
assert.doesNotMatch(html, /measureOverlay\?\.addEventListener/);


assert.match(adapterSource, /static isMeasurementModeActive = false/);
assert.match(adapterSource, /static isDragging = false/);
assert.match(adapterSource, /static bindMeasureMouseTracker\(/);
assert.match(adapterSource, /pressHandler:/);
assert.match(adapterSource, /dragHandler:/);
assert.match(adapterSource, /releaseHandler:/);
assert.match(adapterSource, /viewerElementToViewportCoordinates/);
assert.match(adapterSource, /preventDefaultAction = true/);
assert.match(adapterSource, /static ensureMeasurementDefaults\(/);
assert.match(adapterSource, /static nextSequentialMeasurementLabel\(/);
assert.match(adapterSource, /saveMeasurementToSession\(/);
assert.match(adapterSource, /onSessionListChange/);
assert.match(adapterSource, /rapid-fire path|Auto-save|auto-save/i);
assert.match(adapterSource, /setMouseNavEnabled\(!enabled\)/);
assert.match(adapterSource, /z-index:100000/);

AnnotationAdapter.setImageMetadata({ micronsPerPixelX: 0.5, micronsPerPixelY: 0.5 });
const mpp = AnnotationAdapter.micronsPerPixel();
assert.ok(mpp);
assert.equal(mpp.x, 0.5);
assert.equal(mpp.y, 0.5);
const microns = AnnotationAdapter.measureLengthMicrons(0, 0, 30, 40);
assert.equal(microns, 25);
assert.equal(AnnotationAdapter.formatMicrons(25), "25.0 µm");

let mouseNav = true;
AnnotationAdapter.setViewer({
    setMouseNavEnabled(enabled) { mouseNav = enabled; }
});
assert.equal(AnnotationAdapter.setMeasurementModeActive(true), true);
assert.equal(AnnotationAdapter.isMeasurementModeActive, true);
assert.equal(AnnotationAdapter.isDragging, false);
assert.equal(AnnotationAdapter.isDraggingMeasurement, false);
assert.equal(AnnotationAdapter.measureStartX, null);
assert.equal(mouseNav, false);
assert.equal(AnnotationAdapter.updateMeasurementDrag({
    overlayX: 50, overlayY: 50, imageX: 1, imageY: 1, labelText: "nope"
}), false);
assert.equal(AnnotationAdapter.setMeasurementModeActive(false), false);
assert.equal(mouseNav, true);

// Cleared-storage style corruption recovers via ensureMeasurementDefaults
AnnotationAdapter.measurementSessionList = null;
AnnotationAdapter.isDragging = "bad";
AnnotationAdapter.ensureMeasurementDefaults();
assert.ok(Array.isArray(AnnotationAdapter.measurementSessionList));
assert.equal(AnnotationAdapter.measurementSessionList.length, 0);
assert.equal(AnnotationAdapter.isDragging, false);

const overlaySandbox = (() => {
    const fake = makeFakeDom();
    const trackers = [];
    const sandbox = {
        console,
        document: fake.document,
        window: {
            getComputedStyle() { return { position: "relative" }; },
            OpenSeadragon: {
                MouseTracker: class {
                    constructor(opts) {
                        this.opts = opts;
                        this.destroyed = false;
                        trackers.push(this);
                    }
                    destroy() { this.destroyed = true; }
                }
            }
        },
        setInterval() { return 1; },
        clearInterval() {},
        localStorage: {
            store: Object.create(null),
            getItem() { return null; },
            setItem() {},
            removeItem() {}
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
    sandbox.globalThis = sandbox;
    sandbox.OpenSeadragon = sandbox.window.OpenSeadragon;
    vm.runInNewContext(`${adapterSource}\nthis.AnnotationAdapter = AnnotationAdapter;`, sandbox);
    return { Adapter: sandbox.AnnotationAdapter, host: fake.host, trackers };
})();

const OA = overlaySandbox.Adapter;
const hostEl = overlaySandbox.host;
const fakeViewer = {
    element: hostEl,
    container: hostEl,
    setMouseNavEnabled() {},
    viewport: {
        viewerElementToViewportCoordinates(pos) { return { x: pos.x / 100, y: pos.y / 100 }; },
        viewportToImageCoordinates(vp) { return { x: vp.x * 10, y: vp.y * 10 }; }
    },
    world: {
        getItemCount() { return 1; },
        getItemAt() {
            return {
                viewportToImageCoordinates(vp) { return { x: vp.x * 10, y: vp.y * 10 }; }
            };
        }
    }
};
OA.setImageMetadata({ micronsPerPixelX: 0.5, micronsPerPixelY: 0.5 });
OA.setViewer(fakeViewer);
OA.setMeasurementModeActive(true);

let completed = null;
const tracker = OA.bindMeasureMouseTracker(fakeViewer, {
    onMeasurementComplete(microns, snapshot) { completed = { microns, snapshot }; }
});
assert.ok(tracker);
assert.equal(typeof tracker.opts.pressHandler, "function");
assert.equal(typeof tracker.opts.dragHandler, "function");
assert.equal(typeof tracker.opts.releaseHandler, "function");

const svg = OA.ensureMeasureOverlay(hostEl);
assert.ok(svg);
assert.equal(svg.style.display, "none");

// press arms, no draw
tracker.opts.pressHandler({
    position: { x: 10, y: 20 },
    preventDefaultAction: false,
    originalEvent: { preventDefault() {} }
});
assert.equal(OA.isDragging, true);
assert.equal(OA.measureStartX, 10);
assert.equal(svg.style.display, "none");

// drag draws
tracker.opts.dragHandler({
    position: { x: 110, y: 80 },
    preventDefaultAction: false,
    originalEvent: { preventDefault() {} }
});
assert.equal(svg.style.display, "block");
const stroke = svg.querySelector('[data-measure="stroke"]');
assert.equal(stroke.getAttribute("stroke"), "#FFEA00");

tracker.opts.releaseHandler({
    position: { x: 110, y: 80 },
    preventDefaultAction: false
});
assert.equal(OA.isDragging, false);
assert.ok(completed);
assert.ok(completed.microns > 0);
assert.equal(OA.lastMeasuredMicrons, completed.microns);
assert.ok(completed.snapshot?.entry);
assert.equal(OA.measurementSessionList.length, 1);
assert.match(completed.snapshot.entry.label, /^Measurement 1 /);

OA.clearMeasureVector({ remove: true });
assert.equal(OA.measureOverlayEl, null);

const saved = AnnotationAdapter.saveMeasurementToSession({
    lengthMicrons: microns,
    label: "Core Diameter",
    imageId: "demo"
});
assert.equal(saved.label, "Core Diameter");
assert.equal(AnnotationAdapter.measurementSessionList.length, 1);

console.log("micron-measure.test.js: ok");
