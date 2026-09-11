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
assert.match(html, />Hierarchy</);
assert.doesNotMatch(html, />Workflow</);
assert.match(html, /id="qp-view-hierarchy"/);
assert.match(html, /id="qp-hierarchy-tree"/);
assert.match(html, /Filter measurements by key/);
assert.match(html, />Measurements</);
assert.match(html, />Description</);
assert.match(html, /data-qp-hierarchy-action="expand"/);
assert.match(html, /data-qp-hierarchy-action="collapse"/);
assert.match(html, /data-qp-hierarchy-action="lock"/);
assert.match(html, /data-qp-hierarchy-action="delete"/);
assert.match(html, /data-qp-hierarchy-action="select-annotations"/);
assert.match(html, /data-qp-hierarchy-action="select-detections"/);
assert.match(html, /id="qp-view-image"[\s\S]*id="image-info"/);
assert.match(html, /id="qp-annotation-list-title">Annotation list \(0\)</);
assert.doesNotMatch(html, /<details id="image-info"/);

function createEl(tag, attrs = {}) {
    const attributes = { ...attrs };
    const dataset = {};
    if (attrs.id) dataset.id = attrs.id;
    if (attrs["data-qp-view"]) dataset.qpView = attrs["data-qp-view"];
    if (attrs["data-qp-hierarchy-action"]) dataset.qpHierarchyAction = attrs["data-qp-hierarchy-action"];
    if (attrs["data-qp-hierarchy-sort"]) dataset.qpHierarchySort = attrs["data-qp-hierarchy-sort"];
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
        style: {},
        get value() { return attributes.value || ""; },
        set value(next) { attributes.value = String(next ?? ""); },
        setAttribute(name, value) {
            attributes[name] = String(value);
            if (name === "data-qp-view") dataset.qpView = String(value);
            if (name === "data-annotation-id") dataset.annotationId = String(value);
            if (name === "data-qp-list-annotation-id") dataset.qpListAnnotationId = String(value);
            if (name === "data-qp-hierarchy-key") dataset.qpHierarchyKey = String(value);
            if (name === "data-qp-hierarchy-kind") dataset.qpHierarchyKind = String(value);
            if (name === "data-qp-hierarchy-action") dataset.qpHierarchyAction = String(value);
            if (name === "data-qp-hierarchy-lock") dataset.qpHierarchyLock = String(value);
            if (name === "data-qp-measure-key") dataset.qpMeasureKey = String(value);
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
    if (sel === ".qp-hierarchy-row") return node.classList.contains("qp-hierarchy-row");
    if (sel === ".qp-hierarchy-label") return node.classList.contains("qp-hierarchy-label");
    if (sel === ".qp-hierarchy-toolbar") return node.classList.contains("qp-hierarchy-toolbar");
    if (sel === ".qp-hierarchy-value-text") return node.classList.contains("qp-hierarchy-value-text");
    if (sel === "tr") return node.tagName === "TR";
    if (sel === "[data-qp-hierarchy-key]") {
        return Boolean(node.getAttribute("data-qp-hierarchy-key") || node.dataset?.qpHierarchyKey);
    }
    const hierarchyKey = sel.match(/^\[data-qp-hierarchy-key="([^"]+)"\]$/);
    if (hierarchyKey) {
        return (node.getAttribute("data-qp-hierarchy-key") || node.dataset?.qpHierarchyKey) === hierarchyKey[1];
    }
    if (sel === "[data-qp-hierarchy-action]") {
        return Boolean(node.getAttribute("data-qp-hierarchy-action") || node.dataset?.qpHierarchyAction);
    }
    if (sel === "[data-qp-hierarchy-sort]") {
        return Boolean(node.getAttribute("data-qp-hierarchy-sort") || node.dataset?.qpHierarchySort);
    }
    if (sel === "[data-qp-hierarchy-lock]") {
        return Boolean(node.getAttribute("data-qp-hierarchy-lock") || node.dataset?.qpHierarchyLock);
    }
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
        }),
        hierarchy: createEl("button", {
            id: "qp-tab-hierarchy", role: "tab", "data-qp-view": "hierarchy", "aria-selected": "false"
        })
    };
    const views = {
        slides: createEl("div", { id: "qp-view-slides", "data-qp-view": "slides" }),
        image: createEl("div", { id: "qp-view-image", "data-qp-view": "image", hidden: true }),
        annotations: createEl("div", { id: "qp-view-annotations", "data-qp-view": "annotations", hidden: true }),
        hierarchy: createEl("div", { id: "qp-view-hierarchy", "data-qp-view": "hierarchy", hidden: true })
    };
    views.slides.hidden = false;
    views.image.hidden = true;
    views.annotations.hidden = true;
    views.hierarchy.hidden = true;
    const tablist = createEl("div", { id: "qp-analysis-tabs" });
    tablist.append(tabs.slides, tabs.image, tabs.annotations, tabs.hierarchy);
    const title = createEl("span", { id: "qp-annotation-list-title" });
    title.textContent = "Annotation list (0)";
    const list = createEl("ul", { id: "qp-annotation-list" });
    const toolbar = createEl("div", { id: "qp-hierarchy-toolbar", class: "qp-hierarchy-toolbar" });
    const actions = {
        expand: createEl("button", { id: "qp-hierarchy-expand", "data-qp-hierarchy-action": "expand" }),
        collapse: createEl("button", { id: "qp-hierarchy-collapse", "data-qp-hierarchy-action": "collapse" }),
        lock: createEl("button", { id: "qp-hierarchy-lock", "data-qp-hierarchy-action": "lock" }),
        delete: createEl("button", { id: "qp-hierarchy-delete", "data-qp-hierarchy-action": "delete" }),
        selectAnnotations: createEl("button", {
            id: "qp-hierarchy-select-annotations", "data-qp-hierarchy-action": "select-annotations"
        }),
        selectDetections: createEl("button", {
            id: "qp-hierarchy-select-detections", "data-qp-hierarchy-action": "select-detections"
        })
    };
    Object.values(actions).forEach(button => {
        button.setAttribute("data-qp-hierarchy-action", button.attributes["data-qp-hierarchy-action"]);
        toolbar.appendChild(button);
    });
    const tree = createEl("div", { id: "qp-hierarchy-tree" });
    const crumb = createEl("div", { id: "qp-hierarchy-crumb" });
    crumb.textContent = "Image";
    const tableWrap = createEl("div", { id: "qp-hierarchy-table-wrap" });
    const table = createEl("table", { id: "qp-hierarchy-measurements" });
    const keyHeader = createEl("th", { "data-qp-hierarchy-sort": "key" });
    keyHeader.setAttribute("data-qp-hierarchy-sort", "key");
    keyHeader.textContent = "Key";
    const valueHeader = createEl("th", { "data-qp-hierarchy-sort": "value" });
    valueHeader.setAttribute("data-qp-hierarchy-sort", "value");
    valueHeader.textContent = "Value";
    table.append(keyHeader, valueHeader);
    const tbody = createEl("tbody", { id: "qp-hierarchy-measurements-body" });
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    const description = createEl("div", { id: "qp-hierarchy-description", hidden: true });
    const filter = createEl("input", { id: "qp-hierarchy-filter" });
    const measureTab = createEl("button", { id: "qp-hierarchy-tab-measurements" });
    const descTab = createEl("button", { id: "qp-hierarchy-tab-description" });
    measureTab.setAttribute("aria-selected", "true");
    descTab.setAttribute("aria-selected", "false");
    views.hierarchy.append(toolbar, tree, crumb, tableWrap, description, filter, measureTab, descTab);
    const byId = {
        "qp-analysis-tabs": tablist,
        "qp-tab-slides": tabs.slides,
        "qp-tab-image": tabs.image,
        "qp-tab-annotations": tabs.annotations,
        "qp-tab-hierarchy": tabs.hierarchy,
        "qp-view-slides": views.slides,
        "qp-view-image": views.image,
        "qp-view-annotations": views.annotations,
        "qp-view-hierarchy": views.hierarchy,
        "qp-annotation-list-title": title,
        "qp-annotation-list": list,
        "qp-hierarchy-toolbar": toolbar,
        "qp-hierarchy-expand": actions.expand,
        "qp-hierarchy-collapse": actions.collapse,
        "qp-hierarchy-lock": actions.lock,
        "qp-hierarchy-delete": actions.delete,
        "qp-hierarchy-select-annotations": actions.selectAnnotations,
        "qp-hierarchy-select-detections": actions.selectDetections,
        "qp-hierarchy-tree": tree,
        "qp-hierarchy-crumb": crumb,
        "qp-hierarchy-table-wrap": tableWrap,
        "qp-hierarchy-measurements": table,
        "qp-hierarchy-measurements-body": tbody,
        "qp-hierarchy-description": description,
        "qp-hierarchy-filter": filter,
        "qp-hierarchy-tab-measurements": measureTab,
        "qp-hierarchy-tab-description": descTab
    };
    const doc = {
        byId,
        tabs,
        views,
        title,
        list,
        tree,
        tbody,
        tablist,
        createElement: createEl,
        getElementById(id) { return byId[id] || null; },
        querySelector(sel) {
            if (sel.startsWith("#")) return byId[sel.slice(1)] || null;
            return tablist.querySelector(sel)
                || views.hierarchy.querySelector(sel)
                || list.querySelector(sel)
                || tree.querySelector(sel)
                || tbody.querySelector(sel);
        },
        querySelectorAll(sel) {
            if (sel === "#qp-analysis-tabs [role='tab'][data-qp-view]"
                || sel === "[role='tab'][data-qp-view]") {
                return [tabs.slides, tabs.image, tabs.annotations, tabs.hierarchy];
            }
            return [
                ...list.querySelectorAll(sel),
                ...tree.querySelectorAll(sel),
                ...tbody.querySelectorAll(sel),
                ...views.hierarchy.querySelectorAll(sel)
            ];
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
    assert.equal(doc.views.hierarchy.hidden, true);

    assert.equal(AnnotationAdapter.setAnalysisPaneView("image", doc), "image");
    assert.equal(doc.tabs.image.getAttribute("aria-selected"), "true");
    assert.equal(doc.tabs.slides.getAttribute("aria-selected"), "false");
    assert.equal(doc.views.image.hidden, false);
    assert.equal(doc.views.slides.hidden, true);
    assert.equal(doc.views.annotations.hidden, true);
    assert.equal(doc.views.hierarchy.hidden, true);

    assert.equal(AnnotationAdapter.setAnalysisPaneView("annotations", doc), "annotations");
    assert.equal(doc.tabs.annotations.getAttribute("aria-selected"), "true");
    assert.equal(doc.views.annotations.hidden, false);
    assert.equal(doc.views.slides.hidden, true);
    assert.equal(doc.title.textContent, "Annotation list (0)");
    assert.equal(doc.list.children[0].textContent, "No annotations on this image.");
    assert.equal(doc.views.hierarchy.hidden, true);

    assert.equal(AnnotationAdapter.setAnalysisPaneView("hierarchy", doc), "hierarchy");
    assert.equal(doc.tabs.hierarchy.getAttribute("aria-selected"), "true");
    assert.equal(doc.views.hierarchy.hidden, false);
    assert.equal(doc.views.annotations.hidden, true);
    assert.match(doc.tree.querySelector(".qp-hierarchy-label").textContent, /Image \(0 objects\)/);
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
    doc.tablist.dispatch("click", { target: doc.tabs.hierarchy });
    assert.equal(doc.views.hierarchy.hidden, false);
    assert.equal(doc.tabs.hierarchy.getAttribute("aria-selected"), "true");
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
    const previous = AnnotationAdapter.openAnnotationPropertiesDialog;
    AnnotationAdapter.openAnnotationPropertiesDialog = (_root, ids) => {
        opened.push(ids);
        return true;
    };
    doc.list.querySelectorAll(".qp-annotation-list-item")[0].dispatch("dblclick");
    assert.equal(opened.length, 1);
    assert.ok(Array.isArray(opened[0]));
    assert.equal(opened[0][0], "wand-id");
    AnnotationAdapter.openAnnotationPropertiesDialog = previous;

    AnnotationAdapter.setAnalysisPaneView("slides", doc);
    assert.equal(AnnotationAdapter.savedAnnotationsArray.length, 2,
        "changing tabs must not clear annotations");
}

{
    const doc = analysisDocument();
    context.document = doc;
    AnnotationAdapter.hierarchyExpandedKeys = new Set(["image"]);
    AnnotationAdapter.hierarchySelection = { kind: "image", annotationId: null, detectionIndex: null };
    AnnotationAdapter.selectedHierarchyDetectionIndex = null;
    AnnotationAdapter.hierarchyDetailTab = "measurements";
    AnnotationAdapter.hierarchyMeasureFilter = "";
    AnnotationAdapter.hierarchyMeasureSortKey = null;
    AnnotationAdapter.lockedAnnotationIds = new Set();
    AnnotationAdapter._lockedAnnotationsLoaded = true;
    AnnotationAdapter.selectedNativeAnnotationIds = new Set();
    AnnotationAdapter.selectedNativeAnnotationId = null;
    AnnotationAdapter.imageMetadata = {
        name: "spleen (tissue)",
        micronsPerPixelX: 0.5,
        micronsPerPixelY: 0.5
    };
    AnnotationAdapter.replaceLocalizedCellObjects([
        {
            id: "n1",
            cx: 15,
            cy: 15,
            pathClass: "GL7",
            vertices: [{ x: 14, y: 14 }, { x: 16, y: 14 }, { x: 15, y: 16 }]
        },
        {
            id: "n2",
            cx: 80,
            cy: 80,
            vertices: [{ x: 79, y: 79 }, { x: 81, y: 79 }, { x: 80, y: 81 }]
        }
    ]);
    AnnotationAdapter.lastNucleiCircles = AnnotationAdapter.localizedCellObjects.slice();
    AnnotationAdapter.setSavedAnnotations([
        { id: "roi", type: "rectangle", x: 10, y: 10, width: 20, height: 20, name: "GC" }
    ]);
    assert.equal(AnnotationAdapter.setAnalysisPaneView("hierarchy", doc), "hierarchy");
    AnnotationAdapter.expandHierarchyAll(doc);
    const labels = doc.tree.querySelectorAll(".qp-hierarchy-label").map(node => node.textContent);
    assert.ok(labels.some(text => /spleen \(tissue\) \(3 objects\)/.test(text)));
    assert.ok(labels.some(text => text.includes("GC")));
    assert.ok(labels.some(text => text.includes("Cell (GL7)")));
    assert.ok(labels.some(text => text === "Cell"));

    const annotationRow = doc.tree.querySelectorAll(".qp-hierarchy-row")
        .find(row => row.getAttribute("data-qp-hierarchy-key") === "annotation:roi");
    annotationRow.dispatch("click");
    assert.equal(AnnotationAdapter.selectedNativeAnnotationId, "roi");
    assert.equal(doc.getElementById("qp-hierarchy-crumb").textContent, "Image > GC");
    const annotationKeys = doc.tbody.querySelectorAll("tr").map(row =>
        row.children[0].textContent
    );
    assert.ok(annotationKeys.includes("Object type"));
    assert.ok(annotationKeys.includes("Classification"));
    assert.ok(annotationKeys.includes("ROI"));

    const detectionRow = doc.tree.querySelectorAll(".qp-hierarchy-row")
        .find(row => row.getAttribute("data-qp-hierarchy-key") === "detection:0");
    detectionRow.dispatch("click");
    assert.equal(AnnotationAdapter.selectedHierarchyDetectionIndex, 0);
    assert.equal(AnnotationAdapter.detectionIndexAtImagePoint(15, 15), 0);
    assert.equal(AnnotationAdapter.detectionIndexAtImagePoint(80, 80), 1);
    assert.equal(AnnotationAdapter.detectionIndexAtImagePoint(400, 400), null);
    const went = [];
    const previousGoTo = AnnotationAdapter.goToDetection;
    AnnotationAdapter.goToDetection = index => {
        went.push(index);
        return true;
    };
    detectionRow.dispatch("dblclick");
    assert.deepEqual(went, [0]);
    assert.equal(AnnotationAdapter.selectedHierarchyDetectionIndex, 0);
    AnnotationAdapter.goToDetection = previousGoTo;
    const menus = [];
    const previousMenu = AnnotationAdapter.openAnnotationContextMenu;
    AnnotationAdapter.openAnnotationContextMenu = (_ids, _x, _y, _root, options = {}) => {
        menus.push(options);
        return true;
    };
    detectionRow.dispatch("contextmenu");
    assert.equal(menus.length, 1);
    assert.equal(menus[0].kind, "detection");
    assert.equal(menus[0].indexes.length, 1);
    assert.equal(menus[0].indexes[0], 0);
    AnnotationAdapter.openAnnotationContextMenu = previousMenu;
    assert.match(doc.getElementById("qp-hierarchy-crumb").textContent, /Cell \(GL7\)/);
    const measureKeys = doc.tbody.querySelectorAll("tr").map(row => row.children[0].textContent);
    assert.ok(measureKeys.includes("Nucleus: Area"));
    assert.ok(measureKeys.includes("Nucleus: Perimeter"));
    assert.ok(measureKeys.includes("Nucleus: Circularity"));
    assert.ok(measureKeys.includes("Nucleus: Max caliper"));
    const classRow = doc.tbody.querySelectorAll("tr")
        .find(row => row.children[0].textContent === "Classification");
    assert.equal(classRow.querySelector(".qp-hierarchy-value-text").textContent, "GL7");

    AnnotationAdapter.hierarchyMeasureFilter = "nucleus";
    AnnotationAdapter.applyHierarchyMeasurementFilter(doc);
    const visible = doc.tbody.querySelectorAll("tr").filter(row => !row.hidden);
    assert.ok(visible.length >= 3);
    assert.ok(visible.every(row => String(row.getAttribute("data-qp-measure-key")).includes("nucleus")));

    AnnotationAdapter.setHierarchyDetailTab("description", doc);
    assert.equal(doc.getElementById("qp-hierarchy-description").hidden, false);
    assert.equal(doc.getElementById("qp-hierarchy-table-wrap").hidden, true);
    assert.match(doc.getElementById("qp-hierarchy-description").textContent, /Cell/);
    assert.match(doc.getElementById("qp-hierarchy-description").textContent, /GL7/);

    doc.getElementById("qp-hierarchy-select-annotations").dispatch("click");
    assert.equal(AnnotationAdapter.selectedNativeAnnotationId, "roi");
    assert.ok(AnnotationAdapter.selectedNativeAnnotationIds.has("roi"));
}

console.log("analysis pane tab checks passed");
