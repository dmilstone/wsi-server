const test = require("node:test");
const assert = require("node:assert/strict");
const {LiveImageDiscovery} = require("../../main/resources/static/live-image-discovery.js");

function documentStub() {
  const listeners = new Map();
  return {hidden:false, listeners,
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name) { listeners.delete(name); }};
}

test("default browser timers retain their required global receiver", () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let cleared = false;
  globalThis.setInterval = function () {
    assert.equal(this, globalThis);
    return 17;
  };
  globalThis.clearInterval = function (id) {
    assert.equal(this, globalThis);
    cleared = id === 17;
  };
  try {
    const discovery = new LiveImageDiscovery({document:documentStub(),
      request: async () => ({images:[]}), applyImages: () => 0, status: () => {}});
    discovery.start();
    discovery.stop();
    assert.equal(cleared, true);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("manual refresh posts, renders additions, and reports concise status", async () => {
  const calls = [], messages = [], doc = documentStub();
  const discovery = new LiveImageDiscovery({document:doc,
    request: async (url, options={}) => { calls.push([url, options.method]);
      if (url.endsWith("discovery")) return {running:false, added:1};
      if (url === "/api/images") return {images:[{id:"new"}]};
      return {running:true}; },
    applyImages: images => images.length, status: value => messages.push(value)});
  assert.equal(await discovery.refresh(true), true);
  assert.deepEqual(calls[0], ["/api/images/refresh", "POST"]);
  assert.equal(messages.at(-1), "1 new image available");
});

test("automatic refresh is bounded, pauses hidden, resumes, and cleans up", async () => {
  const doc = documentStub(); let tick, cleared = false, requests = 0;
  const discovery = new LiveImageDiscovery({document:doc, intervalMs:1,
    setIntervalFn: fn => { tick=fn; return 7; }, clearIntervalFn: id => { cleared=id===7; },
    request: async url => { requests++; return url.endsWith("discovery") ? {running:false} : {images:[]}; },
    applyImages: () => 0, status: () => {}});
  discovery.start(); assert.equal(discovery.intervalMs, 5000);
  doc.hidden=true; tick(); await new Promise(resolve => setImmediate(resolve)); assert.equal(requests, 0);
  doc.hidden=false; doc.listeners.get("visibilitychange")(); await new Promise(resolve => setImmediate(resolve));
  assert.ok(requests > 0);
  discovery.stop(); assert.equal(cleared, true); assert.equal(doc.listeners.size, 0);
});

test("overlap is prevented and failures retain the rendered list", async () => {
  const doc = documentStub(); let release, applied=0, messages=[];
  const blocker = new Promise(resolve => release=resolve);
  const discovery = new LiveImageDiscovery({document:doc, request: () => blocker,
    applyImages: () => ++applied, status: message => messages.push(message)});
  const first = discovery.refresh(false);
  assert.equal(await discovery.refresh(false), false);
  release(Promise.reject(new Error("failed")));
  assert.equal(await first, false); assert.equal(applied, 0);
  assert.equal(messages.at(-1), "Refresh failed; existing list retained");
});
