const { test, expect } = require("bun:test");
const { GitStatusStore } = require("./git-status-store");

function makeFetch(responses) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const body = responses.shift();
    return {
      ok: !(body && body.__notOk),
      async json() {
        return body || {};
      },
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test("getStatus fetches /api/git/status for the cwd and caches the result", async () => {
  const fetchImpl = makeFetch([{ branch: "main", files: [], root: "/repo" }]);
  const store = new GitStatusStore({ fetchImpl });

  const first = await store.getStatus("/repo");
  expect(first.root).toBe("/repo");
  expect(fetchImpl.calls).toHaveLength(1);
  expect(fetchImpl.calls[0]).toContain("/api/git/status?cwd=");
  expect(fetchImpl.calls[0]).toContain(encodeURIComponent("/repo"));

  // Second call is served from cache (no new fetch).
  const second = await store.getStatus("/repo");
  expect(second).toBe(first);
  expect(fetchImpl.calls).toHaveLength(1);
});

test("refreshStatus forces a re-fetch and notifies listeners", async () => {
  const fetchImpl = makeFetch([
    { branch: "main", files: [], root: "/repo" },
    { branch: "main", files: [{ path: "a.txt", status: "M" }], root: "/repo" },
  ]);
  const store = new GitStatusStore({ fetchImpl });

  await store.getStatus("/repo");

  const events = [];
  store.onChange((cwd, status) => events.push({ cwd, status }));

  const refreshed = await store.refreshStatus("/repo");
  expect(fetchImpl.calls).toHaveLength(2);
  expect(refreshed.files).toHaveLength(1);
  expect(events).toHaveLength(1);
  expect(events[0].cwd).toBe("/repo");
  expect(events[0].status.files).toHaveLength(1);
});

test("getStatus surfaces a status error result (not a repo) and does not cache it", async () => {
  const fetchImpl = makeFetch([
    { error: "not a git repository", __notOk: true },
    { error: "not a git repository", __notOk: true },
  ]);
  const store = new GitStatusStore({ fetchImpl });

  const result = await store.getStatus("/tmp");
  expect(result.error).toBeTruthy();

  // Errors are not cached, so a later call retries.
  await store.getStatus("/tmp");
  expect(fetchImpl.calls).toHaveLength(2);
});

test("onChange returns an unsubscribe function", async () => {
  const fetchImpl = makeFetch([
    { files: [], root: "/repo" },
    { files: [], root: "/repo" },
  ]);
  const store = new GitStatusStore({ fetchImpl });
  await store.getStatus("/repo");

  const events = [];
  const off = store.onChange(() => events.push(1));
  off();
  await store.refreshStatus("/repo");
  expect(events).toHaveLength(0);
});

test("invalidate drops a cached cwd so the next getStatus re-fetches", async () => {
  const fetchImpl = makeFetch([
    { files: [], root: "/repo" },
    { files: [], root: "/repo" },
  ]);
  const store = new GitStatusStore({ fetchImpl });
  await store.getStatus("/repo");
  store.invalidate("/repo");
  await store.getStatus("/repo");
  expect(fetchImpl.calls).toHaveLength(2);
});
