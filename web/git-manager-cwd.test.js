// Controller-level unit tests for the Git-cwd resync slice (app.js):
//   - TerminalManager.getGitCwd() — the canonical LIVE cwd source (fixes the
//     Git/SCM panel freezing on its initial cwd).
//   - TerminalManager.commitWorkingDirectory() — the atomic explorer + git
//     wiring a COMMITTED working-dir field value drives (keystroke drafts must
//     never reach this).
//
// Both methods live on the TerminalManager class in app.js, which is not a
// module export. Harness style copied from ide-explorer-autoload.test.js: a
// plain object that carries the methods COPIED VERBATIM from app.js, plus
// stubbed dependencies (fileExplorer, active-terminal/workspace context, and
// the global window.gitManager app.js reads directly — same access pattern as
// openGitPanel()/closeGitPanel()/syncRightSurfaceForWorkspace()). This lets us
// verify the cwd invariants without a browser DOM or a live server.

import { expect, test, afterEach } from "bun:test";

// window.gitManager is read as a bare global in app.js (matching every other
// GitManager call site there). Stub it per test and always restore, so a leak
// can't bleed into other test files that might run in the same bun process.
const originalWindow = globalThis.window;
afterEach(() => {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});

// Build a minimal TerminalManager-like host that owns getGitCwd() and
// commitWorkingDirectory() exactly as written in app.js, wired to injected
// stubs for fileExplorer / the active terminal / the current directory field.
function makeHost({
  fileExplorer = null,
  activeTerminal = null,
  currentDirectoryValue = "",
} = {}) {
  const calls = {
    setDirectoryValue: [],
  };

  const host = {
    fileExplorer,
    calls,

    getActiveTerminal() {
      return activeTerminal;
    },
    getCurrentDirectoryValue() {
      return currentDirectoryValue;
    },

    // Copied verbatim from app.js (TerminalManager.normalizeWorkspaceCwd).
    normalizeWorkspaceCwd(value) {
      const cwd = String(value || "").trim();
      if (!cwd) return "";
      if (cwd === "/") return cwd;
      return cwd.replace(/\/+$/, "");
    },

    // Copied verbatim from app.js (TerminalManager.getActiveWorkspaceContext).
    getActiveWorkspaceContext() {
      const active = this.getActiveTerminal();
      return {
        workspaceId: active?.workspaceId || null,
        cwd: active?.cwd || this.getCurrentDirectoryValue() || "/",
      };
    },

    // Copied verbatim from app.js (TerminalManager.getGitCwd).
    getGitCwd() {
      return (
        this.fileExplorer?.currentPath || this.getActiveWorkspaceContext().cwd
      );
    },

    // Copied verbatim from app.js (TerminalManager.commitWorkingDirectory).
    async commitWorkingDirectory(value) {
      const cwd = this.normalizeWorkspaceCwd(value);
      if (!cwd) return;

      const { workspaceId } = this.getActiveWorkspaceContext();
      if (this.fileExplorer && workspaceId) {
        if (this.fileExplorer.currentWorkspaceId !== workspaceId) {
          this.fileExplorer.openForWorkspace(workspaceId, cwd);
        }
        await this.fileExplorer.loadDir(cwd, workspaceId);
      }

      await window.gitManager?.refresh();
    },

    // Stand-ins for the app.js directoryInput event listeners (4872-4889),
    // written to mirror them exactly: input events are DRAFTS (record only,
    // via the real setDirectoryValue's userDraft path — stubbed here since its
    // DOM/settings-store persistence is out of scope for the cwd invariant
    // this file specs); change events are COMMITTED values and additionally
    // call commitWorkingDirectory().
    setDirectoryValue(value, opts) {
      this.calls.setDirectoryValue.push({ value, opts });
    },
    onDirectoryInputEvent(value) {
      this.setDirectoryValue(value, { force: true, userDraft: true });
    },
    onDirectoryChangeEvent(value) {
      this.setDirectoryValue(value, { force: true, userDraft: true });
      return this.commitWorkingDirectory(value);
    },
  };

  return host;
}

// A minimal fake FileExplorerController: tracks currentWorkspaceId/currentPath
// (as a mutable pair, matching the real getters) + records openForWorkspace /
// loadDir calls. loadDir() simulates a successful navigation by updating
// currentPath (mirroring the real store.setWorkspacePath side effect).
function makeFileExplorer({
  currentWorkspaceId = null,
  currentPath = null,
} = {}) {
  const state = { currentWorkspaceId, currentPath };
  const calls = { openForWorkspace: [], loadDir: [] };
  return {
    calls,
    get currentWorkspaceId() {
      return state.currentWorkspaceId;
    },
    get currentPath() {
      return state.currentPath;
    },
    openForWorkspace(workspaceId, cwd) {
      calls.openForWorkspace.push({ workspaceId, cwd });
      state.currentWorkspaceId = workspaceId;
      state.currentPath = cwd;
      return cwd;
    },
    async loadDir(path, workspaceId) {
      calls.loadDir.push({ path, workspaceId });
      state.currentPath = path;
      return { path };
    },
  };
}

// ── getGitCwd() preference order ────────────────────────────────────────────

test("getGitCwd() prefers the file explorer's live currentPath", () => {
  const fileExplorer = makeFileExplorer({
    currentWorkspaceId: "ws-1",
    currentPath: "/explorer/path",
  });
  const host = makeHost({
    fileExplorer,
    activeTerminal: { workspaceId: "ws-1", cwd: "/terminal/cwd" },
  });

  expect(host.getGitCwd()).toBe("/explorer/path");
});

test("getGitCwd() falls back to the active workspace cwd when the explorer has no path", () => {
  const fileExplorer = makeFileExplorer({
    currentWorkspaceId: null,
    currentPath: null,
  });
  const host = makeHost({
    fileExplorer,
    activeTerminal: { workspaceId: "ws-1", cwd: "/terminal/cwd" },
  });

  expect(host.getGitCwd()).toBe("/terminal/cwd");
});

test("getGitCwd() falls back to the active workspace cwd when there is no file explorer at all", () => {
  const host = makeHost({
    fileExplorer: null,
    activeTerminal: { workspaceId: "ws-1", cwd: "/terminal/cwd" },
  });

  expect(host.getGitCwd()).toBe("/terminal/cwd");
});

test("getGitCwd() falls back all the way to the directory field / '/' when nothing else is set", () => {
  const host = makeHost({
    fileExplorer: null,
    activeTerminal: null,
    currentDirectoryValue: "",
  });

  expect(host.getGitCwd()).toBe("/");

  const hostWithDraft = makeHost({
    fileExplorer: null,
    activeTerminal: null,
    currentDirectoryValue: "/typed/dir",
  });
  expect(hostWithDraft.getGitCwd()).toBe("/typed/dir");
});

// ── commitWorkingDirectory(): committed path → atomic navigate + git refresh ─

test("commitWorkingDirectory() navigates the explorer AND refreshes git for a workspace not yet opened", async () => {
  const fileExplorer = makeFileExplorer({
    currentWorkspaceId: null,
    currentPath: null,
  });
  let refreshCalls = 0;
  globalThis.window = { gitManager: { refresh: async () => refreshCalls++ } };

  const host = makeHost({
    fileExplorer,
    activeTerminal: { workspaceId: "ws-1", cwd: "/old/cwd" },
  });

  await host.commitWorkingDirectory("/new/project/");

  // openForWorkspace runs because the explorer's currentWorkspaceId (null)
  // doesn't match the active workspace yet.
  expect(fileExplorer.calls.openForWorkspace).toHaveLength(1);
  expect(fileExplorer.calls.openForWorkspace[0]).toEqual({
    workspaceId: "ws-1",
    cwd: "/new/project", // normalized (trailing slash stripped)
  });
  expect(fileExplorer.calls.loadDir).toHaveLength(1);
  expect(fileExplorer.calls.loadDir[0]).toEqual({
    path: "/new/project",
    workspaceId: "ws-1",
  });
  expect(refreshCalls).toBe(1);
});

test("commitWorkingDirectory() skips openForWorkspace (but still loadDir + refreshes git) when the workspace is already open", async () => {
  const fileExplorer = makeFileExplorer({
    currentWorkspaceId: "ws-1",
    currentPath: "/old/cwd",
  });
  let refreshCalls = 0;
  globalThis.window = { gitManager: { refresh: async () => refreshCalls++ } };

  const host = makeHost({
    fileExplorer,
    activeTerminal: { workspaceId: "ws-1", cwd: "/old/cwd" },
  });

  await host.commitWorkingDirectory("/new/cwd");

  expect(fileExplorer.calls.openForWorkspace).toHaveLength(0);
  expect(fileExplorer.calls.loadDir).toHaveLength(1);
  expect(fileExplorer.calls.loadDir[0]).toEqual({
    path: "/new/cwd",
    workspaceId: "ws-1",
  });
  expect(refreshCalls).toBe(1);
  // getGitCwd() now reflects the committed navigation immediately.
  expect(host.getGitCwd()).toBe("/new/cwd");
});

test("commitWorkingDirectory() is a no-op for an empty/whitespace value (no navigation, no git refresh)", async () => {
  const fileExplorer = makeFileExplorer({ currentWorkspaceId: "ws-1" });
  let refreshCalls = 0;
  globalThis.window = { gitManager: { refresh: async () => refreshCalls++ } };

  const host = makeHost({
    fileExplorer,
    activeTerminal: { workspaceId: "ws-1", cwd: "/old" },
  });

  await host.commitWorkingDirectory("   ");

  expect(fileExplorer.calls.openForWorkspace).toHaveLength(0);
  expect(fileExplorer.calls.loadDir).toHaveLength(0);
  expect(refreshCalls).toBe(0);
});

test("commitWorkingDirectory() still refreshes git even without an active workspace (no explorer nav possible)", async () => {
  let refreshCalls = 0;
  globalThis.window = { gitManager: { refresh: async () => refreshCalls++ } };

  const host = makeHost({
    fileExplorer: makeFileExplorer(),
    activeTerminal: null, // no workspaceId available
  });

  await host.commitWorkingDirectory("/some/path");

  expect(host.fileExplorer.calls.openForWorkspace).toHaveLength(0);
  expect(host.fileExplorer.calls.loadDir).toHaveLength(0);
  expect(refreshCalls).toBe(1);
});

test("commitWorkingDirectory() does not throw when window.gitManager is absent", async () => {
  globalThis.window = {}; // no gitManager registered yet
  const fileExplorer = makeFileExplorer({ currentWorkspaceId: "ws-1" });
  const host = makeHost({
    fileExplorer,
    activeTerminal: { workspaceId: "ws-1", cwd: "/old" },
  });

  await expect(host.commitWorkingDirectory("/new")).resolves.toBeUndefined();
  expect(fileExplorer.calls.loadDir).toHaveLength(1);
});

// ── Draft keystrokes (input event) must NOT navigate ────────────────────────

test("input-event drafts record the value but never navigate the explorer or refresh git", () => {
  const fileExplorer = makeFileExplorer({ currentWorkspaceId: "ws-1" });
  let refreshCalls = 0;
  globalThis.window = { gitManager: { refresh: async () => refreshCalls++ } };

  const host = makeHost({
    fileExplorer,
    activeTerminal: { workspaceId: "ws-1", cwd: "/old" },
  });

  // Simulate several keystrokes (input events) while typing a new path.
  host.onDirectoryInputEvent("/t");
  host.onDirectoryInputEvent("/ty");
  host.onDirectoryInputEvent("/typ");

  expect(host.calls.setDirectoryValue).toHaveLength(3);
  expect(host.calls.setDirectoryValue.every((c) => c.opts.userDraft)).toBe(
    true,
  );
  expect(fileExplorer.calls.openForWorkspace).toHaveLength(0);
  expect(fileExplorer.calls.loadDir).toHaveLength(0);
  expect(refreshCalls).toBe(0);
});

test("a change event (committed value) navigates + refreshes, unlike the input drafts preceding it", async () => {
  const fileExplorer = makeFileExplorer({ currentWorkspaceId: "ws-1" });
  let refreshCalls = 0;
  globalThis.window = { gitManager: { refresh: async () => refreshCalls++ } };

  const host = makeHost({
    fileExplorer,
    activeTerminal: { workspaceId: "ws-1", cwd: "/old" },
  });

  // Draft keystrokes first (no navigation)...
  host.onDirectoryInputEvent("/type");
  host.onDirectoryInputEvent("/typed");
  expect(fileExplorer.calls.loadDir).toHaveLength(0);

  // ...then the commit (change/Enter) — navigates + refreshes exactly once.
  await host.onDirectoryChangeEvent("/typed/path");

  expect(fileExplorer.calls.loadDir).toHaveLength(1);
  expect(fileExplorer.calls.loadDir[0].path).toBe("/typed/path");
  expect(refreshCalls).toBe(1);
});
