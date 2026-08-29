"use strict";

/**
 * Regression coverage for AnnotationStore.prefetchImage()'s caching/dedup
 * mechanics (see commit "Restore annotation prefetch caching"). This is the
 * mechanism that lets selectImage() in index.html kick off the annotations
 * GET immediately -- in parallel with the slide's metadata/display fetches
 * and any pending save-flush for the previously viewed slide -- instead of
 * fetching them sequentially after everything else finishes. store.load()
 * then reuses whichever promise is already in flight rather than issuing a
 * second GET, so the win only holds up if the cache actually dedupes/hits
 * correctly. None of that behavior had a dedicated test before this file --
 * the only existing coverage (annotation-workstation-scoping.test.js) checks
 * the X-WSI-User header, not the caching itself -- so a future refactor could
 * silently reintroduce the old sequential-latency behavior without anything
 * catching it.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const staticRoot = path.join(__dirname, "../../main/resources/static");
const storeSource = fs.readFileSync(path.join(staticRoot, "annotation-store.js"), "utf8");

function freshContext(hostname = "localhost") {
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

function okResponse(collection) {
    return { ok: true, json: async () => collection };
}

function failResponse(status = 500, statusText = "Server Error") {
    return { ok: false, status, statusText, text: async () => "" };
}

(async () => {
    // Two calls for the same image issued back-to-back, before the first fetch
    // resolves, must share exactly one in-flight request -- the whole point of
    // caching by promise (not by resolved value) is to dedupe concurrent callers,
    // e.g. selectImage()'s early prefetch racing store.load()'s own call.
    {
        const context = freshContext();
        const { AnnotationStore } = context;
        let fetchCallCount = 0;
        let resolveFetch;
        context.fetch = () => {
            fetchCallCount += 1;
            return new Promise(resolve => {
                resolveFetch = () => resolve(okResponse({ version: 1, imageId: "slide-1", annotations: [{ id: "a1" }] }));
            });
        };

        const first = AnnotationStore.prefetchImage("slide-1");
        const second = AnnotationStore.prefetchImage("slide-1");
        assert.equal(fetchCallCount, 1, "concurrent calls for the same image must share one in-flight fetch");
        assert.equal(first, second, "must return the exact same promise, not just eventually-equal data");

        resolveFetch();
        const [r1, r2] = await Promise.all([first, second]);
        assert.equal(r1, r2);
        assert.equal(r1.annotations.length, 1);
    }

    // A later call, after the first has already resolved, must hit the cache
    // instead of the network -- this is the "revisit a slide" case.
    {
        const context = freshContext();
        const { AnnotationStore } = context;
        let fetchCallCount = 0;
        context.fetch = () => {
            fetchCallCount += 1;
            return Promise.resolve(okResponse({ version: 1, imageId: "slide-1", annotations: [] }));
        };

        const first = await AnnotationStore.prefetchImage("slide-1");
        const second = await AnnotationStore.prefetchImage("slide-1");
        assert.equal(fetchCallCount, 1, "a cached image must not be re-fetched on a later call");
        assert.equal(first, second);
    }

    // Different images must not collide in the cache -- each gets its own fetch.
    {
        const context = freshContext();
        const { AnnotationStore } = context;
        const requestedUrls = [];
        context.fetch = url => {
            requestedUrls.push(url);
            return Promise.resolve(okResponse({ version: 1, imageId: url, annotations: [] }));
        };

        await AnnotationStore.prefetchImage("slide-1");
        await AnnotationStore.prefetchImage("slide-2");
        assert.equal(requestedUrls.length, 2, "two distinct images must each trigger their own fetch");
        assert.notEqual(requestedUrls[0], requestedUrls[1]);
    }

    // A failed fetch must evict its own cache entry so a later call actually
    // retries over the network, instead of being stuck forever on the same
    // rejected promise (which would permanently break that slide's annotations).
    {
        const context = freshContext();
        const { AnnotationStore } = context;
        let fetchCallCount = 0;
        context.fetch = () => {
            fetchCallCount += 1;
            return Promise.resolve(
                fetchCallCount === 1
                    ? failResponse()
                    : okResponse({ version: 1, imageId: "slide-1", annotations: [] })
            );
        };

        await assert.rejects(() => AnnotationStore.prefetchImage("slide-1"));
        assert.equal(AnnotationStore.collectionCache.has("slide-1"), false,
            "a failed fetch must evict its cache entry so it does not permanently poison this image");

        const retried = await AnnotationStore.prefetchImage("slide-1");
        assert.equal(fetchCallCount, 2, "must actually retry over the network, not replay the same rejection");
        assert.equal(retried.imageId, "slide-1");
    }

    // save() must prime the cache with the freshly-saved collection, so
    // navigating away and back to a just-edited slide does not re-GET data
    // this workstation already has in hand.
    {
        const context = freshContext();
        const { AnnotationStore } = context;
        let fetchCallCount = 0;
        context.fetch = () => {
            fetchCallCount += 1;
            return Promise.reject(new Error("prefetchImage must not hit the network right after a save cached this image"));
        };
        context.WsiCsrf.csrfFetch = async (url, options) => okResponse(JSON.parse(options.body));

        const store = new AnnotationStore({});
        store.currentImageId = "slide-1";
        store.currentCollection = {
            version: 1, imageId: "slide-1", slidePath: "x", userId: "local", modifiedAt: null,
            annotations: [{ id: "a1" }]
        };
        store.changeVersion = 1;
        await store.save();

        const cached = await AnnotationStore.prefetchImage("slide-1");
        assert.equal(fetchCallCount, 0, "save() must have already primed the cache");
        assert.equal(cached.annotations.length, 1);
    }

    // End-to-end: this is the actual overlap the optimization exists for.
    // Kick off prefetchImage() "early" (mirroring selectImage()'s call, made
    // before metadata/display are even requested), then call store.load() for
    // the same image the way the viewer-open handler does -- load() must reuse
    // the already-in-flight request rather than issuing a second GET.
    {
        const context = freshContext();
        const { AnnotationStore } = context;
        let fetchCallCount = 0;
        context.fetch = () => {
            fetchCallCount += 1;
            return Promise.resolve(okResponse({ version: 1, imageId: "slide-1", annotations: [{ id: "a1" }] }));
        };

        const store = new AnnotationStore({});
        const early = AnnotationStore.prefetchImage("slide-1");
        await store.load("slide-1");

        assert.equal(fetchCallCount, 1,
            "load() must reuse the promise an earlier prefetchImage() call already started, not issue a second GET");
        assert.equal(store.currentCollection.annotations.length, 1);
        await early;
    }

    console.log("annotation-prefetch-cache.test.js: ok");
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
