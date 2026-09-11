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
    window: { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} },
    document: { getElementById() { return null; }, querySelectorAll() { return []; }, addEventListener() {} },
    fetch: null,
    Event,
    WeakMap,
    WsiCsrf: { csrfFetch: async () => { throw new Error("unexpected save"); } }
});
vm.runInContext(`${storeSource}\nthis.AnnotationStore = AnnotationStore;`, context);
vm.runInContext(`${adapterSource}\nthis.AnnotationAdapter = AnnotationAdapter;`, context);
const { AnnotationAdapter } = context;

const ALL = AnnotationAdapter.CASE_FILTER_ALL_SLIDES_VALUE;
const records = [
    { value: ALL, label: "All Slides" },
    { value: "BA26-041340", label: "BA26-041340" },
    { value: "BS26-000111", label: "BS26-000111" }
];

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

assert.deepEqual(
    plain(AnnotationAdapter.filterCaseFilterOptions(records, "")),
    records,
    "empty query keeps All Slides and every case"
);
assert.deepEqual(
    plain(AnnotationAdapter.filterCaseFilterOptions([
        { value: "", label: "-- Select Slides --" },
        ...records
    ], "  ")),
    records,
    "placeholder rows are never pickable"
);
assert.deepEqual(
    plain(AnnotationAdapter.filterCaseFilterOptions(records, "ba26")),
    [{ value: "BA26-041340", label: "BA26-041340" }]
);
assert.deepEqual(
    plain(AnnotationAdapter.filterCaseFilterOptions(records, "041")),
    [{ value: "BA26-041340", label: "BA26-041340" }]
);
assert.deepEqual(
    plain(AnnotationAdapter.filterCaseFilterOptions(records, "ALL")),
    [{ value: ALL, label: "All Slides" }]
);
assert.deepEqual(
    plain(AnnotationAdapter.filterCaseFilterOptions(records, "zzz")),
    []
);

{
    const select = {
        options: [
            { value: "", textContent: "-- Select Slides --" },
            { value: ALL, textContent: "All Slides" },
            { value: "BA26-041340", textContent: "BA26-041340" }
        ]
    };
    assert.deepEqual(plain(AnnotationAdapter.listCaseFilterOptions(select)), [
        { value: ALL, label: "All Slides" },
        { value: "BA26-041340", label: "BA26-041340" }
    ]);
}

{
    const changes = [];
    const select = {
        value: "",
        selectedOptions: [{ textContent: "-- Select Slides --" }],
        addEventListener(type, fn) { (this._listeners ||= {})[type] = fn; },
        dispatchEvent(event) {
            changes.push(event.type);
            this._listeners?.[event.type]?.(event);
            return true;
        }
    };
    assert.equal(AnnotationAdapter.caseFilterDisplayLabel(select), "");
    assert.equal(AnnotationAdapter.applyCaseFilterComboboxChoice(select, ALL), true);
    assert.equal(select.value, ALL);
    assert.deepEqual(changes, ["change"]);
    select.selectedOptions = [{ textContent: "All Slides" }];
    assert.equal(AnnotationAdapter.caseFilterDisplayLabel(select), "All Slides");
    assert.equal(AnnotationAdapter.applyCaseFilterComboboxChoice(select, ALL), false);
    assert.deepEqual(changes, ["change"], "same value must not dispatch a second change");
    assert.equal(AnnotationAdapter.applyCaseFilterComboboxChoice(select, "BA26-041340"), true);
    assert.equal(select.value, "BA26-041340");
    assert.deepEqual(changes, ["change", "change"]);
}

{
    const list = { style: {}, parentNode: null };
    const body = { children: [], append(node) { this.children.push(node); node.parentNode = this; } };
    const view = { innerHeight: 800 };
    const input = {
        getBoundingClientRect() { return { left: 40, top: 48, bottom: 80, width: 180 }; }
    };
    const select = {
        closest() {
            return {
                querySelector(sel) {
                    if (sel === "#case-filter-search" || sel === ".case-filter-search") return input;
                    if (sel === "#case-filter-listbox" || sel === ".case-filter-listbox") return list;
                    return null;
                }
            };
        },
        ownerDocument: { body, getElementById() { return null; }, defaultView: view },
        dataset: {}
    };
    AnnotationAdapter.ensureCaseFilterListboxPortal(select);
    assert.equal(list.parentNode, body, "listbox must leave the clipping toolbar");
    assert.equal(AnnotationAdapter.positionCaseFilterListbox(select), true);
    assert.equal(list.style.position, "fixed");
    assert.equal(list.style.left, "40px");
    assert.equal(list.style.top, "82px");
    assert.equal(list.style.bottom, "auto");
    assert.equal(list.style.width, "180px");
    assert.equal(list.style.maxHeight, "712px");
}

{
    const list = { style: {} };
    const input = {
        getBoundingClientRect() { return { left: 40, top: 700, bottom: 732, width: 180 }; }
    };
    const select = {
        closest() {
            return {
                querySelector(sel) {
                    if (sel === "#case-filter-search" || sel === ".case-filter-search") return input;
                    if (sel === "#case-filter-listbox" || sel === ".case-filter-listbox") return list;
                    return null;
                }
            };
        },
        ownerDocument: { defaultView: { innerHeight: 768 }, getElementById() { return null; } }
    };
    assert.equal(AnnotationAdapter.positionCaseFilterListbox(select), true);
    assert.equal(list.style.top, "auto");
    assert.equal(list.style.bottom, "70px");
    assert.equal(list.style.maxHeight, "692px");
}

assert.match(html, /id="case-filter-combobox"/);
assert.match(html, /id="case-filter-search"/);
assert.match(html, /id="case-filter-listbox"/);
assert.match(html, /id="case-filter-select"/);
assert.match(html, /role="combobox"/);
assert.match(html, /placeholder="Search slides\.\.\."/);
assert.match(html, /Search slides in the upper left/);
assert.match(html, /annotation-adapter\.js\?v=20260911-ai-plugins-fix/);
assert.match(html, /environment-ui\.js\?v=20260908-window-title/);
assert.match(html, /id="wsi-document-title"/);
assert.match(html, /app-header-brand-left[\s\S]*id="case-filter-combobox"/);
assert.match(html, /app-header-brand-right/);
assert.doesNotMatch(html, /class="brand-mark"/);
assert.doesNotMatch(html, /id="sidebar-header-controls"[\s\S]*id="case-filter-combobox"/);
assert.match(adapterSource, /Search slides in the upper left/);
assert.match(adapterSource, /No matching slides/);
assert.doesNotMatch(html, /id="case-selector"/);
assert.doesNotMatch(html, /id="case-search-input"/);
assert.doesNotMatch(html, /window\.cachedCaseList/);
assert.match(adapterSource, /static filterCaseFilterOptions\(/);
assert.match(adapterSource, /static applyCaseFilterComboboxChoice\(/);
assert.match(adapterSource, /static bindSearchableCaseFilter\(/);
assert.match(adapterSource, /static ensureCaseFilterListboxPortal\(/);
assert.match(html, /max-height:\s*calc\(100vh - 48px\)/);
assert.match(adapterSource, /list\.style\.maxHeight/);
assert.match(adapterSource, /overflow-y: hidden/);
assert.match(adapterSource, /dispatchEvent\(new EventCtor\("change"/);
assert.doesNotMatch(adapterSource, /window\.cachedCaseList/);

console.log("case-filter-combobox.test.js: ok");
