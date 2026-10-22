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

// --- refresh(key, merge) (Agents overview: attention.seen) -----------------

function createServerFake(initial = {}) {
  const server = { ...initial };
  const puts = [];
  const fetchImpl = async (url, options = {}) => {
    if (options.method === "PUT") {
      const body = JSON.parse(options.body).settings;
      puts.push(body);
      for (const [key, value] of Object.entries(body)) {
        if (value === null) delete server[key];
        else server[key] = value;
      }
    }
    return new Response(JSON.stringify({ settings: { ...server } }), {
      status: 200,
    });
  };
  return { server, puts, fetchImpl };
}

test("refresh takes the server value of one key when nothing is pending", async () => {
  const fake = createServerFake({ "attention.seen": { a: 1 }, other: 1 });
  const store = createSettingsStore({
    fetchImpl: fake.fetchImpl,
    storage: createFakeStorage(),
    scheduler: createFakeScheduler(),
  });
  await store.load();
  fake.server["attention.seen"] = { a: 4 };
  fake.server.other = 2;
  expect(await store.refresh("attention.seen")).toEqual({ a: 4 });
  // Only the requested key is refreshed.
  expect(store.get("other")).toBe(1);
  delete fake.server["attention.seen"];
  expect(await store.refresh("attention.seen")).toBeUndefined();
});

test("refresh keeps a pending local write without a merge function", async () => {
  const fake = createServerFake({ key: "server-old" });
  const scheduler = createFakeScheduler();
  const store = createSettingsStore({
    fetchImpl: fake.fetchImpl,
    storage: createFakeStorage(),
    scheduler,
  });
  await store.load();
  store.set("key", "local-new");
  fake.server.key = "server-newer";
  expect(await store.refresh("key")).toBe("local-new");
  await scheduler.runAll();
  expect(fake.puts.at(-1)).toEqual({ key: "local-new" });
});

test("refresh merges with the given function and keeps the merge pending", async () => {
  const fake = createServerFake({ "attention.seen": { a: 1, b: 1 } });
  const scheduler = createFakeScheduler();
  const store = createSettingsStore({
    fetchImpl: fake.fetchImpl,
    storage: createFakeStorage(),
    scheduler,
  });
  await store.load();
  store.set("attention.seen", { a: 5, b: 1 });
  fake.server["attention.seen"] = { a: 2, b: 7, c: 3 };
  const max = (local, server) => {
    const out = { ...(local || {}) };
    for (const [id, seq] of Object.entries(server || {})) {
      out[id] = Math.max(out[id] || 0, seq);
    }
    return out;
  };
  expect(await store.refresh("attention.seen", max)).toEqual({
    a: 5,
    b: 7,
    c: 3,
  });
  await scheduler.runAll();
  expect(fake.puts.at(-1)).toEqual({
    "attention.seen": { a: 5, b: 7, c: 3 },
  });
});

test("refresh leaves the cache alone when the fetch fails", async () => {
  let fail = false;
  const store = createSettingsStore({
    fetchImpl: async () => {
      if (fail) throw new Error("offline");
      return new Response(JSON.stringify({ settings: { k: 1 } }), {
        status: 200,
      });
    },
    storage: createFakeStorage(),
    scheduler: createFakeScheduler(),
  });
  await store.load();
  fail = true;
  expect(await store.refresh("k")).toBe(1);
});
