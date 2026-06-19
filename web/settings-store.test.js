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
