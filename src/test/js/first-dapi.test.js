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

assert.match(html, /id="first-dapi-checkbox"/);
assert.match(html, /class="first-dapi-toggle"/);
assert.match(
    html,
    /id="first-dapi-checkbox"[\s\S]{0,400}1st DAPI[\s\S]{0,800}<button id="classify-menu-button"/
);
assert.doesNotMatch(html, /id="classify-menu-button"[\s\S]{0,200}id="first-dapi-checkbox"/);
assert.match(html, /<label class="first-dapi-toggle"[\s\S]*?>[\s\S]*?1st DAPI\s*<\/label>/);
assert.match(html, /id="first-dapi-checkbox"[^>]*class="floating-channel-cb"/);
assert.doesNotMatch(html, /id="first-dapi-checkbox"[^>]*\schecked/);
assert.match(html, /\.floating-channel-cb:checked::after[\s\S]*?content:\s*"\\00d7"/);
assert.doesNotMatch(html, /\.floating-channel-cb:not\(:checked\)::after/);
assert.match(html, /\.first-dapi-toggle(?:\s*,\s*\.auto-clip-toggle)?\s*\{/);

assert.match(adapterSource, /static scheduleFirstDapiInitialization\(/);
assert.match(adapterSource, /static bindFirstDapiToggle\(/);
assert.match(adapterSource, /static applyFirstDapiChannelDefault\(/);
assert.match(adapterSource, /requestAnimationFrame\(\(\) => \{/);
assert.match(adapterSource, /setTimeout\(run, 50\)/);
assert.match(adapterSource, /setTimeout\(run, 200\)/);
assert.match(adapterSource, /scheduleFirstDapiInitialization\(doc\)/);
assert.match(adapterSource, /if \(!options\.preserveViewport && viewChannels\.length\)/);
assert.match(adapterSource, /AnnotationAdapter\.applyFirstDapiChannelDefault\(viewChannels\)/);

assert.equal(AnnotationAdapter.bindFirstDapiToggle(null), false);
assert.equal(AnnotationAdapter.applyFirstDapiChannelDefault(null).length, 0);
assert.equal(AnnotationAdapter.applyFirstDapiChannelDefault(undefined).length, 0);
assert.equal(AnnotationAdapter.isDapiViewingChannel(null), false);
assert.equal(AnnotationAdapter.isDapiViewingChannel({ name: "FITC" }), false);
assert.equal(AnnotationAdapter.isDapiViewingChannel({ name: "Cyan (DAPI)" }), true);
assert.equal(AnnotationAdapter.isFirstDapiEnabled(), false);

{
    AnnotationAdapter.firstDapiEnabled = false;
    const channels = [
        { name: "DAPI", index: 0, visible: true },
        { name: "FITC", index: 1, visible: true },
        { name: "Cyan (DAPI)", index: 2, visible: true },
        null,
        "DAPI"
    ];
    AnnotationAdapter.applyFirstDapiChannelDefault(channels);
    assert.equal(channels[0].visible, false);
    assert.equal(channels[1].visible, true);
    assert.equal(channels[2].visible, false);
    assert.equal(channels[4], "DAPI");
}

{
    AnnotationAdapter.firstDapiEnabled = true;
    const channels = [
        { name: "DAPI", index: 0, visible: false },
        { name: "TRITC", index: 2, visible: true }
    ];
    AnnotationAdapter.applyFirstDapiChannelDefault(channels);
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
        getElementById(id) { return id === "first-dapi-checkbox" ? box : null; }
    };
    AnnotationAdapter.firstDapiEnabled = true;
    assert.equal(AnnotationAdapter.bindFirstDapiToggle(doc), true);
    assert.equal(AnnotationAdapter.firstDapiEnabled, false);
    assert.equal(box.dataset.firstDapiBound, "1");
    assert.equal(listeners.length, 1);
    assert.equal(listeners[0].type, "change");
    assert.equal(AnnotationAdapter.bindFirstDapiToggle(doc), true);

    const channels = [
        { name: "DAPI", index: 0, visible: false },
        { name: "FITC", index: 1, visible: true }
    ];
    AnnotationAdapter.setDisplayController({
        getDisplay: () => ({ channels }),
        getViewer: () => null,
        getCurrentZ: () => 0,
        syncChannelControls() {}
    });
    box.checked = true;
    listeners[0].handler();
    assert.equal(AnnotationAdapter.firstDapiEnabled, true);
    assert.equal(channels[0].visible, true);
    assert.equal(channels[1].visible, true);
    box.checked = false;
    listeners[0].handler();
    assert.equal(channels[0].visible, false);
    assert.equal(channels[1].visible, true);
    AnnotationAdapter.setDisplayController(null);
}

{
    function fakeWorld(items) {
        return {
            getItemCount() { return items.length; },
            getItemAt(index) { return items[index]; }
        };
    }
    const opened = [];
    const viewer = {
        open(source) { opened.push(source); },
        addOnceHandler() {},
        world: fakeWorld([])
    };
    AnnotationAdapter.firstDapiEnabled = false;
    const channels = [
        { name: "DAPI", index: 0, visible: true },
        { name: "FITC", index: 1, visible: true }
    ];
    const ok = AnnotationAdapter.openMultiPlaneZStack(viewer, {
        planeCount: 1,
        activeZ: 0,
        channels,
        tileSourceForPlane: (z, channel) => ({ plane: z, channel: channel.name })
    });
    assert.equal(ok, true);
    assert.equal(channels[0].visible, false);
    assert.equal(channels[1].visible, true);
    assert.equal(opened[0].find(spec => spec.channelName === "DAPI").opacity, 0);
    assert.equal(opened[0].find(spec => spec.channelName === "FITC").opacity, 1);

    channels[0].visible = true;
    AnnotationAdapter.openMultiPlaneZStack(viewer, {
        planeCount: 1,
        activeZ: 0,
        channels,
        preserveViewport: { bounds: { x: 0, y: 0 }, zoom: 1 },
        tileSourceForPlane: (z, channel) => ({ plane: z, channel: channel.name })
    });
    assert.equal(channels[0].visible, true);
}

{
    AnnotationAdapter.firstDapiInitScheduled = false;
    AnnotationAdapter.firstDapiEnabled = false;
    assert.equal(AnnotationAdapter.scheduleFirstDapiInitialization(null), true);
    assert.equal(AnnotationAdapter.firstDapiInitScheduled, true);
    assert.equal(AnnotationAdapter.scheduleFirstDapiInitialization(null), true);
}

AnnotationAdapter.firstDapiEnabled = false;
AnnotationAdapter.setDisplayController(null);

console.log("first-dapi.test.js: ok");
