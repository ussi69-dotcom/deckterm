import { test, expect } from "bun:test";
import {
  scmSections,
  scmTotalCount,
  scmDiffModeForSection,
  GitScmViewController,
} from "./git-scm-view.js";

test("scmSections returns the three groups in render order with files + actions", () => {
  const groups = {
    staged: [{ path: "a.js" }],
    changes: [{ path: "b.js" }, { path: "c.js" }],
    untracked: [{ path: "d.js" }],
  };
  const sections = scmSections(groups);
  expect(sections.map((s) => s.key)).toEqual([
    "staged",
    "changes",
    "untracked",
  ]);
  expect(sections[0].label).toBe("Staged Changes");
  expect(sections[0].groupAction).toBe("unstage-all");
  expect(sections[0].mode).toBe("staged");
  expect(sections[1].groupAction).toBe("stage-all");
  expect(sections[1].mode).toBe("working");
  expect(sections[2].mode).toBe("working");
  expect(sections[1].files).toHaveLength(2);
});

test("scmSections tolerates a missing / partial groups map", () => {
  expect(scmSections(undefined).every((s) => Array.isArray(s.files))).toBe(
    true,
  );
  expect(scmSections({}).every((s) => s.files.length === 0)).toBe(true);
  const partial = scmSections({ staged: [{ path: "x" }] });
  expect(partial[0].files).toHaveLength(1);
  expect(partial[1].files).toHaveLength(0);
});

test("scmTotalCount sums files across all groups", () => {
  expect(
    scmTotalCount({
      staged: [{ path: "a" }],
      changes: [{ path: "b" }, { path: "c" }],
      untracked: [],
    }),
  ).toBe(3);
  expect(scmTotalCount({})).toBe(0);
  expect(scmTotalCount(undefined)).toBe(0);
});

test("scmDiffModeForSection maps staged → staged, others → working", () => {
  expect(scmDiffModeForSection("staged")).toBe("staged");
  expect(scmDiffModeForSection("changes")).toBe("working");
  expect(scmDiffModeForSection("untracked")).toBe("working");
  expect(scmDiffModeForSection("whatever")).toBe("working");
});

// ── GitScmViewController — controller-level tests ────────────────────────────
//
// DOM-free fake harness mirroring the ide-shell.test.js pattern: hand-rolled
// fake elements + a fake document, no jsdom. Tests drive the controller via its
// public lifecycle API and assert state on the fake DOM objects.

// A minimal fake element. querySelector resolves against a `_subs` map (CSS
// selector → fake element) that tests can populate after mount. All DOM
// mutators the controller uses are noops or state-tracking stubs.
function makeFakeEl() {
  const el = {
    _subs: {}, // querySelector stub: sel → element
    _classes: new Set(),
    innerHTML: "",
    value: "",
    checked: false,
    textContent: "",
    parentElement: null,
    children: [],
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
    setAttribute() {},
    getAttribute() {
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) {
      if (child.parentElement && child.parentElement !== el) {
        const idx = child.parentElement.children.indexOf(child);
        if (idx >= 0) child.parentElement.children.splice(idx, 1);
      }
      if (!el.children.includes(child)) el.children.push(child);
      child.parentElement = el;
      return child;
    },
    removeChild(child) {
      const idx = el.children.indexOf(child);
      if (idx >= 0) el.children.splice(idx, 1);
      child.parentElement = null;
    },
    // querySelector resolves against _subs; callers set this up after mount.
    querySelector(sel) {
      return Object.prototype.hasOwnProperty.call(el._subs, sel)
        ? el._subs[sel]
        : null;
    },
    querySelectorAll() {
      return [];
    },
  };
  return el;
}

// A fake document: createElement returns fresh fake elements. The container
// returned here is used as the mount target so tests can grab the root via
// container.children[0] or controller.root after mount.
function makeFakeDoc() {
  return {
    createElement() {
      return makeFakeEl();
    },
  };
}

// A fake git-status store. Listeners registered via onChange are collected;
// _emit() fires them all so tests can simulate external status changes.
function makeFakeStore() {
  const listeners = [];
  return {
    listeners,
    onChange(fn) {
      listeners.push(fn);
      // Return an unsubscribe function.
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    _emit() {
      for (const fn of listeners.slice()) fn();
    },
  };
}

// A fake GitManager with configurable state. commitWith is a stub that tests
// replace per-scenario. statusLetter is needed by renderSignature via getScm().
function makeFakeGm(stateOverrides = {}) {
  return {
    state: {
      files: { staged: [], changes: [], untracked: [] },
      branches: { current: "main", list: ["main"] },
      sync: { ahead: 0, behind: 0 },
      stashes: [],
      cwd: "/repo",
      ...stateOverrides,
    },
    currentCwd: "/repo",
    commitWith: async () => ({ ok: true }),
    async refresh() {},
  };
}

// Wire a GitScmViewController with fakes; overrides replaces individual deps.
function makeScmController(overrides = {}) {
  const doc = overrides.document || makeFakeDoc();
  const store = overrides.store || makeFakeStore();
  const gm = overrides.gm || makeFakeGm();
  const container = makeFakeEl();

  const ctl = new GitScmViewController({
    document: doc,
    getGitManager: () => gm,
    getStatusStore: () => store,
    getTerminalManager: () => null,
  });

  return { ctl, doc, store, gm, container };
}

// ── (1) onChange unsubscribe on unmount ─────────────────────────────────────

test("mount() subscribes to the status store; unmount() tears down the subscription", () => {
  const { ctl, store, container } = makeScmController();

  // Before mount: no listeners.
  expect(store.listeners).toHaveLength(0);

  ctl.mount(container);

  // After mount: exactly one listener registered + _unsubscribe is a function.
  expect(store.listeners).toHaveLength(1);
  expect(typeof ctl._unsubscribe).toBe("function");

  ctl.unmount();

  // After unmount: listener removed + _unsubscribe nulled.
  expect(store.listeners).toHaveLength(0);
  expect(ctl._unsubscribe).toBeNull();
});

test("store onChange after unmount does NOT trigger a render (subscription is torn down)", () => {
  const { ctl, store, container, gm } = makeScmController();
  ctl.mount(container);
  ctl.unmount();

  // Capture the render-sig state at unmount time.
  const sigAfterUnmount = ctl._renderSig;

  // Change the gm state so a live render WOULD update the sig.
  gm.state.branches.current = "feature";

  // Fire the store onChange — should be a no-op (no listener registered).
  store._emit();

  // _renderSig must not have changed (render() never ran).
  expect(ctl._renderSig).toBe(sigAfterUnmount);
});

test("re-mounting after unmount does not double-subscribe (exactly 1 listener after re-mount)", () => {
  const { ctl, store, container } = makeScmController();

  ctl.mount(container);
  ctl.unmount();
  ctl.mount(container);

  expect(store.listeners).toHaveLength(1);

  ctl.unmount();
  expect(store.listeners).toHaveLength(0);
});

// ── (2) renderSignature dedup ────────────────────────────────────────────────

test("two render() calls with identical state set _renderSig once (dedup short-circuits)", () => {
  const { ctl, container } = makeScmController();
  ctl.mount(container);

  // Record the sig after the first render (called inside mount).
  const sig1 = ctl._renderSig;
  expect(sig1).not.toBeNull();

  // Call render() again with no state change → should short-circuit (sig unchanged).
  ctl.render();
  expect(ctl._renderSig).toBe(sig1);
});

test("render() rebuilds when git state changes (different signature triggers re-render)", () => {
  const { ctl, container, gm } = makeScmController();
  ctl.mount(container);
  const sig1 = ctl._renderSig;

  // Mutate the git state (add a changed file).
  gm.state.files.changes = [{ path: "src/foo.js", x: "M", y: " " }];
  ctl.render();

  // Signature must have changed → a new render was not skipped.
  expect(ctl._renderSig).not.toBe(sig1);
  expect(ctl._renderSig).not.toBeNull();
});

test("render() rebuilds when branch changes (signature spans branch + sync)", () => {
  const { ctl, container, gm } = makeScmController();
  ctl.mount(container);
  const sig1 = ctl._renderSig;

  gm.state.branches.current = "dev";
  ctl.render();

  expect(ctl._renderSig).not.toBe(sig1);
});

// ── (3) commit() success + error ─────────────────────────────────────────────

test("commit() success: clears the message textarea, does not surface an error", async () => {
  const { ctl, container, gm } = makeScmController();
  ctl.mount(container);

  // Wire fake sub-elements on the live root so this.q(sel) returns them.
  const msgEl = makeFakeEl();
  msgEl.value = "fix: correct the thing";
  const amendEl = makeFakeEl();
  amendEl.checked = false;
  const statusEl = makeFakeEl();
  ctl.root._subs[".ide-scm-message"] = msgEl;
  ctl.root._subs[".ide-scm-amend-input"] = amendEl;
  ctl.root._subs[".ide-scm-commit-status"] = statusEl;

  gm.commitWith = async ({ message, amend }) => {
    return { ok: true };
  };

  ctl.commit();
  // commit() is async internally; drain the microtask queue.
  await new Promise((r) => setTimeout(r, 0));

  // Success: textarea cleared.
  expect(msgEl.value).toBe("");
  // Status shows "Committed", not an error string.
  expect(statusEl.textContent).toBe("Committed");
});

test("commit() error: preserves the message textarea + surfaces the error", async () => {
  const { ctl, container, gm } = makeScmController();
  ctl.mount(container);

  const msgEl = makeFakeEl();
  msgEl.value = "fix: something";
  const amendEl = makeFakeEl();
  const statusEl = makeFakeEl();
  ctl.root._subs[".ide-scm-message"] = msgEl;
  ctl.root._subs[".ide-scm-amend-input"] = amendEl;
  ctl.root._subs[".ide-scm-commit-status"] = statusEl;

  gm.commitWith = async () => ({ ok: false, error: "nothing to commit" });

  ctl.commit();
  await new Promise((r) => setTimeout(r, 0));

  // On error the message textarea must NOT be cleared.
  expect(msgEl.value).toBe("fix: something");
  // The error text is surfaced.
  expect(statusEl.textContent).toBe("nothing to commit");
});

test("commit() with empty/whitespace message does not call commitWith", async () => {
  const { ctl, container, gm } = makeScmController();
  ctl.mount(container);

  const msgEl = makeFakeEl();
  msgEl.value = "   "; // whitespace only
  const statusEl = makeFakeEl();
  ctl.root._subs[".ide-scm-message"] = msgEl;
  ctl.root._subs[".ide-scm-commit-status"] = statusEl;

  let commitCalled = false;
  gm.commitWith = async () => {
    commitCalled = true;
    return { ok: true };
  };

  ctl.commit();
  await new Promise((r) => setTimeout(r, 0));

  expect(commitCalled).toBe(false);
  // Controller surfaces the "required" hint.
  expect(statusEl.textContent).toBe("Commit message required");
});

// ── (1b) refresh() re-resolves the live cwd every call (no more freeze) ─────

test("refresh() re-resolves the live cwd on every call instead of freezing on the first value", async () => {
  // gm.state.cwd starts pre-set to a STALE value (simulating a panel that
  // already mounted once against the wrong directory) — the old guard
  // (`if (!gm.state?.cwd && !gm.currentCwd)`) would never touch it again.
  const gm = makeFakeGm({ cwd: "/home/deploy" });
  gm.currentCwd = "/home/deploy";
  let liveCwd = "/repo";
  const ctl = new GitScmViewController({
    document: makeFakeDoc(),
    getGitManager: () => gm,
    getStatusStore: () => makeFakeStore(),
    getTerminalManager: () => ({ getGitCwd: () => liveCwd }),
  });
  const container = makeFakeEl();
  ctl.mount(container);

  await ctl.refresh();
  expect(gm.state.cwd).toBe("/repo");
  expect(gm.currentCwd).toBe("/repo");

  // Explorer navigation moves the live cwd again — a second refresh() must
  // pick it up (not stay frozen at "/repo").
  liveCwd = "/repo2";
  await ctl.refresh();
  expect(gm.state.cwd).toBe("/repo2");
  expect(gm.currentCwd).toBe("/repo2");
});

// ── (4) History section ───────────────────────────────────────────────────────

test("skeletonHtml() contains the History section markup above Branches", () => {
  const { ctl } = makeScmController();
  const html = ctl.skeletonHtml();
  // History section must be present
  expect(html).toContain('data-section="history"');
  expect(html).toContain("ide-scm-history-body");
  // History must appear before Branches in the string
  const historyPos = html.indexOf('data-section="history"');
  const branchesPos = html.indexOf('data-section="branches"');
  expect(historyPos).toBeLessThan(branchesPos);
});

test("collapsed.history starts as true (History section collapsed by default)", () => {
  const { ctl } = makeScmController();
  expect(ctl.collapsed.history).toBe(true);
});

test("renderSignature includes collHistory flag", () => {
  const { ctl, container, gm } = makeScmController();
  ctl.mount(container);
  const scm = {
    statusLetter: () => "M",
    statusClass: () => "modified",
    groupStatusFiles: () => ({}),
  };

  const sig1 = ctl.renderSignature(gm, gm.state.files, scm);
  expect(sig1).toContain("collHistory");

  // Toggling history changes the signature
  ctl.collapsed.history = false;
  const sig2 = ctl.renderSignature(gm, gm.state.files, scm);
  expect(sig2).not.toBe(sig1);
  expect(sig2).toContain("collHistory");
});

test("toggling history collapse changes the renderSignature (expand/collapse re-renders)", () => {
  const { ctl, container, gm } = makeScmController();
  ctl.mount(container);
  const sig1 = ctl._renderSig;

  // Toggle history open
  ctl.collapsed.history = false;
  ctl.render();
  const sig2 = ctl._renderSig;
  expect(sig2).not.toBe(sig1);

  // Toggle history closed again
  ctl.collapsed.history = true;
  ctl.render();
  const sig3 = ctl._renderSig;
  expect(sig3).not.toBe(sig2);
  expect(sig3).toBe(sig1); // back to original collapsed state
});

test("unmount() disposes the _historyCtl when it exists", () => {
  const { ctl, container } = makeScmController();
  ctl.mount(container);

  // Inject a fake history controller
  let disposed = false;
  ctl._historyCtl = {
    unmount() {
      disposed = true;
    },
  };

  ctl.unmount();
  expect(disposed).toBe(true);
  expect(ctl._historyCtl).toBeNull();
});

// ── (4b) History per-file scope (6b) ─────────────────────────────────────────

// Build a controller whose TerminalManager reports a given active-file abs path.
function makeScmCtlWithActiveFile(activeFilePath, cwd = "/repo") {
  const gm = makeFakeGm({ cwd });
  return new GitScmViewController({
    document: makeFakeDoc(),
    getGitManager: () => gm,
    getStatusStore: () => makeFakeStore(),
    getTerminalManager: () => ({
      getActiveEditorFilePath: () => activeFilePath,
    }),
  });
}

test("skeletonHtml() includes the Repo/File history scope toggle", () => {
  const { ctl } = makeScmController();
  const html = ctl.skeletonHtml();
  expect(html).toContain('data-history-scope="repo"');
  expect(html).toContain('data-history-scope="file"');
});

test("historyScope defaults to repo and renderSignature includes histScope", () => {
  const { ctl, gm } = makeScmController();
  expect(ctl.historyScope).toBe("repo");
  const scm = require("./git-scm");
  const sig1 = ctl.renderSignature(gm, gm.state.files, scm);
  expect(sig1).toContain("histScope");
  ctl.historyScope = "file";
  const sig2 = ctl.renderSignature(gm, gm.state.files, scm);
  expect(sig1).not.toBe(sig2);
});

test("activeFileRelPath() strips the repo cwd prefix from the active file path", () => {
  const ctl = makeScmCtlWithActiveFile("/repo/src/app.js", "/repo");
  expect(ctl.activeFileRelPath()).toBe("src/app.js");
});

test("activeFileRelPath() returns null when no file is active or it's outside the repo", () => {
  expect(
    makeScmCtlWithActiveFile(null, "/repo").activeFileRelPath(),
  ).toBeNull();
  expect(
    makeScmCtlWithActiveFile("/elsewhere/x.js", "/repo").activeFileRelPath(),
  ).toBeNull();
});

test("onActiveFileChanged() is a no-op in repo scope or when collapsed", () => {
  const ctl = makeScmCtlWithActiveFile("/repo/a.js", "/repo");
  let rendered = 0;
  ctl.renderHistory = () => {
    rendered += 1;
  };
  // repo scope + collapsed → no render
  ctl.onActiveFileChanged();
  expect(rendered).toBe(0);
  // file scope but still collapsed → no render
  ctl.historyScope = "file";
  ctl.onActiveFileChanged();
  expect(rendered).toBe(0);
  // file scope + expanded → renders
  ctl.collapsed.history = false;
  ctl.onActiveFileChanged();
  expect(rendered).toBe(1);
});

test("onSectionsClick switches history scope to file and expands the section", () => {
  const { ctl } = makeScmController();
  ctl.render = () => {}; // isolate from full render
  const evt = {
    target: {
      closest: (sel) =>
        sel === "[data-history-scope]"
          ? { dataset: { historyScope: "file" } }
          : null,
    },
  };
  ctl.onSectionsClick(evt);
  expect(ctl.historyScope).toBe("file");
  expect(ctl.collapsed.history).toBe(false);
});
