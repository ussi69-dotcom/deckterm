import { expect, test } from "bun:test";
import {
  LAYOUT_SCHEMA_VERSION,
  LAYOUT_MODE_KEY,
  LAYOUT_SCHEMA_VERSION_KEY,
  LAYOUT_DETACHED_KEY,
  VIEW_EXPLORER,
  EXPLORER_HOST_SIDEBAR,
  EXPLORER_HOST_DETACHED,
  normalizeLayoutMode,
  toggleLayoutMode,
  resolveRenderedMode,
  isIdeRendered,
  loadLayoutState,
  migrateLayoutState,
  normalizeDetachedState,
  loadDetachedState,
  isViewDetached,
  setViewDetached,
  resolveExplorerHost,
  captureFocusTarget,
  resolveFocusTarget,
  captureExplorerState,
  IdeShellController,
} from "./ide-shell";

// ── normalizeLayoutMode ──────────────────────────────────────────────────────

test("normalizeLayoutMode coerces only the two valid modes, defaults to terminal", () => {
  expect(normalizeLayoutMode("ide")).toBe("ide");
  expect(normalizeLayoutMode("terminal")).toBe("terminal");
  expect(normalizeLayoutMode("IDE")).toBe("ide");
  expect(normalizeLayoutMode("  terminal  ")).toBe("terminal");
  expect(normalizeLayoutMode("garbage")).toBe("terminal");
  expect(normalizeLayoutMode(null)).toBe("terminal");
  expect(normalizeLayoutMode(undefined)).toBe("terminal");
  expect(normalizeLayoutMode(42)).toBe("terminal");
});

// ── toggleLayoutMode (mode reducer) ──────────────────────────────────────────

test("toggleLayoutMode flips between the two modes", () => {
  expect(toggleLayoutMode("terminal")).toBe("ide");
  expect(toggleLayoutMode("ide")).toBe("terminal");
  // Reducer is total: invalid input is treated as terminal, so it flips to ide.
  expect(toggleLayoutMode("nonsense")).toBe("ide");
});

// ── resolveRenderedMode (viewport gating) ────────────────────────────────────

test("resolveRenderedMode renders the stored mode on desktop", () => {
  expect(resolveRenderedMode("ide", true)).toBe("ide");
  expect(resolveRenderedMode("terminal", true)).toBe("terminal");
});

test("resolveRenderedMode forces terminal below the desktop breakpoint", () => {
  // IDE mode is desktop-only: a non-desktop viewport ALWAYS renders terminal,
  // regardless of the stored desktop preference.
  expect(resolveRenderedMode("ide", false)).toBe("terminal");
  expect(resolveRenderedMode("terminal", false)).toBe("terminal");
});

test("resolveRenderedMode does NOT mutate or imply overwriting the stored mode", () => {
  // It is a pure resolver: the stored mode passed in is returned unchanged
  // (string in, string out), so callers can keep persisting "ide" while a
  // narrow viewport merely renders terminal.
  const stored = "ide";
  const rendered = resolveRenderedMode(stored, false);
  expect(rendered).toBe("terminal");
  expect(stored).toBe("ide");
});

test("isIdeRendered is the boolean convenience over resolveRenderedMode", () => {
  expect(isIdeRendered("ide", true)).toBe(true);
  expect(isIdeRendered("ide", false)).toBe(false);
  expect(isIdeRendered("terminal", true)).toBe(false);
});

// ── schema versioning + migration ────────────────────────────────────────────

test("layout schema constants are stable canonical keys", () => {
  expect(LAYOUT_MODE_KEY).toBe("layout.mode");
  expect(LAYOUT_SCHEMA_VERSION_KEY).toBe("layout.schemaVersion");
  expect(LAYOUT_SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
});

function makeFakeStore(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get(key, fallback) {
      return Object.prototype.hasOwnProperty.call(data, key)
        ? data[key]
        : fallback;
    },
    set(key, value) {
      if (value === null || value === undefined) delete data[key];
      else data[key] = value;
    },
    has(key) {
      return Object.prototype.hasOwnProperty.call(data, key);
    },
  };
}

test("loadLayoutState reads stored mode + version + detached, defaulting cleanly", () => {
  const empty = makeFakeStore();
  expect(loadLayoutState(empty)).toEqual({
    mode: "terminal",
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    detached: {},
  });

  const stored = makeFakeStore({
    "layout.mode": "ide",
    "layout.schemaVersion": LAYOUT_SCHEMA_VERSION,
    "layout.detached": { explorer: true },
  });
  expect(loadLayoutState(stored)).toEqual({
    mode: "ide",
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    detached: { explorer: true },
  });

  // A bad stored mode is normalized.
  const bad = makeFakeStore({ "layout.mode": "junk" });
  expect(loadLayoutState(bad).mode).toBe("terminal");
});

test("migrateLayoutState stamps the schema version on a versionless store", () => {
  const store = makeFakeStore({ "layout.mode": "ide" });
  const result = migrateLayoutState(store);
  expect(result.migrated).toBe(true);
  expect(store.get("layout.schemaVersion")).toBe(LAYOUT_SCHEMA_VERSION);
  // It must NOT clobber an existing mode preference.
  expect(store.get("layout.mode")).toBe("ide");
});

test("migrateLayoutState is idempotent once the version is current", () => {
  const store = makeFakeStore({
    "layout.mode": "terminal",
    "layout.schemaVersion": LAYOUT_SCHEMA_VERSION,
  });
  const result = migrateLayoutState(store);
  expect(result.migrated).toBe(false);
  expect(store.get("layout.schemaVersion")).toBe(LAYOUT_SCHEMA_VERSION);
});

test("migrateLayoutState no-ops without a store", () => {
  expect(migrateLayoutState(null)).toEqual({ migrated: false });
});

// ── captureFocusTarget (pure focus snapshot) ─────────────────────────────────

test("captureFocusTarget prefers a live active terminal", () => {
  expect(captureFocusTarget({ activeTerminalId: "t-1" })).toEqual({
    kind: "terminal",
    terminalId: "t-1",
  });
  // A terminal wins even if a control tag is also passed.
  expect(
    captureFocusTarget({ activeTerminalId: "t-2", activeControl: "explorer" }),
  ).toEqual({ kind: "terminal", terminalId: "t-2" });
});

test("captureFocusTarget falls back to a focused control, else none", () => {
  expect(captureFocusTarget({ activeControl: "explorer" })).toEqual({
    kind: "control",
    control: "explorer",
  });
  expect(captureFocusTarget({})).toEqual({ kind: "none" });
  expect(captureFocusTarget()).toEqual({ kind: "none" });
  expect(
    captureFocusTarget({ activeTerminalId: null, activeControl: null }),
  ).toEqual({
    kind: "none",
  });
});

// ── resolveFocusTarget (pure post-switch resolution) ─────────────────────────

test("resolveFocusTarget keeps a terminal target only if it still exists", () => {
  const target = { kind: "terminal", terminalId: "t-1" };
  expect(resolveFocusTarget(target, (id) => id === "t-1")).toEqual(target);
  // Terminal gone → no focus restore.
  expect(resolveFocusTarget(target, () => false)).toEqual({ kind: "none" });
  // Missing predicate → conservatively "none".
  expect(resolveFocusTarget(target)).toEqual({ kind: "none" });
});

test("resolveFocusTarget passes control targets through and guards junk", () => {
  const control = { kind: "control", control: "explorer" };
  expect(resolveFocusTarget(control, () => true)).toEqual(control);
  expect(resolveFocusTarget({ kind: "none" }, () => true)).toEqual({
    kind: "none",
  });
  expect(resolveFocusTarget(null, () => true)).toEqual({ kind: "none" });
  expect(resolveFocusTarget(undefined)).toEqual({ kind: "none" });
});

// ── captureExplorerState (pure prior-state capture) ──────────────────────────

test("captureExplorerState normalizes a flat DOM read", () => {
  expect(
    captureExplorerState({
      parentId: "app",
      isOpen: true,
      surfaceWindow: "files",
    }),
  ).toEqual({ parentId: "app", isOpen: true, surfaceWindow: "files" });
});

test("captureExplorerState defaults missing/blank fields to a closed-home state", () => {
  expect(captureExplorerState({})).toEqual({
    parentId: null,
    isOpen: false,
    surfaceWindow: null,
  });
  expect(captureExplorerState()).toEqual({
    parentId: null,
    isOpen: false,
    surfaceWindow: null,
  });
  // Blank strings + falsy open coerce cleanly.
  expect(
    captureExplorerState({ parentId: "", isOpen: 0, surfaceWindow: "" }),
  ).toEqual({ parentId: null, isOpen: false, surfaceWindow: null });
});

// ── Slice 3: schema v2 + detached-state helpers ──────────────────────────────

test("schema version is v3 (slice 4 bumped it for layout.editorTabs)", () => {
  expect(LAYOUT_SCHEMA_VERSION).toBe(3);
  expect(LAYOUT_DETACHED_KEY).toBe("layout.detached");
  expect(VIEW_EXPLORER).toBe("explorer");
});

test("migrateLayoutState v1 store → current stamps version, never clobbers keys", () => {
  // A store left at v1 with an existing mode + (hypothetical) detached map must
  // be bumped to the current schema WITHOUT touching either existing value.
  const store = makeFakeStore({
    "layout.mode": "ide",
    "layout.schemaVersion": 1,
    "layout.detached": { explorer: true },
  });
  const result = migrateLayoutState(store);
  expect(result.migrated).toBe(true);
  expect(store.get("layout.schemaVersion")).toBe(LAYOUT_SCHEMA_VERSION);
  expect(store.get("layout.mode")).toBe("ide");
  expect(store.get("layout.detached")).toEqual({ explorer: true });
});

test("normalizeDetachedState keeps only true entries, tolerates junk + JSON", () => {
  expect(normalizeDetachedState({ explorer: true })).toEqual({
    explorer: true,
  });
  // Falsy/non-true entries are dropped (docked views are simply absent).
  expect(normalizeDetachedState({ explorer: false, git: 1, x: "y" })).toEqual(
    {},
  );
  expect(normalizeDetachedState('{"explorer":true}')).toEqual({
    explorer: true,
  });
  expect(normalizeDetachedState("not json")).toEqual({});
  expect(normalizeDetachedState(null)).toEqual({});
  expect(normalizeDetachedState([1, 2])).toEqual({});
  expect(normalizeDetachedState(42)).toEqual({});
});

test("loadDetachedState reads the persisted map, defaulting to empty", () => {
  expect(loadDetachedState(makeFakeStore())).toEqual({});
  expect(
    loadDetachedState(makeFakeStore({ "layout.detached": { explorer: true } })),
  ).toEqual({ explorer: true });
  expect(loadDetachedState(null)).toEqual({});
});

test("isViewDetached reports per-view detached flag over a (raw or normalized) map", () => {
  expect(isViewDetached({ explorer: true }, "explorer")).toBe(true);
  expect(isViewDetached({ explorer: true }, "git")).toBe(false);
  expect(isViewDetached({}, "explorer")).toBe(false);
  expect(isViewDetached({ explorer: false }, "explorer")).toBe(false);
  // Tolerates JSON strings too.
  expect(isViewDetached('{"explorer":true}', "explorer")).toBe(true);
});

test("setViewDetached is a pure reducer that never mutates its input", () => {
  const before = { git: true };
  const after = setViewDetached(before, "explorer", true);
  expect(after).toEqual({ git: true, explorer: true });
  // Input untouched.
  expect(before).toEqual({ git: true });
  // Docking drops the key entirely (minimal persisted shape).
  expect(
    setViewDetached({ explorer: true, git: true }, "explorer", false),
  ).toEqual({ git: true });
  // Docking an absent view is a no-op.
  expect(setViewDetached({}, "explorer", false)).toEqual({});
});

test("resolveExplorerHost routes the single element to home/sidebar/detached", () => {
  // Not IDE → terminal-mode home, regardless of the detached flag.
  expect(resolveExplorerHost("terminal", false)).toBe("home");
  expect(resolveExplorerHost("terminal", true)).toBe("home");
  // IDE + docked → sidebar.
  expect(resolveExplorerHost("ide", false)).toBe(EXPLORER_HOST_SIDEBAR);
  // IDE + detached → floating window.
  expect(resolveExplorerHost("ide", true)).toBe(EXPLORER_HOST_DETACHED);
  // Junk mode normalizes to terminal → home.
  expect(resolveExplorerHost("garbage", true)).toBe("home");
});

// ── Slice 3 follow-up: IdeShellController imperative pop-out/dock reparent ────
//
// The pure helpers above are exhaustively covered. These tests instead drive the
// CONTROLLER's imperative reparent dispatch (mount/unmount, detach/dock hooks,
// element reparenting), the part the slice-3 fix commit (b477749) hardened that
// had zero automated coverage. We keep it DOM-free: hand-rolled fake elements +
// a fake document, in the same spirit as the rest of the codebase's web tests.

// A minimal fake DOM element: enough surface for the controller's reparent path.
// `appendChild` sets the child's `parentElement` (and removes it from a prior
// parent's children) so tests can assert WHERE the single #file-explorer lands.
function makeFakeEl(id = null) {
  const el = {
    id,
    parentElement: null,
    children: [],
    hidden: false,
    _classes: new Set(),
    _attrs: {},
    dataset: {},
    classList: {
      add(...names) {
        for (const n of names) el._classes.add(n);
      },
      remove(...names) {
        for (const n of names) el._classes.delete(n);
      },
      contains(name) {
        return el._classes.has(name);
      },
      toggle(name, force) {
        const want = force === undefined ? !el._classes.has(name) : !!force;
        if (want) el._classes.add(name);
        else el._classes.delete(name);
        return want;
      },
    },
    setAttribute(key, value) {
      el._attrs[key] = String(value);
    },
    getAttribute(key) {
      return Object.prototype.hasOwnProperty.call(el._attrs, key)
        ? el._attrs[key]
        : null;
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) {
      if (child.parentElement && child.parentElement !== el) {
        const sibs = child.parentElement.children;
        const i = sibs.indexOf(child);
        if (i >= 0) sibs.splice(i, 1);
      }
      if (!el.children.includes(child)) el.children.push(child);
      child.parentElement = el;
      return child;
    },
    insertBefore(node /*, ref */) {
      return el.appendChild(node);
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    get firstChild() {
      return el.children[0] || null;
    },
  };
  return el;
}

// A fake document with a fixed registry of elements by id. `createElement`
// returns fresh fake elements (used for the shell scaffold the controller builds
// lazily). `getElementById` returns a registered element or null.
function makeFakeDoc() {
  const byId = new Map();
  const register = (id) => {
    const el = makeFakeEl(id);
    byId.set(id, el);
    return el;
  };
  // Stable elements the controller reaches for by id.
  register("workspace-area");
  register("terminal-container");
  register("app");
  register("file-explorer");
  const body = makeFakeEl("body");
  const doc = {
    body,
    getElementById(id) {
      return byId.get(id) || null;
    },
    createElement() {
      return makeFakeEl(null);
    },
    _byId: byId,
    _register: register,
  };
  return doc;
}

// A spy FileExplorerController (ViewHost contract). Records mount/unmount/resize
// call counts + the last mount target so tests can assert the SAME instance is
// reused (never reconstructed) across enter/toggle/exit.
function makeFakeView() {
  const calls = { mount: 0, unmount: 0, resize: 0 };
  return {
    calls,
    lastMountEl: null,
    mount(el) {
      calls.mount += 1;
      this.lastMountEl = el;
    },
    unmount() {
      calls.unmount += 1;
    },
    resize() {
      calls.resize += 1;
    },
  };
}

// Wire a controller with sensible fakes; `overrides` replaces any option.
function makeController(overrides = {}) {
  const doc = overrides.document || makeFakeDoc();
  const store = overrides.settingsStore || makeFakeStore();
  const view = overrides.view || makeFakeView();
  // The detached host: a container the detach hook returns + reparents into.
  const detachedHost =
    overrides.detachedHost || makeFakeEl("ide-explorer-window");
  const detachHookCalls = { count: 0 };
  const dockHookCalls = { count: 0 };

  const options = {
    document: doc,
    settingsStore: store,
    isDesktop: () => true,
    getExplorerView: () => view,
    // Default detach hook: return the detached host (success path). Overridable.
    detachExplorerWindow:
      overrides.detachExplorerWindow !== undefined
        ? overrides.detachExplorerWindow
        : (el) => {
            detachHookCalls.count += 1;
            detachHookCalls.lastEl = el;
            return detachedHost;
          },
    dockExplorerWindow:
      overrides.dockExplorerWindow !== undefined
        ? overrides.dockExplorerWindow
        : () => {
            dockHookCalls.count += 1;
          },
    ...overrides.extraOptions,
  };
  // Start in IDE mode unless told otherwise.
  if (overrides.startMode !== "terminal") {
    store.set(LAYOUT_MODE_KEY, "ide");
  }
  const controller = new IdeShellController(options);
  return {
    controller,
    doc,
    store,
    view,
    detachedHost,
    detachHookCalls,
    dockHookCalls,
    explorerEl: () => doc.getElementById("file-explorer"),
    sidebarBody: () => controller.sidebarBodyEl,
  };
}

// ── (1) toggleExplorerDetached happy path ────────────────────────────────────

test("toggleExplorerDetached pops out into the detached host, then docks back", () => {
  const h = makeController();
  h.controller.applyMode(); // enter IDE → explorer mounts in the sidebar
  expect(h.controller.rendered).toBe(true);
  expect(h.controller.isExplorerDetached()).toBe(false);
  expect(h.explorerEl().parentElement).toBe(h.sidebarBody());

  // Toggle → detached: flag persisted true, hook called, element in detached host.
  h.controller.toggleExplorerDetached();
  expect(h.controller.isExplorerDetached()).toBe(true);
  expect(h.store.get(LAYOUT_DETACHED_KEY)).toEqual({ explorer: true });
  expect(h.detachHookCalls.count).toBe(1);
  expect(h.detachHookCalls.lastEl).toBe(h.explorerEl());
  expect(h.explorerEl().parentElement).toBe(h.detachedHost);

  // Toggle again → docked: flag cleared, dock hook called, element back in sidebar.
  h.controller.toggleExplorerDetached();
  expect(h.controller.isExplorerDetached()).toBe(false);
  // Persisted map has the explorer key dropped (minimal shape: empty map).
  expect(normalizeDetachedState(h.store.get(LAYOUT_DETACHED_KEY))).toEqual({});
  expect(h.dockHookCalls.count).toBe(1);
  expect(h.explorerEl().parentElement).toBe(h.sidebarBody());
});

test("toggleExplorerDetached is a no-op outside rendered IDE mode", () => {
  const h = makeController();
  // Not entered yet (rendered === false).
  h.controller.toggleExplorerDetached();
  expect(h.controller.isExplorerDetached()).toBe(false);
  expect(h.detachHookCalls.count).toBe(0);
});

// ── (2) Detach-fallback flag rollback (Codex slice-3 #2) ─────────────────────

test("mountExplorerDetached falls back to sidebar + rolls back flag when no detach hook is wired", () => {
  // detachExplorerWindow absent → mountExplorerDetached must fall back.
  const h = makeController({ detachExplorerWindow: null });
  h.controller.applyMode(); // enter IDE
  h.controller.toggleExplorerDetached();
  // Persisted flag rolled back to false; element landed in the sidebar.
  expect(h.controller.isExplorerDetached()).toBe(false);
  expect(normalizeDetachedState(h.store.get(LAYOUT_DETACHED_KEY))).toEqual({});
  expect(h.explorerEl().parentElement).toBe(h.sidebarBody());
});

test("mountExplorerDetached rolls back when the detach hook returns null", () => {
  const h = makeController({ detachExplorerWindow: () => null });
  h.controller.applyMode();
  h.controller.toggleExplorerDetached();
  expect(h.controller.isExplorerDetached()).toBe(false);
  expect(normalizeDetachedState(h.store.get(LAYOUT_DETACHED_KEY))).toEqual({});
  expect(h.explorerEl().parentElement).toBe(h.sidebarBody());
});

test("mountExplorerDetached rolls back when the detach hook throws", () => {
  const h = makeController({
    detachExplorerWindow: () => {
      throw new Error("window failed to open");
    },
  });
  h.controller.applyMode();
  h.controller.toggleExplorerDetached();
  expect(h.controller.isExplorerDetached()).toBe(false);
  expect(normalizeDetachedState(h.store.get(LAYOUT_DETACHED_KEY))).toEqual({});
  expect(h.explorerEl().parentElement).toBe(h.sidebarBody());
});

// ── (3) Dock-back element survival + dock hook (no onClose loop) ──────────────

test("docking back closes via the dock hook and reparents the SAME element home", () => {
  // Enter IDE detached from the start (persisted flag set before render).
  const h = makeController();
  h.store.set(LAYOUT_DETACHED_KEY, { explorer: true });
  h.controller.applyMode();
  // Entered straight into the detached host.
  expect(h.controller.isExplorerDetached()).toBe(true);
  expect(h.explorerEl().parentElement).toBe(h.detachedHost);
  const elBefore = h.explorerEl();

  // Dock back: dock hook fires exactly once (maps to manager.close = hide-only),
  // and the single element survives — reparented into the sidebar, not lost.
  h.controller.toggleExplorerDetached();
  expect(h.dockHookCalls.count).toBe(1);
  expect(h.explorerEl()).toBe(elBefore); // same node (not recreated/lost)
  expect(elBefore.parentElement).toBe(h.sidebarBody());
  expect(h.detachedHost.children.includes(elBefore)).toBe(false);
});

test("dockExplorer (activity-bar click) docks only when detached, else no-op", () => {
  const h = makeController();
  h.store.set(LAYOUT_DETACHED_KEY, { explorer: true });
  h.controller.applyMode();
  expect(h.controller.isExplorerDetached()).toBe(true);

  h.controller.dockExplorer();
  expect(h.controller.isExplorerDetached()).toBe(false);
  expect(h.dockHookCalls.count).toBe(1);

  // Already docked → no-op (no extra dock-hook fire).
  h.controller.dockExplorer();
  expect(h.dockHookCalls.count).toBe(1);
});

// ── (4) resolveExplorerHost across mode × detached via the controller ────────
// (the pure resolver itself is covered above; here we exercise the controller's
//  live host resolution wiring through renderedMode + isExplorerDetached.)

test("controller.explorerHost reflects mode × detached × viewport", () => {
  const desktop = makeController();
  // Terminal mode → home regardless of detached flag.
  desktop.store.set(LAYOUT_MODE_KEY, "terminal");
  desktop.store.set(LAYOUT_DETACHED_KEY, { explorer: true });
  expect(desktop.controller.explorerHost()).toBe("home");

  // IDE + docked → sidebar.
  desktop.store.set(LAYOUT_MODE_KEY, "ide");
  desktop.store.set(LAYOUT_DETACHED_KEY, {});
  expect(desktop.controller.explorerHost()).toBe(EXPLORER_HOST_SIDEBAR);

  // IDE + detached → detached.
  desktop.store.set(LAYOUT_DETACHED_KEY, { explorer: true });
  expect(desktop.controller.explorerHost()).toBe(EXPLORER_HOST_DETACHED);

  // Non-desktop viewport forces terminal → home even with IDE stored + detached.
  const mobile = makeController({ extraOptions: { isDesktop: () => false } });
  mobile.store.set(LAYOUT_MODE_KEY, "ide");
  mobile.store.set(LAYOUT_DETACHED_KEY, { explorer: true });
  expect(mobile.controller.explorerHost()).toBe("home");
});

// ── (5) Controller REUSES the injected view (never reconstructs it) ──────────

test("controller reuses the same explorer view instance across enter/toggle/exit", () => {
  const view = makeFakeView();
  const h = makeController({ view });
  // The getter always returns the same injected instance.
  expect(h.controller.explorerView).toBe(view);

  h.controller.applyMode(); // enter → rebind (unmount+mount+resize)
  const afterEnter = { ...view.calls };
  expect(afterEnter.mount).toBeGreaterThanOrEqual(1);
  expect(h.controller.explorerView).toBe(view);

  h.controller.toggleExplorerDetached(); // pop out → rebind on same view
  expect(view.calls.mount).toBeGreaterThan(afterEnter.mount);
  expect(view.calls.unmount).toBeGreaterThan(afterEnter.unmount);
  expect(h.controller.explorerView).toBe(view);

  h.controller.toggleExplorerDetached(); // dock back → rebind on same view
  h.controller.exitIde(); // exit → unmount/mount once more (fallback restore)
  expect(h.controller.explorerView).toBe(view);
  // Mount target was always the single #file-explorer element.
  expect(view.lastMountEl).toBe(h.explorerEl());
});

test("controller restores explorer state losslessly via the app hook on exit", () => {
  const restored = [];
  const h = makeController({
    extraOptions: {
      readExplorerState: () => ({
        parentId: "app",
        isOpen: true,
        surfaceWindow: "files",
      }),
      restoreExplorerState: (descriptor) => restored.push(descriptor),
    },
  });
  h.controller.applyMode(); // enter (captures prior state)
  h.controller.exitIde(); // exit → app hook restores the captured descriptor
  expect(restored).toHaveLength(1);
  expect(restored[0]).toEqual({
    parentId: "app",
    isOpen: true,
    surfaceWindow: "files",
  });
});
