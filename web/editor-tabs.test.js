import { expect, test } from "bun:test";
import {
  EDITOR_TABS_KEY,
  TAB_FILE,
  TAB_DIFF,
  TAB_SETTINGS,
  TAB_TASKS,
  makeFileTab,
  makeDiffTab,
  makeSettingsTab,
  makeTasksTab,
  tabKey,
  findTabIndex,
  openTab,
  activateTab,
  closeTab,
  pinTab,
  serializeTabs,
  deserializeTabs,
  filterRestoredTabs,
  migrateEditorTabsState,
  EditorTabsModel,
} from "./editor-tabs";

// ── descriptor constructors ──────────────────────────────────────────────────

test("makeFileTab builds a file descriptor with a stable ref + preview default", () => {
  const tab = makeFileTab("/home/deploy/x.txt");
  expect(tab.type).toBe(TAB_FILE);
  expect(tab.ref).toBe("/home/deploy/x.txt");
  expect(tab.preview).toBe(true);
  expect(tab.pinned).toBe(false);
});

test("makeFileTab honours an explicit pinned/preview", () => {
  const tab = makeFileTab("/a", { preview: false });
  expect(tab.preview).toBe(false);
  expect(tab.pinned).toBe(true);
});

test("makeDiffTab encodes the diff sources into the ref descriptor", () => {
  const tab = makeDiffTab({
    relPath: "src/x.js",
    mode: "working",
    cwd: "/repo",
    title: "src/x.js (Working Tree)",
  });
  expect(tab.type).toBe(TAB_DIFF);
  expect(tab.ref.relPath).toBe("src/x.js");
  expect(tab.ref.mode).toBe("working");
  expect(tab.ref.cwd).toBe("/repo");
  // diff tabs always pinned (no preview semantics for diffs)
  expect(tab.preview).toBe(false);
});

// ── tabKey identity ──────────────────────────────────────────────────────────

test("tabKey is identical for the same file regardless of preview/pin", () => {
  expect(tabKey(makeFileTab("/a"))).toBe(
    tabKey(makeFileTab("/a", { preview: false })),
  );
  expect(tabKey(makeFileTab("/a"))).not.toBe(tabKey(makeFileTab("/b")));
});

test("tabKey distinguishes diff tabs by relPath+mode+cwd+commit", () => {
  const a = makeDiffTab({ relPath: "x", mode: "working", cwd: "/r" });
  const b = makeDiffTab({ relPath: "x", mode: "staged", cwd: "/r" });
  const c = makeDiffTab({ relPath: "x", mode: "working", cwd: "/r" });
  expect(tabKey(a)).not.toBe(tabKey(b));
  expect(tabKey(a)).toBe(tabKey(c));
  expect(tabKey(a)).not.toBe(tabKey(makeFileTab("x")));
});

// ── openTab (preview-slot / focus-if-open semantics) ─────────────────────────

test("openTab as preview replaces the existing preview slot", () => {
  let s = { tabs: [], activeKey: null };
  s = openTab(s, makeFileTab("/a")); // preview
  expect(s.tabs).toHaveLength(1);
  expect(s.tabs[0].preview).toBe(true);
  s = openTab(s, makeFileTab("/b")); // preview replaces /a
  expect(s.tabs).toHaveLength(1);
  expect(s.tabs[0].ref).toBe("/b");
  expect(s.activeKey).toBe(tabKey(makeFileTab("/b")));
});

test("openTab pinned keeps prior pinned tabs and appends", () => {
  let s = { tabs: [], activeKey: null };
  s = openTab(s, makeFileTab("/a", { preview: false })); // pinned
  s = openTab(s, makeFileTab("/b", { preview: false })); // pinned
  expect(s.tabs).toHaveLength(2);
  expect(s.tabs.every((t) => !t.preview)).toBe(true);
});

test("openTab a pinned file while a preview exists keeps the preview", () => {
  let s = { tabs: [], activeKey: null };
  s = openTab(s, makeFileTab("/a")); // preview
  s = openTab(s, makeFileTab("/b", { preview: false })); // pinned -> appended
  expect(s.tabs).toHaveLength(2);
  // preview slot still /a
  expect(s.tabs.find((t) => t.preview)?.ref).toBe("/a");
});

test("openTab an already-open file just focuses it (no duplicate)", () => {
  let s = { tabs: [], activeKey: null };
  s = openTab(s, makeFileTab("/a", { preview: false })); // pinned
  s = openTab(s, makeFileTab("/b")); // preview
  const before = s.tabs.length;
  s = openTab(s, makeFileTab("/a")); // reopen as preview -> focus existing pinned
  expect(s.tabs).toHaveLength(before);
  expect(s.activeKey).toBe(tabKey(makeFileTab("/a")));
  // existing tab stays pinned (not downgraded to preview)
  expect(s.tabs.find((t) => t.ref === "/a")?.preview).toBe(false);
});

test("openTab the current preview file again as pinned promotes it (double-click)", () => {
  let s = { tabs: [], activeKey: null };
  s = openTab(s, makeFileTab("/a")); // preview
  s = openTab(s, makeFileTab("/a", { preview: false })); // pin promote
  expect(s.tabs).toHaveLength(1);
  expect(s.tabs[0].preview).toBe(false);
});

// ── pinTab (edit / double-click promotes) ────────────────────────────────────

test("pinTab promotes the preview tab to pinned", () => {
  let s = { tabs: [], activeKey: null };
  s = openTab(s, makeFileTab("/a")); // preview
  s = pinTab(s, tabKey(makeFileTab("/a")));
  expect(s.tabs[0].preview).toBe(false);
  expect(s.tabs[0].pinned).toBe(true);
});

test("pinTab is a no-op for an unknown key", () => {
  let s = { tabs: [makeFileTab("/a")], activeKey: null };
  const next = pinTab(s, "nope");
  expect(next.tabs[0].preview).toBe(true);
});

// ── activateTab / closeTab ───────────────────────────────────────────────────

test("activateTab sets the active key when present", () => {
  let s = {
    tabs: [
      makeFileTab("/a", { preview: false }),
      makeFileTab("/b", { preview: false }),
    ],
    activeKey: null,
  };
  s = activateTab(s, tabKey(makeFileTab("/b")));
  expect(s.activeKey).toBe(tabKey(makeFileTab("/b")));
});

test("closeTab removes the tab and re-points active to a neighbour", () => {
  let s = { tabs: [], activeKey: null };
  s = openTab(s, makeFileTab("/a", { preview: false }));
  s = openTab(s, makeFileTab("/b", { preview: false }));
  s = openTab(s, makeFileTab("/c", { preview: false }));
  s = activateTab(s, tabKey(makeFileTab("/b")));
  s = closeTab(s, tabKey(makeFileTab("/b")));
  expect(s.tabs.map((t) => t.ref)).toEqual(["/a", "/c"]);
  // active moves to a surviving neighbour
  expect(["/a", "/c"]).toContain(
    s.tabs.find((t) => tabKey(t) === s.activeKey)?.ref,
  );
});

test("closeTab the last tab clears active", () => {
  let s = { tabs: [], activeKey: null };
  s = openTab(s, makeFileTab("/a", { preview: false }));
  s = closeTab(s, tabKey(makeFileTab("/a")));
  expect(s.tabs).toHaveLength(0);
  expect(s.activeKey).toBe(null);
});

// ── serialize / deserialize (descriptors only, never content) ────────────────

test("serializeTabs persists only descriptors + active + preview slot", () => {
  let s = { tabs: [], activeKey: null };
  s = openTab(s, makeFileTab("/a", { preview: false }));
  s = openTab(s, makeFileTab("/b")); // preview
  const ser = serializeTabs(s);
  expect(ser.schemaVersion).toBe(3);
  expect(ser.tabs).toEqual([
    { type: "file", ref: "/a", pinned: true, preview: false },
    { type: "file", ref: "/b", pinned: false, preview: true },
  ]);
  expect(ser.activeKey).toBe(tabKey(makeFileTab("/b")));
  // never embeds content
  expect(JSON.stringify(ser)).not.toContain("content");
});

test("deserializeTabs round-trips a serialized state", () => {
  let s = { tabs: [], activeKey: null };
  s = openTab(s, makeFileTab("/a", { preview: false }));
  s = openTab(s, makeFileTab("/b"));
  const round = deserializeTabs(serializeTabs(s));
  expect(round.tabs.map((t) => t.ref)).toEqual(["/a", "/b"]);
  expect(round.activeKey).toBe(s.activeKey);
});

test("deserializeTabs tolerates junk / missing fields", () => {
  expect(deserializeTabs(null).tabs).toEqual([]);
  expect(deserializeTabs("garbage").tabs).toEqual([]);
  expect(deserializeTabs({ tabs: "nope" }).tabs).toEqual([]);
  const partial = deserializeTabs({ tabs: [{ type: "file", ref: "/a" }] });
  expect(partial.tabs[0].ref).toBe("/a");
});

test("deserializeTabs round-trips a diff descriptor", () => {
  let s = { tabs: [], activeKey: null };
  s = openTab(
    s,
    makeDiffTab({ relPath: "src/x.js", mode: "staged", cwd: "/r", title: "t" }),
  );
  const round = deserializeTabs(serializeTabs(s));
  expect(round.tabs[0].type).toBe(TAB_DIFF);
  expect(round.tabs[0].ref.relPath).toBe("src/x.js");
  expect(round.tabs[0].ref.mode).toBe("staged");
});

// ── v3 migration (idempotent; never clobbers existing) ───────────────────────

test("migrateEditorTabsState seeds an empty v3 state for a versionless store", () => {
  const cache = {};
  const store = {
    get: (k, f) => (k in cache ? cache[k] : f),
    set: (k, v) => {
      cache[k] = v;
    },
  };
  const r = migrateEditorTabsState(store);
  expect(r.migrated).toBe(true);
  expect(cache[EDITOR_TABS_KEY].schemaVersion).toBe(3);
  expect(cache[EDITOR_TABS_KEY].tabs).toEqual([]);
});

test("migrateEditorTabsState never clobbers an existing editorTabs value", () => {
  const existing = {
    schemaVersion: 3,
    tabs: [{ type: "file", ref: "/keep", pinned: true, preview: false }],
    activeKey: "file:/keep",
  };
  const cache = { [EDITOR_TABS_KEY]: existing };
  const store = {
    get: (k, f) => (k in cache ? cache[k] : f),
    set: (k, v) => {
      cache[k] = v;
    },
  };
  const r = migrateEditorTabsState(store);
  expect(r.migrated).toBe(false);
  expect(cache[EDITOR_TABS_KEY]).toBe(existing);
});

// ── filterRestoredTabs (revalidation through the capability layer) ───────────

test("filterRestoredTabs drops tabs whose probe says they can't open", async () => {
  const restored = {
    tabs: [
      makeFileTab("/ok", { preview: false }),
      makeFileTab("/gone", { preview: false }),
      makeFileTab("/denied", { preview: false }),
    ],
    activeKey: tabKey(makeFileTab("/gone")),
  };
  // canOpen probe: only /ok survives.
  const canOpen = async (tab) => tab.ref === "/ok";
  const survived = await filterRestoredTabs(restored, canOpen);
  expect(survived.tabs.map((t) => t.ref)).toEqual(["/ok"]);
  // active pointed at a dropped tab -> re-points to a survivor
  expect(survived.activeKey).toBe(tabKey(makeFileTab("/ok")));
});

test("filterRestoredTabs keeps a valid active key", async () => {
  const restored = {
    tabs: [
      makeFileTab("/a", { preview: false }),
      makeFileTab("/b", { preview: false }),
    ],
    activeKey: tabKey(makeFileTab("/b")),
  };
  const survived = await filterRestoredTabs(restored, async () => true);
  expect(survived.activeKey).toBe(tabKey(makeFileTab("/b")));
});

test("filterRestoredTabs yields empty when nothing survives", async () => {
  const restored = {
    tabs: [makeFileTab("/x", { preview: false })],
    activeKey: tabKey(makeFileTab("/x")),
  };
  const survived = await filterRestoredTabs(restored, async () => false);
  expect(survived.tabs).toEqual([]);
  expect(survived.activeKey).toBe(null);
});

test("filterRestoredTabs treats a throwing probe as a drop (silent)", async () => {
  const restored = {
    tabs: [makeFileTab("/boom", { preview: false })],
    activeKey: null,
  };
  const survived = await filterRestoredTabs(restored, async () => {
    throw new Error("403");
  });
  expect(survived.tabs).toEqual([]);
});

// ── EditorTabsModel (stateful wrapper around the pure reducers) ──────────────

test("EditorTabsModel exposes the reducers as instance ops and emits change", () => {
  const model = new EditorTabsModel();
  let changes = 0;
  model.onChange = () => {
    changes += 1;
  };
  model.open(makeFileTab("/a"));
  expect(model.state.tabs).toHaveLength(1);
  expect(changes).toBeGreaterThan(0);
  model.open(makeFileTab("/a", { preview: false }));
  expect(model.state.tabs[0].preview).toBe(false);
  expect(model.activeTab()?.ref).toBe("/a");
  model.close(tabKey(makeFileTab("/a")));
  expect(model.state.tabs).toHaveLength(0);
});

// ── Explorer intent → preview vs pinned open (Fix 7, slice-4 review) ──────────

// The explorer threads a { pinned } intent (single open = preview, double-click
// = pinned). handleExplorerOpenFile maps it to makeFileTab({ preview: !pinned }).
// This covers the model-level outcome of that mapping.
test("explorer single-open (pinned:false) opens a PREVIEW tab", () => {
  const pinned = false;
  let s = openTab(
    { tabs: [], activeKey: null },
    makeFileTab("/a", { preview: !pinned }),
  );
  expect(s.tabs[0].preview).toBe(true);
  expect(s.tabs[0].pinned).toBe(false);
});

test("explorer double-click (pinned:true) opens a PINNED tab", () => {
  const pinned = true;
  let s = openTab(
    { tabs: [], activeKey: null },
    makeFileTab("/a", { preview: !pinned }),
  );
  expect(s.tabs[0].preview).toBe(false);
  expect(s.tabs[0].pinned).toBe(true);
});

test("explorer double-click on the current preview pins it in place (no dup)", () => {
  let s = openTab(
    { tabs: [], activeKey: null },
    makeFileTab("/a", { preview: true }),
  );
  // double-click the same file: pinned open promotes the existing preview.
  s = openTab(s, makeFileTab("/a", { preview: false }));
  expect(s.tabs).toHaveLength(1);
  expect(s.tabs[0].preview).toBe(false);
  expect(s.tabs[0].pinned).toBe(true);
});

// ── Controller body pruning (Fix 3, slice-4 review) ──────────────────────────

// Minimal DOM stub: enough for the controller's scaffold/render/body-cache path
// without a real browser (verifies orphan bodies are torn down + removed).
function fakeDocument() {
  const make = (tag) => {
    const el = {
      tagName: tag,
      className: "",
      dataset: {},
      children: [],
      hidden: false,
      attrs: {},
      _connected: true,
      classList: {
        _set: new Set(),
        add(c) {
          this._set.add(c);
        },
        remove(c) {
          this._set.delete(c);
        },
        toggle() {},
        contains(c) {
          return this._set.has(c);
        },
      },
      setAttribute(k, v) {
        this.attrs[k] = v;
      },
      appendChild(c) {
        this.children.push(c);
        c.parent = el;
        return c;
      },
      replaceChildren() {
        this.children = [];
      },
      remove() {
        this._connected = false;
        if (this.parent) {
          this.parent.children = this.parent.children.filter((x) => x !== this);
        }
      },
      addEventListener() {},
      querySelector() {
        return null;
      },
      get isConnected() {
        return this._connected;
      },
    };
    return el;
  };
  return { createElement: (tag) => make(tag) };
}

test("controller prunes + tears down a preview body replaced in place", async () => {
  const { EditorTabsController } = require("./editor-tabs");
  const doc = fakeDocument();
  const areaEl = doc.createElement("div");
  const tornDown = [];
  const controller = new EditorTabsController({
    document: doc,
    areaEl: () => areaEl,
    placeholderEl: () => null,
    mountFileBody: async () => {},
    onBodyTeardown: (key) => tornDown.push(key),
  });

  // Open preview /a, render + mount its body.
  controller.openFile("/a", { preview: true });
  await controller.renderActiveBody();
  const keyA = tabKey(makeFileTab("/a"));
  expect(controller.bodies.has(keyA)).toBe(true);

  // Open preview /b: it REPLACES /a's preview slot. Render must prune /a's body.
  controller.openFile("/b", { preview: true });
  expect(controller.bodies.has(keyA)).toBe(false);
  expect(tornDown).toContain(keyA);
});

// ── Concurrent same-key mount guard (Fix 1, slice-4 code-quality follow-up) ───

// Two activations of the SAME key racing a slow async mount must NOT start two
// mounts: a second body/handle would orphan the first (the body-mount path
// overwrites the per-key handle unconditionally, leaking the first view). The
// in-flight guard makes the second activation a no-op until the first resolves.
test("controller guards a concurrent same-key mount (only one body/handle, none dropped)", async () => {
  const { EditorTabsController } = require("./editor-tabs");
  const doc = fakeDocument();
  const areaEl = doc.createElement("div");

  // Simulate the app's body-mount path: it registers a handle per key (like
  // app.mountEditorFileTab → editorTabHandles.set(key, handle)) and the
  // controller destroys it on teardown via onBodyTeardown.
  const handles = new Map();
  const destroyed = [];
  let mountCount = 0;
  let releaseMount;
  const mountGate = new Promise((resolve) => {
    releaseMount = resolve;
  });

  const controller = new EditorTabsController({
    document: doc,
    areaEl: () => areaEl,
    placeholderEl: () => null,
    mountFileBody: async (_hostEl, tab) => {
      mountCount += 1;
      const key = tabKey(tab);
      await mountGate; // slow mount: stays pending until released
      // Unconditional overwrite (mirrors app.mountEditorFileTab).
      handles.set(key, { id: mountCount });
    },
    onBodyTeardown: (key) => {
      // Destroying the live handle for a torn-down body (mirrors the app).
      if (handles.has(key)) {
        destroyed.push(key);
        handles.delete(key);
      }
    },
  });

  const keyR = tabKey(makeFileTab("/race"));

  // Open the file: render() starts the gated mount #1 (mountCount → 1) and marks
  // the key pending. The mount stays in flight until we release the gate.
  controller.openFile("/race", { preview: true });
  await Promise.resolve(); // let the sync part of render()/mountFileBody run
  expect(mountCount).toBe(1);
  expect(controller.pendingMounts.has(keyR)).toBe(true);

  // Close + reopen the SAME key WHILE mount #1 is still in flight. closeKey drops
  // the cached body (so the cache is empty for that key) and reopen re-renders.
  // Without the guard, that re-render would see bodies.get(key) undefined and
  // start a SECOND mount, overwriting the first handle (the leak). The in-flight
  // guard makes the reopen's render a no-op until mount #1 resolves.
  controller.closeKey(keyR);
  controller.openFile("/race", { preview: true });
  await Promise.resolve();
  expect(mountCount).toBe(1); // guarded: no second mount started

  releaseMount();
  // Let mount #1 resolve + its post-await re-check + any follow-on render drain.
  await new Promise((r) => setTimeout(r, 0));

  // The mount ran exactly once; at most one handle survives and no handle was
  // ever left dropped without a destroy (handles dropped → recorded in
  // `destroyed`). No second mount means no orphaned/leaked view.
  expect(mountCount).toBe(1);
  expect(handles.size).toBeLessThanOrEqual(1);
  expect(controller.pendingMounts.size).toBe(0);
});

// ── Open-at-line (slice 7: search result → editor) ───────────────────────────

// openFile with { line } records a one-shot reveal target keyed by tabKey, and
// the body-mount path consumes it via onRevealLine exactly once. A later mount
// of the SAME file with no line must NOT re-fire a stale reveal.
test("openFile { line } reveals the line once after the body mounts", async () => {
  const { EditorTabsController } = require("./editor-tabs");
  const doc = fakeDocument();
  const areaEl = doc.createElement("div");
  const reveals = [];
  const controller = new EditorTabsController({
    document: doc,
    areaEl: () => areaEl,
    placeholderEl: () => null,
    mountFileBody: async () => {},
    onRevealLine: (key, target) => reveals.push({ key, ...target }),
  });

  controller.openFile("/file.js", { preview: true, line: 12, col: 4 });
  const key = tabKey(makeFileTab("/file.js"));
  // The reveal is pending until the body mounts.
  expect(controller.pendingReveal.has(key)).toBe(true);

  await controller.renderActiveBody();
  expect(reveals).toEqual([{ key, line: 12, col: 4 }]);
  // One-shot: consumed, so the pending entry is gone.
  expect(controller.pendingReveal.has(key)).toBe(false);

  // Re-activating the already-mounted body must NOT re-fire a reveal.
  await controller.renderActiveBody();
  expect(reveals).toHaveLength(1);
});

test("openFile without line never fires a reveal", async () => {
  const { EditorTabsController } = require("./editor-tabs");
  const doc = fakeDocument();
  const areaEl = doc.createElement("div");
  const reveals = [];
  const controller = new EditorTabsController({
    document: doc,
    areaEl: () => areaEl,
    placeholderEl: () => null,
    mountFileBody: async () => {},
    onRevealLine: (key, target) => reveals.push({ key, ...target }),
  });
  controller.openFile("/plain.js", { preview: true });
  await controller.renderActiveBody();
  expect(reveals).toHaveLength(0);
});

// ── Slice 8: Settings tab (Part A) ───────────────────────────────────────────

// tabKey namespacing: settings key must NEVER collide with a file named "settings".
test("tabKey for settings is namespaced and never collides with a file path", () => {
  const settingsTab = makeSettingsTab();
  const fileNamedSettings = makeFileTab("settings");
  const fileAbsSettings = makeFileTab("/home/deploy/settings");
  expect(tabKey(settingsTab)).toBe("settings:global");
  expect(tabKey(settingsTab)).not.toBe(tabKey(fileNamedSettings));
  expect(tabKey(settingsTab)).not.toBe(tabKey(fileAbsSettings));
  expect(tabKey(fileNamedSettings)).toBe("file:settings");
  expect(tabKey(fileAbsSettings)).toBe("file:/home/deploy/settings");
});

// makeSettingsTab builds a pinned, non-preview singleton.
test("makeSettingsTab builds a pinned non-preview settings descriptor", () => {
  const tab = makeSettingsTab();
  expect(tab.type).toBe(TAB_SETTINGS);
  expect(tab.pinned).toBe(true);
  expect(tab.preview).toBe(false);
  expect(tab.ref).toBe(null);
});

// EditorTabsModel.openSettings: second open focuses, doesn't duplicate.
test("EditorTabsModel.openSettings opens a pinned settings tab (singleton)", () => {
  const model = new EditorTabsModel();
  model.openSettings();
  expect(model.state.tabs).toHaveLength(1);
  expect(model.state.tabs[0].type).toBe(TAB_SETTINGS);
  expect(model.state.activeKey).toBe("settings:global");

  // Second open: focuses, no duplicate.
  model.open(makeFileTab("/a", { preview: false }));
  expect(model.state.tabs).toHaveLength(2);
  model.openSettings();
  // Still exactly 1 settings tab.
  expect(model.state.tabs.filter((t) => t.type === TAB_SETTINGS)).toHaveLength(
    1,
  );
  expect(model.state.activeKey).toBe("settings:global");
});

// openSettings NEVER touches the previewKey (Codex fix 4).
test("EditorTabsModel.openSettings never clears/replaces the existing preview slot", () => {
  const model = new EditorTabsModel();
  // Open a file as preview first.
  model.open(makeFileTab("/preview.js", { preview: true }));
  const previewKey = tabKey(makeFileTab("/preview.js"));
  expect(model.state.tabs.find((t) => tabKey(t) === previewKey)?.preview).toBe(
    true,
  );

  // Open settings: must not replace the preview slot.
  model.openSettings();
  // Preview tab still there and still preview.
  const preview = model.state.tabs.find((t) => tabKey(t) === previewKey);
  expect(preview).toBeTruthy();
  expect(preview?.preview).toBe(true);
  // Settings tab appended (not in the preview slot).
  expect(model.state.tabs).toHaveLength(2);
  expect(model.state.activeKey).toBe("settings:global");
});

// serialize emits {type:"settings"} with no extra fields.
test("serializeTabs emits {type:'settings'} for a settings tab", () => {
  const model = new EditorTabsModel();
  model.openSettings();
  const ser = serializeTabs(model.state);
  expect(ser.tabs).toHaveLength(1);
  expect(ser.tabs[0]).toEqual({ type: "settings" });
  // Never embeds content or ref.
  expect(JSON.stringify(ser.tabs[0])).not.toContain("content");
  expect(JSON.stringify(ser.tabs[0])).not.toContain('"ref"');
});

// Restore filter is type-scoped: settings passes WITHOUT a probe (Codex fix 1).
test("filterRestoredTabs restores a settings tab without calling canOpen probe", async () => {
  const restored = {
    tabs: [makeSettingsTab()],
    activeKey: "settings:global",
  };
  let probeCallCount = 0;
  // canOpen should NOT be called for settings tabs.
  const canOpen = async () => {
    probeCallCount += 1;
    return true;
  };
  const survived = await filterRestoredTabs(restored, canOpen);
  expect(probeCallCount).toBe(0); // no probe for settings
  expect(survived.tabs).toHaveLength(1);
  expect(survived.tabs[0].type).toBe(TAB_SETTINGS);
  expect(survived.activeKey).toBe("settings:global");
});

// Unknown types are dropped (type-scoped restore, Codex fix 1).
test("filterRestoredTabs drops unknown tab types silently", async () => {
  const unknownTab = { type: "future-unknown-type", ref: "x", pinned: true };
  // reviveDescriptor drops unknown types, so they should not survive deserialize.
  const raw = {
    schemaVersion: 3,
    tabs: [
      { type: "file", ref: "/ok", pinned: true, preview: false },
      unknownTab,
    ],
    activeKey: "file:/ok",
  };
  const restored = deserializeTabs(raw);
  // Unknown type dropped at revive time.
  expect(restored.tabs.every((t) => t.type !== "future-unknown-type")).toBe(
    true,
  );
  expect(restored.tabs).toHaveLength(1);
  expect(restored.tabs[0].ref).toBe("/ok");
});

// Backward-compat: a LEGACY file descriptor with NO `type` field (older stores)
// revives as a file (not dropped), while an explicit unknown type still drops.
test("deserializeTabs revives a legacy type-less descriptor as a file", () => {
  const restored = deserializeTabs({
    schemaVersion: 3,
    tabs: [
      { ref: "/legacy.js", pinned: true }, // no `type` (old store)
      { type: "future-unknown-type", ref: "/x" }, // explicit unknown → drop
    ],
    activeKey: "file:/legacy.js",
  });
  expect(restored.tabs).toHaveLength(1);
  expect(restored.tabs[0].type).toBe("file");
  expect(restored.tabs[0].ref).toBe("/legacy.js");
});

// At most ONE settings tab restored (de-dup, Codex fix 5).
test("filterRestoredTabs accepts at most one settings tab (de-dup)", async () => {
  const restored = {
    tabs: [makeSettingsTab(), makeSettingsTab(), makeSettingsTab()],
    activeKey: "settings:global",
  };
  const survived = await filterRestoredTabs(restored, async () => true);
  const settingsTabs = survived.tabs.filter((t) => t.type === TAB_SETTINGS);
  expect(settingsTabs).toHaveLength(1);
});

// ── Slice 8: Dirty-close guard (Part B) ──────────────────────────────────────

// A dirty file tab close is aborted when confirm returns false (Codex fix 3).
test("requestCloseKey aborts close of a dirty file tab when confirm declines", () => {
  const { EditorTabsController } = require("./editor-tabs");
  const doc = fakeDocument();
  const areaEl = doc.createElement("div");
  let confirmed = false;
  const controller = new EditorTabsController({
    document: doc,
    areaEl: () => areaEl,
    placeholderEl: () => null,
    mountFileBody: async () => {},
    isDirtyImpl: () => true, // always dirty
    confirmImpl: () => {
      confirmed = true;
      return false; // decline → abort close
    },
  });

  controller.openFile("/dirty.js", { preview: false });
  const key = tabKey(makeFileTab("/dirty.js"));
  expect(controller.model.state.tabs).toHaveLength(1);

  controller.requestCloseKey(key);
  expect(confirmed).toBe(true); // confirm was called
  expect(controller.model.state.tabs).toHaveLength(1); // tab still present
});

// A non-dirty file tab closes without prompting.
test("requestCloseKey closes a clean file tab without prompting", () => {
  const { EditorTabsController } = require("./editor-tabs");
  const doc = fakeDocument();
  const areaEl = doc.createElement("div");
  let prompted = false;
  const controller = new EditorTabsController({
    document: doc,
    areaEl: () => areaEl,
    placeholderEl: () => null,
    mountFileBody: async () => {},
    isDirtyImpl: () => false, // clean
    confirmImpl: () => {
      prompted = true;
      return true;
    },
  });

  controller.openFile("/clean.js", { preview: false });
  const key = tabKey(makeFileTab("/clean.js"));
  controller.requestCloseKey(key);
  expect(prompted).toBe(false); // no prompt for clean tab
  expect(controller.model.state.tabs).toHaveLength(0); // closed
});

// diff tab closes without prompting (no dirty state for diffs).
test("requestCloseKey closes a diff tab without prompting", () => {
  const { EditorTabsController } = require("./editor-tabs");
  const doc = fakeDocument();
  const areaEl = doc.createElement("div");
  let prompted = false;
  const controller = new EditorTabsController({
    document: doc,
    areaEl: () => areaEl,
    placeholderEl: () => null,
    mountDiffBody: async () => {},
    isDirtyImpl: () => true, // would be dirty if file, but diff ignores it
    confirmImpl: () => {
      prompted = true;
      return false;
    },
  });

  controller.openDiff({ relPath: "a.js", mode: "working", cwd: "/r" });
  const diffTab = makeDiffTab({ relPath: "a.js", mode: "working", cwd: "/r" });
  const key = tabKey(diffTab);
  controller.requestCloseKey(key);
  expect(prompted).toBe(false); // diff → no prompt
  expect(controller.model.state.tabs).toHaveLength(0);
});

// Settings tab closes without prompting.
test("requestCloseKey closes a settings tab without prompting", () => {
  const { EditorTabsController } = require("./editor-tabs");
  const doc = fakeDocument();
  const areaEl = doc.createElement("div");
  let prompted = false;
  const controller = new EditorTabsController({
    document: doc,
    areaEl: () => areaEl,
    placeholderEl: () => null,
    mountSettingsBody: async () => {},
    isDirtyImpl: () => true,
    confirmImpl: () => {
      prompted = true;
      return false;
    },
  });

  controller.openSettings();
  const key = "settings:global";
  controller.requestCloseKey(key);
  expect(prompted).toBe(false); // settings → no prompt
  expect(controller.model.state.tabs).toHaveLength(0);
});

// Programmatic removal (closeKey) never prompts even for a dirty file tab.
test("closeKey (programmatic) never prompts even for a dirty file tab", () => {
  const { EditorTabsController } = require("./editor-tabs");
  const doc = fakeDocument();
  const areaEl = doc.createElement("div");
  let prompted = false;
  const controller = new EditorTabsController({
    document: doc,
    areaEl: () => areaEl,
    placeholderEl: () => null,
    mountFileBody: async () => {},
    isDirtyImpl: () => true, // dirty
    confirmImpl: () => {
      prompted = true;
      return false;
    },
  });

  controller.openFile("/dirty.js", { preview: false });
  const key = tabKey(makeFileTab("/dirty.js"));
  // Programmatic path: closeKey bypasses the confirm.
  controller.closeKey(key);
  expect(prompted).toBe(false); // no prompt for programmatic close
  expect(controller.model.state.tabs).toHaveLength(0); // closed
});

// Settings tab singleton via EditorTabsController.openSettings().
test("EditorTabsController.openSettings opens singleton, second call focuses not duplicates", () => {
  const { EditorTabsController } = require("./editor-tabs");
  const doc = fakeDocument();
  const areaEl = doc.createElement("div");
  const controller = new EditorTabsController({
    document: doc,
    areaEl: () => areaEl,
    placeholderEl: () => null,
    mountSettingsBody: async () => {},
  });

  controller.openSettings();
  expect(controller.model.state.tabs).toHaveLength(1);
  expect(controller.model.state.tabs[0].type).toBe(TAB_SETTINGS);
  expect(controller.model.state.activeKey).toBe("settings:global");

  // Open a file, then open settings again — should focus, not duplicate.
  controller.openFile("/x.js", { preview: false });
  expect(controller.model.state.tabs).toHaveLength(2);
  controller.openSettings();
  const settingsTabs = controller.model.state.tabs.filter(
    (t) => t.type === TAB_SETTINGS,
  );
  expect(settingsTabs).toHaveLength(1);
  expect(controller.model.state.activeKey).toBe("settings:global");
});

// ── Task Board tab (backlog: tasks board in the main editor area) ────────────

// tabKey namespacing: tasks key must NEVER collide with a file named "tasks".
test("tabKey for tasks is namespaced and never collides with a file path", () => {
  const tasksTab = makeTasksTab();
  expect(tabKey(tasksTab)).toBe("tasks:board");
  expect(tabKey(tasksTab)).not.toBe(tabKey(makeFileTab("tasks")));
  expect(tabKey(tasksTab)).not.toBe(tabKey(makeSettingsTab()));
});

// makeTasksTab builds a pinned, non-preview singleton.
test("makeTasksTab builds a pinned non-preview tasks descriptor", () => {
  const tab = makeTasksTab();
  expect(tab.type).toBe(TAB_TASKS);
  expect(tab.pinned).toBe(true);
  expect(tab.preview).toBe(false);
  expect(tab.ref).toBe(null);
});

// EditorTabsModel.openTasksBoard: second open focuses, doesn't duplicate.
test("EditorTabsModel.openTasksBoard opens a pinned tasks tab (singleton)", () => {
  const model = new EditorTabsModel();
  model.openTasksBoard();
  expect(model.state.tabs).toHaveLength(1);
  expect(model.state.tabs[0].type).toBe(TAB_TASKS);
  expect(model.state.activeKey).toBe("tasks:board");

  model.open(makeFileTab("/a", { preview: false }));
  expect(model.state.tabs).toHaveLength(2);
  model.openTasksBoard();
  expect(model.state.tabs.filter((t) => t.type === TAB_TASKS)).toHaveLength(1);
  expect(model.state.activeKey).toBe("tasks:board");
});

// openTasksBoard NEVER touches the preview slot (mirrors openSettings).
test("EditorTabsModel.openTasksBoard never clears/replaces the existing preview slot", () => {
  const model = new EditorTabsModel();
  model.open(makeFileTab("/preview.js", { preview: true }));
  const previewKey = tabKey(makeFileTab("/preview.js"));

  model.openTasksBoard();
  const preview = model.state.tabs.find((t) => tabKey(t) === previewKey);
  expect(preview).toBeTruthy();
  expect(preview?.preview).toBe(true);
  expect(model.state.tabs).toHaveLength(2);
  expect(model.state.activeKey).toBe("tasks:board");
});

// serialize emits {type:"tasks"} with no extra fields; round-trips.
test("serializeTabs emits {type:'tasks'} for a tasks tab and it round-trips", () => {
  const model = new EditorTabsModel();
  model.openTasksBoard();
  const ser = serializeTabs(model.state);
  expect(ser.tabs).toHaveLength(1);
  expect(ser.tabs[0]).toEqual({ type: "tasks" });

  const restored = deserializeTabs(ser);
  expect(restored.tabs).toHaveLength(1);
  expect(restored.tabs[0].type).toBe(TAB_TASKS);
  expect(restored.tabs[0].pinned).toBe(true);
});

// Restore filter is type-scoped: tasks passes WITHOUT a probe + de-dups.
test("filterRestoredTabs restores at most one tasks tab without calling canOpen", async () => {
  const restored = {
    tabs: [makeTasksTab(), makeTasksTab()],
    activeKey: "tasks:board",
  };
  let probeCallCount = 0;
  const canOpen = async () => {
    probeCallCount += 1;
    return true;
  };
  const survived = await filterRestoredTabs(restored, canOpen);
  expect(probeCallCount).toBe(0);
  expect(survived.tabs).toHaveLength(1);
  expect(survived.tabs[0].type).toBe(TAB_TASKS);
  expect(survived.activeKey).toBe("tasks:board");
});

// Tasks tab singleton via EditorTabsController.openTasksBoard() + mount hook.
test("EditorTabsController.openTasksBoard opens singleton and mounts via mountTasksBody", async () => {
  const { EditorTabsController } = require("./editor-tabs");
  const doc = fakeDocument();
  const areaEl = doc.createElement("div");
  let mounts = 0;
  const controller = new EditorTabsController({
    document: doc,
    areaEl: () => areaEl,
    placeholderEl: () => null,
    mountTasksBody: async () => {
      mounts += 1;
    },
  });

  controller.openTasksBoard();
  expect(controller.model.state.tabs).toHaveLength(1);
  expect(controller.model.state.tabs[0].type).toBe(TAB_TASKS);
  expect(controller.model.state.activeKey).toBe("tasks:board");
  await controller.renderActiveBody();
  expect(mounts).toBe(1);

  // Second open focuses, no duplicate, no re-mount (body is cached).
  controller.openTasksBoard();
  await controller.renderActiveBody();
  expect(
    controller.model.state.tabs.filter((t) => t.type === TAB_TASKS),
  ).toHaveLength(1);
  expect(mounts).toBe(1);
});
