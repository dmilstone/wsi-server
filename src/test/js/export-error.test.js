"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(
    path.join(__dirname, "../../main/resources/static/index.html"),
    "utf8"
);

function extractFunction(name) {
    const match = html.match(new RegExp(`(?:async\\s+)?function ${name}\\([\\s\\S]*?\\n    \\}`));
    assert.ok(match, `missing ${name} in index.html`);
    return match[0];
}

function extractConst(name) {
    const match = html.match(new RegExp(`const ${name}\\s*=\\s*([\\s\\S]*?);`));
    assert.ok(match, `missing ${name} in index.html`);
    return `const ${name} = ${match[1]};`;
}

const context = vm.createContext({});
vm.runInContext(
    [
        extractConst("EXPORT_TOO_LARGE_CODE"),
        extractConst("EXPORT_TOO_LARGE_MESSAGE"),
        extractConst("EXPORT_GENERIC_FAILURE_MESSAGE"),
        extractFunction("isExportTooLargePayload"),
        extractFunction("messageFromExportErrorPayload"),
        extractFunction("readExportFailureMessage"),
        "this.EXPORT_TOO_LARGE_CODE = EXPORT_TOO_LARGE_CODE;",
        "this.EXPORT_TOO_LARGE_MESSAGE = EXPORT_TOO_LARGE_MESSAGE;",
        "this.EXPORT_GENERIC_FAILURE_MESSAGE = EXPORT_GENERIC_FAILURE_MESSAGE;",
        "this.isExportTooLargePayload = isExportTooLargePayload;",
        "this.messageFromExportErrorPayload = messageFromExportErrorPayload;",
        "this.readExportFailureMessage = readExportFailureMessage;"
    ].join("\n"),
    context
);

const {
    EXPORT_TOO_LARGE_CODE,
    EXPORT_TOO_LARGE_MESSAGE,
    EXPORT_GENERIC_FAILURE_MESSAGE,
    isExportTooLargePayload,
    messageFromExportErrorPayload,
    readExportFailureMessage
} = context;

test("export error constants and oversized detection", () => {
    assert.equal(EXPORT_TOO_LARGE_CODE, "EXPORT_TOO_LARGE");
    assert.equal(
        EXPORT_TOO_LARGE_MESSAGE,
        "Export failed: the requested region is too large to export at native resolution. Zoom in or select a smaller region and try again."
    );
    assert.equal(
        EXPORT_GENERIC_FAILURE_MESSAGE,
        "Export failed. Please try again or choose a smaller region."
    );

    assert.equal(
        isExportTooLargePayload({ code: "EXPORT_TOO_LARGE", detail: "anything" }),
        true
    );
    assert.equal(
        isExportTooLargePayload({
            detail: "Export exceeds the configured maximum of 16000000 pixels."
        }),
        true
    );
    assert.equal(
        isExportTooLargePayload({
            detail: "Export region must be contained within the image."
        }),
        false
    );
});

test("maps oversized and meaningful backend export errors", () => {
    assert.equal(
        messageFromExportErrorPayload({
            code: "EXPORT_TOO_LARGE",
            detail: "Export exceeds the configured maximum of 16000000 pixels."
        }),
        EXPORT_TOO_LARGE_MESSAGE
    );
    assert.equal(
        messageFromExportErrorPayload({
            detail: "Export region must be contained within the image."
        }),
        "Export region must be contained within the image."
    );
    assert.equal(messageFromExportErrorPayload({}), "");
});

test("readExportFailureMessage maps oversized, backend detail, and parse failure", async () => {
    const oversized = await readExportFailureMessage({
        async json() {
            return {
                code: "EXPORT_TOO_LARGE",
                detail: "Export exceeds the configured maximum of 16000000 pixels.",
                title: "Export region too large",
                status: 400
            };
        }
    });
    assert.equal(oversized, EXPORT_TOO_LARGE_MESSAGE);

    const meaningful = await readExportFailureMessage({
        async json() {
            return {
                detail: "Export region must be contained within the image.",
                title: "Invalid export request",
                status: 400
            };
        }
    });
    assert.equal(meaningful, "Export region must be contained within the image.");

    const generic = await readExportFailureMessage({
        async json() {
            throw new Error("not json");
        }
    });
    assert.equal(generic, EXPORT_GENERIC_FAILURE_MESSAGE);
});

test("export success and shared failure UI wiring", () => {
    assert.match(html, /function reportExportFailure\(/);
    assert.match(html, /id="export-error-dialog"/);
    assert.match(html, /function showExportErrorDialog\(/);
    assert.match(
        html,
        /async function exportVisibleRegion\(\)[\s\S]*reportExportFailure\(error\)/
    );
    assert.match(
        html,
        /async function exportSelectedAnnotation\(\)[\s\S]*reportExportFailure\(error\)/
    );
    assert.match(
        html,
        /downloadName:\s*buildExportDownloadName\(selectedImage\?\.name,\s*annotationName\)/
    );
    assert.match(html, /scale:\s*String\(scale\)/);
    assert.match(html, /function exportScaleForRegion\([\s\S]*return 1;/);
    assert.match(html, /if\s*\(!response\.ok\)\s*\{[\s\S]*readExportFailureMessage\(response\)/);
    assert.match(html, /URL\.createObjectURL\(await response\.blob\(\)\)/);
    assert.match(html, /statusElement\.textContent = "Visible region exported\."/);
    assert.match(html, /statusElement\.textContent = "Selected annotation exported\."/);
});
