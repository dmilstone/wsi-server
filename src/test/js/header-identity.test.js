"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const staticRoot = path.join(__dirname, "../../main/resources/static");
const adapterSource = fs.readFileSync(path.join(staticRoot, "annotation-adapter.js"), "utf8");
const storeSource = fs.readFileSync(path.join(staticRoot, "annotation-store.js"), "utf8");
const html = fs.readFileSync(path.join(staticRoot, "index.html"), "utf8");

assert.match(html, /#current-image-name\.is-single-line/);
assert.match(html, /id="wsi-document-title"/);
assert.match(html, /data-normal-title="WSI Viewer"/);
assert.match(html, /<title[^>]*>WSI Viewer<\/title>/);
assert.match(html, /\.brand-title\s*\{[\s\S]*?linear-gradient\(145deg, #347fc2, #65a6df\)/);
assert.match(adapterSource, /static headerFolderLineIsPrefixOfSlide\(/);
assert.match(adapterSource, /static applyDocumentTitle\(/);

function createEl() {
    const classSet = new Set();
    return {
        textContent: "",
        hidden: false,
        classList: {
            add(name) { classSet.add(name); },
            remove(name) { classSet.delete(name); },
            contains(name) { return classSet.has(name); },
            toggle(name, force) {
                const on = force === undefined ? !classSet.has(name) : Boolean(force);
                if (on) classSet.add(name);
                else classSet.delete(name);
                return on;
            }
        }
    };
}

function headerDocument() {
    const caseEl = createEl();
    const detailEl = createEl();
    const selectedName = createEl();
    const currentName = createEl();
    const titleNode = { dataset: { normalTitle: "WSI Viewer", titlePrefix: "" }, textContent: "WSI Viewer" };
    const doc = {
        title: "WSI Viewer",
        caseEl,
        detailEl,
        selectedName,
        currentName,
        titleNode,
        getElementById(id) {
            if (id === "header-case-id") return caseEl;
            if (id === "header-slide-detail") return detailEl;
            if (id === "selected-name") return selectedName;
            if (id === "current-image-name") return currentName;
            if (id === "wsi-document-title") return titleNode;
            return null;
        },
        querySelector(sel) {
            return sel === "title" || sel === "head > title" ? titleNode : null;
        }
    };
    return doc;
}

const context = vm.createContext({
    console: { info() {}, warn() {}, error() {} },
    window: { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} },
    document: { getElementById() { return null; }, querySelectorAll() { return []; }, addEventListener() {} },
    fetch: null,
    WsiCsrf: { csrfFetch: async () => { throw new Error("unexpected save"); } }
});
vm.runInContext(`${storeSource}\nthis.AnnotationStore = AnnotationStore;`, context);
vm.runInContext(`${adapterSource}\nthis.AnnotationAdapter = AnnotationAdapter;`, context);
const { AnnotationAdapter } = context;

assert.equal(
    AnnotationAdapter.headerFolderLineIsPrefixOfSlide(
        "BS26-041340",
        "BS26-041340 A2-11_20260813_170501.vsi"
    ),
    true
);
assert.equal(
    AnnotationAdapter.headerFolderLineIsPrefixOfSlide(
        "bs26-041340",
        "BS26-041340_A2.vsi"
    ),
    true
);
assert.equal(
    AnnotationAdapter.headerFolderLineIsPrefixOfSlide("CASE-1", "Other_slide.vsi"),
    false
);
assert.equal(AnnotationAdapter.headerFolderLineIsPrefixOfSlide("CASE-1", ""), false);

{
    const doc = headerDocument();
    AnnotationAdapter.applyHeaderIdentity(doc, {
        name: "BS26-041340 A2-11_20260813_170501.vsi",
        relativePath: "BS26-041340/BS26-041340 A2-11_20260813_170501.vsi",
        folder: "BS26-041340"
    });
    assert.equal(doc.caseEl.hidden, true, "folder line must hide when the slide name starts with it");
    assert.equal(doc.caseEl.textContent, "");
    assert.equal(doc.detailEl.hidden, false);
    assert.equal(doc.detailEl.textContent, "BS26-041340 A2-11_20260813_170501.vsi");
    assert.equal(doc.currentName.classList.contains("is-single-line"), true);
    assert.equal(doc.selectedName.textContent, "BS26-041340 A2-11_20260813_170501.vsi");
    assert.equal(doc.title, "WSI Viewer BS26-041340 A2-11_20260813_170501.vsi");
}

{
    const doc = headerDocument();
    AnnotationAdapter.applyHeaderIdentity(doc, {
        name: "Other_slide.vsi",
        relativePath: "BS26-041340/Other_slide.vsi",
        folder: "BS26-041340"
    });
    assert.equal(doc.caseEl.hidden, false, "keep the folder line when the slide name does not start with it");
    assert.equal(doc.caseEl.textContent, "BS26-041340");
    assert.equal(doc.detailEl.textContent, "Other_slide.vsi");
    assert.equal(doc.currentName.classList.contains("is-single-line"), false);
    assert.equal(doc.title, "WSI Viewer Other_slide.vsi");
}

{
    const doc = headerDocument();
    doc.titleNode.dataset.titlePrefix = "[DEV]";
    assert.equal(AnnotationAdapter.applyDocumentTitle("", doc), "[DEV] WSI Viewer");
    assert.equal(
        AnnotationAdapter.applyDocumentTitle("slide.vsi", doc),
        "[DEV] WSI Viewer slide.vsi"
    );
}

console.log("header identity checks passed");
