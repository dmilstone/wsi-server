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
AnnotationAdapter.setCurrentZ(4);
assert.equal(AnnotationAdapter.currentZ, 4);

assert.equal(
    AnnotationAdapter.appendTileDepthQuery("/tile/img/composite/1/0/0.png?revision=3"),
    "/tile/img/composite/1/0/0.png?revision=3&z=4"
);
assert.equal(
    AnnotationAdapter.appendTileDepthQuery("/tile/img/composite/1/0/0.png"),
    "/tile/img/composite/1/0/0.png?z=4"
);
assert.equal(
    AnnotationAdapter.appendTileDepthQuery("/tile/img/composite/1/0/0.png?revision=3&z=9"),
    "/tile/img/composite/1/0/0.png?revision=3&z=4"
);
assert.equal(
    AnnotationAdapter.appendTileDepthQuery("/api/images/abc/annotations"),
    "/api/images/abc/annotations"
);

assert.match(html, /let currentZ = 0/);
assert.match(html, /syncZStackControl\(metadata\)/);
assert.match(html, /zStackControl\.hidden = true/);
assert.match(html, /planes <= 1/);
assert.match(html, /flushViewerTileCache\(/);
assert.match(html, /viewer\.tileCache\.clearCache/);
assert.match(html, /onZStackSliderInput/);
assert.match(html, /openViewer\(true\)/);

console.log("z-stack-viewer.test.js: ok");
