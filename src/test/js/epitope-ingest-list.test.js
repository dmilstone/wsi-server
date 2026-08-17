"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const staticRoot = path.join(__dirname, "../../main/resources/static");
const adapterSource = fs.readFileSync(path.join(staticRoot, "annotation-adapter.js"), "utf8");
const html = fs.readFileSync(path.join(staticRoot, "index.html"), "utf8");

function node(tag = "div") {
    const children = [];
    const attrs = {};
    const dataset = {};
    const klass = new Set();
    const el = {
        tagName: String(tag).toUpperCase(),
        children,
        dataset,
        hidden: false,
        textContent: "",
        className: "",
        style: {},
        classList: {
            add(name) { klass.add(name); },
            remove(name) { klass.delete(name); },
            contains(name) { return klass.has(name) || String(el.className).split(/\s+/).includes(name); }
        },
        querySelector(sel) {
            const name = String(sel || "").replace(/^\./, "");
            return children.find((c) => c.classList.contains(name) || String(c.className).split(/\s+/).includes(name)) || null;
        },
        append(...nodes) {
            for (const child of nodes) {
                child.parent = el;
                children.push(child);
            }
        },
        addEventListener() {},
        setAttribute(name, value) { attrs[name] = value; }
    };
    el.after = (other) => {
        const parent = el.parent;
        if (!parent) return;
        const idx = parent.children.indexOf(el);
        parent.children.splice(idx + 1, 0, other);
        other.parent = parent;
    };
    return el;
}

const created = [];
const context = vm.createContext({
    console: { info() {}, warn() {}, error() {} },
    window: { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} },
    document: {
        getElementById() { return null; },
        addEventListener() {},
        createElement(tag) {
            const el = node(tag);
            created.push(el);
            return el;
        }
    },
    fetch: null,
    WsiCsrf: { csrfFetch: async () => { throw new Error("unexpected save"); } }
});
vm.runInContext(
    `${fs.readFileSync(path.join(staticRoot, "annotation-store.js"), "utf8")}\nthis.AnnotationStore = AnnotationStore;`,
    context
);
vm.runInContext(`${adapterSource}\nthis.AnnotationAdapter = AnnotationAdapter;`, context);
const { AnnotationAdapter } = context;

{
    const image = {
        id: "slide-1",
        name: "BA26.vsi",
        relativePath: "case/BA26.vsi",
        clinicalMarker: "if.IgG"
    };
    const { row, button } = AnnotationAdapter.createSlideRow(
        context.document,
        image,
        "BA26",
        "",
        () => {}
    );
    assert.equal(row, button);
    assert.match(String(button.className), /image-button/);
    const epitope = button.querySelector(".ocr-result-text");
    assert.ok(epitope);
    assert.equal(epitope.textContent, "if.IgG");
    assert.equal(button.children[0].textContent, "BA26");
    assert.equal(button.children[1], epitope);
}

assert.doesNotMatch(adapterSource, /slide-row-expand/);
assert.doesNotMatch(adapterSource, /slide-row-body/);
assert.match(adapterSource, /label\.after\(result\)/);
assert.match(html, /z-index:\s*1000/);
assert.match(adapterSource, /allowBrowserFallback === true/);
assert.match(adapterSource, /scheduleSidebarClinicalOcrBatch\(container/);

console.log("epitope-ingest-list.test.js: ok");
