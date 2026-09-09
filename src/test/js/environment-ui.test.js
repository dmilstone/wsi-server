"use strict";

const assert = require("node:assert/strict");
const environmentUi = require("../../main/resources/static/environment-ui.js");

function fakeDocument() {
    const banner = {textContent: "", hidden: true};
    const titleNode = {dataset: {normalTitle: "Fluorescence Sample Viewer"}, textContent: "Fluorescence Sample Viewer"};
    const classes = new Set();
    return {
        title: "Fluorescence Sample Viewer",
        body: {classList: {toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); }}},
        getElementById(id) {
            if (id === "environment-banner") return banner;
            if (id === "wsi-document-title") return titleNode;
            return null;
        },
        querySelector(selector) {
            if (selector === "title" || selector === "head > title") return titleNode;
            return null;
        },
        banner,
        titleNode,
        classes
    };
}

for (const [environment, bannerText, title] of [
    ["production", "", "Fluorescence Sample Viewer"],
    ["staging", "STAGING — VALIDATION ONLY", "[STAGING] Fluorescence Sample Viewer"],
    ["development", "DEVELOPMENT — NOT FOR CLINICAL USE", "[DEV] Fluorescence Sample Viewer"]
]) {
    const documentObject = fakeDocument();
    environmentUi.apply(environment, documentObject);
    assert.equal(documentObject.banner.textContent, bannerText);
    assert.equal(documentObject.banner.hidden, environment === "production");
    assert.equal(documentObject.title, title);
    assert.equal(documentObject.classes.has("nonproduction-environment"), environment !== "production");
}

const unknownDocument = fakeDocument();
environmentUi.apply("untrusted markup", unknownDocument);
assert.equal(unknownDocument.banner.hidden, true);
assert.equal(unknownDocument.title, "Fluorescence Sample Viewer");

console.log("environment UI checks passed");
