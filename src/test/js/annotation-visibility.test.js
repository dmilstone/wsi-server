const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const staticRoot = path.join(__dirname, "../../main/resources/static");
const adapterSource = fs.readFileSync(path.join(staticRoot, "annotation-adapter.js"), "utf8");
const storeSource = fs.readFileSync(path.join(staticRoot, "annotation-store.js"), "utf8");

const context = vm.createContext({
    console: { info() {}, warn() {}, error() {} },
    window: { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} },
    document: { getElementById() { return null; }, querySelectorAll() { return []; }, addEventListener() {} },
    fetch: null,
    WsiCsrf: { csrfFetch: async () => { throw new Error("unexpected save"); } }
});
vm.runInContext(`${storeSource}\nthis.AnnotationStore = AnnotationStore;`, context);
vm.runInContext(`${adapterSource}\nthis.AnnotationAdapter = AnnotationAdapter; this.NativeOsdAnnotationEngine = NativeOsdAnnotationEngine;`, context);

function button() {
    return {
        disabled: false,
        attributes: new Map(),
        setAttribute(name, value) { this.attributes.set(name, value); }
    };
}

const classes = new Set();
const engine = new context.NativeOsdAnnotationEngine({
    viewer: {
        element: {
            classList: {
                toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); }
            }
        }
    },
    toggleButton: button(),
    visibilityButton: button(),
    annotator: { getAnnotations() { return []; } }
});

engine.setAnnotationsVisible(false);
assert.equal(engine.annotationsVisible, false);
assert(classes.has("annotations-hidden"));
assert.equal(engine.toggleButton.disabled, true);
assert.equal(engine.visibilityButton.textContent, "Annotations");
assert.equal(engine.visibilityButton.attributes.get("aria-pressed"), "false");
assert.equal(engine.visibilityButton.attributes.get("aria-label"), "Show annotations");

engine.setAnnotationsVisible(true);
assert.equal(engine.annotationsVisible, true);
assert(!classes.has("annotations-hidden"));
assert.equal(engine.toggleButton.disabled, false);
assert.equal(engine.visibilityButton.attributes.get("aria-pressed"), "true");
assert.equal(engine.visibilityButton.attributes.get("aria-label"), "Hide annotations");

assert.match(adapterSource, /\.osd-annotation-shape/);
assert.match(adapterSource, /svgOverlay\(\)/);
assert.doesNotMatch(adapterSource, /createOSDAnnotator/);

console.log("annotation visibility checks passed");
