"use strict";

const assert = require("node:assert/strict");
const environmentUi = require("../../main/resources/static/environment-ui.js");

function fakeDocument() {
    const banner = {textContent: "", hidden: true};
    const classes = new Set();
    return {
        title: "Fluorescence Sample Viewer",
        body: {classList: {toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); }}},
        getElementById(id) { assert.equal(id, "environment-banner"); return banner; },
        querySelector(selector) {
            assert.equal(selector, "title");
            return {dataset: {normalTitle: "Fluorescence Sample Viewer"}};
        },
        banner,
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
