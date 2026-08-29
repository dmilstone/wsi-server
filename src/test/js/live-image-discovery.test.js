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
  // refresh(true) implicitly calls start() when no timer is running yet (see
  // below), so — like the other tests that reach start() — this must supply
  // fake interval fns and stop() afterward. Without this, it previously left
  // a real, referenced setInterval(fn, 30000) running forever, hanging the
  // process (node:test prints every "✔" line but never exits).
  let intervalId = 0, cleared = false;
  const discovery = new LiveImageDiscovery({document:doc,
    setIntervalFn: () => ++intervalId, clearIntervalFn: () => { cleared = true; },
    request: async (url, options={}) => { calls.push([url, options.method]);
      if (url.endsWith("discovery")) return {running:false, added:1};
      if (url === "/api/images") return {images:[{id:"new"}]};
      return {running:true}; },
    applyImages: images => images.length, status: value => messages.push(value)});
  assert.equal(await discovery.refresh(true), true);
  assert.deepEqual(calls[0], ["/api/images/refresh", "POST"]);
  assert.equal(messages.at(-1), "1 new image available");
  // Confirms refresh(true) started the timer (start() ran) and that stop()
  // tears it down cleanly.
  discovery.stop();
  assert.equal(cleared, true);
});

test("automatic refresh applies the current list without waiting for a long scan", async () => {
  const applied = [];
  const discovery = new LiveImageDiscovery({document: documentStub(),
    request: async (url) => {
      if (url.endsWith("discovery")) return {running: true};
      if (url === "/api/images") return {images: [{id: "a"}]};
      return {};
    },
    applyImages: images => { applied.push(images); return images.length; },
    status: () => {}});
  assert.equal(await discovery.refresh(false), true);
  assert.deepEqual(applied, [[{id: "a"}]]);
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

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

async function waitIdle(discovery) {
  for (let i = 0; i < 30 && discovery.running; i++) await flush();
}

async function pump(discovery, tick) {
  tick();
  await flush();
  await waitIdle(discovery);
}

test("three consecutive connection refusals back off without stopping the timer", async () => {
  const doc = documentStub();
  let tick;
  let now = 1_000;
  let requests = 0;
  const discovery = new LiveImageDiscovery({document:doc, intervalMs:1,
    nowFn: () => now,
    setIntervalFn: fn => { tick = fn; return 11; },
    clearIntervalFn: () => { throw new Error("timer should stay running"); },
    request: async () => { requests++; throw new TypeError("Failed to fetch"); },
    applyImages: () => 0, status: () => {}});
  discovery.start();
  await pump(discovery, tick);
  await pump(discovery, tick);
  await pump(discovery, tick);
  assert.equal(requests, 3);
  assert.equal(discovery.halted, true);
  await pump(discovery, tick);
  assert.equal(requests, 3);
  now += 60_001;
  await pump(discovery, tick);
  assert.equal(requests, 4);
});

test("success resets refusal count so later refusals do not halt early", async () => {
  const doc = documentStub();
  let tick;
  let cleared = false;
  let refuse = true;
  const discovery = new LiveImageDiscovery({document:doc, intervalMs:1,
    setIntervalFn: fn => { tick = fn; return 13; },
    clearIntervalFn: id => { cleared = id === 13; },
    request: async url => {
      if (refuse) throw new TypeError("ERR_CONNECTION_REFUSED");
      return url.endsWith("discovery") ? {running:false} : {images:[]};
    },
    applyImages: () => 0, status: () => {}});
  discovery.start();
  await pump(discovery, tick);
  await pump(discovery, tick);
  assert.equal(discovery.halted, false);
  refuse = false;
  await pump(discovery, tick);
  refuse = true;
  await pump(discovery, tick);
  await pump(discovery, tick);
  assert.equal(cleared, false);
  assert.equal(discovery.halted, false);
});

test("manual refresh after backoff clears it and polls again", async () => {
  const doc = documentStub();
  let tick;
  let intervalId = 0;
  let liveTimer = null;
  let refuse = true;
  const discovery = new LiveImageDiscovery({document:doc, intervalMs:1,
    setIntervalFn: fn => { tick = fn; liveTimer = ++intervalId; return liveTimer; },
    clearIntervalFn: id => { if (id === liveTimer) liveTimer = null; },
    request: async url => {
      if (refuse) throw new TypeError("Failed to fetch");
      return url.endsWith("discovery") ? {running:false} : {images:[]};
    },
    applyImages: () => 0, status: () => {}});
  discovery.start();
  await pump(discovery, tick);
  await pump(discovery, tick);
  await pump(discovery, tick);
  assert.equal(discovery.halted, true);
  assert.notEqual(liveTimer, null);
  refuse = false;
  assert.equal(await discovery.refresh(true), true);
  assert.equal(discovery.halted, false);
  assert.notEqual(liveTimer, null);
});

test("showing the tab again retries immediately after backoff", async () => {
  const doc = documentStub();
  let tick;
  let now = 1_000;
  let requests = 0;
  const discovery = new LiveImageDiscovery({document:doc, intervalMs:1,
    nowFn: () => now,
    setIntervalFn: fn => { tick = fn; return 15; },
    clearIntervalFn: () => {},
    request: async url => {
      requests++;
      if (requests <= 3) throw new TypeError("Failed to fetch");
      return url.endsWith("discovery") ? {running:false} : {images:[]};
    },
    applyImages: () => 0, status: () => {}});
  discovery.start();
  await pump(discovery, tick);
  await pump(discovery, tick);
  await pump(discovery, tick);
  assert.equal(discovery.halted, true);
  doc.listeners.get("visibilitychange")();
  await flush();
  await waitIdle(discovery);
  assert.equal(discovery.halted, false);
  assert.ok(requests > 3);
});
