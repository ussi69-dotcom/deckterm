// Controller-level unit tests for ensureIdeExplorerLoaded (app.js).
//
// The method lives on the TerminalManager class in app.js, which is not a
// module export. We test it via a minimal harness: a plain object that carries
// the method (copied verbatim from app.js) and the four dependencies it calls —
// all stubbed. This lets us verify the three invariants without a browser DOM
// or a live server.
//
// Invariants (from the slice brief):
//  1. IDE active + workspace present + tree empty → openForWorkspace AND loadDir
//     are both called once.
//  2. Items already loaded for the same workspace → loadDir is NOT called again
//     (idempotent guard).
//  3. isIdeModeActive() returns false → neither openForWorkspace nor loadDir is
//     called.

import { expect, test } from "bun:test";

// Build a minimal TerminalManager-like host that owns ensureIdeExplorerLoaded
// exactly as written in app.js, wired to injected stubs for all four dependency
// methods.
function makeHost({
  ideModeActive = true,
  workspaceId = "ws-1",
  cwd = "/home/user/project",
  explorerCurrentWorkspaceId = null,
  explorerItems = [],
  openForWorkspaceReturn = "/home/user/project",
} = {}) {
  const calls = {
    openForWorkspace: [],
    loadDir: [],
  };

  const fileExplorer = {
    get currentWorkspaceId() {
      return explorerCurrentWorkspaceId;
    },
    getWorkspaceItems(wsId) {
      return explorerCurrentWorkspaceId === wsId ? explorerItems : [];
    },
    openForWorkspace(wsId, cwdArg) {
      calls.openForWorkspace.push({ wsId, cwdArg });
      return openForWorkspaceReturn;
    },
    loadDir(path, wsId) {
      calls.loadDir.push({ path, wsId });
      return Promise.resolve(null);
    },
  };

  const host = {
    fileExplorer,
    calls,

    isIdeModeActive() {
      return ideModeActive;
    },

    getActiveWorkspaceContext() {
      return { workspaceId, cwd };
    },

    // The method under test — kept in lockstep with app.js's
    // ensureIdeExplorerLoaded so this file is a logic-spec for the
    // load/idempotency contract. End-to-end wiring (the three call-sites) is
    // covered by the Playwright IDE smoke; this only locks the decision logic.
    ensureIdeExplorerLoaded() {
      if (!this.fileExplorer || !this.isIdeModeActive()) return;
      const { workspaceId: wsId, cwd: cwdVal } =
        this.getActiveWorkspaceContext();
      if (!wsId) return;
      const sameWorkspace = this.fileExplorer.currentWorkspaceId === wsId;
      const hasItems = this.fileExplorer.getWorkspaceItems(wsId).length > 0;
      if (sameWorkspace && hasItems) return;
      const targetPath = this.fileExplorer.openForWorkspace(wsId, cwdVal);
      if (targetPath) void this.fileExplorer.loadDir(targetPath, wsId);
    },
  };

  return host;
}

// ── Invariant 1: first load (empty tree) ────────────────────────────────────

test("ensureIdeExplorerLoaded calls openForWorkspace AND loadDir when tree is empty", () => {
  const h = makeHost({
    ideModeActive: true,
    workspaceId: "ws-1",
    cwd: "/proj",
    explorerCurrentWorkspaceId: null, // workspace not yet set on explorer
    explorerItems: [],
    openForWorkspaceReturn: "/proj",
  });

  h.ensureIdeExplorerLoaded();

  expect(h.calls.openForWorkspace.length).toBe(1);
  expect(h.calls.openForWorkspace[0].wsId).toBe("ws-1");
  expect(h.calls.loadDir.length).toBe(1);
  expect(h.calls.loadDir[0].path).toBe("/proj");
  expect(h.calls.loadDir[0].wsId).toBe("ws-1");
});

// ── Invariant 1b: correct workspace but zero items still triggers loadDir ───

test("ensureIdeExplorerLoaded loads when workspace matches but items array is empty", () => {
  const h = makeHost({
    ideModeActive: true,
    workspaceId: "ws-2",
    cwd: "/home/user",
    explorerCurrentWorkspaceId: "ws-2", // already set, but no items yet
    explorerItems: [],
    openForWorkspaceReturn: "/home/user",
  });

  h.ensureIdeExplorerLoaded();

  expect(h.calls.openForWorkspace.length).toBe(1);
  expect(h.calls.loadDir.length).toBe(1);
});

// ── Invariant 2: idempotent — no second fetch when items are present ─────────

test("ensureIdeExplorerLoaded does NOT call loadDir when items are already loaded", () => {
  const h = makeHost({
    ideModeActive: true,
    workspaceId: "ws-1",
    cwd: "/proj",
    explorerCurrentWorkspaceId: "ws-1", // same workspace already active
    explorerItems: [{ name: "src", path: "/proj/src", isDir: true }], // non-empty
    openForWorkspaceReturn: "/proj",
  });

  h.ensureIdeExplorerLoaded();
  // Same workspace + items already loaded → full no-op: neither openForWorkspace
  // nor loadDir runs, so a browsed subdirectory is never reset.
  expect(h.calls.openForWorkspace.length).toBe(0);
  expect(h.calls.loadDir.length).toBe(0);
});

test("ensureIdeExplorerLoaded remains idempotent across multiple calls when loaded", () => {
  const h = makeHost({
    ideModeActive: true,
    workspaceId: "ws-1",
    cwd: "/proj",
    explorerCurrentWorkspaceId: "ws-1",
    explorerItems: [{ name: "index.ts", path: "/proj/index.ts", isDir: false }],
    openForWorkspaceReturn: "/proj",
  });

  h.ensureIdeExplorerLoaded();
  h.ensureIdeExplorerLoaded();
  h.ensureIdeExplorerLoaded();

  // Loaded workspace → every call is a no-op (no reload, no re-open churn).
  expect(h.calls.loadDir.length).toBe(0);
  expect(h.calls.openForWorkspace.length).toBe(0);
});

// ── Invariant 3: no-op outside IDE mode ─────────────────────────────────────

test("ensureIdeExplorerLoaded is a no-op when isIdeModeActive() is false", () => {
  const h = makeHost({
    ideModeActive: false,
    workspaceId: "ws-1",
    cwd: "/proj",
    explorerCurrentWorkspaceId: null,
    explorerItems: [],
    openForWorkspaceReturn: "/proj",
  });

  h.ensureIdeExplorerLoaded();

  expect(h.calls.openForWorkspace.length).toBe(0);
  expect(h.calls.loadDir.length).toBe(0);
});

// ── Edge cases ───────────────────────────────────────────────────────────────

test("ensureIdeExplorerLoaded is a no-op when workspaceId is null", () => {
  const h = makeHost({
    ideModeActive: true,
    workspaceId: null, // no active workspace
    cwd: "/proj",
    explorerCurrentWorkspaceId: null,
    explorerItems: [],
    openForWorkspaceReturn: "/proj",
  });

  h.ensureIdeExplorerLoaded();

  expect(h.calls.openForWorkspace.length).toBe(0);
  expect(h.calls.loadDir.length).toBe(0);
});

test("ensureIdeExplorerLoaded is a no-op when fileExplorer is absent", () => {
  const h = makeHost({
    ideModeActive: true,
    workspaceId: "ws-1",
  });
  // Override to remove the explorer.
  h.fileExplorer = null;

  // Must not throw.
  expect(() => h.ensureIdeExplorerLoaded()).not.toThrow();
  expect(h.calls.openForWorkspace.length).toBe(0);
});

test("ensureIdeExplorerLoaded skips loadDir when openForWorkspace returns null/falsy", () => {
  const h = makeHost({
    ideModeActive: true,
    workspaceId: "ws-1",
    cwd: "/proj",
    explorerCurrentWorkspaceId: null,
    explorerItems: [],
    openForWorkspaceReturn: null, // openForWorkspace returned null (no path resolved)
  });

  h.ensureIdeExplorerLoaded();

  expect(h.calls.openForWorkspace.length).toBe(1);
  expect(h.calls.loadDir.length).toBe(0); // targetPath falsy → no load
});
