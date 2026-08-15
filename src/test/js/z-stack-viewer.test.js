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
        URL,
        URLSearchParams,
        atob: (value) => Buffer.from(String(value), "base64").toString("utf8"),
        setInterval(fn, _ms) { return 1; },
        clearInterval(_id) {},
        document: {
            createElement(tag) {
                return {
                    tagName: String(tag).toUpperCase(),
                    value: "",
                    textContent: "",
                    children: [],
                    append(...nodes) { this.children.push(...nodes); },
                    replaceChildren(...nodes) { this.children = nodes; }
                };
            }
        },
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

assert.equal(
    AnnotationAdapter.extractCaseId("nested/dir/BA26-041340_A2.vsi"),
    "BA26-041340"
);
assert.equal(
    AnnotationAdapter.extractCaseId("ba26-041340 something"),
    "ba26-041340"
);
assert.equal(AnnotationAdapter.extractCaseId("no-case-here.vsi"), null);
assert.equal(
    AnnotationAdapter.uniqueCaseIdsFromImages([
        { name: "BA26-041340_A2.vsi", relativePath: "nested/dir/BA26-041340_A2.vsi" },
        { name: "other.vsi", relativePath: "20280813_z/BS26-041330_slide.vsi" },
        { name: "dup.vsi", relativePath: "x/ba26-041340_B.vsi" },
        { name: "plain.vsi", relativePath: "folder/plain.vsi" }
    ]).join(","),
    "BA26-041340,BS26-041330"
);
assert.equal(
    AnnotationAdapter.parseSlideLabel({
        name: "BA26-041340_A2.vsi",
        relativePath: "nested/dir/BA26-041340_A2.vsi"
    }),
    "A2"
);
assert.equal(
    AnnotationAdapter.resolveCaseFilterMode("__all_slides__"),
    "all"
);
assert.equal(
    AnnotationAdapter.resolveCaseFilterMode("BA26-041340"),
    "case"
);
assert.equal(
    AnnotationAdapter.resolveCaseFilterMode(""),
    "placeholder"
);
assert.deepEqual(
    JSON.parse(JSON.stringify(AnnotationAdapter.buildHeaderIdentity({
        name: "BA26-041340_A2.vsi",
        relativePath: "x/BA26-041340_A2.vsi"
    }))),
    { caseId: "BA26-041340", slideDetail: "BA26-041340_A2.vsi" }
);
assert.equal(
    AnnotationAdapter.parseSlideLabel({
        name: "BA26-041340_HER2_IHC.vsi"
    }),
    "HER2_IHC"
);
assert.doesNotMatch(adapterSource, /\.replace\(\/\[_\]\+\/g,\s*["'] ["']\)/);
assert.match(adapterSource, /rawImageFileName/);
assert.match(adapterSource, /TIMESTAMP_SUFFIX_PATTERN/);
assert.match(adapterSource, /stripFilenameTimestampSuffix/);
assert.match(adapterSource, /assignSidebarDisplayTitles/);
assert.match(adapterSource, /naturalCollator/);
assert.match(adapterSource, /sortImagesNaturally/);
assert.match(adapterSource, /numeric:\s*true/);
{
    const sorted = AnnotationAdapter.sortImagesNaturally([
        { id: "c", name: "slide_20.vsi" },
        { id: "a", name: "slide_2.vsi" },
        { id: "b", name: "slide_10.vsi" },
        { id: "d", name: "slide_19.vsi" }
    ]).map(image => image.name);
    assert.deepEqual(sorted, [
        "slide_2.vsi",
        "slide_10.vsi",
        "slide_19.vsi",
        "slide_20.vsi"
    ]);
}
assert.equal(
    AnnotationAdapter.stripFilenameTimestampSuffix("L712_5830_5_20260706_233104"),
    "L712_5830_5"
);
assert.equal(
    AnnotationAdapter.sidebarDisplayStem({
        name: "L712_5830_5_20260706_233104.vsi"
    }),
    "L712_5830_5"
);
{
    const titled = AnnotationAdapter.assignSidebarDisplayTitles([
        { id: "a", name: "L712_5830_5_20260706_233104.vsi" },
        { id: "b", name: "L712_5830_5_20260707_101112.vsi" },
        { id: "c", name: "L712_5830_5_20260708_121314.vsi" },
        { id: "d", name: "OTHER_SLIDE_20260101_000000.vsi" }
    ]);
    assert.equal(titled[0].title, "L712_5830_5 (1 of 3)");
    assert.equal(titled[1].title, "L712_5830_5 (2 of 3)");
    assert.equal(titled[2].title, "L712_5830_5 (3 of 3)");
    assert.equal(titled[3].title, "OTHER_SLIDE");
    assert.equal(titled[0].image.id, "a");
    assert.equal(titled[1].image.id, "b");
}
assert.equal(
    AnnotationAdapter.compactChannelName({ name: "Channel 0 - DAPI", index: 0 }),
    "DAPI"
);
assert.equal(
    AnnotationAdapter.channelVisibilityGroupKey({ name: "Channel 0 - DAPI" }),
    AnnotationAdapter.channelVisibilityGroupKey({ name: "Channel 3 - DAPI" })
);
assert.match(adapterSource, /CASE_ID_PATTERN/);
assert.match(adapterSource, /uniqueCaseIdsFromImages/);
assert.match(adapterSource, /applyCaseFilterToSlideButtons/);
assert.match(adapterSource, /renderImageBrowser/);
assert.match(adapterSource, /parseSlideLabel/);
assert.match(adapterSource, /Strict collapse/);
assert.match(adapterSource, /details\.open = false/);
assert.match(adapterSource, /contents\.style\.display = "none"/);
assert.match(adapterSource, /CASE_FILTER_ALL_SLIDES_VALUE/);
assert.match(adapterSource, /CASE_FILTER_PLACEHOLDER_LABEL/);
assert.match(adapterSource, /Select Slides/);
assert.doesNotMatch(adapterSource, /"-- Select a Patient Case --"/);
assert.match(adapterSource, /All Slides/);
assert.match(adapterSource, /EMPTY_VIEWPORT_GUIDANCE/);
assert.match(adapterSource, /setEmptyViewportGuidanceVisible/);
assert.match(adapterSource, /setSlideLabelThumbsEnabled/);
assert.match(adapterSource, /loadSlideLabelThumbs/);
assert.match(adapterSource, /clearSlideLabelThumbs/);
assert.match(adapterSource, /cycleSlideLabelThumbRotation/);
assert.match(adapterSource, /applySlideLabelThumbRotation/);
assert.match(adapterSource, /syncMainWindowSlideLabelRotation/);
assert.match(adapterSource, /cycleOverviewSlideLabelRotation/);
assert.match(adapterSource, /SLIDE_LABEL_DEFAULT_ROTATION_DEG\s*=\s*90/);
assert.equal(AnnotationAdapter.SLIDE_LABEL_DEFAULT_ROTATION_DEG, 90);
{
    const wrap = {
        dataset: {},
        style: { setProperty() {} },
        classList: { toggle() {} },
        querySelector() { return null; },
        closest() { return { dataset: { imageId: "img-1" } }; }
    };
    assert.equal(AnnotationAdapter.applySlideLabelThumbRotation(wrap, 90), 90);
    assert.equal(AnnotationAdapter.cycleSlideLabelThumbRotation(wrap), 180);
    assert.equal(AnnotationAdapter.getSlideLabelRotation("img-1"), 180);
    assert.equal(AnnotationAdapter.cycleSlideLabelThumbRotation(wrap), 270);
    assert.equal(AnnotationAdapter.cycleSlideLabelThumbRotation(wrap), 0);
    assert.equal(AnnotationAdapter.cycleSlideLabelThumbRotation(wrap), 90);
}
assert.match(adapterSource, /label\.png/);
assert.match(adapterSource, /shouldBypassSessionImageAutoload/);
assert.match(adapterSource, /applyZeroExposureWorkspace/);
assert.match(adapterSource, /forceCaseFilterViewportWipe/);
assert.match(adapterSource, /bindCaseFilterChangeGuard/);
assert.match(adapterSource, /viewer\.close\(\)/);
assert.match(adapterSource, /currentImageId\s*=\s*null/);
assert.match(adapterSource, /resetActiveImageTracking/);
assert.match(adapterSource, /revealWorkspaceImageChrome/);
assert.match(adapterSource, /ZERO_EXPOSURE_STATUS/);
assert.match(html, /id="case-filter-select"/);
assert.doesNotMatch(html, /<label[^>]*>Slide Filter<\/label>/);
assert.doesNotMatch(html, />Case filter</);
assert.match(html, /id="slide-filter-header"/);
assert.match(html, /slide-filter-row/);
assert.match(html, /position:\s*sticky/);
assert.match(html, /z-index:\s*100/);
assert.match(html, /Select Slides/);
assert.doesNotMatch(html, /Select a Patient Case/);
assert.match(html, /All Slides/);
assert.doesNotMatch(html, /All Cases/);
assert.doesNotMatch(html, /Drag to pan/);
assert.match(html, /id="empty-viewport-guidance"/);
assert.match(html, /Use the dropdown menu on the left to select slides for viewing\./);
assert.match(html, /id="show-slide-labels"/);
assert.match(html, /Show Label/);
assert.doesNotMatch(html, /Show Slide Labels/);
assert.match(html, /Hide Label/);
assert.doesNotMatch(html, /Hide Slide Labels/);
assert.match(html, /#show-slide-labels\s*\{[^}]*white-space:\s*normal/s);
assert.match(html, /#show-slide-labels\s*\{[^}]*word-break:\s*break-word/s);
assert.match(html, /data-collapse="left"/);
assert.match(html, /id="reveal-left"[^>]*>Show Filenames</);
assert.doesNotMatch(html, />Show images</);
assert.match(html, /\.workspace\.left-collapsed\s*\{[^}]*grid-template-columns:\s*0px 0px minmax\(0,\s*1fr\)/s);
assert.match(html, /\.workspace\.left-collapsed #images-panel[\s\S]*?display:\s*none/);
assert.match(html, /\.workspace > main\s*\{[^}]*grid-column:\s*3/s);
assert.match(html, /removeProperty\(`--\$\{side\}-panel`\)/);
assert.match(adapterSource, /label\.textContent\s*=\s*title/);
assert.doesNotMatch(adapterSource, /class="image-path"/);
assert.doesNotMatch(adapterSource, /span class="image-path"/);
assert.match(html, /slide-label-thumb-wrap/);
assert.match(html, /sidebar-label-wrapper/);
assert.match(html, /sidebar-label-slot/);
assert.match(html, /80px/);
assert.match(html, /rotate\(var\(--label-rotation/);
assert.match(html, /id="overview-label-stage"/);
assert.match(html, /id="overview-label-rotate"/);
assert.match(html, /overview-label-image/);
assert.match(html, /id="header-case-id"/);
assert.match(html, /id="header-slide-detail"/);
assert.match(html, /id="current-image-name"/);
assert.match(html, /app-header-brand-row/);
assert.match(html, /app-header-toolbar-row/);
assert.match(html, /#current-image-name[\s\S]*?flex-grow:\s*1/);
assert.match(html, /#current-image-name[\s\S]*?font-size:\s*1\.4rem/);
assert.match(html, /#current-image-name[\s\S]*?white-space:\s*normal/);
assert.match(html, /#current-image-name[\s\S]*?line-height:\s*1\.4/);
assert.match(html, /#current-image-name[\s\S]*?padding-bottom:\s*4px/);
assert.match(html, /#current-image-name[\s\S]*?overflow:\s*visible/);
assert.match(html, /\.app-header-toolbar-row\s*\{[^}]*padding-left:\s*calc\(var\(--left-panel/s);
assert.match(adapterSource, /getElementById\("current-image-name"\)/);
assert.match(adapterSource, /static slideLabelThumbUrl\([\s\S]*?label\.png/);
assert.doesNotMatch(adapterSource, /label-cache\.png/);
assert.match(html, /\/label\.png/);
assert.match(html, /cdn\.jsdelivr\.net\/npm\/tesseract\.js/);
assert.match(adapterSource, /ocr-test-btn/);
assert.match(adapterSource, /ocr-result-text/);
assert.match(adapterSource, /runSidebarLabelOcr/);
assert.match(adapterSource, /runOverviewLabelOcr/);
assert.match(adapterSource, /recognizeLabelImage/);
assert.match(adapterSource, /recognizeClinicalLabelOcr/);
assert.match(adapterSource, /recognizeLabelMultiAngle/);
assert.match(adapterSource, /Tesseract\.recognize/);
assert.match(adapterSource, /renderOcrRawDump/);
assert.match(adapterSource, /\[RAW:/);
assert.match(adapterSource, /#ff9900/);
assert.match(adapterSource, /\.slide-label-thumb/);
assert.doesNotMatch(adapterSource, /prepareClinicalOcrCanvas/);
assert.doesNotMatch(adapterSource, /binarizeCanvasInPlace/);
assert.doesNotMatch(adapterSource, /maskBarcodeRegionsOnCanvas/);
assert.doesNotMatch(adapterSource, /OCR_SCAN_ORDER_DEG/);
assert.doesNotMatch(adapterSource, /OCR_LOCK_ROTATION_DEG/);
assert.doesNotMatch(adapterSource, /\[if\. N\/A\]/);
assert.doesNotMatch(adapterSource, /renderOcrIfMarker/);
assert.match(html, /\.ocr-result-text\s*\{[\s\S]*?display:\s*block/);
assert.match(html, /id="overview-ocr-scan"/);
assert.match(html, /id="overview-ocr-result"/);
assert.match(html, /ocr-test-btn/);
assert.match(html, /ocr-result-text/);
assert.match(html, /#ff9900/);
assert.match(adapterSource, /enableOcrResultTextSelection/);
assert.match(adapterSource, /createRotated90CwDataUrl/);
assert.match(adapterSource, /toDataURL\(["']image\/png["']\)/);
assert.match(adapterSource, /rotate\(90\s*\*\s*Math\.PI\s*\/\s*180\)/);
assert.match(adapterSource, /rotatedDataUrl/);
assert.match(adapterSource, /tessedit_char_whitelist/);
assert.match(adapterSource, /tessedit_enable_doc_dict:\s*["']0["']/);
assert.match(adapterSource, /tessedit_enable_bigram_dict:\s*["']0["']/);
assert.match(adapterSource, /tessedit_pages_seg_mode/);
assert.match(adapterSource, /normalizeOcrClinicalText/);
assert.match(adapterSource, /if\[\\s\\\.\]\+/i);
assert.match(html, /user-select:\s*text\s*!important/);
assert.match(html, /-webkit-user-select:\s*text\s*!important/);
assert.match(html, /pointer-events:\s*auto\s*!important/);
assert.match(html, /z-index:\s*1000/);
assert.match(html, /annotation-adapter\.js\?v=20260815-ocr-if-omni-norm/);
assert.match(html, /channel-levels/);
assert.match(html, /renderImageBrowser/);
assert.match(html, /populateCaseFilterSelect/);
assert.match(adapterSource, /applyCaseFilterToSlideButtons/);
assert.match(html, /shouldBypassSessionImageAutoload/);
assert.match(html, /applyBlankWorkspaceState/);
assert.match(html, /bindCaseFilterChangeGuard/);
assert.match(html, /folder-group:not\(\[open\]\)\s*>\s*\.folder-contents/);
assert.match(html, /id="workstation-admin-tools"/);
assert.match(html, /Workstation Admin Tools/);
assert.match(html, /workstation-admin-tools:not\(\[open\]\)\s*>\s*\.workstation-admin-body/);
assert.match(html, /id="refresh-images"/);
assert.match(html, /id="directory"/);
// Admin tools must live in the right-column drawer, not the left slide list header.
assert.match(html, /id="workstation-admin-tools"[\s\S]*id="directory"[\s\S]*id="refresh-images"/);
assert.doesNotMatch(html, /id="images-panel"[\s\S]*panel-kicker">Browse[\s\S]*id="image-list"/);

console.log("z-stack-viewer.test.js: ok");
