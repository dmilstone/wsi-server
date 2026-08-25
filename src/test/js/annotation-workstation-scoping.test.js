"use strict";

/**
 * Regression coverage for per-workstation annotation isolation:
 *  - AnnotationStore.prefetchImage() / save() must attach the X-WSI-User header
 *    (previously silently dropped, so every browser fell into the shared "local"
 *    backend bucket regardless of its own generated workstation id).
 *  - The web host's own loopback-accessed browser (localhost/127.0.0.1/::1) always
 *    resolves to the canonical "local" identity, so annotations that predate this
 *    scoping stay exactly where they already are on disk.
 *  - Any other hostname (a genuinely different physical workstation reaching the
 *    server over the network) gets its own generated, cached, non-"local" id.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const staticRoot = path.join(__dirname, "../../main/resources/static");
const storeSource = fs.readFileSync(path.join(staticRoot, "annotation-store.js"), "utf8");

function freshContext(hostname) {
    const context = vm.createContext({
        console: { info() {}, warn() {}, error() {} },
        window: { setTimeout, clearTimeout, location: { hostname } },
        document: undefined,
        fetch: null,
        WsiCsrf: { csrfFetch: async () => { throw new Error("unexpected save"); } }
    });
    vm.runInContext(`${storeSource}\nthis.AnnotationStore = AnnotationStore;`, context);
    return context;
}

(async () => {
    // isWebHostLoopback() recognizes every loopback-style hostname, and rejects a
    // real LAN address / remote hostname (a genuinely different workstation).
    for (const hostname of ["localhost", "127.0.0.1", "::1", ""]) {
        const { AnnotationStore } = freshContext(hostname);
        assert.equal(AnnotationStore.isWebHostLoopback(), true, `expected loopback for "${hostname}"`);
    }
    for (const hostname of ["192.168.1.42", "workstation-2.local", "example.com"]) {
        const { AnnotationStore } = freshContext(hostname);
        assert.equal(AnnotationStore.isWebHostLoopback(), false, `expected non-loopback for "${hostname}"`);
    }

    // The host machine's own browser always resolves to "local", regardless of
    // whether some other, unrelated random id happens to already be cached.
    {
        const { AnnotationStore } = freshContext("localhost");
        AnnotationStore.workstationUserIdCache = "some-stale-random-id";
        assert.equal(AnnotationStore.resolveWorkstationUserId(), "local");
    }

    // A genuinely different workstation (reached over the network, not loopback)
    // gets its own generated id, distinct from "local", stable across repeat calls.
    {
        const { AnnotationStore } = freshContext("192.168.1.42");
        const first = AnnotationStore.resolveWorkstationUserId();
        assert.notEqual(first, "local");
        assert.ok(first.length > 0);
        assert.equal(AnnotationStore.resolveWorkstationUserId(), first, "id must be stable/cached");
    }

    // prefetchImage() (GET) must send X-WSI-User with the resolved workstation id.
    {
        const context = freshContext("localhost");
        const { AnnotationStore } = context;
        let seenHeaders = null;
        context.fetch = async (url, options) => {
            seenHeaders = options?.headers || null;
            return { ok: true, json: async () => ({ version: 1, imageId: "slide-1", annotations: [] }) };
        };
        await AnnotationStore.prefetchImage("slide-1");
        assert.equal(seenHeaders?.[AnnotationStore.USER_HEADER], "local");
    }

    // save() (PUT) must also send X-WSI-User with the same resolved id.
    {
        const context = freshContext("192.168.1.42");
        const { AnnotationStore } = context;
        const expectedId = AnnotationStore.resolveWorkstationUserId();
        let seenHeaders = null;
        context.WsiCsrf.csrfFetch = async (url, options) => {
            seenHeaders = options?.headers || null;
            return { ok: true, json: async () => JSON.parse(options.body) };
        };
        const store = new AnnotationStore({});
        store.currentImageId = "slide-1";
        store.currentCollection = {
            version: 1, imageId: "slide-1", slidePath: "x", userId: expectedId, modifiedAt: null, annotations: []
        };
        store.changeVersion = 1;
        await store.save();
        assert.equal(seenHeaders?.[AnnotationStore.USER_HEADER], expectedId);
        assert.notEqual(expectedId, "local");
    }

    console.log("annotation workstation scoping checks passed");
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
