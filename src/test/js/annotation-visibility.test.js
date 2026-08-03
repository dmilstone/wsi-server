const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
    path.join(__dirname, "../../main/resources/static/annotorious-spike.js"),
    "utf8"
);
const context = vm.createContext({ console });
vm.runInContext(`${source}\nthis.AnnotoriousSpike = AnnotoriousSpike;`, context);

function button() {
    return {
        disabled: false,
        attributes: new Map(),
        setAttribute(name, value) { this.attributes.set(name, value); }
    };
}

const classes = new Set();
const spike = Object.create(context.AnnotoriousSpike.prototype);
spike.annotationsVisible = true;
spike.drawingEnabled = true;
spike.viewer = {
    element: {
        classList: {
            toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); }
        }
    }
};
spike.toggleButton = button();
spike.visibilityButton = button();
spike.annotator = {
    drawingCalls: [],
    setDrawingEnabled(enabled) { this.drawingCalls.push(enabled); }
};
spike.notifySelectionChanged = () => {};

spike.setAnnotationsVisible(false);
assert.equal(spike.annotationsVisible, false);
assert(classes.has("annotations-hidden"));
assert.equal(spike.toggleButton.disabled, true);
assert.equal(spike.visibilityButton.textContent, "Show annotations");
assert.equal(spike.visibilityButton.attributes.get("aria-pressed"), "true");
assert.deepEqual(spike.annotator.drawingCalls, [false]);

spike.setAnnotationsVisible(true);
assert.equal(spike.annotationsVisible, true);
assert(!classes.has("annotations-hidden"));
assert.equal(spike.toggleButton.disabled, false);
assert.equal(spike.visibilityButton.textContent, "Hide annotations");
assert.equal(spike.visibilityButton.attributes.get("aria-pressed"), "false");
// Visibility changes never call annotation create/update/delete or store APIs;
// only Annotorious drawing interaction is disabled while the overlay is hidden.
assert.deepEqual(Object.keys(spike.annotator).sort(), ["drawingCalls", "setDrawingEnabled"]);

console.log("annotation visibility checks passed");
