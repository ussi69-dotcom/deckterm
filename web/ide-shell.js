// IDE shell (VS Code IDE shell, phase 5 — slice 2).
//
// Toggling "IDE mode" reshapes the desktop workspace into a VS Code layout:
// an activity bar + sidebar on the left (hosting the Explorer this slice), an
// empty editor-area placeholder (file/diff tabs come in slice 4), and the
// terminals docked to the bottom panel (reuses the phase-1 bottom dock).
//
// MODE TRANSITION CONTRACT (highest-risk; Codex-flagged): mode switching is a
// reversible PRESENTATION change, not a second workspace model.
//   - No PTY recreation. Terminals / Bun.Terminal sessions are never destroyed
//     or recreated on a switch — only their container's CSS / parent changes.
//     This module only toggles a `body.ide-mode` class + reparents the single
//     #file-explorer element; it never touches terminal DOM or WebSockets.
//   - Reversible & lossless. IDE→terminal restores the prior full-bleed
//     TileManager presentation exactly (we only added/removed CSS + moved one
//     element; tile geometry/z-order/focus are untouched).
//   - Focus & resize. The host runs a resize pass AFTER reparenting (xterm
//     needs a fit once its container changes size; the explorer re-renders),
//     then RESTORES focus to the element that held it before the switch (the
//     active terminal, or the focused control if it survived the reparent).
//   - Lossless explorer state. The Explorer's prior presentation (parent +
//     open/visibility + surface-window host) is captured BEFORE entering IDE
//     and restored EXACTLY on exit — an explorer that was closed stays closed,
//     one open in #app reopens in #app. IDE never force-closes it.
//
// LAYOUT PERSISTENCE (Codex xhigh):
//   - layout.mode ("ide" | "terminal") is DEVICE-LOCAL / viewport-gated: stored
//     as a desktop preference, but a viewport <768px ALWAYS renders terminal
//     mode WITHOUT overwriting the stored desktop preference. IDE mode is
//     desktop-only (>=768px), consistent with phase 1.
//   - All persisted layout is schema-versioned (layout.schemaVersion).
//
// The pure logic (mode reducer, viewport gating, schema/migration) is DOM-free
// and unit-tested without a browser. The DOM controller is a thin class that
// the app wires to the live settingsStore + the FileExplorerController view.

// ── Schema + canonical keys ──────────────────────────────────────────────────

const LAYOUT_SCHEMA_VERSION = 1;
const LAYOUT_MODE_KEY = "layout.mode";
const LAYOUT_SCHEMA_VERSION_KEY = "layout.schemaVersion";

const LAYOUT_MODE_IDE = "ide";
const LAYOUT_MODE_TERMINAL = "terminal";

// ── Pure logic (DOM-free, unit-tested) ───────────────────────────────────────

// Coerce any input into one of the two valid modes; default terminal.
function normalizeLayoutMode(value) {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return v === LAYOUT_MODE_IDE ? LAYOUT_MODE_IDE : LAYOUT_MODE_TERMINAL;
}

// Mode reducer: flip between the two modes. Total over any input.
function toggleLayoutMode(mode) {
  return normalizeLayoutMode(mode) === LAYOUT_MODE_IDE
    ? LAYOUT_MODE_TERMINAL
    : LAYOUT_MODE_IDE;
}

// Viewport gating: which mode actually RENDERS. IDE mode is desktop-only, so a
// non-desktop viewport always renders terminal — WITHOUT changing the stored
// `storedMode` (callers keep persisting the desktop preference). Pure: in/out.
function resolveRenderedMode(storedMode, isDesktop) {
  const stored = normalizeLayoutMode(storedMode);
  if (!isDesktop) return LAYOUT_MODE_TERMINAL;
  return stored;
}

// Boolean convenience over resolveRenderedMode.
function isIdeRendered(storedMode, isDesktop) {
  return resolveRenderedMode(storedMode, isDesktop) === LAYOUT_MODE_IDE;
}

// Read the persisted layout state from a settings store (get(key, fallback)).
function loadLayoutState(store) {
  const mode =
    store && typeof store.get === "function"
      ? normalizeLayoutMode(store.get(LAYOUT_MODE_KEY, LAYOUT_MODE_TERMINAL))
      : LAYOUT_MODE_TERMINAL;
  const schemaVersion =
    store && typeof store.get === "function"
      ? Number(store.get(LAYOUT_SCHEMA_VERSION_KEY, LAYOUT_SCHEMA_VERSION)) ||
        LAYOUT_SCHEMA_VERSION
      : LAYOUT_SCHEMA_VERSION;
  return { mode, schemaVersion };
}

// Stamp the current schema version onto a versionless store. Never clobbers an
// existing mode preference. Idempotent once the version is current.
function migrateLayoutState(store) {
  if (
    !store ||
    typeof store.get !== "function" ||
    typeof store.set !== "function"
  ) {
    return { migrated: false };
  }
  const current = Number(store.get(LAYOUT_SCHEMA_VERSION_KEY, 0)) || 0;
  if (current >= LAYOUT_SCHEMA_VERSION) return { migrated: false };
  store.set(LAYOUT_SCHEMA_VERSION_KEY, LAYOUT_SCHEMA_VERSION);
  return { migrated: true };
}

// ── Pure focus-target resolution (DOM-free, unit-tested) ─────────────────────

// Snapshot the focus target before a mode switch into a serializable descriptor,
// so it can be restored after reparenting. Pure: given the active-terminal id and
// (optionally) a tag describing the active control, it returns a descriptor. Pref
// order: a live active terminal wins (its xterm/textarea is the natural focus);
// else, if a relevant control is focused, remember it as a "control"; else none.
//   activeTerminalId  string|null — the TerminalManager active terminal id
//   activeControl     string|null — a stable id/tag for a focused control (e.g.
//                     "explorer"), or null when focus isn't on a relevant control
function captureFocusTarget({ activeTerminalId, activeControl } = {}) {
  if (activeTerminalId) {
    return { kind: "terminal", terminalId: activeTerminalId };
  }
  if (activeControl) {
    return { kind: "control", control: activeControl };
  }
  return { kind: "none" };
}

// Given a captured descriptor + a predicate that says whether a terminal id still
// exists/connected, decide what to refocus AFTER the switch. Pure resolver: returns
// the same descriptor when the target survived, else a "none" descriptor. Callers
// do the actual .focus() on the live node — this only decides the target.
//   target          the descriptor from captureFocusTarget
//   terminalExists  (id) => boolean — is that terminal still live?
function resolveFocusTarget(target, terminalExists) {
  if (!target || typeof target !== "object") return { kind: "none" };
  if (target.kind === "terminal") {
    const exists =
      typeof terminalExists === "function"
        ? Boolean(terminalExists(target.terminalId))
        : false;
    return exists ? target : { kind: "none" };
  }
  if (target.kind === "control") return target;
  return { kind: "none" };
}

// ── Pure explorer prior-state capture (DOM-free, unit-tested) ─────────────────

// Distill the Explorer's prior presentation into a serializable descriptor so the
// EXACT state can be restored on IDE exit. Pure: given a flat read of the live DOM
// (parent id, open flag, surface-window host), returns a normalized descriptor.
//   parentId       id of the explorer's parent element (or null)
//   isOpen         was the explorer visible/open?
//   surfaceWindow  was it hosted in a floating surface window? (string id|null)
function captureExplorerState({ parentId, isOpen, surfaceWindow } = {}) {
  return {
    parentId: typeof parentId === "string" && parentId ? parentId : null,
    isOpen: Boolean(isOpen),
    surfaceWindow:
      typeof surfaceWindow === "string" && surfaceWindow ? surfaceWindow : null,
  };
}

// ── DOM controller (browser-only) ────────────────────────────────────────────

// Drives the IDE shell scaffold + the terminal/explorer reparenting. Injected
// dependencies keep it testable in isolation, but the heavy reparenting + xterm
// refit lives behind callbacks owned by the app (so this stays a thin shell).
//
// Options:
//   document        the DOM document (defaults to global document)
//   settingsStore   actor-scoped settings KV (get/set)
//   getStoredMode   () => stored layout.mode (defaults to settingsStore read)
//   isDesktop       () => boolean — the live desktop-breakpoint check
//   explorerView    the FileExplorerController (mount/unmount ViewHost contract)
//   getExplorerView () => the controller, resolved lazily (the app creates the
//                   explorer AFTER the shell is wired, so prefer this getter)
//   beforeEnterIde  () => void — app hook run BEFORE reparenting the explorer:
//                   release the Files surface-window so the (still-hosted) node
//                   can be moved into the sidebar without racing stale state.
//   onEnterIde      () => void — app hook (after reparent): dock terminals to
//                   bottom, refit xterm. (alias kept for back-compat)
//   onExitIde       () => void — app hook: restore full-bleed terminals
//   afterRender     () => void — app hook: run a resize/measure pass post-switch
//   captureFocus    () => descriptor — snapshot the focus target pre-switch
//                   (e.g. { kind:"terminal", terminalId } or { kind:"control" }).
//   restoreFocus    (descriptor) => void — refocus the resolved target post-switch
//   terminalExists  (id) => boolean — is a terminal id still live/connected?
//   readExplorerState  () => { parentId, isOpen, surfaceWindow } — flat DOM read
//                   of the explorer's prior presentation (for lossless restore).
//   restoreExplorerState (descriptor) => void — app hook: re-present the explorer
//                   in its captured prior parent/open/surface-window state.
class IdeShellController {
  constructor(options = {}) {
    this.doc =
      options.document || (typeof document !== "undefined" ? document : null);
    this.settingsStore = options.settingsStore || null;
    this.isDesktopFn =
      typeof options.isDesktop === "function" ? options.isDesktop : () => true;
    this.getStoredModeFn =
      typeof options.getStoredMode === "function"
        ? options.getStoredMode
        : () =>
            this.settingsStore
              ? normalizeLayoutMode(
                  this.settingsStore.get(LAYOUT_MODE_KEY, LAYOUT_MODE_TERMINAL),
                )
              : LAYOUT_MODE_TERMINAL;
    // The explorer controller is created by the app AFTER the shell is wired,
    // so resolve it lazily: a getter wins, else the static instance.
    this.getExplorerViewFn =
      typeof options.getExplorerView === "function"
        ? options.getExplorerView
        : () => options.explorerView || null;
    this.beforeEnterIde =
      typeof options.beforeEnterIde === "function"
        ? options.beforeEnterIde
        : null;
    this.onEnterIde =
      typeof options.onEnterIde === "function" ? options.onEnterIde : null;
    this.onExitIde =
      typeof options.onExitIde === "function" ? options.onExitIde : null;
    this.afterRender =
      typeof options.afterRender === "function" ? options.afterRender : null;
    this.captureFocusFn =
      typeof options.captureFocus === "function" ? options.captureFocus : null;
    this.restoreFocusFn =
      typeof options.restoreFocus === "function" ? options.restoreFocus : null;
    this.terminalExistsFn =
      typeof options.terminalExists === "function"
        ? options.terminalExists
        : null;
    this.readExplorerStateFn =
      typeof options.readExplorerState === "function"
        ? options.readExplorerState
        : null;
    this.restoreExplorerStateFn =
      typeof options.restoreExplorerState === "function"
        ? options.restoreExplorerState
        : null;

    // Captured across an enter→exit round-trip (null when not in IDE mode).
    this.priorExplorerState = null;

    // DOM handles, created lazily on first IDE render.
    this.shellEl = null;
    this.activityBarEl = null;
    this.sidebarEl = null;
    this.sidebarBodyEl = null;
    this.editorAreaEl = null;

    // True while the shell is actually rendered (IDE presentation active).
    this.rendered = false;
  }

  // The live FileExplorerController (resolved lazily; may be null pre-init).
  get explorerView() {
    return this.getExplorerViewFn();
  }

  // Stored desktop preference (NOT necessarily what renders — viewport gates it).
  getStoredMode() {
    return normalizeLayoutMode(this.getStoredModeFn());
  }

  isDesktop() {
    return Boolean(this.isDesktopFn());
  }

  // Which mode actually renders right now (viewport-gated).
  renderedMode() {
    return resolveRenderedMode(this.getStoredMode(), this.isDesktop());
  }

  // Persist a new desktop preference (device-local) + apply live. Does NOT write
  // when the viewport can't host IDE — but the toggle button is desktop-only, so
  // this path always runs on desktop. Schema version is stamped alongside.
  setMode(mode) {
    const next = normalizeLayoutMode(mode);
    if (this.settingsStore) {
      this.settingsStore.set(LAYOUT_MODE_KEY, next);
      this.settingsStore.set(LAYOUT_SCHEMA_VERSION_KEY, LAYOUT_SCHEMA_VERSION);
    }
    this.applyMode();
    return next;
  }

  // Flip the stored desktop preference and apply.
  toggle() {
    return this.setMode(toggleLayoutMode(this.getStoredMode()));
  }

  // Reconcile the DOM to the resolved (viewport-gated) mode. Idempotent: calling
  // it when already in the target state is a no-op. Safe to call on resize so a
  // viewport crossing 768px renders terminal without touching the stored mode.
  applyMode() {
    const ide = this.renderedMode() === LAYOUT_MODE_IDE;
    if (ide && !this.rendered) this.enterIde();
    else if (!ide && this.rendered) this.exitIde();
  }

  // Build (once) + show the shell scaffold, host the explorer in the sidebar,
  // and ask the app to dock terminals to the bottom panel.
  enterIde() {
    if (!this.doc || this.rendered) return;

    // Snapshot focus + the explorer's prior presentation BEFORE any reparenting,
    // so exit can restore them losslessly.
    const focusTarget = this.captureFocusFn ? this.captureFocusFn() : null;
    this.priorExplorerState = this.captureExplorerStateNow();

    this.ensureShell();
    const body = this.doc.body;
    if (body) body.classList.add("ide-mode");
    if (this.shellEl) this.shellEl.hidden = false;

    // Release-before-reparent: if the Files surface-window currently HOSTS the
    // #file-explorer element, release it FIRST so reparenting into the sidebar
    // doesn't race stale surface-window state / no-op against a moved node.
    if (this.beforeEnterIde) this.beforeEnterIde();

    // Host the Explorer in the sidebar: move the single #file-explorer element
    // into the sidebar body, then rebind the controller to it via the ViewHost
    // contract (unmount old host → mount new host). The controller instance is
    // REUSED — never recreated — so its model/store persist.
    this.mountExplorer();

    // App hook: dock terminals to the bottom panel (CSS only — no PTY touch).
    if (this.onEnterIde) this.onEnterIde();

    this.rendered = true;

    // Resize/measure pass AFTER reparenting (xterm fit, explorer re-render).
    this.runAfterRender();

    // Restore focus to the prior target if it survived the reparent.
    this.restoreFocusTo(focusTarget);
  }

  // Restore terminal mode: undock terminals, return the explorer element to its
  // home, hide the shell. The TileManager presentation is restored exactly
  // because we only toggled CSS + moved one element.
  exitIde() {
    if (!this.doc || !this.rendered) return;

    // Snapshot focus before the reparent so it can be restored after.
    const focusTarget = this.captureFocusFn ? this.captureFocusFn() : null;

    // Return the explorer element home + rebind so the surface-window / sheet
    // path keeps working in terminal mode. Lossless: restore the EXACT prior
    // parent/open/surface-window state captured on enter (not a forced hide).
    this.unmountExplorer();

    // App hook: restore full-bleed terminals (undock).
    if (this.onExitIde) this.onExitIde();

    const body = this.doc.body;
    if (body) body.classList.remove("ide-mode");
    if (this.shellEl) this.shellEl.hidden = true;

    this.rendered = false;

    this.runAfterRender();

    // Restore focus to the prior target if it survived the reparent.
    this.restoreFocusTo(focusTarget);
  }

  // Create the activity-bar + sidebar + editor-area scaffold once, inserted at
  // the top of #workspace-area so it sits to the left of the terminal area.
  ensureShell() {
    if (this.shellEl || !this.doc) return;
    const workspace = this.doc.getElementById("workspace-area");
    if (!workspace) return;

    const shell = this.doc.createElement("div");
    shell.id = "ide-shell";
    shell.className = "ide-shell";
    shell.hidden = true;

    // Activity bar — Explorer icon only this slice.
    const activityBar = this.doc.createElement("div");
    activityBar.className = "ide-activity-bar";
    activityBar.setAttribute("role", "tablist");
    activityBar.setAttribute("aria-label", "Activity bar");
    const explorerBtn = this.doc.createElement("button");
    explorerBtn.type = "button";
    explorerBtn.className = "ide-activity-item active";
    explorerBtn.dataset.view = "explorer";
    explorerBtn.title = "Explorer";
    explorerBtn.setAttribute("aria-label", "Explorer");
    explorerBtn.innerHTML = '<i data-lucide="files"></i>';
    activityBar.appendChild(explorerBtn);

    // Sidebar — hosts the Explorer skeleton (#file-explorer) this slice.
    const sidebar = this.doc.createElement("div");
    sidebar.className = "ide-sidebar";
    const sidebarHeader = this.doc.createElement("div");
    sidebarHeader.className = "ide-sidebar-header";
    sidebarHeader.textContent = "Explorer";
    const sidebarBody = this.doc.createElement("div");
    sidebarBody.className = "ide-sidebar-body";
    sidebar.appendChild(sidebarHeader);
    sidebar.appendChild(sidebarBody);

    // Editor area — empty placeholder this slice (tabs come in slice 4).
    const editorArea = this.doc.createElement("div");
    editorArea.className = "ide-editor-area";
    const placeholder = this.doc.createElement("div");
    placeholder.className = "ide-editor-placeholder";
    placeholder.textContent = "Open a file from the Explorer to edit it.";
    editorArea.appendChild(placeholder);

    shell.appendChild(activityBar);
    shell.appendChild(sidebar);

    // Insert the activity-bar + sidebar shell as the first child of the
    // workspace so fl/grid layout places it to the left; the editor-area
    // placeholder lives in the workspace too (above the docked terminals).
    workspace.insertBefore(shell, workspace.firstChild);
    workspace.insertBefore(
      editorArea,
      this.doc.getElementById("terminal-container"),
    );

    this.shellEl = shell;
    this.activityBarEl = activityBar;
    this.sidebarEl = sidebar;
    this.sidebarBodyEl = sidebarBody;
    this.editorAreaEl = editorArea;

    // Render the lucide icon if the library is present.
    if (typeof window !== "undefined" && window.lucide?.createIcons) {
      try {
        window.lucide.createIcons();
      } catch {
        // Icon rendering is cosmetic; never let it break the shell.
      }
    }
  }

  // Move the #file-explorer element into the sidebar body and rebind the
  // controller. Reuses the live FileExplorerController — no recreation.
  mountExplorer() {
    if (!this.doc) return;
    const explorerEl = this.doc.getElementById("file-explorer");
    if (!explorerEl || !this.sidebarBodyEl) return;
    if (explorerEl.parentElement !== this.sidebarBodyEl) {
      this.sidebarBodyEl.appendChild(explorerEl);
    }
    // The explorer is a sheet/window by default (hidden). In the sidebar it is
    // always visible and docked — strip the modal chrome via a host class.
    explorerEl.classList.add("ide-hosted");
    explorerEl.classList.remove("hidden");
    const view = this.explorerView;
    if (view) {
      // ViewHost contract: rebind to the (now reparented) skeleton.
      if (typeof view.unmount === "function") view.unmount();
      if (typeof view.mount === "function") view.mount(explorerEl);
    }
  }

  // Return the #file-explorer element to terminal mode and rebind. Lossless:
  // when the app supplies restoreExplorerState + a captured prior state, restore
  // the EXACT prior parent/open/surface-window presentation. Otherwise fall back
  // to the safe default (home in #app, hidden). Always strips `ide-hosted` so an
  // interrupted transition can't leave IDE positioning leaking into terminal mode.
  unmountExplorer() {
    if (!this.doc) return;
    const explorerEl = this.doc.getElementById("file-explorer");
    if (!explorerEl) return;

    // Always remove the IDE host class first (defensive: never let it linger).
    explorerEl.classList.remove("ide-hosted");

    const prior = this.priorExplorerState;
    this.priorExplorerState = null;

    if (this.restoreExplorerStateFn && prior) {
      // App owns the lossless restore (parent, open/hidden, surface-window host)
      // + the ViewHost rebind. The explorer node is already free of ide-hosted.
      this.restoreExplorerStateFn(prior);
      return;
    }

    // Fallback when no app hook is wired: home in #app, closed.
    const home = this.doc.getElementById("app");
    explorerEl.classList.add("hidden");
    if (home && explorerEl.parentElement !== home) home.appendChild(explorerEl);
    const view = this.explorerView;
    if (view) {
      if (typeof view.unmount === "function") view.unmount();
      if (typeof view.mount === "function") view.mount(explorerEl);
    }
  }

  // Read the explorer's live prior presentation into a pure descriptor (delegates
  // to the app's flat DOM read when wired, else reads the element directly).
  captureExplorerStateNow() {
    if (this.readExplorerStateFn) {
      return captureExplorerState(this.readExplorerStateFn() || {});
    }
    const explorerEl = this.doc?.getElementById("file-explorer");
    if (!explorerEl) return captureExplorerState({});
    return captureExplorerState({
      parentId: explorerEl.parentElement?.id || null,
      isOpen: !explorerEl.classList.contains("hidden"),
      surfaceWindow: null,
    });
  }

  // Resolve + apply focus restoration for a captured descriptor. Pure resolution
  // (does the target still exist?) lives in resolveFocusTarget; the actual focus
  // is delegated to the app's restoreFocus hook on the live node.
  restoreFocusTo(focusTarget) {
    if (!focusTarget || !this.restoreFocusFn) return;
    const resolved = resolveFocusTarget(
      focusTarget,
      this.terminalExistsFn || (() => false),
    );
    if (resolved.kind === "none") return;
    try {
      this.restoreFocusFn(resolved);
    } catch {
      // Focus restoration is best-effort; never break the mode switch.
    }
  }

  runAfterRender() {
    if (this.afterRender) {
      try {
        this.afterRender();
      } catch {
        // A measurement hook failure must not break the mode switch.
      }
    }
  }
}

// ── Exports (triple pattern) ─────────────────────────────────────────────────

const IdeShell = {
  LAYOUT_SCHEMA_VERSION,
  LAYOUT_MODE_KEY,
  LAYOUT_SCHEMA_VERSION_KEY,
  LAYOUT_MODE_IDE,
  LAYOUT_MODE_TERMINAL,
  normalizeLayoutMode,
  toggleLayoutMode,
  resolveRenderedMode,
  isIdeRendered,
  loadLayoutState,
  migrateLayoutState,
  captureFocusTarget,
  resolveFocusTarget,
  captureExplorerState,
  IdeShellController,
};

if (typeof window !== "undefined") {
  window.IdeShell = IdeShell;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = IdeShell;
}

if (typeof exports !== "undefined") {
  exports.LAYOUT_SCHEMA_VERSION = LAYOUT_SCHEMA_VERSION;
  exports.LAYOUT_MODE_KEY = LAYOUT_MODE_KEY;
  exports.LAYOUT_SCHEMA_VERSION_KEY = LAYOUT_SCHEMA_VERSION_KEY;
  exports.LAYOUT_MODE_IDE = LAYOUT_MODE_IDE;
  exports.LAYOUT_MODE_TERMINAL = LAYOUT_MODE_TERMINAL;
  exports.normalizeLayoutMode = normalizeLayoutMode;
  exports.toggleLayoutMode = toggleLayoutMode;
  exports.resolveRenderedMode = resolveRenderedMode;
  exports.isIdeRendered = isIdeRendered;
  exports.loadLayoutState = loadLayoutState;
  exports.migrateLayoutState = migrateLayoutState;
  exports.captureFocusTarget = captureFocusTarget;
  exports.resolveFocusTarget = resolveFocusTarget;
  exports.captureExplorerState = captureExplorerState;
  exports.IdeShellController = IdeShellController;
}
