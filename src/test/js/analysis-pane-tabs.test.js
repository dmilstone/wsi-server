"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const staticRoot = path.join(__dirname, "../../main/resources/static");
const adapterSource = fs.readFileSync(path.join(staticRoot, "annotation-adapter.js"), "utf8");
const storeSource = fs.readFileSync(path.join(staticRoot, "annotation-store.js"), "utf8");
const html = fs.readFileSync(path.join(staticRoot, "index.html"), "utf8");

assert.match(html, /role="tablist"/);
assert.match(html, />Slides</);
assert.match(html, />Image</);
assert.match(html, />Annotations</);
assert.doesNotMatch(html, />Hierarchy</);
assert.doesNotMatch(html, />Workflow</);
assert.match(html, /id="qp-view-image"[\s\S]*id="image-info"/);
assert.match(html, /id="qp-annotation-list-title">Annotation list \(0\)</);
assert.doesNotMatch(html, /<details id="image-info"/);

function createEl(tag, attrs = {}) {
    const attributes = { ...attrs };
    const dataset = {};
    if (attrs.id) dataset.id = attrs.id;
    if (attrs["data-qp-view"]) dataset.qpView = attrs["data-qp-view"];
    const classSet = new Set(String(attrs.class || "").split(/\s+/).filter(Boolean));
    const listeners = {};
    let textContent = "";
    const el = {
        tagName: String(tag).toUpperCase(),
        id: attrs.id || "",
        hidden: Boolean(attrs.hidden),
        children: [],
        parent: null,
        dataset,
        attributes,
        listeners,
        get className() { return [...classSet].join(" "); },
        set className(value) {
            classSet.clear();
            String(value || "").split(/\s+/).filter(Boolean).forEach(name => classSet.add(name));
        },
        classList: {
            add(name) {
                classSet.add(name);
                el.className = [...classSet].join(" ");
            },
            remove(name) {
                classSet.delete(name);
                el.className = [...classSet].join(" ");
            },
            contains(name) { return classSet.has(name); },
            toggle(name, force) {
                const on = force === undefined ? !classSet.has(name) : Boolean(force);
                if (on) classSet.add(name);
                else classSet.delete(name);
                el.className = [...classSet].join(" ");
                return on;
            }
        },
        setAttribute(name, value) {
            attributes[name] = String(value);
            if (name === "data-qp-view") dataset.qpView = String(value);
            if (name === "data-annotation-id") dataset.annotationId = String(value);
        },
        getAttribute(name) { return Object.hasOwn(attributes, name) ? attributes[name] : null; },
        appendChild(child) {
            el.children.push(child);
            child.parent = el;
            return child;
        },
        append(...nodes) { nodes.forEach(node => el.appendChild(node)); },
        addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
        contains(node) {
            return el.children.includes(node)
                || el.children.some(child => child.contains?.(node));
        },
        closest(sel) {
            return matches(el, sel) ? el : (el.parent?.closest?.(sel) || null);
        },
        querySelector(sel) { return el.querySelectorAll(sel)[0] || null; },
        querySelectorAll(sel) {
            const out = [];
            const walk = node => {
                if (matches(node, sel)) out.push(node);
                (node.children || []).forEach(walk);
            };
            el.children.forEach(walk);
            return out;
        },
        focus() { el.focused = true; },
        get textContent() {
            if (el.children.length) return el.children.map(child => child.textContent).join("");
            return textContent;
        },
        set textContent(value) {
            textContent = String(value ?? "");
            el.children.length = 0;
        },
        dispatch(type, event = {}) {
            const payload = {
                target: event.target || el,
                key: event.key,
                shiftKey: Boolean(event.shiftKey),
                preventDefault() {},
                stopPropagation() {}
            };
            for (const fn of listeners[type] || []) fn(payload);
        }
    };
    if (attrs.role) el.setAttribute("role", attrs.role);
    if (attrs["aria-selected"]) el.setAttribute("aria-selected", attrs["aria-selected"]);
    if (attrs["data-qp-view"]) el.setAttribute("data-qp-view", attrs["data-qp-view"]);
    return el;
}

function matches(node, sel) {
    if (!node || !sel) return false;
    if (sel === "[role='tab'][data-qp-view]") {
        return node.getAttribute("role") === "tab"
            && Boolean(node.getAttribute("data-qp-view") || node.dataset?.qpView);
    }
    if (sel === ".qp-annotation-list-item") return node.classList.contains("qp-annotation-list-item");
    if (sel === ".qp-annotation-list-name") return node.classList.contains("qp-annotation-list-name");
    if (sel.startsWith("#")) return node.id === sel.slice(1);
    return false;
}

function analysisDocument() {
    const tabs = {
        slides: createEl("button", {
            id: "qp-tab-slides", role: "tab", "data-qp-view": "slides", "aria-selected": "true"
        }),
        image: createEl("button", {
            id: "qp-tab-image", role: "tab", "data-qp-view": "image", "aria-selected": "false"
        }),
        annotations: createEl("button", {
            id: "qp-tab-annotations", role: "tab", "data-qp-view": "annotations", "aria-selected": "false"
        })
    };
    const views = {
        slides: createEl("div", { id: "qp-view-slides", "data-qp-view": "slides" }),
        image: createEl("div", { id: "qp-view-image", "data-qp-view": "image", hidden: true }),
        annotations: createEl("div", { id: "qp-view-annotations", "data-qp-view": "annotations", hidden: true })
    };
    views.slides.hidden = false;
    views.image.hidden = true;
    views.annotations.hidden = true;
    const tablist = createEl("div", { id: "qp-analysis-tabs" });
    tablist.append(tabs.slides, tabs.image, tabs.annotations);
    const title = createEl("span", { id: "qp-annotation-list-title" });
    title.textContent = "Annotation list (0)";
    const list = createEl("ul", { id: "qp-annotation-list" });
    const byId = {
        "qp-analysis-tabs": tablist,
        "qp-tab-slides": tabs.slides,
        "qp-tab-image": tabs.image,
        "qp-tab-annotations": tabs.annotations,
        "qp-view-slides": views.slides,
        "qp-view-image": views.image,
        "qp-view-annotations": views.annotations,
        "qp-annotation-list-title": title,
        "qp-annotation-list": list
    };
    const doc = {
        byId,
        tabs,
        views,
        title,
        list,
        tablist,
        createElement: createEl,
        getElementById(id) { return byId[id] || null; },
        querySelector(sel) {
            if (sel.startsWith("#")) return byId[sel.slice(1)] || null;
            return tablist.querySelector(sel);
        },
        querySelectorAll(sel) {
            if (sel === "#qp-analysis-tabs [role='tab'][data-qp-view]"
                || sel === "[role='tab'][data-qp-view]") {
                return [tabs.slides, tabs.image, tabs.annotations];
            }
            return list.querySelectorAll(sel);
        },
        addEventListener() {}
    };
    return doc;
}

const documentStub = {
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    createElement() { return createEl("div"); }
};

const context = vm.createContext({
    console: { info() {}, warn() {}, error() {} },
    window: { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} },
    document: documentStub,
    fetch: null,
    WsiCsrf: { csrfFetch: async () => { throw new Error("unexpected save"); } }
});
vm.runInContext(`${storeSource}\nthis.AnnotationStore = AnnotationStore;`, context);
vm.runInContext(`${adapterSource}\nthis.AnnotationAdapter = AnnotationAdapter;`, context);
const { AnnotationAdapter } = context;

{
    const doc = analysisDocument();
    context.document = doc;
    assert.equal(AnnotationAdapter.setAnalysisPaneView("slides", doc), "slides");
    assert.equal(doc.tabs.slides.getAttribute("aria-selected"), "true");
    assert.equal(doc.views.slides.hidden, false);
    assert.equal(doc.views.image.hidden, true);
    assert.equal(doc.views.annotations.hidden, true);

    assert.equal(AnnotationAdapter.setAnalysisPaneView("image", doc), "image");
    assert.equal(doc.tabs.image.getAttribute("aria-selected"), "true");
    assert.equal(doc.tabs.slides.getAttribute("aria-selected"), "false");
    assert.equal(doc.views.image.hidden, false);
    assert.equal(doc.views.slides.hidden, true);
    assert.equal(doc.views.annotations.hidden, true);

    assert.equal(AnnotationAdapter.setAnalysisPaneView("annotations", doc), "annotations");
    assert.equal(doc.tabs.annotations.getAttribute("aria-selected"), "true");
    assert.equal(doc.views.annotations.hidden, false);
    assert.equal(doc.views.slides.hidden, true);
    assert.equal(doc.title.textContent, "Annotation list (0)");
    assert.equal(doc.list.children[0].textContent, "No annotations on this image.");
}

{
    const doc = analysisDocument();
    context.document = doc;
    AnnotationAdapter.bindAnalysisPaneTabs(doc);
    doc.tablist.dispatch("click", { target: doc.tabs.image });
    assert.equal(doc.views.image.hidden, false);
    assert.equal(doc.tabs.image.getAttribute("aria-selected"), "true");
    doc.tablist.dispatch("click", { target: doc.tabs.annotations });
    assert.equal(doc.views.annotations.hidden, false);
    doc.tablist.dispatch("click", { target: doc.tabs.slides });
    assert.equal(doc.views.slides.hidden, false);
    assert.equal(doc.views.annotations.hidden, true);
}

{
    const doc = analysisDocument();
    context.document = doc;
    AnnotationAdapter.selectedNativeAnnotationIds = new Set();
    AnnotationAdapter.selectedNativeAnnotationId = null;
    AnnotationAdapter.setSavedAnnotations([
        { id: "wand-id", type: "wand", name: "Germinal Center 1" },
        { id: "line-id", type: "line", name: null }
    ]);
    assert.equal(doc.title.textContent, "Annotation list (2)");
    const names = doc.list.querySelectorAll(".qp-annotation-list-name").map(node => node.textContent);
    assert.deepEqual(names, ["Germinal Center 1", "(unnamed)"]);
    assert.equal(
        AnnotationAdapter.annotationListDisplayName({ id: "wand-id", type: "wand", name: "Germinal Center 1" }),
        "Germinal Center 1"
    );
    assert.notEqual(
        AnnotationAdapter.annotationListDisplayName({ id: "line-id", type: "line", name: null }),
        "line1"
    );

    const first = doc.list.querySelectorAll(".qp-annotation-list-item")[0];
    first.dispatch("click");
    assert.equal(AnnotationAdapter.selectedNativeAnnotationId, "wand-id");
    assert.equal(doc.list.querySelectorAll(".qp-annotation-list-item")[0].classList.contains("is-selected"), true);

    const opened = [];
    const previous = AnnotationAdapter.openAnnotationNamePanelForShape;
    AnnotationAdapter.openAnnotationNamePanelForShape = id => {
        opened.push(id);
        return true;
    };
    doc.list.querySelectorAll(".qp-annotation-list-item")[0].dispatch("dblclick");
    assert.deepEqual(opened, ["wand-id"]);
    AnnotationAdapter.openAnnotationNamePanelForShape = previous;

    AnnotationAdapter.setAnalysisPaneView("slides", doc);
    assert.equal(AnnotationAdapter.savedAnnotationsArray.length, 2,
        "changing tabs must not clear annotations");
}

console.log("analysis pane tab checks passed");
