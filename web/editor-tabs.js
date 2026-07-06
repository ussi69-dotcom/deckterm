// Editor tabs (VS Code IDE shell, phase 5 — slice 4).
//
// The IDE editor area is a tab bar + content host. This module owns:
//   - a PURE, DOM-free tab model (open-tabs list, the single preview slot, the
//     active tab) with reducers for open / activate / close / pin — all total
//     and immutable, so they're unit-tested without a browser.
//   - VS Code preview semantics: single-click opens a PREVIEW tab (one slot,
//     replaced by the next preview); double-click OR an edit PINS it; opening an
//     already-open file just focuses it.
//   - the `layout.editorTabs` v3 descriptor (de)serialization + idempotent
//     migration, persisting ONLY descriptors (never file content).
//   - the revalidation filter: given restored descriptors + an async canOpen()
//     probe (which re-opens each tab through the gated file/git endpoints), it
//     yields the surviving tabs and silently drops anything that 403/404s.
//
// The DOM controller (EditorTabsController, browser-only) renders the tab bar +
// content host into the IDE editor area and delegates content rendering to the
// app via injected mount callbacks — it never imports CodeMirror itself (it
// reuses FileEditor's CodeMirror machinery + app.renderMergeDiff through hooks).

// ── Canonical keys + tab types ───────────────────────────────────────────────

// layout.editorTabs is part of the IDE-shell layout schema (bumped 2 → 3 in
// slice 4). The state is stored as a self-describing object under this key.
const EDITOR_TABS_KEY = "layout.editorTabs";
const EDITOR_TABS_SCHEMA_VERSION = 3;

const TAB_FILE = "file";
const TAB_DIFF = "diff";
const TAB_SETTINGS = "settings";
const TAB_TASKS = "tasks";

// ── Pure tab model (DOM-free, unit-tested) ───────────────────────────────────

// A file tab. `preview` true = the single italic preview slot; pinned = the
// opposite. Default open is a preview (single-click). Passing { preview:false }
// (double-click / edit) builds a pinned tab.
function makeFileTab(path, { preview = true } = {}) {
  const isPreview = preview !== false;
  return {
    type: TAB_FILE,
    ref: String(path || ""),
    pinned: !isPreview,
    preview: isPreview,
  };
}

// A diff tab. The ref carries everything needed to re-render the merge diff:
// the file rel path, the diff mode (working/staged/commit/timeline), the repo
// cwd, an optional commit/ref, and a human title. Diffs are always pinned (no
// preview semantics) so a diff opened from the SCM list isn't clobbered.
function makeDiffTab({ relPath, mode, cwd, commit, ref, title } = {}) {
  return {
    type: TAB_DIFF,
    ref: {
      relPath: String(relPath || ""),
      mode: String(mode || "working"),
      cwd: String(cwd || ""),
      commit: commit ? String(commit) : ref ? String(ref) : "",
      title: title ? String(title) : "",
    },
    pinned: true,
    preview: false,
  };
}

// A settings tab. SINGLETON, always pinned, no file ref. Descriptor: {type:"settings"}.
// Never uses the preview slot — settings is a first-class pinned tab.
function makeSettingsTab() {
  return {
    type: TAB_SETTINGS,
    ref: null,
    pinned: true,
    preview: false,
  };
}

// A tasks-board tab. SINGLETON, always pinned, no file ref — same shape as the
// settings tab. Descriptor: {type:"tasks"}. Renders the full-width task board.
function makeTasksTab() {
  return {
    type: TAB_TASKS,
    ref: null,
    pinned: true,
    preview: false,
  };
}

// Stable identity for a tab. File tabs key on their absolute path; diff tabs key
// on the (relPath, mode, cwd, commit) tuple so the same file's working vs staged
// vs a specific commit are DISTINCT tabs.
function tabKey(tab) {
  if (!tab || typeof tab !== "object") return "";
  if (tab.type === TAB_SETTINGS) {
    // Type-namespaced key so it can never collide with a file named "settings".
    return "settings:global";
  }
  if (tab.type === TAB_TASKS) {
    // Type-namespaced like settings — never collides with a file named "tasks".
    return "tasks:board";
  }
  if (tab.type === TAB_DIFF) {
    const r = tab.ref || {};
    return `diff:${r.cwd || ""}::${r.relPath || ""}::${r.mode || ""}::${r.commit || ""}`;
  }
  return `file:${typeof tab.ref === "string" ? tab.ref : ""}`;
}

// Index of a tab by key in a tabs array (-1 when absent).
function findTabIndex(tabs, key) {
  if (!Array.isArray(tabs)) return -1;
  return tabs.findIndex((t) => tabKey(t) === key);
}

// Normalize a state object into a clean { tabs:[], activeKey } shape.
function normalizeState(state) {
  const tabs = Array.isArray(state?.tabs) ? state.tabs.slice() : [];
  const activeKey =
    typeof state?.activeKey === "string" && state.activeKey
      ? state.activeKey
      : null;
  return { tabs, activeKey };
}

// Open reducer (VS Code semantics). Total + immutable.
//   - already-open file → just focus it (no duplicate, no preview downgrade).
//   - opening pinned (double-click/edit) → if it's the current preview, promote
//     it in place; otherwise append a pinned tab.
//   - opening preview (single-click) → replace the single existing preview slot
//     (or append the first preview), then focus it.
function openTab(state, tab) {
  const s = normalizeState(state);
  const key = tabKey(tab);
  if (!key) return s;

  const existingIdx = findTabIndex(s.tabs, key);
  if (existingIdx >= 0) {
    // Already open: focus it. If the incoming open is PINNED, promote the
    // existing tab (covers double-clicking the current preview).
    const tabs = s.tabs.slice();
    if (tab.preview === false) {
      tabs[existingIdx] = {
        ...tabs[existingIdx],
        pinned: true,
        preview: false,
      };
    }
    return { tabs, activeKey: key };
  }

  if (tab.preview === false) {
    // Pinned open → append; leave any existing preview untouched.
    return { tabs: [...s.tabs, tab], activeKey: key };
  }

  // Preview open → replace the existing preview slot (one preview at a time).
  const previewIdx = s.tabs.findIndex((t) => t.preview === true);
  if (previewIdx >= 0) {
    const tabs = s.tabs.slice();
    tabs[previewIdx] = tab;
    return { tabs, activeKey: key };
  }
  return { tabs: [...s.tabs, tab], activeKey: key };
}

// Activate reducer: set the active key when the tab exists.
function activateTab(state, key) {
  const s = normalizeState(state);
  if (findTabIndex(s.tabs, key) < 0) return s;
  return { tabs: s.tabs, activeKey: key };
}

// Pin reducer: promote a (preview) tab to pinned. No-op for unknown keys.
function pinTab(state, key) {
  const s = normalizeState(state);
  const idx = findTabIndex(s.tabs, key);
  if (idx < 0) return s;
  const tabs = s.tabs.slice();
  tabs[idx] = { ...tabs[idx], pinned: true, preview: false };
  return { tabs, activeKey: s.activeKey };
}

// Close reducer: drop a tab; if it was active, re-point active to the nearest
// surviving neighbour (prefer the next tab, else the previous), else null.
function closeTab(state, key) {
  const s = normalizeState(state);
  const idx = findTabIndex(s.tabs, key);
  if (idx < 0) return s;
  const tabs = s.tabs.filter((_, i) => i !== idx);
  let activeKey = s.activeKey;
  if (s.activeKey === key) {
    if (tabs.length === 0) activeKey = null;
    else {
      const neighbour = tabs[Math.min(idx, tabs.length - 1)];
      activeKey = tabKey(neighbour);
    }
  } else if (findTabIndex(tabs, activeKey) < 0) {
    activeKey = tabs.length ? tabKey(tabs[0]) : null;
  }
  return { tabs, activeKey };
}

// ── Persistence (descriptors only — NEVER content) ───────────────────────────

// Serialize the live state into the v3 persisted shape. Strips everything but
// the descriptor fields ({type, ref, pinned, preview}) so file CONTENT is never
// persisted (Codex xhigh).
function serializeTabs(state) {
  const s = normalizeState(state);
  return {
    schemaVersion: EDITOR_TABS_SCHEMA_VERSION,
    tabs: s.tabs.map(toDescriptor),
    activeKey: s.activeKey,
  };
}

// Reduce a tab to its persisted descriptor (drops any transient/content fields).
function toDescriptor(tab) {
  if (tab?.type === TAB_SETTINGS) {
    return { type: TAB_SETTINGS };
  }
  if (tab?.type === TAB_TASKS) {
    return { type: TAB_TASKS };
  }
  if (tab?.type === TAB_DIFF) {
    const r = tab.ref || {};
    return {
      type: TAB_DIFF,
      ref: {
        relPath: String(r.relPath || ""),
        mode: String(r.mode || "working"),
        cwd: String(r.cwd || ""),
        commit: String(r.commit || ""),
        title: String(r.title || ""),
      },
      pinned: tab.pinned !== false,
      preview: false,
    };
  }
  return {
    type: TAB_FILE,
    ref: typeof tab?.ref === "string" ? tab.ref : "",
    pinned: tab?.pinned === true,
    preview: tab?.preview === true,
  };
}

// Rebuild a clean { tabs, activeKey } state from a persisted (or junk) value.
// Tolerates strings (JSON), missing fields, and bad shapes.
function deserializeTabs(value) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return { tabs: [], activeKey: null };
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { tabs: [], activeKey: null };
  }
  const rawTabs = Array.isArray(parsed.tabs) ? parsed.tabs : [];
  const tabs = [];
  for (const raw of rawTabs) {
    const tab = reviveDescriptor(raw);
    if (tab) tabs.push(tab);
  }
  const activeKey =
    typeof parsed.activeKey === "string" && parsed.activeKey
      ? parsed.activeKey
      : null;
  return { tabs, activeKey };
}

// Revive one descriptor into a normalized tab (or null when unusable).
// Type-scoped: settings → exact match, file/diff → existing paths, unknown → drop.
function reviveDescriptor(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.type === TAB_SETTINGS) {
    // Settings tab: no probe needed, no file ref — just revive it.
    return makeSettingsTab();
  }
  if (raw.type === TAB_TASKS) {
    // Tasks-board tab: no probe needed, no file ref — just revive it.
    return makeTasksTab();
  }
  if (raw.type === TAB_DIFF) {
    const r = raw.ref || {};
    if (!r.relPath && !r.cwd) return null;
    return {
      type: TAB_DIFF,
      ref: {
        relPath: String(r.relPath || ""),
        mode: String(r.mode || "working"),
        cwd: String(r.cwd || ""),
        commit: String(r.commit || ""),
        title: String(r.title || ""),
      },
      pinned: raw.pinned !== false,
      preview: false,
    };
  }
  // file (explicit type:"file" OR a legacy type-less descriptor — older stores
  // persisted file tabs without a type field; treat those as files for
  // backward-compat). The ref still goes through the gated canReopen probe, so
  // this opens no access hole. An EXPLICIT unknown future type still drops below.
  if (raw.type === TAB_FILE || raw.type == null) {
    const ref = typeof raw.ref === "string" ? raw.ref : "";
    if (!ref) return null;
    const preview = raw.preview === true;
    return { type: TAB_FILE, ref, pinned: !preview, preview };
  }
  // Explicit unknown type → silently drop (type-scoped restore).
  return null;
}

// ── v3 migration (idempotent; never clobbers) ────────────────────────────────

// Seed an empty v3 editorTabs state onto a store that doesn't have one yet.
// Idempotent: never overwrites an existing value (a future newer-schema client's
// state is left untouched). Returns { migrated } like the slice-2/3 migrators.
function migrateEditorTabsState(store) {
  if (
    !store ||
    typeof store.get !== "function" ||
    typeof store.set !== "function"
  ) {
    return { migrated: false };
  }
  const existing = store.get(EDITOR_TABS_KEY, undefined);
  if (existing && typeof existing === "object") return { migrated: false };
  store.set(EDITOR_TABS_KEY, {
    schemaVersion: EDITOR_TABS_SCHEMA_VERSION,
    tabs: [],
    activeKey: null,
  });
  return { migrated: true };
}

// ── Revalidated restore (Codex xhigh) ────────────────────────────────────────

// Filter restored descriptors through the capability layer. `canOpen(tab)` is an
// async probe the app supplies that ACTUALLY re-opens the tab via the gated
// file/git endpoints (which enforce requireFileAccess server-side); it resolves
// truthy when the open succeeded. Any falsy result OR a throw drops the tab
// SILENTLY (deleted / moved / unauthorized). The active key is re-pointed to a
// survivor when its target was dropped.
async function filterRestoredTabs(restored, canOpen) {
  const s = normalizeState(restored);
  const survivors = [];
  // Deduplication guard for the singleton settings/tasks tabs (Codex fix 5:
  // at most ONE of each).
  let settingsRestored = false;
  let tasksRestored = false;
  for (const tab of s.tabs) {
    // Settings tabs: type-scoped, no probe needed (Codex fix 1).
    if (tab.type === TAB_SETTINGS) {
      if (!settingsRestored) {
        survivors.push(tab);
        settingsRestored = true;
      }
      // Drop any duplicate settings descriptors silently.
      continue;
    }
    // Tasks-board tab: same probeless singleton treatment as settings.
    if (tab.type === TAB_TASKS) {
      if (!tasksRestored) {
        survivors.push(tab);
        tasksRestored = true;
      }
      continue;
    }
    // File/diff tabs: probe through the capability layer.
    let ok = false;
    try {
      ok = Boolean(await canOpen(tab));
    } catch {
      ok = false; // 403/404/network → silently drop
    }
    if (ok) survivors.push(tab);
  }
  let activeKey = s.activeKey;
  if (!activeKey || findTabIndex(survivors, activeKey) < 0) {
    activeKey = survivors.length ? tabKey(survivors[0]) : null;
  }
  return { tabs: survivors, activeKey };
}

// ── Stateful model (thin wrapper over the pure reducers) ─────────────────────

// Holds the live { tabs, activeKey } state and exposes the reducers as mutating
// ops, firing onChange after each. The DOM controller subscribes to onChange to
// re-render; the app subscribes to persist serializeTabs(state).
class EditorTabsModel {
  constructor(initial) {
    this.state = normalizeState(initial);
    this.onChange = null;
  }

  emit() {
    if (typeof this.onChange === "function") {
      try {
        this.onChange(this.state);
      } catch {
        // A subscriber error must not corrupt the model.
      }
    }
  }

  setState(next) {
    this.state = normalizeState(next);
    this.emit();
    return this.state;
  }

  open(tab) {
    return this.setState(openTab(this.state, tab));
  }

  activate(key) {
    return this.setState(activateTab(this.state, key));
  }

  pin(key) {
    return this.setState(pinTab(this.state, key));
  }

  close(key) {
    return this.setState(closeTab(this.state, key));
  }

  // Open (or focus) the singleton settings tab. NEVER reads or writes the
  // preview slot — settings is always pinned (Codex fix 4).
  openSettings() {
    const key = "settings:global";
    const existingIdx = findTabIndex(this.state.tabs, key);
    if (existingIdx >= 0) {
      // Already open: just focus it. No preview mutation, no duplicate.
      return this.setState(activateTab(this.state, key));
    }
    // Not present: append a pinned settings tab (NEVER via the preview slot).
    const tab = makeSettingsTab();
    return this.setState({
      tabs: [...this.state.tabs, tab],
      activeKey: key,
    });
  }

  // Open (or focus) the singleton tasks-board tab. Same preview-slot-free
  // semantics as openSettings.
  openTasksBoard() {
    const key = "tasks:board";
    const existingIdx = findTabIndex(this.state.tabs, key);
    if (existingIdx >= 0) {
      return this.setState(activateTab(this.state, key));
    }
    const tab = makeTasksTab();
    return this.setState({
      tabs: [...this.state.tabs, tab],
      activeKey: key,
    });
  }

  activeTab() {
    return (
      this.state.tabs.find((t) => tabKey(t) === this.state.activeKey) || null
    );
  }

  hasTabs() {
    return this.state.tabs.length > 0;
  }
}

// ── DOM controller (browser-only) ────────────────────────────────────────────

// Renders a tab bar + content host into the IDE editor area and mounts each
// tab's body via injected hooks. It NEVER imports CodeMirror itself — file tabs
// mount through `mountFileBody(hostEl, tab)` (which reuses FileEditor's
// CodeMirror machinery) and diff tabs through `mountDiffBody(hostEl, tab)`
// (which reuses app.renderMergeDiff). This keeps the heavy editor machinery out
// of this module (the Slice-6 ViewHost refactor is deferred).
//
// Options:
//   document        the DOM document
//   areaEl          the .ide-editor-area element to render into
//   placeholderEl   the existing placeholder (shown when there are no tabs)
//   model           an EditorTabsModel (created here if omitted)
//   mountFileBody   async (hostEl, tab) => void — render a file editor into host
//   mountDiffBody   async (hostEl, tab) => void — render a merge diff into host
//   mountSettingsBody (hostEl) => void — render the settings UI into host
//   onActiveBodyMeasure (hostEl, tab) => void — post-mount measure/refresh hook
//                   (CodeMirror needs a requestMeasure after its container sizes)
//   onChange        (state) => void — app persistence hook (serializeTabs)
//   labelForTab     (tab) => string — display label (defaults to basename)
//   confirmImpl     (msg) => bool — user-close dirty-confirm. Defaults to window.confirm.
class EditorTabsController {
  constructor(options = {}) {
    this.doc =
      options.document || (typeof document !== "undefined" ? document : null);
    // areaEl / placeholderEl may be passed as a value OR a getter (the IDE
    // editor area is created lazily on first enterIde, after this controller is
    // constructed), so resolve them through a getter every render.
    this.getAreaEl =
      typeof options.areaEl === "function"
        ? options.areaEl
        : () => options.areaEl || null;
    this.getPlaceholderEl =
      typeof options.placeholderEl === "function"
        ? options.placeholderEl
        : () => options.placeholderEl || null;
    this.model = options.model || new EditorTabsModel();
    this.mountFileBody =
      typeof options.mountFileBody === "function"
        ? options.mountFileBody
        : null;
    this.mountDiffBody =
      typeof options.mountDiffBody === "function"
        ? options.mountDiffBody
        : null;
    this.mountTasksBody =
      typeof options.mountTasksBody === "function"
        ? options.mountTasksBody
        : null;
    this.mountSettingsBody =
      typeof options.mountSettingsBody === "function"
        ? options.mountSettingsBody
        : null;
    // Injected confirm for dirty-close (user-initiated close only). Defaults to
    // window.confirm in a browser; tests inject a stub.
    this.confirmImpl =
      typeof options.confirmImpl === "function"
        ? options.confirmImpl
        : typeof window !== "undefined" && typeof window.confirm === "function"
          ? (msg) => window.confirm(msg)
          : () => true;
    // Injected dirty-check: (key) => bool. App supplies this so the controller
    // can ask the live handle whether the file has unsaved changes.
    this.isDirtyImpl =
      typeof options.isDirtyImpl === "function" ? options.isDirtyImpl : null;
    this.onActiveBodyMeasure =
      typeof options.onActiveBodyMeasure === "function"
        ? options.onActiveBodyMeasure
        : null;
    this.appOnChange =
      typeof options.onChange === "function" ? options.onChange : null;
    // Hook fired when a tab's cached body is torn down (close OR clear), so the
    // app can destroy the live CodeMirror view/handle for that key.
    this.onBodyTeardown =
      typeof options.onBodyTeardown === "function"
        ? options.onBodyTeardown
        : null;
    this.labelForTab =
      typeof options.labelForTab === "function"
        ? options.labelForTab
        : (tab) => defaultLabel(tab);

    // Reveal-at-line hook: (key, target:{line,col}) => void. The controller
    // doesn't own CodeMirror handles (the app does), so it delegates the actual
    // scroll/cursor placement. Optional — open-at-line is a no-op without it.
    this.onRevealLine =
      typeof options.onRevealLine === "function" ? options.onRevealLine : null;

    this.tabBarEl = null;
    this.bodyHostEl = null;
    // Per-tab mounted body element cache (so switching tabs doesn't re-fetch).
    this.bodies = new Map();
    // Per-tab one-shot reveal targets ({ line, col }) set by openFile and
    // consumed once the body is live (search open-at-line).
    this.pendingReveal = new Map();
    // The key whose body is currently shown.
    this.mountedKey = null;
    // Keys whose async body mount is still in flight. Guards a second
    // activation of the SAME key (re-render mid-mount) from starting a second
    // mount that would orphan the first body + leak its CodeMirror view (the
    // body-mount path overwrites editorTabHandles unconditionally, so the first
    // handle would never be destroyed).
    this.pendingMounts = new Set();

    this.model.onChange = (state) => {
      this.render();
      if (this.appOnChange) {
        try {
          this.appOnChange(state);
        } catch {
          // persistence is best-effort
        }
      }
    };
  }

  // Lazily-resolved editor-area host (created on first IDE enterIde).
  get areaEl() {
    return this.getAreaEl();
  }

  // Lazily-resolved placeholder ("Open a file…") shown when there are no tabs.
  get placeholderEl() {
    return this.getPlaceholderEl();
  }

  // Build the tab bar + content host scaffold once inside the editor area.
  ensureScaffold() {
    if (this.tabBarEl || !this.doc || !this.areaEl) return;
    const bar = this.doc.createElement("div");
    bar.className = "ide-editor-tabs";
    bar.setAttribute("role", "tablist");
    const host = this.doc.createElement("div");
    host.className = "ide-editor-bodies";
    this.areaEl.appendChild(bar);
    this.areaEl.appendChild(host);
    this.tabBarEl = bar;
    this.bodyHostEl = host;
  }

  // Public open: build a tab descriptor and route through the model. An
  // optional { line, col } is a ONE-SHOT reveal target (not persisted tab
  // state): a search result opens the file and scrolls/places the cursor at the
  // line. It's recorded per tabKey and consumed by the body mount (and applied
  // immediately when the tab is already mounted). Line is 1-based.
  openFile(path, { preview = true, line, col } = {}) {
    this.ensureScaffold();
    const tab = makeFileTab(path, { preview });
    const key = tabKey(tab);
    if (Number.isFinite(line) && line > 0) {
      this.pendingReveal.set(key, {
        line,
        col: Number.isFinite(col) ? col : 1,
      });
      // If this file tab is already the mounted, live body, apply the reveal
      // now (no mount will fire to consume it). Otherwise the mount path picks
      // it up via consumeReveal().
      if (this.mountedKey === key && typeof this.applyReveal === "function") {
        this.applyReveal(key);
      }
    }
    this.model.open(tab);
  }

  // Consume (read + clear) a pending one-shot reveal target for a tab key. The
  // body-mount path calls this after the editor view is live to scroll to the
  // search-hit line exactly once.
  consumeReveal(key) {
    const target = this.pendingReveal.get(key) || null;
    if (target) this.pendingReveal.delete(key);
    return target;
  }

  openDiff(spec) {
    this.ensureScaffold();
    this.model.open(makeDiffTab(spec));
  }

  // Open (or focus) the singleton settings tab. Delegates to the model's
  // openSettings() which NEVER touches the preview slot (Codex fix 4).
  openSettings() {
    this.ensureScaffold();
    this.model.openSettings();
  }

  // Open (or focus) the singleton tasks-board tab (mirrors openSettings).
  openTasksBoard() {
    this.ensureScaffold();
    this.model.openTasksBoard();
  }

  // Restore a pre-filtered state (after revalidation) without firing the app
  // persistence hook in a loop — set directly then render.
  restoreState(state) {
    this.ensureScaffold();
    this.model.setState(state);
  }

  // Reconcile the DOM to the model state: tab bar + the active body.
  render() {
    if (!this.doc || !this.areaEl) return;
    const hasTabs = this.model.hasTabs();
    // Toggle the placeholder vs the tab UI.
    if (this.placeholderEl) this.placeholderEl.hidden = hasTabs;
    if (!hasTabs) {
      // No tabs: tear down bodies + clear the bar, show the placeholder.
      if (this.tabBarEl) this.tabBarEl.replaceChildren();
      this.clearBodies();
      if (this.areaEl) this.areaEl.classList.remove("has-tabs");
      return;
    }
    this.ensureScaffold();
    if (this.areaEl) this.areaEl.classList.add("has-tabs");
    // Prune any cached bodies whose tab is no longer in state (e.g. a preview
    // tab replaced in place by openTab). Tear them down so their CodeMirror
    // views/handles are destroyed — otherwise the replaced preview's body would
    // leak and a pending async mount could still reveal it.
    this.pruneOrphanBodies();
    this.renderTabBar();
    void this.renderActiveBody();
  }

  // Drop cached bodies whose key is absent from the current tab state.
  pruneOrphanBodies() {
    const live = new Set(this.model.state.tabs.map((t) => tabKey(t)));
    for (const key of Array.from(this.bodies.keys())) {
      if (live.has(key)) continue;
      this.teardownBody(key);
      const el = this.bodies.get(key);
      if (el) el.remove();
      this.bodies.delete(key);
      if (this.mountedKey === key) this.mountedKey = null;
    }
  }

  renderTabBar() {
    if (!this.tabBarEl) return;
    const { tabs, activeKey } = this.model.state;
    this.tabBarEl.replaceChildren();
    for (const tab of tabs) {
      const key = tabKey(tab);
      const el = this.doc.createElement("div");
      el.className = "ide-editor-tab";
      el.dataset.tabKey = key;
      el.setAttribute("role", "tab");
      if (key === activeKey) el.classList.add("active");
      if (tab.preview) el.classList.add("preview");
      if (tab.type === TAB_DIFF) el.classList.add("is-diff");
      if (tab.type === TAB_SETTINGS) el.classList.add("is-settings");
      if (tab.type === TAB_TASKS) el.classList.add("is-tasks");
      el.setAttribute("aria-selected", key === activeKey ? "true" : "false");

      if (tab.type === TAB_DIFF) {
        const ind = this.doc.createElement("span");
        ind.className = "ide-editor-tab-diff-indicator";
        ind.textContent = "±";
        ind.title = "Diff";
        el.appendChild(ind);
      }

      const label = this.doc.createElement("span");
      label.className = "ide-editor-tab-label";
      label.textContent = this.labelForTab(tab);
      label.title = fullTitle(tab);
      el.appendChild(label);

      const close = this.doc.createElement("button");
      close.type = "button";
      close.className = "ide-editor-tab-close";
      close.title = "Close";
      close.setAttribute("aria-label", "Close tab");
      close.textContent = "✕";
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        // Route through the user-close chokepoint (dirty-confirm for file tabs).
        this.requestCloseKey(key);
      });
      el.appendChild(close);

      // Single click = activate (and promote the tab if it's the preview being
      // clicked twice). Double click = pin (VS Code).
      el.addEventListener("click", () => this.model.activate(key));
      el.addEventListener("dblclick", () => this.model.pin(key));
      this.tabBarEl.appendChild(el);
    }
  }

  // Mount/show the active tab's body, lazily building it once per key.
  async renderActiveBody() {
    const { activeKey } = this.model.state;
    if (!activeKey || !this.bodyHostEl) return;
    if (this.mountedKey === activeKey) {
      this.measureActive();
      return;
    }
    const tab = this.model.state.tabs.find((t) => tabKey(t) === activeKey);
    if (!tab) return;

    // Hide every cached body, then reveal/build the active one.
    for (const el of this.bodies.values()) el.hidden = true;

    let bodyEl = this.bodies.get(activeKey);
    if (!bodyEl) {
      // In-flight guard: if a mount for this key is already pending, don't start
      // a second one. The pending mount's own post-await re-check reveals the
      // correct body when it resolves — racing a second mount here would create
      // a second bodyEl + overwrite the first handle (leaking its view).
      if (this.pendingMounts.has(activeKey)) return;
      this.pendingMounts.add(activeKey);
      bodyEl = this.doc.createElement("div");
      bodyEl.className = "ide-editor-body";
      bodyEl.dataset.tabKey = activeKey;
      this.bodyHostEl.appendChild(bodyEl);
      this.bodies.set(activeKey, bodyEl);
      try {
        if (tab.type === TAB_SETTINGS) {
          if (this.mountSettingsBody) await this.mountSettingsBody(bodyEl);
        } else if (tab.type === TAB_TASKS) {
          if (this.mountTasksBody) await this.mountTasksBody(bodyEl);
        } else if (tab.type === TAB_DIFF) {
          if (this.mountDiffBody) await this.mountDiffBody(bodyEl, tab);
        } else if (this.mountFileBody) {
          await this.mountFileBody(bodyEl, tab);
        }
      } catch {
        // A mount failure leaves an empty body; never break the tab switch.
      } finally {
        this.pendingMounts.delete(activeKey);
      }
      // The mount above is async: by the time it resolves the tab may have been
      // replaced (preview clobbered) or another tab may now be active. If so,
      // discard this just-mounted body (tearing down its view) instead of
      // revealing a tab that no longer exists / isn't active.
      const stillPresent = findTabIndex(this.model.state.tabs, activeKey) >= 0;
      const stillActive = this.model.state.activeKey === activeKey;
      if (!stillPresent || !stillActive) {
        this.teardownBody(activeKey);
        if (this.bodies.get(activeKey) === bodyEl) {
          bodyEl.remove();
          this.bodies.delete(activeKey);
        }
        // Re-render the (now-current) active body if the active tab changed.
        if (
          this.model.state.activeKey &&
          this.model.state.activeKey !== activeKey
        ) {
          void this.renderActiveBody();
        }
        return;
      }
    }
    bodyEl.hidden = false;
    this.mountedKey = activeKey;
    this.measureActive();
    // Apply a pending open-at-line reveal once the body is live + measured.
    this.applyReveal(activeKey);
  }

  // Consume + apply a pending reveal target for a key, delegating the actual
  // scroll/cursor placement to the app's onRevealLine hook (which owns the live
  // CodeMirror handle). One-shot: consumeReveal clears it.
  applyReveal(key) {
    if (!key || !this.onRevealLine) return;
    const target = this.consumeReveal(key);
    if (!target) return;
    try {
      this.onRevealLine(key, target);
    } catch {
      // best-effort — a reveal failure never breaks the tab switch
    }
  }

  measureActive() {
    const tab = this.model.activeTab();
    const el = this.mountedKey ? this.bodies.get(this.mountedKey) : null;
    if (tab && el && this.onActiveBodyMeasure) {
      try {
        this.onActiveBodyMeasure(el, tab);
      } catch {
        // best-effort refresh
      }
    }
  }

  // Promote the active tab to pinned (called by the app when the editor reports
  // an edit — VS Code "editing a preview pins it").
  pinActive() {
    const key = this.model.state.activeKey;
    if (key) this.model.pin(key);
  }

  // Single user-close chokepoint (Codex fix 3). ALL user-initiated closes (tab
  // "×" button, keyboard close, close-all) MUST go through this. For a FILE tab
  // whose handle is dirty, prompt and abort when declined. diff/settings have no
  // dirty state → never prompt. Programmatic removals (restore cleanup,
  // pruneOrphanBodies, mode teardown) call closeKey directly — no prompt.
  requestCloseKey(key) {
    const tab = this.model.state.tabs.find((t) => tabKey(t) === key);
    if (tab && tab.type === TAB_FILE) {
      const dirty =
        typeof this.isDirtyImpl === "function" && this.isDirtyImpl(key);
      if (dirty) {
        const ok = this.confirmImpl("Discard unsaved changes?");
        if (!ok) return; // user declined → keep the tab
      }
    }
    this.closeKey(key);
  }

  // PROGRAMMATIC close (no dirty prompt). Use this ONLY for non-user-initiated
  // removals (load-fail cleanup, orphan prune, mode teardown). Any USER-initiated
  // close MUST go through requestCloseKey() so a dirty file tab prompts first.
  closeKey(key) {
    // Drop the cached body for the closed tab + tear down its live view.
    const body = this.bodies.get(key);
    if (body) {
      this.teardownBody(key);
      body.remove();
      this.bodies.delete(key);
    }
    if (this.mountedKey === key) this.mountedKey = null;
    this.model.close(key);
  }

  teardownBody(key) {
    if (this.onBodyTeardown) {
      try {
        this.onBodyTeardown(key);
      } catch {
        // best-effort teardown
      }
    }
  }

  clearBodies() {
    for (const key of this.bodies.keys()) this.teardownBody(key);
    for (const el of this.bodies.values()) el.remove();
    this.bodies.clear();
    this.mountedKey = null;
  }

  // Run a measure pass over the active body (the app calls this after the editor
  // area resizes — e.g. dock sash drag / mode switch — like the explorer.resize).
  refresh() {
    this.measureActive();
  }
}

// Default tab label: file basename, or the diff's relPath basename, or "Settings".
function defaultLabel(tab) {
  if (tab?.type === TAB_SETTINGS) return "Settings";
  if (tab?.type === TAB_TASKS) return "Task Board";
  if (tab?.type === TAB_DIFF) {
    const rel = tab.ref?.relPath || "";
    return basename(rel) || "diff";
  }
  return basename(typeof tab?.ref === "string" ? tab.ref : "") || "untitled";
}

function fullTitle(tab) {
  if (tab?.type === TAB_SETTINGS) return "Settings";
  if (tab?.type === TAB_TASKS) return "Task Board";
  if (tab?.type === TAB_DIFF) {
    return tab.ref?.title || tab.ref?.relPath || "diff";
  }
  return typeof tab?.ref === "string" ? tab.ref : "";
}

function basename(p) {
  const s = String(p || "");
  const cut = s.split("/").filter(Boolean).pop();
  return cut || "";
}

// ── Exports (triple pattern) ─────────────────────────────────────────────────

const EditorTabs = {
  EDITOR_TABS_KEY,
  EDITOR_TABS_SCHEMA_VERSION,
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
  EditorTabsController,
};

if (typeof window !== "undefined") {
  window.EditorTabs = EditorTabs;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = EditorTabs;
}

if (typeof exports !== "undefined") {
  exports.EDITOR_TABS_KEY = EDITOR_TABS_KEY;
  exports.EDITOR_TABS_SCHEMA_VERSION = EDITOR_TABS_SCHEMA_VERSION;
  exports.TAB_FILE = TAB_FILE;
  exports.TAB_DIFF = TAB_DIFF;
  exports.TAB_SETTINGS = TAB_SETTINGS;
  exports.TAB_TASKS = TAB_TASKS;
  exports.makeFileTab = makeFileTab;
  exports.makeDiffTab = makeDiffTab;
  exports.makeSettingsTab = makeSettingsTab;
  exports.makeTasksTab = makeTasksTab;
  exports.tabKey = tabKey;
  exports.findTabIndex = findTabIndex;
  exports.openTab = openTab;
  exports.activateTab = activateTab;
  exports.closeTab = closeTab;
  exports.pinTab = pinTab;
  exports.serializeTabs = serializeTabs;
  exports.deserializeTabs = deserializeTabs;
  exports.filterRestoredTabs = filterRestoredTabs;
  exports.migrateEditorTabsState = migrateEditorTabsState;
  exports.EditorTabsModel = EditorTabsModel;
  exports.EditorTabsController = EditorTabsController;
}
