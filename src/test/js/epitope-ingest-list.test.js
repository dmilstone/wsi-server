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
            add(name) {
                klass.add(name);
                const parts = new Set(String(el.className).split(/\s+/).filter(Boolean));
                parts.add(name);
                el.className = [...parts].join(" ");
            },
            remove(name) {
                klass.delete(name);
                el.className = String(el.className).split(/\s+/).filter((n) => n && n !== name).join(" ");
            },
            contains(name) { return klass.has(name) || String(el.className).split(/\s+/).includes(name); }
        },
        querySelector(sel) {
            const name = String(sel || "").replace(/^\./, "");
            const walk = (current) => {
                for (const child of current.children || []) {
                    if (child.classList.contains(name) || String(child.className).split(/\s+/).includes(name)) {
                        return child;
                    }
                    const nested = walk(child);
                    if (nested) return nested;
                }
                return null;
            };
            return walk(el);
        },
        append(...nodes) {
            for (const child of nodes) {
                child.parent = el;
                children.push(child);
            }
        },
        closest(sel) {
            const name = String(sel || "").replace(/^\./, "");
            let current = el;
            while (current) {
                if (current.classList?.contains?.(name) || String(current.className || "").split(/\s+/).includes(name)) {
                    return current;
                }
                current = current.parent;
            }
            return null;
        },
        addEventListener(type, handler) {
            el.listeners = el.listeners || {};
            el.listeners[type] = handler;
        },
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
    let selected = null;
    const { row, button } = AnnotationAdapter.createSlideRow(
        context.document,
        image,
        "BA26",
        "",
        (picked) => { selected = picked; }
    );
    assert.equal(row, button);
    assert.match(String(button.className), /image-button/);
    assert.match(String(button.className), /image-button-stack/);
    assert.match(String(button.className), /slide-list-row/);
    const info = button.querySelector(".slide-info-block");
    const topRow = button.querySelector(".slide-top-row");
    const second = button.querySelector(".slide-second-row");
    const epitopeCol = button.querySelector(".slide-epitope-col");
    const actions = button.querySelector(".slide-actions-col");
    const epitope = button.querySelector(".ocr-result-text");
    const title = button.querySelector(".image-button-label");
    assert.ok(info);
    assert.ok(topRow);
    assert.ok(second);
    assert.ok(epitopeCol);
    assert.ok(actions);
    assert.ok(epitope);
    assert.ok(title);
    assert.equal(title.textContent, "BA26");
    assert.equal(epitope.textContent, "if.IgG");
    assert.equal(epitope.hidden, false);
    assert.ok(epitope.classList.contains("ocr-result-ready"));
    assert.equal(epitope.classList.contains("hidden-ingestion"), false);
    assert.equal(topRow.children[0], title);
    assert.equal(epitopeCol.children[0], epitope);
    assert.equal(second.children[0], epitopeCol);
    assert.equal(second.children[1], actions);
    assert.equal(Boolean(button.listeners?.click), true);
    assert.equal(Boolean(epitope.listeners?.click), false);
    button.listeners.click({ target: epitope });
    assert.equal(selected, image);
}

{
    const image = {
        id: "slide-pending",
        name: "BA27.vsi",
        relativePath: "case/BA27.vsi",
        clinicalMarker: "if.Pending"
    };
    const { button } = AnnotationAdapter.createSlideRow(
        context.document,
        image,
        "BA27",
        "",
        () => {}
    );
    const epitope = button.querySelector(".ocr-result-text");
    const title = button.querySelector(".image-button-label");
    assert.ok(epitope);
    assert.ok(title);
    assert.equal(title.textContent, "BA27");
    assert.equal(epitope.textContent, "");
    assert.equal(epitope.hidden, false);
    assert.equal(epitope.classList.contains("hidden-ingestion"), false);
    assert.equal(epitope.classList.contains("ocr-result-ready"), false);
    assert.equal(epitope.classList.contains("ocr-result-raw"), false);
    assert.equal(epitope.classList.contains("ocr-result-pending"), false);
}

assert.doesNotMatch(adapterSource, /slide-row-expand/);
assert.doesNotMatch(adapterSource, /slide-row-body/);
assert.match(adapterSource, /label\.after\(result\)|slide-epitope-col/);
assert.match(adapterSource, /image-button-stack/);
assert.match(adapterSource, /slide-list-row/);
assert.match(adapterSource, /slide-info-block/);
assert.match(adapterSource, /slide-top-row/);
assert.match(adapterSource, /slide-second-row/);
assert.match(adapterSource, /slide-actions-col/);
assert.match(html, /\.slide-list-row/);
assert.match(html, /\.slide-info-block/);
assert.match(html, /\.slide-top-row/);
assert.match(html, /\.slide-second-row/);
assert.match(html, /\.slide-epitope-col/);
assert.match(html, /\.slide-actions-col/);
assert.match(html, /flex-direction:\s*column/);
assert.match(html, /justify-content:\s*space-between/);
assert.match(html, /font-size:\s*1\.15rem/);
assert.match(html, /padding-bottom:\s*4px/);
assert.doesNotMatch(html, /\.hidden-ingestion/);
assert.doesNotMatch(adapterSource, /maskUnvettedSidecar/);
assert.match(adapterSource, /applyAnnotationOverlayOffset/);
assert.match(adapterSource, /translate\(-50%, -130%\)/);
assert.match(adapterSource, /allowBrowserFallback === true/);
assert.match(html, /id="reset-viewport-home-btn"/);
assert.match(html, />🏠<\/button>/);
assert.match(html, /border-radius:\s*12px/);
assert.match(html, /font-size:\s*0\.8rem/);
assert.match(adapterSource, /bindResetViewportHomeButton/);
assert.match(adapterSource, /viewport\.goHome/);

console.log("epitope-ingest-list.test.js: ok");
