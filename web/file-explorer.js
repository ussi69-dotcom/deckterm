const FILE_EXPLORER_MOBILE_BREAKPOINT = 768;

const FILE_ICONS = {
  js: "📜",
  ts: "📜",
  json: "📋",
  md: "📝",
  txt: "📝",
  html: "🌐",
  css: "🎨",
  png: "🖼",
  jpg: "🖼",
  jpeg: "🖼",
  pdf: "📕",
  zip: "📦",
  sh: "⚙️",
  py: "🐍",
};

function normalizeExplorerPath(value) {
  const next = String(value || "").trim();
  return next || null;
}

// Prefer the friendly access-denial explanation (web/access-denied.js) over
// the raw backend error string; fall back to the payload error / caller text.
function explainApiError(payload, fallback) {
  let accessDenied = null;
  if (typeof window !== "undefined" && window.AccessDenied) {
    accessDenied = window.AccessDenied;
  } else if (typeof require !== "undefined") {
    try {
      accessDenied = require("./access-denied");
    } catch {
      accessDenied = null;
    }
  }
  const denial = accessDenied?.describeAccessDenied(payload);
  if (denial) return denial.text;
  return (payload && payload.error) || fallback;
}

// Resolve the FileTreeStore constructor across browser (<script>) and bun:test
// (require), then return a fresh store. Returns null only if the module is
// somehow unavailable; the constructor treats that as a fatal error (fail fast)
// rather than pretending a missing store is null-safe.
function resolveFileTreeStore() {
  let ctor = null;
  if (typeof window !== "undefined" && window.FileTreeStore) {
    ctor = window.FileTreeStore.FileTreeStore;
  } else if (typeof require !== "undefined") {
    try {
      ctor = require("./file-tree-store").FileTreeStore;
    } catch {
      ctor = null;
    }
  }
  return ctor ? new ctor() : null;
}

function getViewportWidth(viewport) {
  const candidate =
    typeof viewport === "number" ? viewport : Number(viewport?.innerWidth);
  return Number.isFinite(candidate) && candidate > 0 ? candidate : 1024;
}

function resolveFileExplorerMode(
  viewport = null,
  breakpoint = FILE_EXPLORER_MOBILE_BREAKPOINT,
) {
  return getViewportWidth(viewport) <= breakpoint ? "overlay" : "docked";
}

function joinExplorerPath(basePath, childName) {
  const base = String(basePath || "").trim();
  const child = String(childName || "")
    .trim()
    .replace(/^\/+/, "");

  if (!base) return child;
  if (!child) return base;
  if (base === "/") return `/${child}`;
  return `${base.replace(/\/+$/, "")}/${child}`;
}

// Pure helper: turns an absolute path + an allowed root path into an ordered
// array of breadcrumb entries, each with { label, path }.
//
// The FIRST entry is the root itself (label = basename of root, e.g. "deploy"
// for "/home/deploy", or "/" for a root of "/"). Subsequent entries are only
// the path segments BELOW rootPath — each with an absolute path within the
// root so loadDir() can navigate to it without hitting a 403.
//
// Segments above the root (e.g. "/" or "home" when root is "/home/deploy") are
// NOT emitted. If path equals rootPath exactly, only the root crumb is emitted.
//
// Returns [] if path is null/empty or rootPath is null/empty.
function breadcrumbSegments(path, rootPath) {
  const normPath = String(path || "").trim();
  // Reject empty rootPath before any normalisation — an empty string falling
  // back to "/" would incorrectly match every absolute path.
  const rawRoot = String(rootPath || "").trim();
  if (!normPath || !rawRoot) return [];
  const normRoot = rawRoot.replace(/\/+$/, "") || "/";

  // Ensure root is a prefix of path (normalise trailing slashes).
  const rootWithSlash = normRoot === "/" ? "/" : normRoot + "/";
  const startsAtRoot =
    normPath === normRoot ||
    normPath.startsWith(rootWithSlash) ||
    normRoot === "/";

  if (!startsAtRoot) return [];

  // Root crumb label: basename of the root, or "/" for a bare-root.
  const rootLabel =
    normRoot === "/"
      ? "/"
      : normRoot.split("/").filter(Boolean).pop() || normRoot;

  const crumbs = [{ label: rootLabel, path: normRoot }];

  // Sub-path: everything after the root prefix.
  let remainder = "";
  if (normRoot === "/") {
    remainder = normPath.replace(/^\/+/, "");
  } else {
    remainder = normPath.slice(normRoot.length).replace(/^\/+/, "");
  }

  if (!remainder) return crumbs;

  const parts = remainder.split("/").filter(Boolean);
  let accumulated = normRoot === "/" ? "" : normRoot;
  for (const part of parts) {
    accumulated = accumulated === "/" ? `/${part}` : `${accumulated}/${part}`;
    crumbs.push({ label: part, path: accumulated });
  }

  return crumbs;
}

function getDefaultAlertImpl() {
  return (...args) => {
    if (typeof alert === "function") {
      return alert(...args);
    }
    return undefined;
  };
}

function getDefaultConfirmImpl() {
  return (...args) => {
    if (typeof confirm === "function") {
      return confirm(...args);
    }
    return true;
  };
}

function getDefaultPromptImpl() {
  return (...args) => {
    if (typeof prompt === "function") {
      return prompt(...args);
    }
    return null;
  };
}

function getDefaultOpenWindowImpl() {
  return (...args) => {
    if (typeof window !== "undefined" && typeof window.open === "function") {
      return window.open(...args);
    }
    return null;
  };
}

// ── format-bytes bridge (browser global OR CommonJS under bun) ───────────────
function resolveFormatByteSize() {
  if (typeof window !== "undefined" && window.FormatBytes?.formatByteSize) {
    return window.FormatBytes.formatByteSize;
  }
  if (typeof require !== "undefined") {
    try {
      return require("./format-bytes").formatByteSize;
    } catch {
      // fall through to the inline copy
    }
  }
  return (bytes) => {
    const value = Number(bytes);
    if (!Number.isFinite(value)) return "";
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 * 1024 * 1024)
      return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  };
}

function formatFileSize(bytes) {
  const nextBytes = Number(bytes);
  if (!Number.isFinite(nextBytes) || nextBytes <= 0) return "";
  return resolveFormatByteSize()(nextBytes);
}

function getItemIcon(item) {
  if (item?.isDir) return "📁";
  const ext =
    String(item?.name || "")
      .split(".")
      .pop()
      ?.toLowerCase() || "";
  return FILE_ICONS[ext] || "📄";
}

class FileExplorerController {
  constructor({
    root = null,
    viewport = null,
    breakpoint = FILE_EXPLORER_MOBILE_BREAKPOINT,
    renderers = {},
    fetchImpl = null,
    alertImpl = null,
    confirmImpl = null,
    promptImpl = null,
    openWindowImpl = null,
    store = null,
  } = {}) {
    this.viewport =
      viewport ||
      (typeof window !== "undefined" ? window : { innerWidth: 1024 });
    this.breakpoint = breakpoint;
    this.fetchImpl =
      fetchImpl ||
      (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    this.alertImpl = alertImpl || getDefaultAlertImpl();
    this.confirmImpl = confirmImpl || getDefaultConfirmImpl();
    // Explicit adapters remain available for callers/tests; the browser uses a
    // labelled modal form rather than a native prompt with no validation.
    this.promptImpl = promptImpl;
    this.cancelNameDialog = null;
    this.focusPathByWorkspace = new Map();
    this.pendingListFocus = null;
    this.requestedMode = null;
    this.modalActive = false;
    this.modalOpener = null;
    this.modalOpenerId = null;
    this.modalFocusGeneration = 0;
    this.fileFeedbackGeneration = 0;
    this.fileLocationGeneration = 0;
    this.fileNotice = null;
    this.fileNoticeEl = null;
    this.trashButtonEl = null;
    this.trashDialog = null;
    this.pendingTrashMutations = new Set();
    this.openWindowImpl = openWindowImpl || getDefaultOpenWindowImpl();
    this.renderers = {
      breadcrumb:
        typeof renderers.breadcrumb === "function"
          ? renderers.breadcrumb
          : null,
      list: typeof renderers.list === "function" ? renderers.list : null,
      status: typeof renderers.status === "function" ? renderers.status : null,
    };

    // The model lives in a DOM-free store so an unmount()/mount() restores the
    // UI from state. The controller's flag/path/selection getters delegate to
    // it; callers keep using the same controller method surface as before.
    // Fail fast if no store is resolvable — the store-backed getters/setters
    // below assume a store exists at construction (it ships alongside this
    // module), mirroring the "requires fetch support" guard in loadDir().
    this.store = store || resolveFileTreeStore();
    if (!this.store) {
      throw new Error("FileExplorerController requires FileTreeStore");
    }
    // NOTE: store.onChange(...) is intentionally NOT subscribed here. Slice 1
    // keeps the exact prior render timing (the controller's own setters drive
    // re-render) and avoids a double-render; auto-subscribing a mounted view to
    // external store mutations is deferred to the pop-out/dock re-host slice.
    this.store.setMode(resolveFileExplorerMode(this.viewport, this.breakpoint));

    // Set true by dispose(); guards post-await continuations so a teardown
    // mid-browse no-ops instead of throwing on a null store / detached DOM.
    this.disposed = false;

    // Per-load bookkeeping is transient (not part of the persisted model).
    this.pendingLoadByWorkspace = new Map();
    this.loadSequence = 0;

    // Per-workspace root path: set once when openForWorkspace() is first called
    // for a workspace (from the cwd passed by the host). Used to scope the
    // breadcrumb so only segments WITHIN the allowed root are rendered as links.
    this.rootByWorkspace = new Map();

    // DOM handles — null until mount(container) binds a host element.
    this.root = null;
    this.shellEl = null;
    this.backdropEl = null;
    this.breadcrumbEl = null;
    this.listEl = null;
    this.dropZoneEl = null;
    this.uploadInputEl = null;
    this.uploadBtnEl = null;
    this.mkdirBtnEl = null;
    this.newFileBtnEl = null;
    this.refreshBtnEl = null;
    this.closeButtons = [];
    this.dropTargetEl = null;
    this._boundUploadClick = null;
    this._boundMkdirClick = null;
    this._boundNewFileClick = null;
    this._boundRefreshClick = null;

    // Both close controls (header × and footer Close) route through this
    // single handler. When the host (app.js) wires onRequestClose, that
    // callback owns closing the surrounding chrome (e.g. the SurfaceWindow)
    // in addition to the controller's own close(); otherwise this falls back
    // to close() alone (e.g. mobile sheet mode has no host to notify).
    this.handleClose = () =>
      typeof this.onRequestClose === "function"
        ? this.onRequestClose()
        : this.close();
    this.handleBackdropClick = this.handleBackdropClick.bind(this);
    this.handleModalKeydown = this.handleModalKeydown.bind(this);
    this.handleViewportResize = () => this.resize();
    this.handleUpload = this.handleUpload.bind(this);
    this.handleDragOver = this.handleDragOver.bind(this);
    this.handleDragLeave = this.handleDragLeave.bind(this);
    this.handleDropEvent = this.handleDropEvent.bind(this);

    // Auto-mount the legacy host (#file-explorer) when present so existing
    // call sites that relied on the constructor binding keep working.
    const initialRoot =
      root ||
      (typeof document !== "undefined"
        ? document.getElementById("file-explorer")
        : null);
    if (initialRoot) {
      this.mount(initialRoot);
    } else {
      this.syncDom();
    }
  }

  // --- Store-backed flag accessors (preserve the prior instance surface) ---

  get isOpen() {
    return this.store.isOpen;
  }
  set isOpen(value) {
    this.store.setOpen(value);
  }

  get mode() {
    return this.store.mode;
  }
  set mode(value) {
    this.store.setMode(value);
  }

  get currentWorkspaceId() {
    return this.store.currentWorkspaceId;
  }
  set currentWorkspaceId(value) {
    this.store.setCurrentWorkspaceId(value);
  }

  get loading() {
    return this.store.loading;
  }
  set loading(value) {
    this.store.setLoading(value);
  }

  get error() {
    return this.store.error;
  }
  set error(value) {
    this.store.setError(value);
  }

  get dragActive() {
    return this.store.dragActive;
  }
  set dragActive(value) {
    this.store.setDragActive(value);
  }

  get currentPath() {
    if (!this.currentWorkspaceId) return null;
    return this.getWorkspacePath(this.currentWorkspaceId);
  }

  // --- ViewHost lifecycle ---------------------------------------------------

  // Render into the provided DOM container and attach listeners.
  //
  // Slice-1 DOM-ownership contract: the HOST provides the explorer DOM skeleton
  // (see #file-explorer in index.html). mount(container) only QUERIES and binds
  // listeners/handles to the skeleton already present in `container` — it does
  // NOT generate markup. Mounting into a fresh, empty container binds nothing.
  // Safe to call after an unmount() to re-host into another skeleton-bearing
  // container; the model persists in the store so the UI restores itself.
  // Template-owning re-host (mount generates the skeleton, unmount removes it)
  // is deferred to the pop-out/dock slice.
  mount(container) {
    if (this.root === container) return;
    if (this.root) this.unmount();
    this.root = container || null;
    this.bindDom();
    this.render();
  }

  // Detach listeners and drop cached DOM handles but KEEP model state. Per the
  // Slice-1 contract above, unmount() does NOT own or remove the skeleton it
  // bound to — the host keeps that markup. After this the view can be
  // mount()ed into another skeleton-bearing container.
  unmount() {
    this.cancelNameDialog?.();
    this.resetFileFeedback();
    this.finishModalFocus({ restoreFocus: false });
    this.pendingListFocus = null;
    this.unbindDom();
    this.root = null;
  }

  // Full teardown: unmount and drop the store binding. Sets `disposed` so any
  // in-flight async continuation (e.g. a loadDir() awaiting fetch) no-ops on
  // resume instead of touching the now-null store / detached DOM.
  dispose() {
    this.disposed = true;
    this.unmount();
    this.store = null;
  }

  // Re-measure / relayout after the container size changed. The explorer has no
  // measured widgets, so a re-render suffices to keep it consistent.
  resize() {
    if (!this.root) return;
    this.mode = this.resolveMode(this.requestedMode);
    this.render();
  }

  bindDom() {
    if (!this.root || typeof this.root.querySelector !== "function") return;

    this.shellEl = this.root.querySelector(".file-explorer-shell");
    this.backdropEl = this.root.querySelector(".file-explorer-backdrop");
    this.breadcrumbEl = this.root.querySelector("#file-explorer-breadcrumb");
    this.listEl = this.root.querySelector("#file-explorer-list");
    this.dropZoneEl = this.root.querySelector("#file-explorer-drop-zone");
    this.uploadInputEl = this.root.querySelector("#file-explorer-upload-input");
    this.uploadBtnEl = this.root.querySelector("#file-explorer-upload-btn");
    this.mkdirBtnEl = this.root.querySelector("#file-explorer-mkdir-btn");
    this.newFileBtnEl = this.root.querySelector("#file-explorer-newfile-btn");
    this.refreshBtnEl = this.root.querySelector("#file-explorer-refresh-btn");
    const toolbar = this.root.querySelector(".file-explorer-toolbar");
    if (toolbar && typeof document !== "undefined") {
      this.trashButtonEl = document.createElement("button");
      this.trashButtonEl.type = "button";
      this.trashButtonEl.id = "file-explorer-trash-btn";
      this.trashButtonEl.className = "btn btn-secondary";
      this.trashButtonEl.textContent = "Trash";
      this.trashButtonEl.addEventListener("click", () => void this.openTrash());
      toolbar.appendChild(this.trashButtonEl);
      this.fileNoticeEl = document.createElement("div");
      this.fileNoticeEl.className = "file-operation-notice";
      this.fileNoticeEl.hidden = true;
      toolbar.after(this.fileNoticeEl);
    }

    const closeSelectors = [
      "#file-explorer-close",
      "#file-explorer-mobile-close",
    ];
    this.closeButtons = closeSelectors
      .map((selector) => this.root.querySelector(selector))
      .filter(Boolean);

    this.closeButtons.forEach((button) => {
      button.addEventListener("click", this.handleClose);
    });

    this.backdropEl?.addEventListener("click", this.handleBackdropClick);
    this.shellEl?.addEventListener("keydown", this.handleModalKeydown);
    this.viewport?.addEventListener?.("resize", this.handleViewportResize);

    // Hold references to the per-mount closures so unmount() can detach them.
    this._boundUploadClick = () => this.uploadInputEl?.click();
    this._boundMkdirClick = () => void this.createFolder();
    this._boundNewFileClick = () => void this.createFile();
    this._boundRefreshClick = () => {
      if (!this.currentPath) return;
      void this.loadDir(this.currentPath);
    };

    this.uploadBtnEl?.addEventListener("click", this._boundUploadClick);
    this.uploadInputEl?.addEventListener("change", this.handleUpload);
    this.mkdirBtnEl?.addEventListener("click", this._boundMkdirClick);
    this.newFileBtnEl?.addEventListener("click", this._boundNewFileClick);
    this.refreshBtnEl?.addEventListener("click", this._boundRefreshClick);

    this.dropTargetEl = this.shellEl || this.root;
    this.dropTargetEl?.addEventListener("dragover", this.handleDragOver);
    this.dropTargetEl?.addEventListener("dragleave", this.handleDragLeave);
    this.dropTargetEl?.addEventListener("drop", this.handleDropEvent);
  }

  // Detach every listener bindDom() attached and drop cached DOM handles, so an
  // unmounted view leaks nothing and a later mount() can rebind cleanly.
  unbindDom() {
    this.trashButtonEl?.remove();
    this.fileNoticeEl?.remove();
    this.trashButtonEl = null;
    this.fileNoticeEl = null;
    this.closeButtons.forEach((button) => {
      button.removeEventListener?.("click", this.handleClose);
    });
    this.backdropEl?.removeEventListener?.("click", this.handleBackdropClick);
    this.shellEl?.removeEventListener?.("keydown", this.handleModalKeydown);
    this.viewport?.removeEventListener?.("resize", this.handleViewportResize);
    if (this._boundUploadClick) {
      this.uploadBtnEl?.removeEventListener?.("click", this._boundUploadClick);
    }
    this.uploadInputEl?.removeEventListener?.("change", this.handleUpload);
    if (this._boundMkdirClick) {
      this.mkdirBtnEl?.removeEventListener?.("click", this._boundMkdirClick);
    }
    if (this._boundNewFileClick) {
      this.newFileBtnEl?.removeEventListener?.(
        "click",
        this._boundNewFileClick,
      );
    }
    if (this._boundRefreshClick) {
      this.refreshBtnEl?.removeEventListener?.(
        "click",
        this._boundRefreshClick,
      );
    }
    if (this.dropTargetEl) {
      this.dropTargetEl.removeEventListener?.("dragover", this.handleDragOver);
      this.dropTargetEl.removeEventListener?.(
        "dragleave",
        this.handleDragLeave,
      );
      this.dropTargetEl.removeEventListener?.("drop", this.handleDropEvent);
    }

    this.shellEl = null;
    this.backdropEl = null;
    this.breadcrumbEl = null;
    this.listEl = null;
    this.dropZoneEl = null;
    this.uploadInputEl = null;
    this.uploadBtnEl = null;
    this.mkdirBtnEl = null;
    this.newFileBtnEl = null;
    this.refreshBtnEl = null;
    this.closeButtons = [];
    this.dropTargetEl = null;
    this._boundUploadClick = null;
    this._boundMkdirClick = null;
    this._boundNewFileClick = null;
    this._boundRefreshClick = null;
  }

  handleBackdropClick(event) {
    if (event.target === this.backdropEl) {
      this.handleClose();
    }
  }

  modalFocusTargets() {
    const candidates =
      this.shellEl?.querySelectorAll?.(
        "button, a[href], input, select, textarea, [tabindex]",
      ) || [];
    return Array.from(candidates).filter(
      (element) =>
        element.tabIndex >= 0 &&
        !element.disabled &&
        !element.hidden &&
        !element.closest?.("[hidden], .hidden, [inert]") &&
        (typeof element.getClientRects !== "function" ||
          element.getClientRects().length > 0),
    );
  }

  handleModalKeydown(event) {
    if (!this.modalActive || !this.isOpen || this.mode !== "overlay") return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.handleClose();
    } else if (event.key === "Tab") {
      const targets = this.modalFocusTargets();
      const active =
        this.shellEl?.ownerDocument?.activeElement ||
        (typeof document !== "undefined" ? document.activeElement : null);
      const index = targets.indexOf(active);
      if (
        targets.length === 0 ||
        index < 0 ||
        (event.shiftKey && index === 0) ||
        (!event.shiftKey && index === targets.length - 1)
      ) {
        event.preventDefault();
        const target = event.shiftKey
          ? targets[targets.length - 1]
          : targets[0];
        (target || this.shellEl)?.focus?.();
      }
      event.stopPropagation();
    }
  }

  syncModalFocus() {
    const active = Boolean(
      this.isOpen && this.mode === "overlay" && this.shellEl,
    );
    if (active === this.modalActive) return;
    if (!active) {
      // Resizing into desktop mode must not move focus to a hidden mobile bar.
      this.finishModalFocus({ restoreFocus: false });
      return;
    }
    this.modalActive = true;
    this.modalFocusGeneration += 1;
    const doc =
      this.shellEl.ownerDocument ||
      (typeof document !== "undefined" ? document : null);
    const focused = doc?.activeElement;
    const candidate =
      focused &&
      focused !== doc.body &&
      focused !== doc.documentElement &&
      !this.root?.contains?.(focused)
        ? focused
        : this.getDefaultOpener?.();
    this.modalOpener = candidate || null;
    this.modalOpenerId = candidate?.id || null;
    this.shellEl.tabIndex = -1;
    (this.modalFocusTargets()[0] || this.shellEl).focus?.({
      preventScroll: true,
    });
  }

  finishModalFocus({ restoreFocus = true } = {}) {
    if (!this.modalActive) return;
    this.modalActive = false;
    const generation = ++this.modalFocusGeneration;
    const opener = this.modalOpener;
    const openerId = this.modalOpenerId;
    const shell = this.shellEl;
    const doc =
      shell?.ownerDocument ||
      (typeof document !== "undefined" ? document : null);
    const focused = doc?.activeElement;
    const wasInside =
      !focused || focused === doc?.body || shell?.contains?.(focused);
    this.modalOpener = null;
    this.modalOpenerId = null;
    if (!restoreFocus || !wasInside) return;
    // Run after the host has hidden its surrounding chrome. A newer modal or
    // deliberately focused destination wins over this return-to-opener step.
    queueMicrotask(() => {
      if (
        this.disposed ||
        this.modalActive ||
        generation !== this.modalFocusGeneration ||
        this.mode !== "overlay" ||
        getViewportWidth(this.viewport) > this.breakpoint
      )
        return;
      const current = doc?.activeElement;
      if (current && current !== doc?.body && !shell?.contains?.(current))
        return;
      const candidates = [
        openerId && doc?.getElementById?.(openerId),
        opener,
        this.getDefaultOpener?.(),
      ];
      const target = candidates.find(
        (entry) =>
          entry &&
          typeof entry.focus === "function" &&
          entry.isConnected !== false &&
          !entry.disabled &&
          !entry.hidden &&
          !entry.closest?.("[hidden], .hidden, [inert]") &&
          (typeof entry.getClientRects !== "function" ||
            entry.getClientRects().length > 0),
      );
      target?.focus?.({ preventScroll: true });
    });
  }

  handleDragOver(event) {
    event.preventDefault();
    this.setDragActive(true);
  }

  handleDragLeave(event) {
    const nextTarget = event.relatedTarget;
    const dropTarget = this.shellEl || this.root;
    if (dropTarget?.contains?.(nextTarget)) return;
    this.setDragActive(false);
  }

  handleDropEvent(event) {
    event.preventDefault();
    this.setDragActive(false);
    if (event.dataTransfer?.files?.length) {
      void this.uploadFiles(event.dataTransfer.files);
    }
  }

  resolveMode(mode) {
    if (mode === "docked" || mode === "overlay") return mode;
    return resolveFileExplorerMode(this.viewport, this.breakpoint);
  }

  buildSnapshot() {
    const workspaceId = this.currentWorkspaceId;
    const path = workspaceId ? this.getWorkspacePath(workspaceId) : null;

    return {
      isOpen: this.isOpen,
      mode: this.mode,
      workspaceId,
      path,
      // The root path this workspace was opened with (first cwd). Used by
      // renderBreadcrumb() to scope links to navigable paths only.
      rootPath: workspaceId
        ? this.rootByWorkspace.get(workspaceId) || null
        : null,
      selectedItem: workspaceId ? this.getSelectedItem(workspaceId) : null,
      items: workspaceId ? this.getWorkspaceItems(workspaceId) : [],
      decorations: workspaceId ? this.store.getDecorations(workspaceId) : {},
      folderDecorations: workspaceId
        ? this.store.getFolderDecorations(workspaceId)
        : {},
      loading: this.loading,
      error: this.error,
      dragActive: this.dragActive,
    };
  }

  syncDom() {
    if (!this.root) return;

    this.root.classList?.toggle("hidden", !this.isOpen);
    this.root.classList?.toggle("drag-active", this.dragActive);

    if (this.root.dataset) {
      this.root.dataset.mode = this.mode;
      this.root.dataset.workspaceId = this.currentWorkspaceId || "";
      this.root.dataset.loading = String(this.loading);
      this.root.dataset.error = this.error || "";
    }

    this.root.setAttribute("data-mode", this.mode);
    this.root.setAttribute("aria-hidden", this.isOpen ? "false" : "true");
    this.shellEl?.setAttribute(
      "aria-modal",
      this.mode === "overlay" ? "true" : "false",
    );
    this.dropZoneEl?.classList?.toggle("hidden", !this.dragActive);
  }

  render() {
    this.syncDom();
    this.renderBreadcrumb();
    this.renderList();
    this.renderStatus();
    this.syncModalFocus();
  }

  renderBreadcrumb() {
    const snapshot = this.buildSnapshot();

    if (this.breadcrumbEl) {
      const focusedPath = this.breadcrumbEl.contains?.(document.activeElement)
        ? document.activeElement?.dataset?.path
        : null;
      this.breadcrumbEl.setAttribute("aria-label", "Current folder");
      this.breadcrumbEl.innerHTML = "";

      if (!snapshot.path) {
        const placeholder = document.createElement("span");
        placeholder.textContent = "Open Files to browse the current workspace.";
        this.breadcrumbEl.appendChild(placeholder);
      } else {
        // Scope the breadcrumb to the workspace's allowed root so every link
        // points to a navigable (in-root) path. breadcrumbSegments() emits only
        // segments at or below the root — never "/" or "home" etc. above it.
        const rootPath = snapshot.rootPath || snapshot.path;
        const crumbs = breadcrumbSegments(snapshot.path, rootPath);

        crumbs.forEach((crumb, i) => {
          if (i > 0) {
            this.breadcrumbEl.appendChild(document.createTextNode(" / "));
          }
          const link = document.createElement("button");
          link.type = "button";
          link.className = "file-breadcrumb-button";
          link.textContent = crumb.label;
          link.dataset.path = crumb.path;
          link.setAttribute("aria-label", `Open folder ${crumb.label}`);
          if (i === crumbs.length - 1)
            link.setAttribute("aria-current", "location");
          // Capture crumb.path in a const so the closure captures the right value.
          const crumbPath = crumb.path;
          link.addEventListener("click", () => void this.loadDir(crumbPath));
          this.breadcrumbEl.appendChild(link);
          if (focusedPath === crumb.path) link.focus?.();
        });
      }
    }

    this.renderers.breadcrumb?.(snapshot);
  }

  renderList() {
    const snapshot = this.buildSnapshot();
    const focused =
      typeof document !== "undefined" ? document.activeElement : null;
    const focusedRow = focused?.closest?.(".file-item");
    const capturedListFocus = focusedRow && this.listEl?.contains?.(focusedRow);
    if (capturedListFocus) {
      this.pendingListFocus = {
        workspaceId: this.listEl.dataset.workspaceId,
        path: focusedRow.dataset.path,
        action: focused.dataset.explorerAction || "open",
        index: Array.from(this.listEl.children).indexOf(focusedRow),
      };
    }

    if (this.listEl?.dataset) {
      this.listEl.dataset.workspaceId = snapshot.workspaceId || "";
      this.listEl.dataset.path = snapshot.path || "";
    }

    if (this.listEl) {
      this.listEl.setAttribute("role", "list");
      this.listEl.setAttribute(
        "aria-label",
        "Files. Use arrow keys to move between items.",
      );
      this.listEl.setAttribute(
        "aria-busy",
        snapshot.loading ? "true" : "false",
      );
      this.listEl.tabIndex = -1;
      this.listEl.innerHTML = "";

      if (snapshot.loading) {
        this.listEl.appendChild(
          this.createMessageCard(
            "muted",
            "Loading files",
            "Refreshing directory contents for the active workspace.",
          ),
        );
      } else if (snapshot.error) {
        this.listEl.appendChild(
          this.createMessageCard("error", "Explorer error", snapshot.error),
        );
      } else if (snapshot.items.length === 0) {
        this.listEl.appendChild(
          this.createMessageCard(
            "muted",
            "This folder is empty",
            "Create a folder, upload files, or switch to a different workspace path.",
          ),
        );
      } else {
        const remembered = this.focusPathByWorkspace.get(snapshot.workspaceId);
        if (!snapshot.items.some((item) => item.path === remembered)) {
          this.focusPathByWorkspace.set(
            snapshot.workspaceId,
            snapshot.items[0].path,
          );
        }
        snapshot.items.forEach((item) => {
          this.listEl.appendChild(this.createItemElement(item, snapshot));
        });
      }
      const pending = this.pendingListFocus;
      if (pending && pending.workspaceId !== snapshot.workspaceId) {
        this.pendingListFocus = null;
      } else if (pending) {
        // A background refresh must never take focus back from a toolbar,
        // another workspace, editor, or dialog the user has since entered.
        const active = document.activeElement;
        const canRestore =
          capturedListFocus ||
          !active ||
          active === document.body ||
          active === this.listEl;
        if (!canRestore) this.pendingListFocus = null;
        else if (!snapshot.loading) {
          const rows = Array.from(
            this.listEl.querySelectorAll?.(".file-item") || [],
          );
          const row =
            rows.find((entry) => entry.dataset.path === pending.path) ||
            rows[Math.min(pending.index, rows.length - 1)];
          const buttons = Array.from(row?.querySelectorAll?.("button") || []);
          const target =
            buttons.find(
              (button) => button.dataset.explorerAction === pending.action,
            ) || buttons[0];
          (target || this.listEl).focus?.({ preventScroll: true });
          this.pendingListFocus = null;
        } else {
          this.listEl.focus?.({ preventScroll: true });
        }
      }
    }

    this.renderers.list?.(snapshot);
  }

  renderStatus() {
    const snapshot = this.buildSnapshot();
    this.renderers.status?.(snapshot);
  }

  createMessageCard(kind, title, body) {
    const card = document.createElement("div");
    card.className = kind === "error" ? "error" : "file-explorer-empty";

    if (kind === "error") {
      const label = document.createElement("strong");
      label.textContent = title;
      const detail = document.createElement("div");
      detail.textContent = body;
      card.appendChild(label);
      card.appendChild(detail);
      return card;
    }

    const heading = document.createElement("strong");
    heading.textContent = title;
    const detail = document.createElement("span");
    detail.textContent = body;
    card.appendChild(heading);
    card.appendChild(detail);
    return card;
  }

  createItemElement(item, snapshot) {
    const el = document.createElement("div");
    const isSelected = snapshot.selectedItem?.path === item.path;
    el.className = "file-item";
    if (isSelected) el.classList.add("selected");
    if (item.isDir) el.classList.add("is-dir");
    el.dataset.path = item.path;
    el.setAttribute("role", "listitem");

    const iconEl = document.createElement("span");
    iconEl.className = "file-icon";
    iconEl.textContent = getItemIcon(item);
    iconEl.setAttribute("aria-hidden", "true");

    const nameEl = document.createElement("button");
    nameEl.type = "button";
    nameEl.className = "file-name file-open";
    nameEl.dataset.explorerAction = "open";
    nameEl.tabIndex =
      this.focusPathByWorkspace.get(snapshot.workspaceId) === item.path
        ? 0
        : -1;
    nameEl.setAttribute(
      "aria-label",
      item.isParent
        ? "Open parent folder"
        : `Open ${item.isDir ? "folder" : "file"} ${item.name}`,
    );
    nameEl.textContent = item.name;
    const rememberRowFocus = () => {
      this.focusPathByWorkspace.set(snapshot.workspaceId, item.path);
      for (const row of this.listEl?.querySelectorAll?.(".file-item") || []) {
        for (const button of row.querySelectorAll("button")) {
          button.tabIndex = row.dataset.path === item.path ? 0 : -1;
        }
      }
    };
    nameEl.addEventListener("focus", rememberRowFocus);
    el.addEventListener("keydown", (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
        return;
      const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const buttons = Array.from(
        this.listEl?.querySelectorAll?.(".file-open") || [],
      );
      const index = buttons.indexOf(nameEl);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : Math.max(
                0,
                Math.min(
                  buttons.length - 1,
                  index + (event.key === "ArrowDown" ? 1 : -1),
                ),
              );
      buttons[next]?.focus();
    });

    // Git status decoration (VS Code style): a single-letter badge + color
    // class threaded in via snapshot.decorations (keyed by absolute path).
    const decoration = snapshot.decorations?.[item.path];
    let badgeEl = null;
    if (decoration && decoration.letter) {
      el.classList.add("git-decorated");
      if (decoration.colorClass) {
        el.classList.add(decoration.colorClass);
        nameEl.classList.add(decoration.colorClass);
      }
      badgeEl = document.createElement("span");
      badgeEl.className = "file-git-status";
      if (decoration.colorClass) badgeEl.classList.add(decoration.colorClass);
      badgeEl.textContent = decoration.letter;
    }

    // Folder rollup badge: shows how many changed files are inside a directory.
    // Mirrors the VS Code Explorer "+N" cue beside changed folders.
    let folderBadgeEl = null;
    if (item.isDir && !item.isParent) {
      const folderDec = snapshot.folderDecorations?.[item.path];
      if (folderDec && folderDec.count > 0) {
        folderBadgeEl = document.createElement("span");
        folderBadgeEl.className = "file-git-folder-count";
        if (folderDec.colorClass)
          folderBadgeEl.classList.add(folderDec.colorClass);
        folderBadgeEl.textContent = String(folderDec.count);
      }
    }

    const sizeEl = document.createElement("span");
    sizeEl.className = "file-size";
    sizeEl.textContent = item.isDir ? "" : formatFileSize(item.size);

    const actionsEl = document.createElement("div");
    actionsEl.className = "file-actions";

    if (
      !item.isDir &&
      !item.isParent &&
      typeof this.onOpenFile === "function"
    ) {
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "edit";
      editBtn.title = "Edit";
      editBtn.textContent = "✎";
      // The edit button is a single explicit open → PREVIEW (VS Code: a single
      // open action previews; editing or a double-click pins it).
      editBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        this.onOpenFile(item.path, { pinned: false });
      });
      actionsEl.appendChild(editBtn);
    }

    if (!item.isDir && !item.isParent) {
      const downloadBtn = document.createElement("button");
      downloadBtn.type = "button";
      downloadBtn.className = "download";
      downloadBtn.title = "Download";
      downloadBtn.textContent = "⬇";
      downloadBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        this.downloadFile(item.path);
      });
      actionsEl.appendChild(downloadBtn);
    }

    // Rename button for both files and folders (not the parent ".." entry).
    if (!item.isParent) {
      const renameBtn = document.createElement("button");
      renameBtn.type = "button";
      renameBtn.className = "rename";
      renameBtn.title = "Rename";
      renameBtn.textContent = "✏";
      renameBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.renameItem(item);
      });
      actionsEl.appendChild(renameBtn);
    }

    if (!item.isParent) {
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "delete danger";
      deleteBtn.title = "Delete";
      deleteBtn.textContent = "🗑";
      deleteBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.deleteItem(item.path, item.isDir);
      });
      actionsEl.appendChild(deleteBtn);
    }

    el.appendChild(iconEl);
    el.appendChild(nameEl);
    if (badgeEl) el.appendChild(badgeEl);
    if (folderBadgeEl) el.appendChild(folderBadgeEl);
    el.appendChild(sizeEl);
    el.appendChild(actionsEl);
    for (const button of actionsEl.children) {
      button.dataset.explorerAction = button.className.split(" ")[0];
      button.tabIndex = nameEl.tabIndex;
      button.setAttribute("aria-label", `${button.title} ${item.name}`);
      button.addEventListener("focus", rememberRowFocus);
    }

    el.addEventListener("click", () => {
      if (item.isDir) {
        this.setSelectedItem(snapshot.workspaceId, null);
        void this.loadDir(item.path, snapshot.workspaceId);
        return;
      }

      this.setSelectedItem(snapshot.workspaceId, item);
      this.renderList();
      // VS Code single-click → open the file as a PREVIEW immediately (when an
      // editor target is wired); a double-click then pins it. Parent (..) rows
      // never open.
      if (!item.isParent && typeof this.onOpenFile === "function") {
        this.onOpenFile(item.path, { pinned: false });
      }
    });

    // Double-click a file row → open PINNED (VS Code: double-click pins).
    // Directories keep their navigate-on-open behavior (no double-click pin).
    if (
      !item.isDir &&
      !item.isParent &&
      typeof this.onOpenFile === "function"
    ) {
      el.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        this.onOpenFile(item.path, { pinned: true });
      });
    }

    return el;
  }

  openForWorkspace(workspaceId, cwd = "", mode = null, options = {}) {
    const normalizedWorkspaceId = String(workspaceId || "").trim();
    if (!normalizedWorkspaceId) return null;

    if (this.currentWorkspaceId !== normalizedWorkspaceId) {
      this.cancelNameDialog?.();
      this.resetFileFeedback();
      this.pendingListFocus = null;
    }
    this.currentWorkspaceId = normalizedWorkspaceId;
    // reveal:false retargets the explorer (workspace/root/path bookkeeping)
    // without forcing it visible — a committed cwd change must not pop the
    // explorer open, only navigate it for whenever the user opens it.
    if (options.reveal !== false) this.isOpen = true;
    this.requestedMode = mode;
    this.mode = this.resolveMode(mode);

    const rememberedPath =
      this.getWorkspacePath(normalizedWorkspaceId) ||
      normalizeExplorerPath(cwd) ||
      "/";

    // Record the workspace root the FIRST time this workspace is opened (the
    // cwd from the host is the best proxy for the allowed root). If there is
    // already a remembered path the workspace was previously open — use the
    // cwd arg as the root only when no root is recorded yet.
    if (!this.rootByWorkspace.has(normalizedWorkspaceId)) {
      const initialRoot = normalizeExplorerPath(cwd) || rememberedPath;
      if (initialRoot)
        this.rootByWorkspace.set(normalizedWorkspaceId, initialRoot);
    }

    this.store.setWorkspacePath(normalizedWorkspaceId, rememberedPath);
    this.render();
    return rememberedPath;
  }

  // Hosts notify this controller before/when hiding its surface. Passing
  // restoreFocus:false is useful when another surface deliberately takes over.
  close({ restoreFocus = true } = {}) {
    this.cancelNameDialog?.();
    this.resetFileFeedback();
    this.finishModalFocus({ restoreFocus });
    this.isOpen = false;
    this.dragActive = false;
    this.render();
  }

  setWorkspacePath(workspaceId, path) {
    const normalizedWorkspaceId = String(workspaceId || "").trim();
    const normalizedPath = normalizeExplorerPath(path);
    if (!normalizedWorkspaceId || !normalizedPath) return null;

    if (
      normalizedWorkspaceId === this.currentWorkspaceId &&
      normalizedPath !== this.currentPath
    ) {
      this.resetFileFeedback();
    }

    this.store.setWorkspacePath(normalizedWorkspaceId, normalizedPath);
    if (normalizedWorkspaceId === this.currentWorkspaceId) {
      this.render();
    }
    return normalizedPath;
  }

  getWorkspacePath(workspaceId) {
    return this.store.getWorkspacePath(workspaceId);
  }

  setSelectedItem(workspaceId, item) {
    const normalizedWorkspaceId = String(workspaceId || "").trim();
    if (!normalizedWorkspaceId) return null;

    const nextSelection = this.store.setSelectedItem(
      normalizedWorkspaceId,
      item,
    );

    if (normalizedWorkspaceId === this.currentWorkspaceId) {
      this.renderList();
    }
    return nextSelection;
  }

  getSelectedItem(workspaceId) {
    return this.store.getSelectedItem(workspaceId);
  }

  setWorkspaceItems(workspaceId, items) {
    const normalizedWorkspaceId = String(workspaceId || "").trim();
    if (!normalizedWorkspaceId) return [];

    const nextItems = this.store.setWorkspaceItems(
      normalizedWorkspaceId,
      items,
    );

    if (normalizedWorkspaceId === this.currentWorkspaceId) {
      this.renderList();
    }
    return nextItems;
  }

  getWorkspaceItems(workspaceId) {
    return this.store.getWorkspaceItems(workspaceId);
  }

  // Git status decorations keyed by absolute item path, plus an optional folder
  // rollup map keyed by absolute dir path. Re-renders the list when set for the
  // active workspace so badges/colors appear immediately.
  // Signature: setDecorations(workspaceId, fileMap, folderMap?)
  // Existing callers that pass only fileMap continue to work (folderMap → {}).
  setDecorations(workspaceId, decorations, folderDecorations = {}) {
    const normalizedWorkspaceId = String(workspaceId || "").trim();
    if (!normalizedWorkspaceId) return null;

    this.store.setDecorations(
      normalizedWorkspaceId,
      decorations,
      folderDecorations,
    );

    if (normalizedWorkspaceId === this.currentWorkspaceId) {
      this.renderList();
    }
    return this.store.getDecorations(normalizedWorkspaceId);
  }

  setLoading(loading) {
    this.loading = Boolean(loading);
    this.renderStatus();
    return this.loading;
  }

  setError(error) {
    this.error = error ? String(error) : null;
    this.renderStatus();
    return this.error;
  }

  setDragActive(dragActive) {
    this.dragActive = Boolean(dragActive);
    this.syncDom();
    this.renderStatus();
    return this.dragActive;
  }

  buildItemsFromBrowse(data) {
    const items = [];
    const currentPath = normalizeExplorerPath(data?.path) || "/";

    if (currentPath !== "/") {
      const parentPath = currentPath.split("/").slice(0, -1).join("/") || "/";
      items.push({
        name: "..",
        path: parentPath,
        isDir: true,
        isParent: true,
      });
    }

    (data?.dirs || []).forEach((name) => {
      items.push({
        name,
        path: joinExplorerPath(currentPath, name),
        isDir: true,
      });
    });

    (data?.files || []).forEach((file) => {
      items.push({
        name: file.name,
        size: file.size,
        path: joinExplorerPath(currentPath, file.name),
        isDir: false,
      });
    });

    return items;
  }

  async loadDir(path, workspaceId = this.currentWorkspaceId) {
    if (!this.fetchImpl) {
      throw new Error("FileExplorerController requires fetch support");
    }

    const normalizedWorkspaceId = String(workspaceId || "").trim();
    const nextPath =
      normalizeExplorerPath(path) ||
      this.getWorkspacePath(normalizedWorkspaceId) ||
      "/";

    if (!normalizedWorkspaceId || !nextPath) return null;

    if (
      normalizedWorkspaceId === this.currentWorkspaceId &&
      nextPath !== this.currentPath
    ) {
      this.resetFileFeedback();
    }

    const requestId = ++this.loadSequence;
    this.pendingLoadByWorkspace.set(normalizedWorkspaceId, requestId);

    if (normalizedWorkspaceId === this.currentWorkspaceId) {
      this.store.setWorkspacePath(normalizedWorkspaceId, nextPath);
      this.setLoading(true);
      this.setError(null);
      this.render();
    } else {
      this.store.setWorkspacePath(normalizedWorkspaceId, nextPath);
    }

    try {
      const res = await this.fetchImpl(
        `/api/browse?path=${encodeURIComponent(nextPath)}&files=true`,
      );
      const data = await res.json().catch(() => ({}));
      // Disposed mid-browse: store is gone and DOM is detached — drop the result
      // rather than write to a null store / re-render a torn-down view.
      if (this.disposed) return null;
      if (
        this.pendingLoadByWorkspace.get(normalizedWorkspaceId) !== requestId
      ) {
        return null;
      }

      if (!res.ok || data.error) {
        throw new Error(explainApiError(data, "Cannot read directory"));
      }

      const resolvedPath = normalizeExplorerPath(data.path) || nextPath;
      const items = this.buildItemsFromBrowse(data);

      this.store.setWorkspacePath(normalizedWorkspaceId, resolvedPath);
      this.store.setWorkspaceItems(normalizedWorkspaceId, items);
      this.loading = false;
      this.error = null;

      if (normalizedWorkspaceId === this.currentWorkspaceId) {
        this.render();
      }

      // Lets the host (app.js) refresh git decorations for the new directory.
      if (typeof this.onDirLoaded === "function") {
        try {
          this.onDirLoaded(resolvedPath, normalizedWorkspaceId);
        } catch {
          // Decoration refresh must not break directory loading.
        }
      }

      return data;
    } catch (err) {
      // Disposed mid-browse: skip the error write-back to the now-null store.
      if (this.disposed) return null;
      if (
        this.pendingLoadByWorkspace.get(normalizedWorkspaceId) !== requestId
      ) {
        return null;
      }

      this.loading = false;
      this.error =
        err instanceof Error ? err.message : "Failed to load directory";
      if (normalizedWorkspaceId === this.currentWorkspaceId) {
        this.render();
      }
      return null;
    }
  }

  downloadFile(path) {
    const nextPath = normalizeExplorerPath(path);
    if (!nextPath) return;

    this.openWindowImpl(
      `/api/files/download?path=${encodeURIComponent(nextPath)}`,
      "_blank",
    );
  }

  resetFileFeedback({ locationChanged = true } = {}) {
    this.fileFeedbackGeneration += 1;
    if (locationChanged) this.fileLocationGeneration += 1;
    this.fileNotice = null;
    this.renderFileNotice();
    this.closeTrash({ restoreFocus: false });
  }

  fileContext() {
    return {
      workspaceId: this.currentWorkspaceId,
      path: this.currentPath,
      generation: this.fileFeedbackGeneration,
      locationGeneration: this.fileLocationGeneration,
    };
  }

  isFileLocationCurrent(context) {
    return (
      !this.disposed &&
      context.locationGeneration === this.fileLocationGeneration &&
      context.workspaceId === this.currentWorkspaceId &&
      context.path === this.currentPath
    );
  }

  isFileContextCurrent(context) {
    return (
      this.isFileLocationCurrent(context) &&
      context.generation === this.fileFeedbackGeneration
    );
  }

  renderFileNotice() {
    const container = this.fileNoticeEl;
    if (!container) return;
    const focusedUndo =
      container.contains(document.activeElement) &&
      document.activeElement?.classList?.contains("file-trash-undo");
    container.innerHTML = "";
    container.hidden = !this.fileNotice;
    if (!this.fileNotice) return;
    const message = document.createElement("span");
    message.setAttribute("role", this.fileNotice.error ? "alert" : "status");
    message.textContent = this.fileNotice.message;
    container.appendChild(message);
    if (this.fileNotice.undo) {
      const undo = document.createElement("button");
      undo.type = "button";
      undo.className = "btn file-trash-undo";
      undo.textContent = this.fileNotice.busy ? "Restoring…" : "Undo";
      undo.setAttribute("aria-disabled", String(Boolean(this.fileNotice.busy)));
      undo.addEventListener("click", () => void this.undoDelete());
      container.appendChild(undo);
      if (focusedUndo) undo.focus();
    }
  }

  async deleteItem(path, isDir = false, workspaceId = this.currentWorkspaceId) {
    const targetPath = normalizeExplorerPath(path);
    const normalizedWorkspaceId = String(workspaceId || "").trim();
    if (
      this.disposed ||
      !this.fetchImpl ||
      !targetPath ||
      !normalizedWorkspaceId ||
      normalizedWorkspaceId !== this.currentWorkspaceId
    )
      return false;
    if (
      !this.confirmImpl(
        `Move ${isDir ? "folder" : "file"} to Trash?\n${targetPath}\nYou can restore it from Trash until it is permanently deleted.`,
      )
    )
      return false;
    this.resetFileFeedback({ locationChanged: false });
    const context = this.fileContext();
    try {
      const res = await this.fetchImpl(
        `/api/files?path=${encodeURIComponent(targetPath)}`,
        { method: "DELETE" },
      );
      const payload = await res.json().catch(() => ({}));
      if (!this.isFileLocationCurrent(context)) return false;
      if (!res.ok || payload.error)
        throw new Error(
          explainApiError(payload, "Could not move item to Trash"),
        );
      if (!payload.trash?.id || !payload.root)
        throw new Error(
          "The server did not confirm a recoverable Trash item. Refresh the file list and check Trash.",
        );
      if (this.getSelectedItem(normalizedWorkspaceId)?.path === targetPath)
        this.setSelectedItem(normalizedWorkspaceId, null);
      await this.loadDir(context.path, context.workspaceId);
      if (!this.isFileLocationCurrent(context)) return false;
      if (this.trashDialog) await this.loadTrashDialog(this.trashDialog);
      if (!this.isFileLocationCurrent(context)) return false;
      // A later action owns the notice, but cannot suppress this successful
      // mutation's refresh of the folder that is still being viewed.
      if (!this.isFileContextCurrent(context)) return true;
      this.fileNotice = {
        message: `Moved ${targetPath.split("/").pop()} to Trash.`,
        undo: { id: payload.trash.id, root: payload.root },
        context,
      };
      this.renderFileNotice();
      return true;
    } catch (err) {
      if (this.isFileContextCurrent(context)) {
        this.fileNotice = {
          error: true,
          message:
            err instanceof Error ? err.message : "Could not move item to Trash",
        };
        this.renderFileNotice();
      }
      return false;
    }
  }

  async requestTrashMutation(operation, root, id) {
    const key = JSON.stringify([root, id]);
    if (this.pendingTrashMutations.has(key)) {
      throw new Error("This item already has an operation in progress.");
    }
    const context = this.fileContext();
    const originalDialog = this.trashDialog;
    this.pendingTrashMutations.add(key);
    try {
      const res = await this.fetchImpl(`/api/files/trash/${operation}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root, id }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload.error) {
        const fallback =
          operation === "restore" && res.status === 409
            ? "A file already exists at the original path. Rename or move that file, then try restoring again."
            : `Could not ${operation === "restore" ? "restore" : "permanently delete"} the Trash item.`;
        throw new Error(explainApiError(payload, fallback));
      }
      // A dialog reopened while the mutation ran may have loaded its old
      // contents. Refresh that view before releasing the per-item guard.
      if (
        this.isFileLocationCurrent(context) &&
        this.trashDialog &&
        this.trashDialog !== originalDialog
      ) {
        await this.loadTrashDialog(this.trashDialog);
      }
      return payload;
    } finally {
      this.pendingTrashMutations.delete(key);
      if (this.trashDialog) this.renderTrashDialog(this.trashDialog);
    }
  }

  async undoDelete() {
    const notice = this.fileNotice;
    if (
      !notice?.undo ||
      notice.busy ||
      !this.isFileContextCurrent(notice.context)
    )
      return false;
    notice.busy = true;
    this.renderFileNotice();
    try {
      await this.requestTrashMutation(
        "restore",
        notice.undo.root,
        notice.undo.id,
      );
      if (!this.isFileLocationCurrent(notice.context)) return false;
      await this.loadDir(notice.context.path, notice.context.workspaceId);
      if (!this.isFileLocationCurrent(notice.context)) return false;
      if (
        !this.isFileContextCurrent(notice.context) ||
        this.fileNotice !== notice
      )
        return true;
      const heldFocus =
        typeof document !== "undefined" &&
        this.fileNoticeEl?.contains?.(document.activeElement);
      this.fileNotice = { message: "Item restored from Trash." };
      this.renderFileNotice();
      // Undo removes its own button; keep keyboard focus in the file list.
      if (heldFocus)
        this.listEl?.querySelector?.(".file-open[tabindex='0']")?.focus?.();
      return true;
    } catch (err) {
      if (
        this.isFileContextCurrent(notice.context) &&
        this.fileNotice === notice
      ) {
        notice.busy = false;
        notice.error = true;
        notice.message =
          err instanceof Error ? err.message : "Could not restore the item.";
        this.renderFileNotice();
      }
      return false;
    }
  }

  async openTrash() {
    if (this.disposed || !this.fetchImpl || !this.currentPath) return false;
    this.resetFileFeedback({ locationChanged: false });
    const state = {
      context: this.fileContext(),
      root: null,
      items: [],
      loading: true,
      busy: false,
      error: "",
      message: "Loading Trash…",
      dialog: null,
      opener: typeof document !== "undefined" ? document.activeElement : null,
    };
    this.trashDialog = state;
    this.showTrashDialog(state);
    return this.loadTrashDialog(state);
  }

  async loadTrashDialog(state) {
    if (!this.isTrashDialogCurrent(state)) return false;
    const requestId = (state.loadGeneration || 0) + 1;
    state.loadGeneration = requestId;
    state.loading = true;
    state.error = "";
    if (!state.busy) state.message = "Loading Trash…";
    this.renderTrashDialog(state);
    try {
      const res = await this.fetchImpl(
        `/api/files/trash?path=${encodeURIComponent(state.context.path)}`,
      );
      const payload = await res.json().catch(() => ({}));
      if (
        !this.isTrashDialogCurrent(state) ||
        state.loadGeneration !== requestId
      )
        return false;
      if (!res.ok || payload.error)
        throw new Error(explainApiError(payload, "Could not load Trash"));
      if (!payload.root || !Array.isArray(payload.items))
        throw new Error("Invalid Trash response. Refresh and try again.");
      state.root = payload.root;
      state.items = payload.items;
      state.loading = false;
      if (!state.busy) state.message = "";
      this.renderTrashDialog(state);
      return true;
    } catch (err) {
      if (
        this.isTrashDialogCurrent(state) &&
        state.loadGeneration === requestId
      ) {
        state.loading = false;
        state.items = [];
        state.message = "";
        state.error =
          err instanceof Error ? err.message : "Could not load Trash";
        this.renderTrashDialog(state);
      }
      return false;
    }
  }

  isTrashDialogCurrent(state) {
    return (
      this.trashDialog === state && this.isFileContextCurrent(state.context)
    );
  }

  showTrashDialog(state) {
    if (typeof document === "undefined" || !document.body) return;
    const dialog = document.createElement("dialog");
    if (typeof dialog.showModal !== "function") return;
    dialog.className = "file-name-dialog file-trash-dialog";
    dialog.setAttribute("aria-label", "Trash");
    const header = document.createElement("div");
    header.className = "file-trash-header";
    const title = document.createElement("h2");
    title.textContent = "Trash";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "btn btn-secondary";
    close.textContent = "Close";
    close.setAttribute("aria-label", "Close Trash");
    close.addEventListener("click", () => this.closeTrash());
    header.appendChild(title);
    header.appendChild(close);
    const location = document.createElement("p");
    location.className = "file-name-dialog-location";
    const policy = document.createElement("p");
    policy.textContent =
      "Restore items until they are permanently deleted. Older items are cleaned up when you next delete a file.";
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    const error = document.createElement("p");
    error.className = "file-name-dialog-error";
    error.setAttribute("role", "alert");
    const list = document.createElement("ul");
    list.className = "file-trash-list";
    for (const child of [header, location, policy, status, error, list])
      dialog.appendChild(child);
    Object.assign(state, {
      dialog,
      location,
      statusEl: status,
      errorEl: error,
      listEl: list,
      closeButton: close,
    });
    dialog.addEventListener("keydown", (event) => event.stopPropagation());
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.closeTrash();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) this.closeTrash();
    });
    document.body.appendChild(dialog);
    this.renderTrashDialog(state);
    dialog.showModal();
    close.focus();
  }

  closeTrash({ restoreFocus = true } = {}) {
    const state = this.trashDialog;
    if (!state) return;
    this.trashDialog = null;
    const active =
      typeof document !== "undefined" ? document.activeElement : null;
    const heldFocus = state.dialog?.contains?.(active);
    state.dialog?.close();
    state.dialog?.remove();
    if (restoreFocus && heldFocus && state.opener?.isConnected)
      state.opener.focus({ preventScroll: true });
  }

  renderTrashDialog(state) {
    if (!this.isTrashDialogCurrent(state) || !state.dialog) return;
    state.location.textContent = state.root || state.context.path;
    state.statusEl.textContent =
      state.message ||
      (!state.loading && !state.error && state.items.length === 0
        ? "Trash is empty."
        : "");
    state.errorEl.textContent = state.error;
    const active = document.activeElement;
    const focus = state.listEl.contains(active)
      ? { id: active.dataset.trashId, action: active.dataset.trashAction }
      : null;
    state.listEl.innerHTML = "";
    for (const item of state.items) {
      const row = document.createElement("li");
      row.dataset.trashId = item.id;
      const name = document.createElement("strong");
      name.textContent = item.originalRelPath;
      const detail = document.createElement("span");
      detail.className = "file-trash-detail";
      const deletedAt = new Date(item.deletedAt);
      const expiresAt = new Date(item.expiresAt);
      const cleanupDate = Number.isNaN(expiresAt.getTime())
        ? "Cleanup date unavailable"
        : `Eligible for cleanup from ${expiresAt.toLocaleString()}`;
      detail.textContent = `Deleted ${Number.isNaN(deletedAt.getTime()) ? "recently" : deletedAt.toLocaleString()} · ${cleanupDate}`;
      const actions = document.createElement("div");
      actions.className = "file-trash-actions";
      for (const [operation, label] of [
        ["restore", "Restore"],
        ["purge", "Delete permanently"],
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = operation === "purge" ? "btn danger" : "btn";
        button.textContent = label;
        button.setAttribute("aria-label", `${label} ${item.originalRelPath}`);
        button.dataset.trashId = item.id;
        button.dataset.trashAction = operation;
        // Keep the current action focusable while the request runs; the shared
        // handler rejects duplicate actions and aria-disabled announces why.
        button.setAttribute(
          "aria-disabled",
          String(
            state.busy ||
              state.loading ||
              this.pendingTrashMutations.has(
                JSON.stringify([state.root, item.id]),
              ),
          ),
        );
        button.addEventListener(
          "click",
          () => void this.mutateTrashItem(operation, item, state),
        );
        actions.appendChild(button);
      }
      for (const child of [name, detail, actions]) row.appendChild(child);
      state.listEl.appendChild(row);
    }
    if (focus) {
      const buttons = Array.from(state.listEl.querySelectorAll("button"));
      const target = buttons.find(
        (button) =>
          button.dataset.trashId === focus.id &&
          button.dataset.trashAction === focus.action,
      );
      (target || buttons[0] || state.closeButton).focus();
    }
  }

  async mutateTrashItem(operation, item, state = this.trashDialog) {
    if (
      !state ||
      !this.isTrashDialogCurrent(state) ||
      state.busy ||
      state.loading ||
      !state.root ||
      this.pendingTrashMutations.has(JSON.stringify([state.root, item.id])) ||
      !["restore", "purge"].includes(operation)
    )
      return false;
    if (
      operation === "purge" &&
      !this.confirmImpl(
        `Permanently delete ${item.originalRelPath}?\nThis cannot be undone.`,
      )
    )
      return false;
    state.busy = true;
    state.error = "";
    state.message =
      operation === "restore" ? "Restoring…" : "Deleting permanently…";
    this.renderTrashDialog(state);
    try {
      await this.requestTrashMutation(operation, state.root, item.id);
      if (!this.isFileLocationCurrent(state.context)) return false;
      if (operation === "restore")
        await this.loadDir(state.context.path, state.context.workspaceId);
      if (!this.isFileLocationCurrent(state.context)) return false;
      if (!this.isTrashDialogCurrent(state)) return true;
      state.items = state.items.filter((entry) => entry.id !== item.id);
      state.busy = false;
      state.message =
        operation === "restore"
          ? "Item restored."
          : "Item permanently deleted.";
      this.renderTrashDialog(state);
      return true;
    } catch (err) {
      if (this.isTrashDialogCurrent(state)) {
        state.busy = false;
        state.message = "";
        state.error =
          err instanceof Error ? err.message : "The operation failed.";
        this.renderTrashDialog(state);
      }
      return false;
    }
  }

  async requestItemName(title, promptLabel, initialValue = "", directory = "") {
    if (this.promptImpl) return this.promptImpl(promptLabel, initialValue);
    if (typeof document === "undefined" || !document.body) {
      return getDefaultPromptImpl()(promptLabel, initialValue);
    }
    const dialog = document.createElement("dialog");
    if (typeof dialog.showModal !== "function") {
      return getDefaultPromptImpl()(promptLabel, initialValue);
    }
    this.cancelNameDialog?.();
    const previouslyFocused = document.activeElement;
    dialog.className = "file-name-dialog";
    dialog.setAttribute("aria-label", title);
    const form = document.createElement("form");
    const heading = document.createElement("h2");
    heading.textContent = title;
    const location = document.createElement("p");
    location.className = "file-name-dialog-location";
    location.textContent = directory;
    const label = document.createElement("label");
    label.textContent = promptLabel;
    const input = document.createElement("input");
    input.type = "text";
    input.name = "name";
    input.required = true;
    input.value = initialValue;
    input.autocomplete = "off";
    input.spellcheck = false;
    label.appendChild(input);
    const error = document.createElement("p");
    error.className = "file-name-dialog-error";
    error.setAttribute("role", "alert");
    const actions = document.createElement("div");
    actions.className = "file-name-dialog-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "primary";
    submit.textContent = initialValue ? "Rename" : "Create";
    actions.appendChild(cancel);
    actions.appendChild(submit);
    for (const child of [heading, location, label, error, actions])
      form.appendChild(child);
    dialog.appendChild(form);
    document.body.appendChild(dialog);
    return new Promise((resolveName) => {
      let finished = false;
      const finish = (value) => {
        if (finished) return;
        finished = true;
        this.cancelNameDialog = null;
        dialog.close();
        dialog.remove();
        if (previouslyFocused?.isConnected) previouslyFocused.focus();
        resolveName(value);
      };
      this.cancelNameDialog = () => finish(null);
      cancel.addEventListener("click", () => finish(null));
      dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        finish(null);
      });
      dialog.addEventListener("keydown", (event) => {
        // Keep modal keystrokes out of shell shortcuts and surface handlers.
        event.stopPropagation();
      });
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const value = input.value.trim();
        if (
          !value ||
          value === "." ||
          value === ".." ||
          /[\\/\0]/.test(value)
        ) {
          error.textContent =
            "Enter a name without slashes. Choose the destination folder before creating or renaming.";
          input.setAttribute("aria-invalid", "true");
          input.focus();
          return;
        }
        finish(value);
      });
      dialog.showModal();
      input.focus();
      input.select();
    });
  }

  async createFolder(
    path = null,
    folderName = null,
    workspaceId = this.currentWorkspaceId,
  ) {
    if (this.disposed) return false;
    const normalizedWorkspaceId = String(workspaceId || "").trim();
    const basePath =
      normalizeExplorerPath(path) ||
      this.getWorkspacePath(normalizedWorkspaceId);
    if (!this.fetchImpl || !basePath) return false;

    const nextFolderName =
      typeof folderName === "string" ? folderName.trim() : "";
    const resolvedFolderName =
      nextFolderName ||
      String(
        (await this.requestItemName(
          "New folder",
          "Folder name:",
          "",
          basePath,
        )) || "",
      ).trim();

    if (this.disposed || !resolvedFolderName) return false;

    try {
      const targetPath = joinExplorerPath(basePath, resolvedFolderName);
      const res = await this.fetchImpl(
        `/api/files/mkdir?path=${encodeURIComponent(targetPath)}`,
        { method: "POST" },
      );
      const payload = await res.json().catch(() => ({}));
      // Disposed mid-mkdir: skip the follow-up reload of the now-null store.
      if (this.disposed) return false;
      if (!res.ok) {
        this.alertImpl(explainApiError(payload, "Failed"));
        return false;
      }

      if (normalizedWorkspaceId) {
        await this.loadDir(basePath, normalizedWorkspaceId);
      }
      return true;
    } catch (err) {
      this.alertImpl(`Failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  async handleUpload(event) {
    const files = event?.target?.files;
    if (files?.length) {
      await this.uploadFiles(files);
    }
    if (event?.target) {
      event.target.value = "";
    }
  }

  async uploadFiles(files, path = null, workspaceId = this.currentWorkspaceId) {
    const normalizedWorkspaceId = String(workspaceId || "").trim();
    const basePath =
      normalizeExplorerPath(path) ||
      this.getWorkspacePath(normalizedWorkspaceId);
    if (
      !this.fetchImpl ||
      !basePath ||
      !normalizedWorkspaceId ||
      !files?.length
    ) {
      return false;
    }

    for (const file of Array.from(files)) {
      const formData = new FormData();
      formData.append("file", file);

      try {
        const res = await this.fetchImpl(
          `/api/files/upload?path=${encodeURIComponent(basePath)}`,
          { method: "POST", body: formData },
        );
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
          this.alertImpl(explainApiError(payload, "Upload failed"));
          return false;
        }
      } catch (err) {
        this.alertImpl(
          `Upload failed: ${err instanceof Error ? err.message : err}`,
        );
        return false;
      }
    }

    // Disposed mid-upload: loadDir() itself guards, but skip kicking it off.
    if (this.disposed) return false;
    await this.loadDir(basePath, normalizedWorkspaceId);
    return true;
  }

  // Create a new empty file in the current directory. Mirrors createFolder().
  async createFile(
    path = null,
    fileName = null,
    workspaceId = this.currentWorkspaceId,
  ) {
    if (this.disposed) return false;
    const normalizedWorkspaceId = String(workspaceId || "").trim();
    const basePath =
      normalizeExplorerPath(path) ||
      this.getWorkspacePath(normalizedWorkspaceId);
    if (!this.fetchImpl || !basePath) return false;

    const nextFileName = typeof fileName === "string" ? fileName.trim() : "";
    const resolvedFileName =
      nextFileName ||
      String(
        (await this.requestItemName("New file", "File name:", "", basePath)) ||
          "",
      ).trim();

    if (this.disposed || !resolvedFileName) return false;

    try {
      const targetPath = joinExplorerPath(basePath, resolvedFileName);
      const res = await this.fetchImpl("/api/files/content", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: targetPath,
          content: "",
          createOnly: true,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      // Disposed mid-create: skip the follow-up reload of the now-null store.
      if (this.disposed) return false;
      if (!res.ok) {
        this.alertImpl(explainApiError(payload, "Failed to create file"));
        return false;
      }

      if (normalizedWorkspaceId) {
        await this.loadDir(basePath, normalizedWorkspaceId);
      }
      return true;
    } catch (err) {
      this.alertImpl(`Failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  // Rename/move a file or folder item within the same directory.
  async renameItem(item, workspaceId = this.currentWorkspaceId) {
    if (this.disposed) return false;
    const normalizedWorkspaceId = String(workspaceId || "").trim();
    if (!this.fetchImpl || !item?.path || !item?.name) return false;

    // Build the target path in the same directory as the source.
    const dirPath = item.path.split("/").slice(0, -1).join("/") || "/";
    const newName = String(
      (await this.requestItemName(
        "Rename item",
        "Rename to:",
        item.name,
        dirPath,
      )) || "",
    ).trim();
    if (this.disposed || !newName || newName === item.name) return false;
    const toPath = joinExplorerPath(dirPath, newName);

    try {
      const res = await this.fetchImpl("/api/files/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: item.path, to: toPath }),
      });
      const payload = await res.json().catch(() => ({}));
      if (this.disposed) return false;
      if (!res.ok) {
        this.alertImpl(explainApiError(payload, "Failed to rename"));
        return false;
      }

      const basePath = this.getWorkspacePath(normalizedWorkspaceId) || dirPath;
      if (normalizedWorkspaceId) {
        await this.loadDir(basePath, normalizedWorkspaceId);
      }
      return true;
    } catch (err) {
      this.alertImpl(`Failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }
}

const FileExplorerModule = {
  FILE_EXPLORER_MOBILE_BREAKPOINT,
  FileExplorerController,
  resolveFileExplorerMode,
  breadcrumbSegments,
};

if (typeof window !== "undefined") {
  window.FileExplorerController = FileExplorerModule;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = FileExplorerModule;
}

if (typeof exports !== "undefined") {
  exports.FILE_EXPLORER_MOBILE_BREAKPOINT = FILE_EXPLORER_MOBILE_BREAKPOINT;
  exports.FileExplorerController = FileExplorerController;
  exports.resolveFileExplorerMode = resolveFileExplorerMode;
  exports.breadcrumbSegments = breadcrumbSegments;
}
