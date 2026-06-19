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
