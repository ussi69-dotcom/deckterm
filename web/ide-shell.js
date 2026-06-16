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

// Schema v2 (slice 3) adds `layout.detached` — a per-view map of "is this IDE
// sidebar view popped out into a floating SurfaceWindow?". The key was reserved
// in slice 2; v2 just stamps the version (the map defaults to {} and never
// clobbers existing keys).
const LAYOUT_SCHEMA_VERSION = 2;
const LAYOUT_MODE_KEY = "layout.mode";
const LAYOUT_SCHEMA_VERSION_KEY = "layout.schemaVersion";
const LAYOUT_DETACHED_KEY = "layout.detached";

const LAYOUT_MODE_IDE = "ide";
const LAYOUT_MODE_TERMINAL = "terminal";

// The only view that gets pop-out/dock this slice (YAGNI: no multi-view
// registry — Source Control / Search / Tasks arrive in slices 5-7).
const VIEW_EXPLORER = "explorer";

// Where the single #file-explorer element is hosted in IDE mode.
const EXPLORER_HOST_SIDEBAR = "sidebar";
const EXPLORER_HOST_DETACHED = "detached";

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
  const detached = loadDetachedState(store);
  return { mode, schemaVersion, detached };
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
  // v2 only stamps the version. `layout.detached` defaults to {} lazily on read,
  // so we never need to seed it — and never clobber an existing value if a future
  // newer-schema client already wrote one. Existing layout.mode is untouched.
  store.set(LAYOUT_SCHEMA_VERSION_KEY, LAYOUT_SCHEMA_VERSION);
  return { migrated: true };
}

// ── Pure detached-state helpers (DOM-free, unit-tested) ──────────────────────

// Normalize any stored value into a clean { [viewId]: true } map. Only `true`
// entries are kept (a docked view is simply absent), so the persisted shape stays
// minimal and idempotent. Tolerates strings (JSON), junk, and arrays.
function normalizeDetachedState(value) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out = {};
  for (const [viewId, flag] of Object.entries(parsed)) {
    if (flag === true) out[viewId] = true;
  }
  return out;
}

// Read the persisted detached map from a settings store (get(key, fallback)).
function loadDetachedState(store) {
  if (!store || typeof store.get !== "function") return {};
  return normalizeDetachedState(store.get(LAYOUT_DETACHED_KEY, {}));
}

// Is a given view popped out, per a (normalized or raw) detached map?
function isViewDetached(detached, viewId) {
  return normalizeDetachedState(detached)[viewId] === true;
}

// Pure reducer: return the next detached map with `viewId` set to `detached`.
// Never mutates the input; drops the key entirely when docking so the persisted
// shape stays minimal.
function setViewDetached(detached, viewId, isDetached) {
  const next = normalizeDetachedState(detached);
  if (isDetached) next[viewId] = true;
  else delete next[viewId];
  return next;
}

// Where should the Explorer be hosted right now? Pure resolver over the resolved
// (viewport-gated) mode + the detached flag:
//   - not IDE        → "home" (terminal-mode #app/sheet/Files-window path)
//   - IDE + detached → "detached" (floating SurfaceWindow)
//   - IDE + docked   → "sidebar"
function resolveExplorerHost(renderedMode, isDetached) {
  if (normalizeLayoutMode(renderedMode) !== LAYOUT_MODE_IDE) return "home";
  return isDetached ? EXPLORER_HOST_DETACHED : EXPLORER_HOST_SIDEBAR;
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
    // Slice-3 pop-out/dock hooks. The app owns the SurfaceWindow plumbing; the
    // shell only decides WHEN to detach/dock + reparents the single element.
    //   detachExplorerWindow(el) => container — open the floating Explorer window
    //     and return the SurfaceWindow body the #file-explorer element now lives
    //     in (so the controller can run the ViewHost rebind against it).
    //   dockExplorerWindow()    => void — close the floating Explorer window
    //     (the controller reparents the element back into the sidebar itself).
    this.detachExplorerWindowFn =
      typeof options.detachExplorerWindow === "function"
        ? options.detachExplorerWindow
        : null;
    this.dockExplorerWindowFn =
      typeof options.dockExplorerWindow === "function"
        ? options.dockExplorerWindow
        : null;

    // Captured across an enter→exit round-trip (null when not in IDE mode).
    this.priorExplorerState = null;

    // DOM handles, created lazily on first IDE render.
    this.shellEl = null;
    this.activityBarEl = null;
    this.sidebarEl = null;
    this.sidebarBodyEl = null;
    this.editorAreaEl = null;
    this.popOutBtnEl = null;

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

  // ── Detached (pop-out) state ────────────────────────────────────────────────

  // Is the Explorer popped out into a floating SurfaceWindow? (persisted flag).
  isExplorerDetached() {
    if (!this.settingsStore) return false;
    return isViewDetached(
      this.settingsStore.get(LAYOUT_DETACHED_KEY, {}),
      VIEW_EXPLORER,
    );
  }

  // Persist a new detached flag for the Explorer (pure reducer + store write).
  setExplorerDetached(isDetached) {
    if (!this.settingsStore) return;
    const next = setViewDetached(
      this.settingsStore.get(LAYOUT_DETACHED_KEY, {}),
      VIEW_EXPLORER,
      Boolean(isDetached),
    );
    this.settingsStore.set(LAYOUT_DETACHED_KEY, next);
  }

  // Where the Explorer element should be hosted right now (pure resolver).
  explorerHost() {
    return resolveExplorerHost(this.renderedMode(), this.isExplorerDetached());
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

    // Host the Explorer in its resolved IDE home: the sidebar by default, or a
    // floating SurfaceWindow when the persisted detached flag is set. Either way
    // the single #file-explorer element is MOVED (not cloned) and the controller
    // is REUSED via the ViewHost contract — never recreated.
    this.mountExplorerForHost();

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

    // If the Explorer is currently popped out into the floating IDE window, close
    // that window so its body releases the #file-explorer element before we
    // restore terminal-mode presentation. The DETACHED FLAG IS PRESERVED in
    // settings — it's an IDE-only artifact: leaving IDE mode closes the window,
    // but the next IDE entry re-detaches the Explorer (mirrors slice 2's
    // "explorer prior-state restored on exit, remembered for next entry").
    if (this.isExplorerDetached() && this.dockExplorerWindowFn) {
      try {
        this.dockExplorerWindowFn();
      } catch {
        // Window may already be gone; restore still reparents the element.
      }
    }

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
    // Clicking the (active) Explorer icon while it's popped out docks it back —
    // VS Code "click the active view re-homes it in the sidebar".
    explorerBtn.addEventListener("click", () => this.dockExplorer());
    activityBar.appendChild(explorerBtn);

    // Sidebar — hosts the Explorer skeleton (#file-explorer) this slice.
    const sidebar = this.doc.createElement("div");
    sidebar.className = "ide-sidebar";
    const sidebarHeader = this.doc.createElement("div");
    sidebarHeader.className = "ide-sidebar-header";
    const sidebarTitle = this.doc.createElement("span");
    sidebarTitle.className = "ide-sidebar-title";
    sidebarTitle.textContent = "Explorer";
    // Pop-out control — detaches the Explorer into a floating SurfaceWindow.
    const popOutBtn = this.doc.createElement("button");
    popOutBtn.type = "button";
    popOutBtn.className = "ide-sidebar-action ide-popout-btn";
    popOutBtn.title = "Move the Explorer into a floating window";
    popOutBtn.setAttribute("aria-label", "Pop out the Explorer");
    popOutBtn.setAttribute("aria-pressed", "false");
    popOutBtn.textContent = "⤢";
    popOutBtn.addEventListener("click", () => this.toggleExplorerDetached());
    sidebarHeader.appendChild(sidebarTitle);
    sidebarHeader.appendChild(popOutBtn);
    const sidebarBody = this.doc.createElement("div");
    sidebarBody.className = "ide-sidebar-body";
    // Hint shown when the Explorer is popped out (sidebar body is then empty).
    const detachedHint = this.doc.createElement("div");
    detachedHint.className = "ide-sidebar-detached-hint";
    detachedHint.textContent = "Explorer is in a floating window.";
    sidebar.appendChild(sidebarHeader);
    sidebar.appendChild(sidebarBody);
    sidebar.appendChild(detachedHint);
    this.popOutBtnEl = popOutBtn;

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

  // Mount the Explorer into its resolved IDE host (sidebar OR floating window),
  // per the persisted detached flag. Single dispatch point used on enter + on a
  // pop-out/dock toggle so the reparent path stays identical.
  mountExplorerForHost() {
    if (this.explorerHost() === EXPLORER_HOST_DETACHED)
      this.mountExplorerDetached();
    else this.mountExplorerSidebar();
    this.syncPopOutAffordance();
  }

  // Move the #file-explorer element into the sidebar body and rebind the
  // controller. Reuses the live FileExplorerController — no recreation.
  mountExplorerSidebar() {
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
    this.rebindExplorerView(explorerEl);
  }

  // Pop the Explorer OUT into a floating SurfaceWindow. The app hook owns the
  // window plumbing and returns the window body the element now lives in; the
  // controller runs the ViewHost rebind against it. Reuses the same element +
  // controller (no recreation). Falls back to the sidebar if no hook is wired.
  mountExplorerDetached() {
    if (!this.doc) return;
    const explorerEl = this.doc.getElementById("file-explorer");
    if (!explorerEl) return;
    if (!this.detachExplorerWindowFn) {
      // No window plumbing wired: keep persisted state consistent with where the
      // element actually lands (sidebar ⇔ flag false), or the pop-out affordance
      // would falsely show "detached".
      this.setExplorerDetached(false);
      this.mountExplorerSidebar();
      return;
    }
    // Floating window content flows like the sheet/window path (NOT the static
    // sidebar layout), so drop the ide-hosted host class but keep it visible.
    explorerEl.classList.remove("ide-hosted");
    explorerEl.classList.remove("hidden");
    let container = null;
    try {
      container = this.detachExplorerWindowFn(explorerEl);
    } catch {
      // If the window failed to open, degrade gracefully to the sidebar.
    }
    if (!container) {
      // Window failed to open: fall back to the sidebar AND roll back the
      // persisted flag so state stays consistent (Codex slice-3 review #2).
      this.setExplorerDetached(false);
      this.mountExplorerSidebar();
      return;
    }
    if (explorerEl.parentElement !== container)
      container.appendChild(explorerEl);
    this.rebindExplorerView(explorerEl);
  }

  // ViewHost rebind helper: unmount the old host + mount the (reparented)
  // skeleton, then run a resize pass. The controller instance is REUSED.
  rebindExplorerView(explorerEl) {
    const view = this.explorerView;
    if (!view) return;
    if (typeof view.unmount === "function") view.unmount();
    if (typeof view.mount === "function") view.mount(explorerEl);
    if (typeof view.resize === "function") {
      try {
        view.resize();
      } catch {
        // Resize is best-effort; never break the reparent.
      }
    }
  }

  // ── Pop-out / dock toggle (slice 3) ─────────────────────────────────────────

  // Flip the Explorer between the sidebar and a floating window. Persists the
  // flag, then re-mounts into the new host (moving the single element, reusing
  // the controller). No-op outside rendered IDE mode.
  toggleExplorerDetached() {
    if (!this.rendered) return;
    const next = !this.isExplorerDetached();
    this.setExplorerDetached(next);
    if (!next) {
      // Docking back: close the floating window FIRST so its body releases the
      // element, then the sidebar mount reclaims it.
      if (this.dockExplorerWindowFn) {
        try {
          this.dockExplorerWindowFn();
        } catch {
          // Window may already be gone; the re-mount still reparents the element.
        }
      }
    }
    this.mountExplorerForHost();
    this.runAfterRender();
  }

  // Dock the Explorer back to the sidebar if it is currently detached (used by
  // the activity-bar Explorer icon — VS Code "click the active view re-focuses
  // it in the sidebar"). No-op when already docked.
  dockExplorer() {
    if (!this.rendered || !this.isExplorerDetached()) return;
    this.toggleExplorerDetached();
  }

  // Keep the sidebar pop-out button + activity-bar state in sync with whether the
  // Explorer is currently detached.
  syncPopOutAffordance() {
    const detached = this.isExplorerDetached();
    if (this.popOutBtnEl) {
      this.popOutBtnEl.classList.toggle("active", detached);
      this.popOutBtnEl.setAttribute(
        "aria-pressed",
        detached ? "true" : "false",
      );
      this.popOutBtnEl.title = detached
        ? "Dock the Explorer back to the sidebar"
        : "Move the Explorer into a floating window";
    }
    // When detached, the sidebar body is empty — show a hint + dim the header.
    if (this.sidebarEl) {
      this.sidebarEl.classList.toggle("explorer-detached", detached);
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
  LAYOUT_DETACHED_KEY,
  LAYOUT_MODE_IDE,
  LAYOUT_MODE_TERMINAL,
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
  exports.LAYOUT_DETACHED_KEY = LAYOUT_DETACHED_KEY;
  exports.LAYOUT_MODE_IDE = LAYOUT_MODE_IDE;
  exports.LAYOUT_MODE_TERMINAL = LAYOUT_MODE_TERMINAL;
  exports.VIEW_EXPLORER = VIEW_EXPLORER;
  exports.EXPLORER_HOST_SIDEBAR = EXPLORER_HOST_SIDEBAR;
  exports.EXPLORER_HOST_DETACHED = EXPLORER_HOST_DETACHED;
  exports.normalizeLayoutMode = normalizeLayoutMode;
  exports.toggleLayoutMode = toggleLayoutMode;
  exports.resolveRenderedMode = resolveRenderedMode;
  exports.isIdeRendered = isIdeRendered;
  exports.loadLayoutState = loadLayoutState;
  exports.migrateLayoutState = migrateLayoutState;
  exports.normalizeDetachedState = normalizeDetachedState;
  exports.loadDetachedState = loadDetachedState;
  exports.isViewDetached = isViewDetached;
  exports.setViewDetached = setViewDetached;
  exports.resolveExplorerHost = resolveExplorerHost;
  exports.captureFocusTarget = captureFocusTarget;
  exports.resolveFocusTarget = resolveFocusTarget;
  exports.captureExplorerState = captureExplorerState;
  exports.IdeShellController = IdeShellController;
}
