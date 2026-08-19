"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const staticRoot = path.join(__dirname, "../../main/resources/static");
const adapterSource = fs.readFileSync(path.join(staticRoot, "annotation-adapter.js"), "utf8");
const html = fs.readFileSync(path.join(staticRoot, "index.html"), "utf8");
const legacySource = fs.readFileSync(path.join(staticRoot, "modules/legacy-right-panel.js"), "utf8");
assert.match(legacySource, /const LegacyRightPanelLayout/);
assert.match(legacySource, /id="channels-panel"/);

assert.match(html, /id="floating-channel-palette"/);
assert.match(html, /id="floating-channel-palette-handle"/);
assert.match(html, /id="floating-channel-palette-close"/);
assert.match(html, /id="floating-channel-histogram"/);
assert.match(html, /id="fcp-min"/);
assert.match(html, /id="fcp-max"/);
assert.match(html, /id="fcp-gamma"/);
assert.match(html, /id="fcp-auto"/);
assert.match(html, /id="fcp-reset"/);
assert.match(html, /id="show-advanced-channel-palette"/);
assert.match(html, /Show Advanced Channel Palette/);
assert.match(html, /Brightness &amp; Contrast/);
assert.match(html, /max="58831"/);
assert.match(html, /58,831/);
assert.match(html, /Channel min/);
assert.match(html, /Channel max/);
assert.match(html, /Viewer gamma/);
assert.match(html, /id="toggle-ai-labs-palette"/);
assert.match(html, /🔬 AI Labs/);
assert.match(html, /toolbar-right-group/);
assert.match(html, /toolbar-docs-row/);
assert.match(html, /toolbar-ops-row/);
assert.match(html, /width:\s*calc\(100% - var\(--sidebar-width, 320px\)\)/);
assert.match(html, />◐</);
assert.match(html, /Admin and Ops Guide/);
assert.match(html, />Admin</);
assert.match(html, />Feedback</);
assert.match(html, />Local Operations</);
assert.match(html, /id="floating-zstack-palette"/);
assert.match(html, /id="floating-zstack-handle"/);
assert.match(html, />Reset</);
assert.match(html, />Auto</);
assert.doesNotMatch(html, /id="channels-panel"/);
assert.doesNotMatch(html, /id="reset-viewport-home-btn"/);
assert.doesNotMatch(html, /id="zoom-in"/);
assert.doesNotMatch(html, /id="zoom-out"/);
assert.match(html, /id="case-filter-select"/);
assert.match(html, /Show\/Hide Image Browser/);
assert.match(html, />📂</);
assert.match(html, /id="sidebar-header-controls"/);
assert.doesNotMatch(html, /sidebar-top-controls/);
assert.doesNotMatch(html, /toolbar-case-cluster/);
assert.match(html, /ops-display-group/);
assert.match(html, /toolbar-ops-spacer/);
assert.match(html, /id="image-info"/);
assert.match(html, /id="floating-zstack-minimize"/);
assert.match(html, /\.zstack-minimized/);
assert.match(adapterSource, /static toggleFloatingZStackMinimized\(/);
assert.match(adapterSource, /zstack-minimized/);
assert.match(adapterSource, /static ensureMeasurementPopupOverlay\(/);
assert.match(adapterSource, /static updateMeasurementPopup\(/);
assert.match(adapterSource, /static hideMeasurementPopup\(/);
assert.match(adapterSource, /measurement-popup-overlay/);
assert.match(adapterSource, /rgba\(0, 0, 0, 0\.9\)/);
assert.match(adapterSource, /#00FF00/);
assert.match(adapterSource, /zIndex = "10002"/);
assert.match(adapterSource, /clientX \+ 15/);
assert.match(adapterSource, /clientY \+ 15/);
assert.match(adapterSource, /static showAnnotationEditorForShape\(/);
assert.match(adapterSource, /static hideAnnotationEditorPopup\(/);
assert.match(adapterSource, /static bindAnnotationShapeEditorLoop\(/);
assert.match(html, /id="annotation-editor-popup"/);
assert.match(html, /id="annotation-name-input"/);
assert.match(html, /placeholder="Enter annotation name\.\.\."/);
assert.match(html, /id="annotation-editor-save"/);
assert.match(html, /id="measurement-popup-overlay"/);
assert.match(html, /z-index:\s*10002/);
assert.match(html, /z-index:\s*10001/);

assert.match(adapterSource, /static bindAdvancedChannelPalette\(/);
assert.match(adapterSource, /static openFloatingChannelPalette\(/);
assert.match(adapterSource, /static closeFloatingChannelPalette\(/);
assert.match(adapterSource, /static applyChannelPaletteVisibility\(/);
assert.match(adapterSource, /static applyViewportTileContrastFilter\(/);
assert.match(adapterSource, /document\.body\.appendChild\(palette\)/);
assert.match(adapterSource, /position = "fixed"/);
assert.match(adapterSource, /zIndex = "9999"/);
assert.match(adapterSource, /setProperty\("resize", "both"/);
assert.match(adapterSource, /viewer\.world\.getItemAt/);
assert.match(adapterSource, /item\.setOpacity/);
assert.match(adapterSource, /CHANNEL_LEVEL_MAX = 58831/);
assert.match(adapterSource, /parentNode\.removeChild\(palette\)/);
assert.match(adapterSource, /static bindFloatingAiLabsPalette\(/);
assert.match(adapterSource, /static bindFloatingZStackPalette\(/);
assert.match(adapterSource, /static setFloatingZStackPaletteVisible\(/);
assert.match(adapterSource, /id="floating-zstack-palette"|floating-zstack-palette/);

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

assert.equal(AnnotationAdapter.CHANNEL_LEVEL_MAX, 58831);
assert.equal(AnnotationAdapter.placeholderPaletteChannels().length, 3);
assert.equal(AnnotationAdapter.placeholderPaletteChannels()[0].lut, "CYAN");
assert.equal(AnnotationAdapter.placeholderPaletteChannels()[1].lut, "GREEN");
assert.equal(AnnotationAdapter.placeholderPaletteChannels()[2].lut, "RED");

{
    const item = {
        opacity: 1,
        options: { channelIndex: 0, channelName: "Cyan" },
        setOpacity(value) { this.opacity = value; },
        setPreload() {}
    };
    const viewer = {
        world: {
            getItemCount() { return 1; },
            getItemAt() { return item; }
        },
        forceRedraw() {}
    };
    AnnotationAdapter.applyChannelLayerOpacities(viewer, [
        { index: 0, name: "Cyan", visible: false, opacity: 1 }
    ], 0);
    assert.equal(item.opacity, 0);
}

{
    const canvas = { style: { filter: "" } };
    const applied = AnnotationAdapter.applyViewportTileContrastFilter(
        { drawer: { canvas } },
        1000,
        20000,
        1.25
    );
    assert.equal(applied, true);
    assert.match(canvas.style.filter, /contrast\(/);
    assert.match(canvas.style.filter, /brightness\(/);
    AnnotationAdapter.clearViewportTileContrastFilter({ drawer: { canvas } });
    assert.equal(canvas.style.filter, "");
}

{
    const block = {
        width: 2,
        height: 2,
        channels: 1,
        values: [0, 29415, 58831, 1000]
    };
    const bins = AnnotationAdapter.histogramBinsFromPixelBlock(block, 0, 8);
    assert.equal(bins.length, 8);
    assert.ok(bins.some(count => count > 0));
}

console.log("floating-channel-palette.test.js: ok");
