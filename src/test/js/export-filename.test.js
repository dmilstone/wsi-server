"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(
    path.join(__dirname, "../../main/resources/static/index.html"),
    "utf8"
);

function extractFunction(name) {
    const match = html.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n    \\}`));
    assert.ok(match, `missing ${name} in index.html`);
    return match[0];
}

const context = vm.createContext({});
vm.runInContext(
    [
        "const MAX_EXPORT_FILENAME_PART = 80;",
        extractFunction("sanitizeExportFilenamePart"),
        extractFunction("buildExportDownloadName"),
        "this.sanitizeExportFilenamePart = sanitizeExportFilenamePart;",
        "this.buildExportDownloadName = buildExportDownloadName;"
    ].join("\n"),
    context
);

const { sanitizeExportFilenamePart, buildExportDownloadName } = context;

assert.equal(sanitizeExportFilenamePart("Tumor  A"), "Tumor-A");
assert.equal(sanitizeExportFilenamePart('a/b\\c:d*e?f"g<h>i|j'), "a-b-c-d-e-f-g-h-i-j");
assert.equal(sanitizeExportFilenamePart("  ..hidden..  "), "hidden");
assert.equal(sanitizeExportFilenamePart(""), "");
assert.equal(sanitizeExportFilenamePart(null), "");
assert.ok(sanitizeExportFilenamePart("x".repeat(120)).length <= 80);

assert.equal(
    buildExportDownloadName("Sample_Slide.vsi", "Region 1"),
    "Sample_Slide-Region-1.png"
);
assert.equal(
    buildExportDownloadName("Sample_Slide.vsi", 'Tumor / "edge"'),
    "Sample_Slide-Tumor-edge.png"
);
assert.equal(
    buildExportDownloadName("Sample_Slide.vsi", null),
    "Sample_Slide-region.png"
);
assert.equal(
    buildExportDownloadName("Sample_Slide.vsi", "   "),
    "Sample_Slide-region.png"
);
assert.equal(
    buildExportDownloadName("Sample_Slide.vsi", undefined),
    "Sample_Slide-region.png"
);
assert.equal(
    buildExportDownloadName("weird name?.ome.tiff", "focus"),
    "weird-name-.ome-focus.png"
);

// Selected-annotation export wires the filename helper into exportImageBounds.
assert.match(
    html,
    /downloadName:\s*buildExportDownloadName\(selectedImage\?\.name,\s*annotationName\)/
);
assert.match(
    html,
    /link\.download\s*=\s*options\.downloadName\s*\|\|\s*buildExportDownloadName\(selectedImage\.name\)/
);
assert.match(html, /const annotationName = annotationSpike\.adapter\?\.getAnnotationName\?\.\(annotation\.id\)/);

console.log("export filename checks passed");
