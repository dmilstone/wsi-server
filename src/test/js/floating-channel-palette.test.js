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
assert.match(html, /class="bc-channels-grid"/);
assert.match(html, /grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(100px,\s*1fr\)\)/);
assert.match(html, /overflow-y:\s*auto\s*!important/);
assert.match(html, /class="fcp-layout-bar"/);
assert.match(html, /id="fcp-layout-select"/);
assert.match(html, /Column List/);
assert.match(html, /id="fcp-list-splitter"/);
assert.match(html, /data-fcp-layout="1"/);
assert.match(html, /🎛️ Brightness/);
assert.match(adapterSource, /static formatChannelPaletteLabel\(/);
assert.match(adapterSource, /static applyChannelPaletteLayout\(/);
assert.match(adapterSource, /static bindChannelListSplitter\(/);
assert.match(html, /\.floating-channel-cb\s*\{/);
assert.match(html, /border:\s*2px solid #fff\s*!important/);
assert.match(html, /\.floating-channel-cb:checked/);
assert.match(html, /background-color:\s*#00FF00\s*!important/);
assert.match(html, /#floating-channel-palette\s*\{[\s\S]*?min-width:\s*340px/);
assert.match(html, /#floating-channel-palette\s*\{[\s\S]*?min-height:\s*400px/);
assert.match(html, /#floating-channel-palette\s*\{[\s\S]*?resize:\s*both\s*!important/);
assert.match(html, /class="fcp-edge-handle"/);
assert.match(html, /data-edge="n"/);
assert.match(html, /data-edge="se"/);
assert.match(adapterSource, /static bindFloatingPaletteEdgeResize\(/);
assert.match(adapterSource, /class="floating-channel-cb"/);
assert.match(adapterSource, /bc-channel-cell/);
assert.match(adapterSource, /minWidth: "340px"/);
assert.match(adapterSource, /minHeight: "400px"/);
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
assert.match(html, /width:\s*100%/);
assert.match(html, />◐</);
assert.doesNotMatch(html, />Dashboard</);
assert.doesNotMatch(html, />User Guide</);
assert.doesNotMatch(html, />Viewer Quick Guide</);
assert.doesNotMatch(html, />Admin and Ops Guide</);
assert.doesNotMatch(html, />Local Operations</);
assert.doesNotMatch(html, /❓ Help/);
assert.doesNotMatch(html, /💬 Feedback/);
assert.match(html, /id="help-directory-link"[^>]*>\?</);
assert.match(html, />Feedback</);
assert.match(html, />Reset<\/button>[\s\S]*?>Auto<\/button>[\s\S]*?>🔬 AI Labs<\/button>[\s\S]*?>\?<\/button>[\s\S]*?>🛠️ Tools<\/button>[\s\S]*?>Feedback</);
assert.match(html, /id="toggle-secondary-annotation-toolbar"/);
assert.match(html, /id="secondary-annotation-toolbar"/);
assert.match(html, /id="ij-tool-1"/);
assert.match(html, /id="ij-tool-20"/);
assert.match(html, /title="Pending\.\.\."/);
assert.match(html, /title="Ruler — Click and drag to measure length in microns"/);
assert.match(adapterSource, /static bindSecondaryAnnotationToolbar\(/);
assert.match(adapterSource, /static toggleSecondaryAnnotationToolbar\(/);
assert.match(adapterSource, /static activateImageJTool\(/);
assert.match(adapterSource, /console\.info\("Pending\.\.\."/);
assert.match(adapterSource, /style\.display = "flex"/);
assert.match(html, /id="help-directory-link"/);
assert.match(html, /window\.open\("\/help\/help-directory\.html", "_blank"\)/);
assert.match(html, /id="floating-zstack-palette"/);
assert.match(html, /id="floating-zstack-handle"/);
assert.match(html, />Reset</);
assert.match(html, />Auto</);
assert.match(html, /id="floating-measurement-palette"/);
assert.match(html, /id="floating-measurement-handle"/);
assert.match(html, /id="floating-measurement-close"/);
assert.match(html, /z-index: 9998/);
assert.doesNotMatch(html, /id="measurement-results-box"/);
assert.match(html, /id="measurement-results-table"/);
assert.match(html, /id="measurement-results-body"/);
assert.match(html, /Saved Measurements/);
assert.match(html, /📐 Saved Measurements/);
assert.match(html, /id="measurement-copy-btn"/);
assert.match(html, /id="measurement-save-btn"/);
assert.match(html, /id="measurement-export-format"/);
assert.match(html, />📋 Copy</);
assert.match(html, />💾 Save</);
assert.match(html, /user-select:\s*text\s*!important/);
assert.match(html, /-webkit-user-select:\s*text\s*!important/);
assert.match(adapterSource, /static appendMeasurementResultRow\(/);
assert.match(html, /copy-row-btn/);
assert.match(adapterSource, /navigator\.clipboard\.writeText/);
assert.match(adapterSource, /✓ Copied/);
assert.match(adapterSource, /📋 Copy/);
assert.match(adapterSource, /static copyMeasurementResults\(/);
assert.match(adapterSource, /static saveMeasurementResults\(/);
assert.match(adapterSource, /static releaseMeasurementDrawingAfterExport\(/);
assert.match(adapterSource, /#copy-all-measurements-btn/);
assert.match(adapterSource, /#download-measurements-btn/);
assert.match(adapterSource, /Freezes active vector calculations/);
assert.match(adapterSource, /typeof viewer\.canvas\.releasePointerCapture === ["']function["']/);
assert.match(adapterSource, /Re-enables fluid mouse wheel zoom/);
assert.match(adapterSource, /static formatMeasurementExport\(/);
assert.match(adapterSource, /static releaseMeasurementPointerLock\(/);
assert.match(adapterSource, /viewer\.canvas\.releasePointerCapture\(e\.pointerId\)/);
assert.match(adapterSource, /measurementTracker\.setTracking\(false\)/);
assert.match(adapterSource, /viewer\.setMouseNavEnabled\(true\)/);
assert.match(adapterSource, /isDrawing = false/);
assert.match(adapterSource, /static bindMeasurementPointerUnlock\(/);
assert.match(html, /id="measurement-mode-selector"/);
assert.match(html, /value="multiple"/);
assert.match(adapterSource, /static onMeasureModeButtonClick\(/);
assert.match(adapterSource, /static bindMeasurementKeyboardEscape\(/);
assert.match(adapterSource, /static handleMeasurementKeyboardEscape\(/);
assert.match(adapterSource, /static commitActiveMeasurementSegment\(/);
assert.match(adapterSource, /static escapeMeasurementMultipleMode\(/);
assert.match(adapterSource, /if \(currentMode === ['"]multiple['"]\)/);
assert.match(adapterSource, /e\.key === ['"]Enter['"] \|\| e\.key === ['"]Return['"]/);
assert.match(adapterSource, /viewer\.canvas\.releasePointerCapture\(lastPointerId\)/);
assert.match(adapterSource, /function handleKeyboardEscape\(/);
assert.match(html, /id="fcp-window-func-r"/);
assert.match(html, /color-interpolation-filters="linearRGB"/);
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
assert.match(adapterSource, /input\.addEventListener\("input", onSlide\)/);
assert.doesNotMatch(adapterSource, /input\.addEventListener\("change", onSlide\)/);
assert.match(adapterSource, /viewer\.forceRedraw\(\)/);
assert.match(adapterSource, /static persistMeasurementPopup\(/);
assert.match(adapterSource, /measurement-popup-close/);
assert.match(adapterSource, /document\.body\.appendChild\(palette\)/);
assert.match(adapterSource, /position = "fixed"/);
assert.match(adapterSource, /zIndex \|\| "9999"/);
assert.match(adapterSource, /setProperty\("resize", "both"/);
assert.match(adapterSource, /viewer\.world\.getItemAt/);
assert.match(adapterSource, /item\.setOpacity/);
assert.match(adapterSource, /CHANNEL_LEVEL_MAX = 58831/);
assert.match(adapterSource, /BIT16_INTENSITY_SCALE = 65535/);
assert.match(adapterSource, /static mapChannelWindowToFloatFilter\(/);
assert.match(adapterSource, /static applyFloat16BitWindowProcessor\(/);
assert.match(adapterSource, /static renderMeasurementResultsTable\(/);
assert.match(adapterSource, /static appendMeasurementResultRow\(/);
assert.match(html, /font-size:\s*clamp\(13px,\s*0\.4vw \+ 8px,\s*19px\)/);
assert.match(html, /--sidebar-width:\s*22rem/);
assert.match(html, /--toolbar-height:\s*3\.5rem/);
assert.match(html, /min-height:\s*var\(--toolbar-height\)/);
assert.match(html, /width:\s*var\(--sidebar-width\)/);
assert.match(html, /padding:\s*0\.4em 0\.8em/);
assert.match(html, /font-size:\s*1\.1em/);
assert.match(adapterSource, /style\.maxHeight = minimized \? "2rem" : "none"/);
assert.match(adapterSource, /style\.display = "block"/);
assert.match(adapterSource, /style\.maxHeight = "none"/);
assert.doesNotMatch(adapterSource, /toggleFloatingZStackMinimized[\s\S]{0,200}display = "none"/);
assert.match(adapterSource, /parentNode\.removeChild\(palette\)/);
assert.match(adapterSource, /static bindFloatingAiLabsPalette\(/);
assert.match(adapterSource, /static bindFloatingZStackPalette\(/);
assert.match(adapterSource, /static setFloatingZStackPaletteVisible\(/);
assert.match(adapterSource, /static isolateFloatingPalettePointerEvents\(/);
assert.match(adapterSource, /static bindFloatingMeasurementPalette\(/);
assert.match(adapterSource, /static openFloatingMeasurementPalette\(/);
assert.match(adapterSource, /static positionFloatingMeasurementPalette\(/);
assert.match(adapterSource, /static positionFloatingChannelPalette\(/);
assert.match(adapterSource, /static getAntiOverlapPosition\(/);
assert.match(adapterSource, /function getAntiOverlapPosition\(/);
assert.match(adapterSource, /\.floating-palette, \[id\^="floating-"\], #floating-zstack-palette/);
assert.match(adapterSource, /maxViewportWidth = window\.innerWidth - 20/);
assert.match(adapterSource, /maxViewportHeight = window\.innerHeight - 20/);
assert.match(adapterSource, /finalLeft \+= 240/);
assert.match(adapterSource, /safetyCounter < 15/);
assert.match(adapterSource, /r\.bottom \+ 12/);
assert.match(html, /id="floating-measurement-palette"[^>]*class="floating-palette"/);
assert.match(adapterSource, /static resetImageControllerState\(/);
assert.match(adapterSource, /static resetBrightnessContrastSettings\(/);
assert.match(adapterSource, /controllersToHide/);
assert.match(adapterSource, /savedMeasurementsArray = \[\]/);
assert.match(adapterSource, /resetBrightnessContrastSettings\(\)/);
assert.match(adapterSource, /measurement-results-body/);
assert.match(adapterSource, /static palettesOverlap\(/);
assert.match(adapterSource, /Overlap Collide Detected/);
assert.match(adapterSource, /static viewerStageLaunchOrigin\(/);
assert.match(adapterSource, /dataset\.fcpUserMoved = "1"/);
assert.match(adapterSource, /palette\.style\.display = "block"/);
assert.match(adapterSource, /viewerEl\.offsetLeft \+ 15/);
assert.match(adapterSource, /viewerEl\.offsetTop \+ 15/);
assert.match(adapterSource, /zStack\.offsetTop \+ zStack\.offsetHeight \+ 15/);
assert.match(adapterSource, /zStack\.offsetLeft/);
assert.match(adapterSource, /measPalette\.style\.left = targetLeft/);
assert.match(adapterSource, /measPalette\.style\.top = targetTop/);
assert.match(html, /id="openseadragon-viewer"/);
assert.doesNotMatch(adapterSource, /positionFloatingMeasurementPalette[\s\S]{0,400}isBrightfieldSlide/);
assert.match(adapterSource, /static positionZStackPaletteUpperLeft\(/);
assert.match(adapterSource, /\['mousedown', 'mouseup', 'mousemove', 'click', 'mouseover', 'mouseout', 'wheel', 'mousewheel', 'DOMMouseScroll'\]/);
assert.match(adapterSource, /passive: false/);
assert.match(adapterSource, /parseFloat\(/);
assert.match(adapterSource, /getElementById\(["']openseadragon-viewer["']\)/);
assert.match(adapterSource, /viewerRect\.left \+ 10/);
assert.match(adapterSource, /viewerRect\.top \+ 10/);
assert.match(adapterSource, /id="floating-zstack-palette"|floating-zstack-palette/);
assert.match(adapterSource, /static bindLiberatedPaletteDrag\(/);
assert.match(adapterSource, /function handleWindowMouseUp\(/);
assert.match(adapterSource, /function dragPanelLoop\(/);
assert.match(adapterSource, /isDraggingWindow = false/);
assert.match(adapterSource, /activeDraggingPanel = null/);
assert.match(adapterSource, /e\.target\.releasePointerCapture\(e\.pointerId\)/);
assert.match(adapterSource, /removeEventListener\("mousemove", dragPanelLoop\)/);
assert.match(adapterSource, /removeEventListener\("mouseup", handleWindowMouseUp\)/);

const context = vm.createContext({
    console: { info() {}, warn() {}, error() {} },
    window: { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 },
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
assert.equal(AnnotationAdapter.BIT16_INTENSITY_SCALE, 65535);
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
    assert.match(canvas.style.filter, /url\(#fcp-gamma-filter\)/);
    assert.doesNotMatch(canvas.style.filter, /contrast\(/);
    assert.doesNotMatch(canvas.style.filter, /brightness\(/);
    const mapped = AnnotationAdapter.mapChannelWindowToFloatFilter(1000, 20000, 1.25);
    assert.equal(mapped.scale, 65535);
    assert.ok(mapped.slope > 1);
    assert.equal(typeof mapped.slope, "number");
    assert.equal(Number.isInteger(mapped.slope), false);
    assert.equal(typeof mapped.intercept, "number");
    assert.equal(mapped.exponent, 1.25);
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

{
    AnnotationAdapter.measurementSessionList = [];
    const entry = AnnotationAdapter.saveMeasurementToSession({
        lengthMicrons: 12.5,
        lengthPixels: 40
    });
    assert.equal(entry.id, "1");
    assert.equal(entry.lengthMicrons, 12.5);
    assert.equal(entry.lengthPixels, 40);
    assert.equal(AnnotationAdapter.measurementSessionList.length, 1);
    const csv = AnnotationAdapter.formatMeasurementExport(
        AnnotationAdapter.measurementSessionList,
        "csv"
    );
    assert.match(csv, /ID,Microns,Pixels/);
    assert.match(csv, /1,12.50,40/);
}

{
    let navEnabled = false;
    let tracking = true;
    let released = null;
    AnnotationAdapter.isDragging = true;
    AnnotationAdapter.isMeasurementModeActive = true;
    AnnotationAdapter.measureMouseTracker = {
        setTracking(value) { tracking = value; }
    };
    AnnotationAdapter.viewer = {
        canvas: {
            releasePointerCapture(id) { released = id; }
        },
        setMouseNavEnabled(value) { navEnabled = value; },
        gestureSettingsMouse: { scrollToZoom: false }
    };
    AnnotationAdapter.releaseMeasurementPointerLock({ pointerId: 7 });
    assert.equal(AnnotationAdapter.isDragging, false);
    assert.equal(AnnotationAdapter.isDrawing, false);
    assert.equal(AnnotationAdapter.isMeasurementModeActive, false);
    assert.equal(tracking, false);
    assert.equal(navEnabled, true);
    assert.equal(released, 7);
    assert.equal(AnnotationAdapter.viewer.gestureSettingsMouse.scrollToZoom, true);
}

{
    let navEnabled = false;
    let tracking = true;
    let released = null;
    AnnotationAdapter.measurementSessionList = [];
    AnnotationAdapter.imageMetadata = { micronsPerPixel: 0.5 };
    AnnotationAdapter.setMeasurementEntryMode("multiple");
    AnnotationAdapter.isMeasurementModeActive = true;
    AnnotationAdapter.isDrawing = true;
    AnnotationAdapter.measureStartImageX = 0;
    AnnotationAdapter.measureStartImageY = 0;
    AnnotationAdapter.measureEndImageX = 40;
    AnnotationAdapter.measureEndImageY = 0;
    AnnotationAdapter.measureStartX = 0;
    AnnotationAdapter.measureStartY = 0;
    AnnotationAdapter.measureEndX = 40;
    AnnotationAdapter.measureEndY = 0;
    AnnotationAdapter.lastPointerId = 11;
    AnnotationAdapter.measureMouseTracker = {
        setTracking(value) { tracking = value; }
    };
    AnnotationAdapter.viewer = {
        canvas: {
            releasePointerCapture(id) { released = id; }
        },
        setMouseNavEnabled(value) { navEnabled = value; },
        gestureSettingsMouse: { scrollToZoom: false }
    };
    const next = AnnotationAdapter.onMeasureModeButtonClick({ pointerId: 11 });
    assert.equal(next, false);
    assert.equal(AnnotationAdapter.isMeasurementModeActive, false);
    assert.equal(AnnotationAdapter.isDrawing, false);
    assert.equal(AnnotationAdapter.measurementEntryMode(), "single");
    assert.equal(AnnotationAdapter.measurementSessionList.length, 1);
    assert.equal(AnnotationAdapter.measurementSessionList[0].lengthPixels, 40);
    assert.equal(tracking, false);
    assert.equal(navEnabled, true);
    assert.equal(released, 11);
}

{
    let navEnabled = false;
    let tracking = true;
    let prevented = false;
    AnnotationAdapter.measurementSessionList = [];
    AnnotationAdapter.imageMetadata = { micronsPerPixel: 0.25 };
    AnnotationAdapter.setMeasurementEntryMode("multiple");
    AnnotationAdapter.isMeasurementModeActive = true;
    AnnotationAdapter.isDrawing = true;
    AnnotationAdapter.measureStartImageX = 0;
    AnnotationAdapter.measureStartImageY = 0;
    AnnotationAdapter.measureEndImageX = 20;
    AnnotationAdapter.measureEndImageY = 0;
    AnnotationAdapter.measureStartX = 0;
    AnnotationAdapter.measureStartY = 0;
    AnnotationAdapter.measureEndX = 20;
    AnnotationAdapter.measureEndY = 0;
    AnnotationAdapter.lastPointerId = 3;
    AnnotationAdapter.measureMouseTracker = {
        setTracking(value) { tracking = value; }
    };
    AnnotationAdapter.viewer = {
        canvas: {
            releasePointerCapture() {}
        },
        setMouseNavEnabled(value) { navEnabled = value; },
        gestureSettingsMouse: { scrollToZoom: false }
    };
    const handled = AnnotationAdapter.handleMeasurementKeyboardEscape({
        key: "Enter",
        preventDefault() { prevented = true; },
        stopPropagation() {}
    });
    assert.equal(handled, true);
    assert.equal(prevented, true);
    assert.equal(AnnotationAdapter.isMeasurementModeActive, false);
    assert.equal(AnnotationAdapter.measurementEntryMode(), "single");
    assert.equal(AnnotationAdapter.measurementSessionList.length, 1);
    assert.equal(AnnotationAdapter.measurementSessionList[0].lengthPixels, 20);
    assert.equal(tracking, false);
    assert.equal(navEnabled, true);
}

{
    let tracking = true;
    let navEnabled = true;
    AnnotationAdapter.measurementSessionList = [];
    AnnotationAdapter.setMeasurementEntryMode("multiple");
    AnnotationAdapter.isMeasurementModeActive = true;
    AnnotationAdapter.isDrawing = true;
    AnnotationAdapter.measureStartImageX = 0;
    AnnotationAdapter.measureStartImageY = 0;
    AnnotationAdapter.measureEndImageX = 12;
    AnnotationAdapter.measureEndImageY = 5;
    AnnotationAdapter.measureStartX = 0;
    AnnotationAdapter.measureStartY = 0;
    AnnotationAdapter.measureEndX = 12;
    AnnotationAdapter.measureEndY = 5;
    AnnotationAdapter.measureMouseTracker = {
        setTracking(value) { tracking = value; }
    };
    AnnotationAdapter.viewer = {
        canvas: { releasePointerCapture() {} },
        setMouseNavEnabled(value) { navEnabled = value; },
        gestureSettingsMouse: { scrollToZoom: false }
    };
    AnnotationAdapter._measureReleaseHandler({});
    assert.equal(AnnotationAdapter.measurementSessionList.length, 1);
    assert.equal(AnnotationAdapter.isMeasurementModeActive, true);
    assert.equal(AnnotationAdapter.measurementEntryMode(), "multiple");
    assert.equal(tracking, true);
    assert.equal(navEnabled, false);
}

{
    const previousGet = context.document.getElementById;
    const measPalette = { style: { display: "none", visibility: "" } };
    const parent = { offsetLeft: 200, offsetTop: 48, offsetParent: null };
    const viewerEl = { offsetLeft: 80, offsetTop: 16, offsetParent: parent };
    const zStack = {
        style: { display: "none", visibility: "" },
        hidden: true,
        offsetTop: 74,
        offsetHeight: 180,
        offsetLeft: 290,
        getAttribute() { return "true"; }
    };
    context.document.getElementById = (id) => {
        if (id === "openseadragon-viewer" || id === "viewer") return viewerEl;
        if (id === "floating-zstack-palette") return zStack;
        if (id === "floating-measurement-palette") return measPalette;
        return null;
    };
    assert.equal(AnnotationAdapter.positionFloatingMeasurementPalette(), true);
    assert.equal(measPalette.style.left, "295px");
    assert.equal(measPalette.style.top, "79px");
    zStack.style.display = "block";
    zStack.hidden = false;
    zStack.getAttribute = () => "false";
    assert.equal(AnnotationAdapter.positionFloatingMeasurementPalette(), true);
    assert.equal(measPalette.style.left, "290px");
    assert.equal(measPalette.style.top, "269px");
    const bcPalette = {
        hidden: false,
        style: { display: "flex", visibility: "", left: "295px", top: "79px" },
        offsetLeft: 295,
        offsetTop: 79,
        offsetWidth: 340,
        offsetHeight: 400,
        getAttribute() { return "false"; }
    };
    const overlapMeas = {
        style: { display: "none", visibility: "", width: "380px", height: "200px" },
        offsetWidth: 380,
        offsetHeight: 200
    };
    context.document.getElementById = (id) => {
        if (id === "openseadragon-viewer" || id === "viewer") return viewerEl;
        if (id === "floating-zstack-palette") return zStack;
        if (id === "floating-measurement-palette") return overlapMeas;
        if (id === "floating-channel-palette") return bcPalette;
        return null;
    };
    zStack.style.display = "none";
    zStack.hidden = true;
    zStack.getAttribute = () => "true";
    assert.equal(AnnotationAdapter.palettesOverlap(
        { left: 295, top: 79, width: 380, height: 200 },
        { left: 295, top: 79, width: 340, height: 400 }
    ), true);
    assert.equal(AnnotationAdapter.positionFloatingMeasurementPalette(), true);
    assert.equal(overlapMeas.style.left, "295px");
    assert.equal(overlapMeas.style.top, "494px");
    AnnotationAdapter.channelPaletteElement = {
        style: {},
        dataset: {}
    };
    context.document.getElementById = (id) => {
        if (id === "openseadragon-viewer" || id === "viewer") return viewerEl;
        if (id === "floating-channel-palette") return AnnotationAdapter.channelPaletteElement;
        return null;
    };
    assert.equal(AnnotationAdapter.positionFloatingChannelPalette(), true);
    assert.equal(AnnotationAdapter.channelPaletteElement.style.left, "295px");
    assert.equal(AnnotationAdapter.channelPaletteElement.style.top, "79px");
    const overlapZ = {
        id: "floating-zstack-palette",
        style: { display: "block", visibility: "" },
        offsetLeft: 290,
        offsetTop: 74,
        offsetWidth: 320,
        offsetHeight: 180,
        getBoundingClientRect() {
            return { left: 290, top: 74, right: 610, bottom: 254, width: 320, height: 180 };
        }
    };
    const overlapCurrent = {
        id: "floating-measurement-palette",
        style: { display: "block", width: "380px", height: "200px" },
        offsetWidth: 380,
        offsetHeight: 200
    };
    context.document.getElementById = (id) => {
        if (id === "floating-zstack-palette") return overlapZ;
        if (id === "floating-measurement-palette") return overlapCurrent;
        return null;
    };
    const cascaded = AnnotationAdapter.getAntiOverlapPosition(
        295,
        79,
        380,
        200,
        "floating-measurement-palette",
        context.document
    );
    assert.equal(cascaded.left, 295);
    assert.equal(cascaded.top, 266);
    const previousW = context.window.innerWidth;
    const previousH = context.window.innerHeight;
    context.window.innerWidth = 820;
    context.window.innerHeight = 420;
    const columnBlocker = {
        id: "floating-zstack-palette",
        style: { display: "block", visibility: "" },
        getBoundingClientRect() {
            return { left: 40, top: 40, right: 220, bottom: 360, width: 180, height: 320 };
        }
    };
    const wrapped = AnnotationAdapter.getAntiOverlapPosition(
        40,
        40,
        200,
        200,
        "floating-measurement-palette",
        {
            getElementById(id) {
                return id === "floating-zstack-palette" ? columnBlocker : null;
            }
        }
    );
    assert.equal(wrapped.left, 280);
    assert.equal(wrapped.top, 40);
    const clamped = AnnotationAdapter.getAntiOverlapPosition(
        900,
        40,
        200,
        200,
        "floating-measurement-palette",
        {
            getElementById() { return null; }
        }
    );
    assert.equal(clamped.left, 600);
    assert.equal(clamped.top, 40);
    context.window.innerWidth = previousW;
    context.window.innerHeight = previousH;
    context.document.getElementById = previousGet;
}

{
    const body = { innerHTML: "old-row" };
    const channelPalette = { style: { display: "flex" } };
    const zPalette = { style: { display: "block" } };
    const doc = {
        querySelector(sel) {
            if (sel === "#floating-channel-palette") return channelPalette;
            if (sel === "#floating-zstack-palette") return zPalette;
            return null;
        },
        getElementById(id) {
            if (id === "measurement-results-body") return body;
            if (id === "floating-channel-palette") return channelPalette;
            if (id === "floating-zstack-palette") return zPalette;
            return null;
        }
    };
    AnnotationAdapter.measurementSessionList = [{ id: "9", lengthMicrons: 1, lengthPixels: 2 }];
    assert.equal(AnnotationAdapter.resetImageControllerState(doc), true);
    assert.equal(channelPalette.style.display, "none");
    assert.equal(zPalette.style.display, "none");
    assert.equal(body.innerHTML, "");
    assert.equal(AnnotationAdapter.measurementSessionList.length, 0);
}

{
    let navEnabled = false;
    let tracking = true;
    let released = null;
    AnnotationAdapter.setMeasurementEntryMode("multiple");
    AnnotationAdapter.isMeasurementModeActive = true;
    AnnotationAdapter.isDrawing = true;
    AnnotationAdapter.lastPointerId = 9;
    AnnotationAdapter.measureMouseTracker = {
        setTracking(value) { tracking = value; }
    };
    AnnotationAdapter.viewer = {
        canvas: {
            releasePointerCapture(id) { released = id; }
        },
        setMouseNavEnabled(value) { navEnabled = value; },
        gestureSettingsMouse: { scrollToZoom: false }
    };
    AnnotationAdapter.measurementSessionList = [{ id: "1", lengthMicrons: 12.5, lengthPixels: 40 }];
    AnnotationAdapter.copyMeasurementResults();
    assert.equal(AnnotationAdapter.isDrawing, false);
    assert.equal(AnnotationAdapter.isMeasurementModeActive, false);
    assert.equal(AnnotationAdapter.measurementEntryMode(), "single");
    assert.equal(tracking, false);
    assert.equal(navEnabled, true);
    assert.equal(released, 9);
}

{
    let navEnabled = false;
    AnnotationAdapter.setMeasurementEntryMode("multiple");
    AnnotationAdapter.isMeasurementModeActive = true;
    AnnotationAdapter.isDrawing = true;
    AnnotationAdapter.lastPointerId = 4;
    AnnotationAdapter.measureMouseTracker = { setTracking() {} };
    AnnotationAdapter.viewer = {
        canvas: { releasePointerCapture() {} },
        setMouseNavEnabled(value) { navEnabled = value; },
        gestureSettingsMouse: { scrollToZoom: false }
    };
    AnnotationAdapter.measurementSessionList = [{ id: "1", lengthMicrons: 1, lengthPixels: 3 }];
    AnnotationAdapter.saveMeasurementResults();
    assert.equal(AnnotationAdapter.isDrawing, false);
    assert.equal(AnnotationAdapter.isMeasurementModeActive, false);
    assert.equal(navEnabled, true);
}

{
    assert.equal(AnnotationAdapter.activateImageJTool("brush"), false);
    assert.equal(AnnotationAdapter.activateImageJTool("pan"), true);
    assert.equal(AnnotationAdapter.activeImageJTool, "pan");
    AnnotationAdapter.viewer = {
        element: { classList: { toggle() {} } },
        setMouseNavEnabled() {},
        viewport: { resize() {}, zoomBy() {}, applyConstraints() {} }
    };
    assert.equal(AnnotationAdapter.activateImageJTool("zoom"), true);
    assert.equal(AnnotationAdapter.activeImageJTool, "zoom");
}

{
    assert.equal(AnnotationAdapter.formatChannelPaletteLabel({
        lut: "CYAN",
        name: "Channel 0 - DAPI"
    }), "Cyan (DAPI)");
    assert.equal(AnnotationAdapter.formatChannelPaletteLabel({
        lut: "GREEN",
        name: "MHCII"
    }), "Green (MHCII)");
    assert.equal(AnnotationAdapter.formatChannelPaletteLabel({
        lut: "CYAN",
        name: "Cyan"
    }), "Cyan");
}

{
    const grid = { dataset: {}, setAttribute() {} };
    const select = { value: "1" };
    AnnotationAdapter.channelPaletteElement = {
        querySelector(sel) {
            if (sel === "#floating-channel-palette-rows") return grid;
            if (sel === "#fcp-layout-select") return select;
            return null;
        }
    };
    assert.equal(AnnotationAdapter.applyChannelPaletteLayout("2"), "2");
    assert.equal(grid.dataset.fcpLayout, "2");
    assert.equal(select.value, "2");
    assert.equal(AnnotationAdapter.applyChannelPaletteLayout("wrap"), "wrap");
    assert.equal(AnnotationAdapter.channelPaletteLayout, "wrap");
    AnnotationAdapter.applyChannelPaletteLayout("1");
}

{
    const splitCalls = [];
    const grid = {
        style: { height: "", setProperty() {} },
        getBoundingClientRect() { return { height: 152 }; }
    };
    const splitter = {
        classList: { add() {}, remove() {} },
        addEventListener(type, fn) { splitCalls.push([type, fn]); },
        setPointerCapture() {}
    };
    const palette = {
        dataset: {},
        querySelector(sel) {
            if (sel === "#fcp-list-splitter") return splitter;
            if (sel === "#floating-channel-palette-rows") return grid;
            return null;
        },
        getBoundingClientRect() { return { height: 480 }; }
    };
    assert.equal(AnnotationAdapter.bindChannelListSplitter(palette), true);
    assert.equal(palette.dataset.fcpListSplitterBound, "1");
    const begin = splitCalls.find(([type]) => type === "pointerdown")?.[1];
    assert.equal(typeof begin, "function");
    begin({
        button: 0,
        clientY: 200,
        preventDefault() {},
        stopPropagation() {}
    });
    assert.equal(palette._fcpListSplit.startH, 152);
}

{
    const cells = [];
    const grid = {
        replaceChildren(...nodes) {
            cells.length = 0;
            cells.push(...nodes);
        }
    };
    const owner = {
        createElement(tag) {
            return {
                tagName: String(tag).toUpperCase(),
                className: "",
                dataset: {},
                innerHTML: "",
                querySelector(sel) {
                    if (String(sel).includes("data-fcp-visible")) {
                        return { addEventListener() {}, checked: true };
                    }
                    return null;
                },
                addEventListener() {}
            };
        }
    };
    const palette = {
        ownerDocument: owner,
        querySelector(sel) {
            if (sel === "#floating-channel-palette-rows") return grid;
            if (sel === "#fcp-min" || sel === "#fcp-max") return { value: "0", max: "" };
            if (sel === "#fcp-gamma") return { value: "1" };
            if (sel === "#fcp-min-value" || sel === "#fcp-max-value" || sel === "#fcp-gamma-value") {
                return { textContent: "" };
            }
            return null;
        }
    };
    AnnotationAdapter.channelPaletteElement = palette;
    AnnotationAdapter.displayController = {
        getDisplay() {
            return {
                channels: Array.from({ length: 22 }, (_, i) => ({
                    index: i,
                    name: `Marker ${i + 1}`,
                    lut: i % 2 ? "GREEN" : "CYAN",
                    visible: i !== 4,
                    black: 0,
                    white: 58831,
                    gamma: 1
                }))
            };
        }
    };
    assert.equal(AnnotationAdapter.syncFloatingChannelPalette(), true);
    assert.equal(cells.length, 22);
    assert.equal(cells[0].tagName, "DIV");
    assert.match(cells[0].className, /bc-channel-cell/);
    assert.match(cells[0].innerHTML, /floating-channel-cb/);
    assert.match(cells[0].innerHTML, /Cyan \(Marker 1\)/);
    assert.match(cells[0].innerHTML, /checked/);
    assert.doesNotMatch(cells[4].innerHTML, /checked/);
}

{
    const bound = [];
    const palette = {
        dataset: {},
        style: {},
        querySelectorAll() {
            return [{
                dataset: { edge: "e" },
                addEventListener(type, fn) { bound.push([type, fn]); }
            }];
        },
        getBoundingClientRect() {
            return { left: 40, top: 50, width: 400, height: 420 };
        }
    };
    assert.equal(AnnotationAdapter.bindFloatingPaletteEdgeResize(palette), true);
    assert.equal(palette.dataset.fcpEdgeResizeBound, "1");
    const begin = bound.find(([type]) => type === "pointerdown")?.[1];
    assert.equal(typeof begin, "function");
    begin({
        button: 0,
        currentTarget: { dataset: { edge: "e" }, setPointerCapture() {} },
        clientX: 440,
        clientY: 80,
        preventDefault() {},
        stopPropagation() {}
    });
    assert.equal(palette._fcpEdgeResize.edge, "e");
    assert.equal(palette._fcpEdgeResize.startW, 400);
}

console.log("floating-channel-palette.test.js: ok");
