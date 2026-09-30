import { expect, test } from "bun:test";

const { createSettingsStore } = require("./settings-store.js");

function createFakeScheduler() {
  const pending = [];
  return {
    schedule(fn, ms) {
      const id = pending.length;
      pending.push({ fn, ms, cancelled: false });
      return id;
    },
    cancel(id) {
      if (pending[id]) pending[id].cancelled = true;
    },
    async runAll() {
      while (pending.length) {
        const job = pending.shift();
        if (!job.cancelled) await job.fn();
      }
    },
  };
}

function createFakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

test("load populates settings from the API and get reads them", async () => {
  const store = createSettingsStore({
    fetchImpl: async () =>
      new Response(JSON.stringify({ settings: { "dock.height": 42 } }), {
        status: 200,
      }),
    storage: createFakeStorage(),
    scheduler: createFakeScheduler(),
  });

  await store.load();
  expect(store.get("dock.height")).toBe(42);
  expect(store.get("missing.key", "fallback")).toBe("fallback");
});

test("set batches changes into one debounced PUT and updates cache immediately", async () => {
  const calls = [];
  const scheduler = createFakeScheduler();
  const store = createSettingsStore({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (options.method === "PUT") {
        return new Response(
          JSON.stringify({ settings: JSON.parse(options.body).settings }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ settings: {} }), { status: 200 });
    },
    storage: createFakeStorage(),
    scheduler,
  });

  await store.load();
  store.set("windows.layout", { files: { x: 1 } });
  store.set("dock.enabled", true);

  // cache reflects writes before any network flush
  expect(store.get("dock.enabled")).toBe(true);

  await scheduler.runAll();

  const puts = calls.filter((call) => call.options.method === "PUT");
  expect(puts.length).toBe(1);
  const body = JSON.parse(puts[0].options.body);
  expect(Object.keys(body.settings).sort()).toEqual([
    "dock.enabled",
    "windows.layout",
  ]);
});

test("API failure falls back to the local storage cache", async () => {
  const storage = createFakeStorage();
  storage.setItem(
    "deckterm.settings.cache.v1",
    JSON.stringify({ "dock.height": 30 }),
  );
  const scheduler = createFakeScheduler();
  const store = createSettingsStore({
    fetchImpl: async () => {
      throw new Error("network down");
    },
    storage,
    scheduler,
  });

  await store.load();
  expect(store.get("dock.height")).toBe(30);

  // sets still land in the local cache even though PUTs fail
  store.set("dock.height", 55);
  await scheduler.runAll();
  expect(store.get("dock.height")).toBe(55);
  expect(JSON.parse(storage.getItem("deckterm.settings.cache.v1"))).toEqual({
    "dock.height": 55,
  });
});

test("explicit flush rejects an HTTP failure and retains entries for retry", async () => {
  let fail = true;
  const requests = [];
  const store = createSettingsStore({
    fetchImpl: async (_url, options = {}) => {
      if (options.method !== "PUT")
        return new Response(JSON.stringify({ settings: {} }));
      requests.push(JSON.parse(options.body).settings);
      return new Response("no", { status: fail ? 503 : 200 });
    },
    storage: createFakeStorage(),
    scheduler: createFakeScheduler(),
  });
  store.set("terminal.scrollbackLimit", 10000);
  await expect(store.flush()).rejects.toThrow("HTTP 503");
  fail = false;
  await store.flush();
  expect(requests).toEqual([
    { "terminal.scrollbackLimit": 10000 },
    { "terminal.scrollbackLimit": 10000 },
  ]);
});

test("overlapping explicit flushes serialize and retain the newer value after an old failure", async () => {
  let release;
  let attempt = 0;
  const sent = [];
  const store = createSettingsStore({
    fetchImpl: async (_url, options = {}) => {
      if (options.method !== "PUT")
        return new Response(JSON.stringify({ settings: {} }));
      sent.push(JSON.parse(options.body).settings);
      if (attempt++ === 0) {
        await new Promise((resolve) => {
          release = resolve;
        });
        return new Response("no", { status: 500 });
      }
      return new Response("ok", { status: 200 });
    },
    storage: createFakeStorage(),
    scheduler: createFakeScheduler(),
  });
  store.set("git.autoFetchInterval", 30);
  const firstFlush = store.flush();
  store.set("git.autoFetchInterval", 0);
  const secondFlush = store.flush();
  // The second PUT cannot start until the old request has completed.
  expect(sent).toEqual([{ "git.autoFetchInterval": 30 }]);
  release();
  await expect(firstFlush).rejects.toThrow("HTTP 500");
  await secondFlush;
  // The retry has the later explicit zero, which wins over the failed 30.
  expect(sent).toEqual([
    { "git.autoFetchInterval": 30 },
    { "git.autoFetchInterval": 0 },
  ]);
});

test("an automatic scheduled flush serializes behind an explicit flush", async () => {
  const jobs = [];
  let release;
  let attempt = 0;
  const sent = [];
  const scheduler = {
    schedule(fn) {
      jobs.push(fn);
      return jobs.length - 1;
    },
    cancel() {},
  };
  const store = createSettingsStore({
    fetchImpl: async (_url, options = {}) => {
      sent.push(JSON.parse(options.body).settings);
      if (attempt++ === 0) {
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      return new Response("ok", { status: 200 });
    },
    storage: createFakeStorage(),
    scheduler,
  });
  store.set("git.autoFetchInterval", 30);
  jobs.shift()();
  await Promise.resolve();
  store.set("git.autoFetchInterval", 0);
  const explicit = store.flush();
  expect(sent).toEqual([{ "git.autoFetchInterval": 30 }]);
  release();
  await explicit;
  expect(sent).toEqual([
    { "git.autoFetchInterval": 30 },
    { "git.autoFetchInterval": 0 },
  ]);
});
