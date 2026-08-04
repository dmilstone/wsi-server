"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const adapter = require("../../main/resources/static/fabric-spike-adapter.js");
const {coordinates} = require("../../main/resources/static/fabric-osd-overlay.js");
const staticDir = path.join(__dirname, "../../main/resources/static");
const html = fs.readFileSync(path.join(staticDir, "fabric-spike.html"), "utf8");
const app = fs.readFileSync(path.join(staticDir, "fabric-spike.js"), "utf8");
const overlay = fs.readFileSync(path.join(staticDir, "fabric-osd-overlay.js"), "utf8");

// Exact dependency declarations and isolation boundary.
assert.match(html, /openseadragon\/4\.1\.0\/openseadragon\.min\.js/);
assert.match(html, /fabric\.js\/5\.3\.0\/fabric\.min\.js/);
assert.match(html, /fabric-osd-overlay\.js" data-overlay-version="1\.0\.0"/);
assert.match(html, /FABRIC ANNOTATION SPIKE — NOT PERSISTED/);
assert.doesNotMatch(html, /annotorious|annotation-store|annotation-adapter\.js/i);
assert.doesNotMatch(app, /AnnotationStore|WsiCsrf|\/annotations/i);
assert.doesNotMatch(app, /method\s*:\s*["'](?:PUT|POST|PATCH|DELETE)/i);
assert.deepEqual([...app.matchAll(/fetch\(([^\n]+)/g)].map(match => match[1]).length, 2,
    "only image discovery and metadata use fetch");

// Full-resolution image coordinates round-trip through an arbitrary viewport scale/offset.
const viewer = {viewport: {
    imageToViewerElementCoordinates: point => ({x: point.x * 2 + 7, y: point.y * 2 + 11}),
    viewerElementToImageCoordinates: point => ({x: (point.x - 7) / 2, y: (point.y - 11) / 2})
}};
const canonical = {x: 100, y: 250, width: 60, height: 80};
const canvasBox = coordinates.imageRectToCanvas(viewer, canonical);
assert.deepEqual(canvasBox, {left: 207, top: 511, width: 120, height: 160});
assert.deepEqual(coordinates.canvasRectToImage(viewer, {...canvasBox, scaleX: 1, scaleY: 1}), canonical);
canvasBox.left += 20; canvasBox.top += 40;
assert.deepEqual(coordinates.canvasRectToImage(viewer, {...canvasBox, scaleX: 1, scaleY: 1}),
    {x: 110, y: 270, width: 60, height: 80});
assert.match(overlay, /\["animation", "resize", "open", "full-screen"\]/,
    "pan/zoom/resize/fullscreen causes canonical reprojection");

// Existing application representation and unknown metadata survive a lossless in-memory cycle.
const stored = {id: "a-1", name: null, bodies: [{purpose: "tagging", value: "keep"}],
    created: "2024-01-01", updated: "2024-01-02", visible: false,
    locking: {owner: "someone", reason: "review"}, unknownTopLevel: {future: [1, 2]},
    target: {source: "opaque", selector: {type: "RECTANGLE", unknownSelector: true,
        geometry: {x: 3, y: 4, w: 10, h: 12, bounds: {minX: 3, minY: 4, maxX: 13, maxY: 16}}}}};
const record = adapter.fromApplication(stored);
assert.deepEqual(record.geometry, {x: 3, y: 4, width: 10, height: 12});
const restored = adapter.toApplication(record);
assert.equal(restored.id, "a-1"); assert.equal(restored.name, null); assert.equal(restored.visible, false);
assert.deepEqual(restored.bodies, stored.bodies); assert.deepEqual(restored.locking, stored.locking);
assert.deepEqual(restored.unknownTopLevel, stored.unknownTopLevel);
assert.equal(restored.target.selector.unknownSelector, true);

// Import replaces each image's collection by ID: re-import never duplicates.
const collection = new Map([["image-one", [record]]]);
const json = adapter.exportCollection(collection);
const destination = new Map([["image-one", [record, record]]]);
adapter.importCollection(json, destination); adapter.importCollection(json, destination);
assert.equal(destination.get("image-one").length, 1);
assert.deepEqual(adapter.toApplication(destination.get("image-one")[0]), restored);

// Lifecycle wiring: movement updates record+label continuously; release alone commits once.
assert.match(overlay, /\["object:moving", "object:scaling"\]/);
assert.match(app, /continuous\(event, object\)[\s\S]*record\.geometry[\s\S]*positionLabel/);
assert.match(app, /modified\(object\)[\s\S]*count\("object:modified"\)[\s\S]*count\("logical:commit"\)/);
assert.equal((app.match(/modified: object => this\.modified\(object\)/g) || []).length, 1);
assert.match(app, /selection:created/); assert.match(app, /selection:updated/); assert.match(app, /selection:cleared/);
assert.match(app, /currentRecords\(\)\.push/); assert.match(app, /records\.splice/);
assert.match(app, /annotation-name[\s\S]*addEventListener\("change"/);
assert.match(app, /geometry-visible/); assert.match(app, /names-visible/);
assert.match(app, /generation !== this\.generation/,
    "stale metadata and open callbacks are generation guarded on rapid switches");
assert.match(overlay, /destroy\(\)[\s\S]*removeHandler[\s\S]*canvas\.dispose/,
    "overlay removes OSD/Fabric listeners and disposes its canvas");
console.log("fabric spike isolation, coordinate, serialization, and lifecycle checks passed");
