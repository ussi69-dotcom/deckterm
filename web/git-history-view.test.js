import { test, expect } from "bun:test";
import { historyRows, GitHistoryViewController } from "./git-history-view.js";

// ── historyRows pure helper ───────────────────────────────────────────────────

test("historyRows maps commits to display rows with expected fields", () => {
  const commits = [
    {
      hash: "abc1234",
      fullHash: "abc1234abcdef1234abcdef1234abcdef12345678",
      message: "fix: correct the thing",
      author: "Alice",
      date: "2020-01-01T00:00:00Z",
      graph: "*",
    },
    {
      hash: "def5678",
      fullHash: "def5678def5678def5678def5678def567890ab",
      message: "feat: add stuff\n\nLonger body here.",
      author: "Bob",
      date: "2020-01-02T00:00:00Z",
      graph: "| *",
    },
  ];
  const rows = historyRows(commits);
  expect(rows).toHaveLength(2);

  expect(rows[0].shortHash).toBe("abc1234");
  expect(rows[0].fullHash).toBe("abc1234abcdef1234abcdef1234abcdef12345678");
  expect(rows[0].subject).toBe("fix: correct the thing");
  expect(rows[0].author).toBe("Alice");
  expect(rows[0].graph).toBe("*");
  // dateLabel should be a non-empty relative string (exact value is time-dependent)
  expect(typeof rows[0].dateLabel).toBe("string");
  expect(rows[0].dateLabel.length).toBeGreaterThan(0);

  // Multi-line message: subject is first line only
  expect(rows[1].subject).toBe("feat: add stuff");
  expect(rows[1].graph).toBe("| *");
});

test("historyRows returns empty array for empty/null input", () => {
  expect(historyRows([])).toHaveLength(0);
  expect(historyRows(null)).toHaveLength(0);
  expect(historyRows(undefined)).toHaveLength(0);
});

test("historyRows skips entries without a hash", () => {
  const commits = [
    {
      hash: "abc1234",
      fullHash: "abc1234abc1234abc1234abc1234abc123456789",
      message: "ok",
      author: "A",
      date: "",
    },
    { message: "no hash at all" },
    null,
  ];
  const rows = historyRows(commits);
  expect(rows).toHaveLength(1);
  expect(rows[0].shortHash).toBe("abc1234");
});

test("historyRows uses fullHash.slice(0,7) when hash is missing", () => {
  const commits = [
    {
      fullHash: "aaabbbcccdddeee111222333444555666777888",
      message: "only fullHash",
      author: "X",
      date: "",
    },
  ];
  const rows = historyRows(commits);
  expect(rows[0].shortHash).toBe("aaabbbc");
});

test("historyRows dateLabel is empty string for missing/invalid date", () => {
  const commits = [
    {
      hash: "aaa0000",
      fullHash: "aaa0000aaa0000aaa0000aaa0000aaa000012345",
      message: "m",
      author: "A",
      date: "",
    },
    {
      hash: "bbb1111",
      fullHash: "bbb1111bbb1111bbb1111bbb1111bbb111123456",
      message: "m",
      author: "A",
      date: "not-a-date",
    },
  ];
  const rows = historyRows(commits);
  expect(rows[0].dateLabel).toBe("");
  expect(rows[1].dateLabel).toBe("");
});

// ── GitHistoryViewController DOM-free harness ─────────────────────────────────
//
// Uses the same minimal fake-element + fake-document pattern as git-scm-view.test.js.

function makeFakeEl() {
  const el = {
    _children: [],
    _listeners: {},
    _classes: new Set(),
    innerHTML: "",
    textContent: "",
    dataset: {},
    parentElement: null,
    classList: {
      toggle(name, force) {
        const want = force === undefined ? !el._classes.has(name) : !!force;
        if (want) el._classes.add(name);
        else el._classes.delete(name);
        return want;
      },
      add(...names) {
        for (const n of names) el._classes.add(n);
      },
      remove(...names) {
        for (const n of names) el._classes.delete(n);
      },
      contains(name) {
        return el._classes.has(name);
      },
    },
    getAttribute() {
      return null;
    },
    setAttribute() {},
    addEventListener(type, fn) {
      (el._listeners[type] = el._listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = el._listeners[type] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    appendChild(child) {
      if (child.parentElement && child.parentElement !== el) {
        const idx = child.parentElement._children.indexOf(child);
        if (idx >= 0) child.parentElement._children.splice(idx, 1);
      }
      if (!el._children.includes(child)) el._children.push(child);
      child.parentElement = el;
      return child;
    },
    removeChild(child) {
      const idx = el._children.indexOf(child);
      if (idx >= 0) el._children.splice(idx, 1);
      child.parentElement = null;
    },
    querySelector(sel) {
      // Resolve against el._subs if present
      if (el._subs && Object.prototype.hasOwnProperty.call(el._subs, sel)) {
        return el._subs[sel];
      }
      return null;
    },
    querySelectorAll() {
      return [];
    },
    closest(sel) {
      // Minimal: check dataset.fullHash for .ide-history-row
      if (sel === ".ide-history-row" && el.dataset?.fullHash !== undefined)
        return el;
      return null;
    },
    _subs: {},
  };
  return el;
}

function makeFakeDoc() {
  return {
    createElement() {
      return makeFakeEl();
    },
  };
}

// A fetch stub that resolves with the given commits array.
function makeFetchStub(commits, { status = 200 } = {}) {
  return async (url) => {
    makeFetchStub._lastUrl = url;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ commits }),
    };
  };
}
makeFetchStub._lastUrl = null;

function makeController(overrides = {}) {
  const doc = overrides.document || makeFakeDoc();
  const container = makeFakeEl();
  const tmCalls = [];
  const ctl = new GitHistoryViewController({
    document: doc,
    fetchImpl: overrides.fetchImpl || makeFetchStub([]),
    getTerminalManager: () => ({
      openDiffTab(opts) {
        tmCalls.push(opts);
      },
    }),
    getCwd: () => overrides.cwd || "/repo",
    path: overrides.path || null,
  });
  return { ctl, container, doc, tmCalls };
}

// ── mount / unmount ───────────────────────────────────────────────────────────

test("mount() appends a root element to the container", async () => {
  const { ctl, container } = makeController();
  ctl.mount(container);
  await new Promise((r) => setTimeout(r, 10));
  expect(container._children).toHaveLength(1);
  expect(container._children[0].className).toBe("ide-history-view");
  ctl.unmount();
});

test("unmount() removes the root from the container", async () => {
  const { ctl, container } = makeController();
  ctl.mount(container);
  await new Promise((r) => setTimeout(r, 10));
  ctl.unmount();
  expect(container._children).toHaveLength(0);
  expect(ctl.root).toBeNull();
});

test("double mount() is safe (unmounts first before re-mounting)", async () => {
  const { ctl, container } = makeController();
  ctl.mount(container);
  await new Promise((r) => setTimeout(r, 10));
  ctl.mount(container);
  await new Promise((r) => setTimeout(r, 10));
  // Only one root child after double mount
  expect(container._children).toHaveLength(1);
  ctl.unmount();
});

// ── lazy fetch ────────────────────────────────────────────────────────────────

test("mount() fetches /api/git/log with the cwd", async () => {
  let capturedUrl = null;
  const fetchStub = async (url) => {
    capturedUrl = url;
    return { ok: true, json: async () => ({ commits: [] }) };
  };
  const { ctl, container } = makeController({
    fetchImpl: fetchStub,
    cwd: "/my/repo",
  });
  ctl.mount(container);
  await new Promise((r) => setTimeout(r, 20));
  expect(capturedUrl).toContain("/api/git/log");
  expect(capturedUrl).toContain(encodeURIComponent("/my/repo"));
  ctl.unmount();
});

test("when path is set, fetch URL includes path param (per-file scoping 6b)", async () => {
  let capturedUrl = null;
  const fetchStub = async (url) => {
    capturedUrl = url;
    return { ok: true, json: async () => ({ commits: [] }) };
  };
  const { ctl, container } = makeController({
    fetchImpl: fetchStub,
    cwd: "/repo",
    path: "src/foo.js",
  });
  ctl.mount(container);
  await new Promise((r) => setTimeout(r, 20));
  expect(capturedUrl).toContain("path=");
  expect(capturedUrl).toContain(encodeURIComponent("src/foo.js"));
  ctl.unmount();
});

test("when path is null, fetch URL does NOT include path param (repo-wide 6a)", async () => {
  let capturedUrl = null;
  const fetchStub = async (url) => {
    capturedUrl = url;
    return { ok: true, json: async () => ({ commits: [] }) };
  };
  const { ctl, container } = makeController({
    fetchImpl: fetchStub,
    path: null,
  });
  ctl.mount(container);
  await new Promise((r) => setTimeout(r, 20));
  expect(capturedUrl).not.toContain("path=");
  ctl.unmount();
});

// ── empty + error states ──────────────────────────────────────────────────────

test("empty commits list renders 'No history' message", async () => {
  const fetchStub = async () => ({
    ok: true,
    json: async () => ({ commits: [] }),
  });
  const { ctl, container } = makeController({ fetchImpl: fetchStub });
  ctl.mount(container);
  await new Promise((r) => setTimeout(r, 20));
  const root = container._children[0];
  expect(root.innerHTML).toContain("No history");
  ctl.unmount();
});

test("fetch error renders an error message", async () => {
  const fetchStub = async () => {
    throw new Error("network failure");
  };
  const { ctl, container } = makeController({ fetchImpl: fetchStub });
  ctl.mount(container);
  await new Promise((r) => setTimeout(r, 20));
  const root = container._children[0];
  expect(root.innerHTML).toContain("network failure");
  ctl.unmount();
});

test("HTTP error response renders an error message", async () => {
  const fetchStub = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ error: "Forbidden path" }),
  });
  const { ctl, container } = makeController({ fetchImpl: fetchStub });
  ctl.mount(container);
  await new Promise((r) => setTimeout(r, 20));
  const root = container._children[0];
  expect(root.innerHTML).toContain("Forbidden path");
  ctl.unmount();
});

// ── row click → openDiffTab ───────────────────────────────────────────────────

test("file-scope commit click calls openDiffTab with mode:'commit' and the fullHash", async () => {
  const commits = [
    {
      hash: "abc1234",
      fullHash: "abc1234abc1234abc1234abc1234abc123456789",
      message: "fix: something",
      author: "Alice",
      date: "2020-01-01T00:00:00Z",
      graph: "*",
    },
  ];
  const fetchStub = async () => ({ ok: true, json: async () => ({ commits }) });
  const { ctl, container, tmCalls } = makeController({
    fetchImpl: fetchStub,
    path: "a.js",
    cwd: "/repo",
  });
  ctl.mount(container);
  await new Promise((r) => setTimeout(r, 20));

  // Simulate a click on a row by calling _onClick with a fake event whose
  // target.closest(".ide-history-row") returns a row element with dataset.fullHash.
  const fakeRow = makeFakeEl();
  fakeRow.dataset.fullHash = "abc1234abc1234abc1234abc1234abc123456789";
  const fakeEvent = {
    target: {
      closest(sel) {
        return sel === ".ide-history-row" ? fakeRow : null;
      },
    },
  };
  ctl._onClick(fakeEvent);

  expect(tmCalls).toHaveLength(1);
  expect(tmCalls[0].mode).toBe("commit");
  expect(tmCalls[0].commit).toBe("abc1234abc1234abc1234abc1234abc123456789");
  expect(tmCalls[0].cwd).toBe("/repo");
  ctl.unmount();
});

test("row click with path set passes relPath to openDiffTab (6b)", async () => {
  const fetchStub = async () => ({
    ok: true,
    json: async () => ({ commits: [] }),
  });
  const { ctl, container, tmCalls } = makeController({
    fetchImpl: fetchStub,
    path: "src/bar.ts",
    cwd: "/repo",
  });
  ctl.mount(container);
  await new Promise((r) => setTimeout(r, 20));

  const fakeRow = makeFakeEl();
  fakeRow.dataset.fullHash = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  ctl._onClick({
    target: {
      closest(sel) {
        return sel === ".ide-history-row" ? fakeRow : null;
      },
    },
  });

  expect(tmCalls).toHaveLength(1);
  expect(tmCalls[0].relPath).toBe("src/bar.ts");
  expect(tmCalls[0].mode).toBe("commit");
  expect(tmCalls[0].commit).toBe("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
  ctl.unmount();
});

test("repo-scope commit click expands to its files (no openDiffTab) and fetches commit-files", async () => {
  const hash = "cafecafecafecafecafecafecafecafecafecafe";
  let lastUrl = null;
  const fetchStub = async (url) => {
    lastUrl = url;
    if (String(url).includes("/api/git/commit-files")) {
      return {
        ok: true,
        json: async () => ({
          files: [
            { status: "M", path: "src/app.js" },
            { status: "A", path: "docs/new.md" },
          ],
        }),
      };
    }
    return { ok: true, json: async () => ({ commits: [] }) };
  };
  const { ctl, container, tmCalls } = makeController({
    fetchImpl: fetchStub,
    path: null,
    cwd: "/repo",
  });
  ctl.mount(container);
  await new Promise((r) => setTimeout(r, 20));

  const fakeRow = makeFakeEl();
  fakeRow.dataset.fullHash = hash;
  ctl._onClick({
    target: {
      closest(sel) {
        return sel === ".ide-history-row" ? fakeRow : null;
      },
    },
  });
  await new Promise((r) => setTimeout(r, 20));

  // Repo-scope click expands, never opens a diff tab directly.
  expect(tmCalls).toHaveLength(0);
  expect(ctl._expanded.has(hash)).toBe(true);
  expect(lastUrl).toContain("/api/git/commit-files");
  expect(lastUrl).toContain(`commit=${hash}`);
  expect(ctl._commitFiles.get(hash)).toHaveLength(2);

  // A second click collapses it.
  ctl._onClick({
    target: { closest: (sel) => (sel === ".ide-history-row" ? fakeRow : null) },
  });
  expect(ctl._expanded.has(hash)).toBe(false);
  ctl.unmount();
});

test("clicking a file inside an expanded commit opens its single-file commit diff", async () => {
  const fetchStub = async () => ({
    ok: true,
    json: async () => ({ commits: [] }),
  });
  const { ctl, container, tmCalls } = makeController({
    fetchImpl: fetchStub,
    path: null,
    cwd: "/repo",
  });
  ctl.mount(container);
  await new Promise((r) => setTimeout(r, 20));

  const fakeFile = makeFakeEl();
  fakeFile.dataset.path = "src/app.js";
  fakeFile.dataset.commit = "f00ff00ff00ff00ff00ff00ff00ff00ff00ff00f";
  ctl._onClick({
    target: {
      closest(sel) {
        if (sel === ".ide-history-file") return fakeFile;
        return null;
      },
    },
  });

  expect(tmCalls).toHaveLength(1);
  expect(tmCalls[0].relPath).toBe("src/app.js");
  expect(tmCalls[0].mode).toBe("commit");
  expect(tmCalls[0].commit).toBe("f00ff00ff00ff00ff00ff00ff00ff00ff00ff00f");
  expect(tmCalls[0].cwd).toBe("/repo");
  ctl.unmount();
});

test("row click does nothing when terminalManager has no openDiffTab", async () => {
  const fetchStub = async () => ({
    ok: true,
    json: async () => ({ commits: [] }),
  });
  const { ctl, container } = makeController({ fetchImpl: fetchStub });
  // Override tm with one lacking openDiffTab
  ctl.getTerminalManagerFn = () => ({});
  ctl.mount(container);
  await new Promise((r) => setTimeout(r, 20));

  // Should not throw
  const fakeRow = makeFakeEl();
  fakeRow.dataset.fullHash = "aabbccdd";
  expect(() => {
    ctl._onClick({
      target: {
        closest(sel) {
          return sel === ".ide-history-row" ? fakeRow : null;
        },
      },
    });
  }).not.toThrow();
  ctl.unmount();
});
