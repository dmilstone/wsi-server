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

assert.match(html, /id="classify-menu-button"/);
assert.match(html, /id="classify-menu"/);
assert.match(html, /aria-label="Classify"/);
assert.match(html, />Object classification </);
assert.match(html, />Pixel classification </);
assert.match(html, />Training images </);
assert.match(html, /Reset detection classifications/);
assert.match(html, /Load object classifier\.\.\./);
assert.match(html, /Train object classifier\.\.\./);
assert.match(html, /Create single measurement classifier\.\.\./);
assert.match(html, /Create composite classifier\.\.\./);
assert.match(html, /Set cell intensity classifications\.\.\./);
assert.match(html, /Load pixel classifier\.\.\./);
assert.match(html, /Train pixel classifier\.\.\./);
assert.match(html, /Create thresholder\.\.\./);
assert.match(html, /Create region annotations\.\.\./);
assert.match(html, /Create training image\.\.\./);
assert.match(html, /Create duplicate channel training images\.\.\./);
assert.match(html, /Split project train\/validation\/test\.\.\./);
assert.match(html, /id="classify-dialog"/);
assert.match(html, /id="annotation-context-menu-set-class"/);
assert.match(html, /Ctrl\+Shift\+D/);
assert.match(html, /Ctrl\+Shift\+P/);
assert.match(html, /annotation-adapter\.js\?v=20260911-ai-hierarchy/);
assert.match(html, /#classify-menu \.multiview-submenu \{\s*position:\s*static/);
assert.match(adapterSource, /static layoutClassifyMenu\(/);

assert.match(adapterSource, /static runClassifyCommand\(/);
assert.match(adapterSource, /static trainNearestCentroid\(/);
assert.match(adapterSource, /static applyObjectClassifierModel\(/);
assert.match(adapterSource, /static applyPixelClassifierModel\(/);
assert.match(adapterSource, /static isClassifyObjectShortcut\(/);
assert.match(adapterSource, /static isClassifyPixelShortcut\(/);

assert.equal(AnnotationAdapter.isClassifyObjectShortcut({ key: "d", shiftKey: true, ctrlKey: true }), true);
assert.equal(AnnotationAdapter.isClassifyPixelShortcut({ key: "p", shiftKey: true, metaKey: true }), true);
assert.equal(AnnotationAdapter.isClassifyObjectShortcut({ key: "d" }), false);

const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 }
];
const geom = AnnotationAdapter.polygonAreaPerimeter(square);
assert.equal(geom.area, 100);
assert.equal(geom.perimeter, 40);
assert.equal(AnnotationAdapter.pointInRing(5, 5, square), true);
assert.equal(AnnotationAdapter.pointInRing(20, 5, square), false);

const small = { imageCoordinates: [[0, 0], [6, 0], [6, 6], [0, 6]], pathClass: "Tumor" };
const large = { imageCoordinates: [[0, 0], [30, 0], [30, 30], [0, 30]], pathClass: "Stroma" };
const unlabeledSmall = { imageCoordinates: [[1, 1], [7, 1], [7, 7], [1, 7]] };
const unlabeledLarge = { imageCoordinates: [[2, 2], [28, 2], [28, 28], [2, 28]] };
AnnotationAdapter.replaceLocalizedCellObjects([small, large, unlabeledSmall, unlabeledLarge]);

const samples = AnnotationAdapter.collectObjectTrainingSamples();
assert.equal(samples.length >= 2, true);
const trained = AnnotationAdapter.trainNearestCentroid(samples, AnnotationAdapter.CLASSIFY_OBJECT_FEATURE_KEYS);
assert.ok(trained.centroids.length >= 2);
AnnotationAdapter.classify.lastObjectModel = trained;
const applied = AnnotationAdapter.applyObjectClassifierModel(trained);
assert.ok(applied >= 2);
assert.ok(["Tumor", "Stroma"].includes(unlabeledSmall.pathClass));
assert.ok(["Tumor", "Stroma"].includes(unlabeledLarge.pathClass));

const saved = AnnotationAdapter.saveClassifier("object", "demo-object", trained);
assert.equal(saved.name, "demo-object");
assert.equal(AnnotationAdapter.loadClassifier("object", "demo-object").name, "demo-object");

AnnotationAdapter.resetDetectionClassifications();
assert.equal(unlabeledSmall.pathClass, null);

AnnotationAdapter.replaceLocalizedCellObjects([
    { imageCoordinates: [[0, 0], [4, 0], [4, 4], [0, 4]] },
    { imageCoordinates: [[0, 0], [40, 0], [40, 40], [0, 40]] }
]);
AnnotationAdapter.applySingleMeasurementClassifier({
    feature: "area",
    threshold: 50,
    above: "Tumor",
    below: "Stroma",
    saveAs: "area-split"
});
assert.equal(AnnotationAdapter.listDetections()[0].pathClass, "Stroma");
assert.equal(AnnotationAdapter.listDetections()[1].pathClass, "Tumor");

AnnotationAdapter.listDetections()[1].pathClass = "Tumor";
AnnotationAdapter.applyCellIntensityClassifications({ feature: "area", t1: 10, t2: 100, t3: 1000 });
assert.match(AnnotationAdapter.listDetections()[1].pathClass, /Tumor: /);

AnnotationAdapter.savedAnnotationsArray = [
    { id: "a1", x: 0, y: 0, width: 10, height: 10, pathClass: "Tumor" },
    { id: "a2", x: 0, y: 0, width: 80, height: 80, pathClass: "Stroma" },
    { id: "a3", x: 0, y: 0, width: 12, height: 12 }
];
const pixelSamples = AnnotationAdapter.collectPixelTrainingSamples();
assert.equal(pixelSamples.length, 2);
const pixelModel = AnnotationAdapter.trainNearestCentroid(
    pixelSamples,
    AnnotationAdapter.CLASSIFY_PIXEL_FEATURE_KEYS
);
AnnotationAdapter.applyPixelClassifierModel(pixelModel);
assert.ok(AnnotationAdapter.savedAnnotationsArray[2].pathClass);

AnnotationAdapter.selectedNativeAnnotationIds = new Set(["a1"]);
AnnotationAdapter.applyThresholder({
    feature: "mean0",
    threshold: 1,
    above: "Tumor",
    below: "Ignore*",
    saveAs: "thresh"
});
assert.equal(AnnotationAdapter.annotationPathClass(AnnotationAdapter.savedAnnotationsArray[0]), "Tumor");

const split = AnnotationAdapter.splitProjectTrainValidationTest(
    ["i1", "i2", "i3", "i4", "i5", "i6", "i7", "i8", "i9", "i10"]
);
assert.equal(split.train.length + split.validation.length + split.test.length, 10);

const training = AnnotationAdapter.createTrainingImageRecord("pack");
assert.equal(training.name, "pack");
assert.ok(training.regions.length >= 2);

assert.equal(AnnotationAdapter.classifyIsIgnored("Ignore*"), true);
assert.equal(AnnotationAdapter.classifyClassColor("Tumor"), "#e6194b");

console.log("classify.test.js: ok");
