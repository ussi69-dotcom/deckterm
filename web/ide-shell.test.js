import { expect, test } from "bun:test";
import {
  LAYOUT_SCHEMA_VERSION,
  LAYOUT_MODE_KEY,
  LAYOUT_SCHEMA_VERSION_KEY,
  normalizeLayoutMode,
  toggleLayoutMode,
  resolveRenderedMode,
  isIdeRendered,
  loadLayoutState,
  migrateLayoutState,
  captureFocusTarget,
  resolveFocusTarget,
  captureExplorerState,
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

test("loadLayoutState reads stored mode + version, defaulting cleanly", () => {
  const empty = makeFakeStore();
  expect(loadLayoutState(empty)).toEqual({
    mode: "terminal",
    schemaVersion: LAYOUT_SCHEMA_VERSION,
  });

  const stored = makeFakeStore({
    "layout.mode": "ide",
    "layout.schemaVersion": LAYOUT_SCHEMA_VERSION,
  });
  expect(loadLayoutState(stored)).toEqual({
    mode: "ide",
    schemaVersion: LAYOUT_SCHEMA_VERSION,
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
