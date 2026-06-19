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

function formatFileSize(bytes) {
  const nextBytes = Number(bytes);
  if (!Number.isFinite(nextBytes) || nextBytes <= 0) return "";
  if (nextBytes < 1024) return `${nextBytes} B`;
  if (nextBytes < 1024 * 1024) return `${(nextBytes / 1024).toFixed(1)} KB`;
  return `${(nextBytes / (1024 * 1024)).toFixed(1)} MB`;
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
    this.promptImpl = promptImpl || getDefaultPromptImpl();
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
    this.refreshBtnEl = null;
    this.closeButtons = [];
    this.dropTargetEl = null;
    this._boundUploadClick = null;
    this._boundMkdirClick = null;
    this._boundRefreshClick = null;

    this.handleClose = this.close.bind(this);
    this.handleBackdropClick = this.handleBackdropClick.bind(this);
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
    this.refreshBtnEl = this.root.querySelector("#file-explorer-refresh-btn");

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

    // Hold references to the per-mount closures so unmount() can detach them.
    this._boundUploadClick = () => this.uploadInputEl?.click();
    this._boundMkdirClick = () => void this.createFolder();
    this._boundRefreshClick = () => {
      if (!this.currentPath) return;
      void this.loadDir(this.currentPath);
    };

    this.uploadBtnEl?.addEventListener("click", this._boundUploadClick);
    this.uploadInputEl?.addEventListener("change", this.handleUpload);
    this.mkdirBtnEl?.addEventListener("click", this._boundMkdirClick);
    this.refreshBtnEl?.addEventListener("click", this._boundRefreshClick);

    this.dropTargetEl = this.shellEl || this.root;
    this.dropTargetEl?.addEventListener("dragover", this.handleDragOver);
    this.dropTargetEl?.addEventListener("dragleave", this.handleDragLeave);
    this.dropTargetEl?.addEventListener("drop", this.handleDropEvent);
  }

  // Detach every listener bindDom() attached and drop cached DOM handles, so an
  // unmounted view leaks nothing and a later mount() can rebind cleanly.
  unbindDom() {
    this.closeButtons.forEach((button) => {
      button.removeEventListener?.("click", this.handleClose);
    });
    this.backdropEl?.removeEventListener?.("click", this.handleBackdropClick);
    if (this._boundUploadClick) {
      this.uploadBtnEl?.removeEventListener?.("click", this._boundUploadClick);
    }
    this.uploadInputEl?.removeEventListener?.("change", this.handleUpload);
    if (this._boundMkdirClick) {
      this.mkdirBtnEl?.removeEventListener?.("click", this._boundMkdirClick);
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
    this.refreshBtnEl = null;
    this.closeButtons = [];
    this.dropTargetEl = null;
    this._boundUploadClick = null;
    this._boundMkdirClick = null;
    this._boundRefreshClick = null;
  }

  handleBackdropClick(event) {
    if (event.target === this.backdropEl) {
      this.close();
    }
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
      selectedItem: workspaceId ? this.getSelectedItem(workspaceId) : null,
      items: workspaceId ? this.getWorkspaceItems(workspaceId) : [],
      decorations: workspaceId ? this.store.getDecorations(workspaceId) : {},
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
  }

  renderBreadcrumb() {
    const snapshot = this.buildSnapshot();

    if (this.breadcrumbEl) {
      this.breadcrumbEl.innerHTML = "";

      if (!snapshot.path) {
        const placeholder = document.createElement("span");
        placeholder.textContent = "Open Files to browse the current workspace.";
        this.breadcrumbEl.appendChild(placeholder);
      } else {
        const parts = snapshot.path.split("/").filter(Boolean);
        const rootLink = document.createElement("a");
        rootLink.textContent = "/";
        rootLink.dataset.path = "/";
        rootLink.addEventListener("click", () => void this.loadDir("/"));
        this.breadcrumbEl.appendChild(rootLink);

        let currentPath = "";
        parts.forEach((part) => {
          currentPath += `/${part}`;

          const separator = document.createTextNode(" / ");
          const link = document.createElement("a");
          link.textContent = part;
          link.dataset.path = currentPath;
          link.addEventListener("click", () => void this.loadDir(currentPath));

          this.breadcrumbEl.appendChild(separator);
          this.breadcrumbEl.appendChild(link);
        });
      }
    }

    this.renderers.breadcrumb?.(snapshot);
  }

  renderList() {
    const snapshot = this.buildSnapshot();

    if (this.listEl?.dataset) {
      this.listEl.dataset.workspaceId = snapshot.workspaceId || "";
      this.listEl.dataset.path = snapshot.path || "";
    }

    if (this.listEl) {
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
        snapshot.items.forEach((item) => {
          this.listEl.appendChild(this.createItemElement(item, snapshot));
        });
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

    const iconEl = document.createElement("span");
    iconEl.className = "file-icon";
    iconEl.textContent = getItemIcon(item);

    const nameEl = document.createElement("span");
    nameEl.className = "file-name";
    nameEl.textContent = item.name;

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
    el.appendChild(sizeEl);
    el.appendChild(actionsEl);

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

  openForWorkspace(workspaceId, cwd = "", mode = null) {
    const normalizedWorkspaceId = String(workspaceId || "").trim();
    if (!normalizedWorkspaceId) return null;

    this.currentWorkspaceId = normalizedWorkspaceId;
    this.isOpen = true;
    this.mode = this.resolveMode(mode);

    const rememberedPath =
      this.getWorkspacePath(normalizedWorkspaceId) ||
      normalizeExplorerPath(cwd) ||
      "/";

    this.store.setWorkspacePath(normalizedWorkspaceId, rememberedPath);
    this.render();
    return rememberedPath;
  }

  close() {
    this.isOpen = false;
    this.dragActive = false;
    this.render();
  }

  setWorkspacePath(workspaceId, path) {
    const normalizedWorkspaceId = String(workspaceId || "").trim();
    const normalizedPath = normalizeExplorerPath(path);
    if (!normalizedWorkspaceId || !normalizedPath) return null;

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

  // Git status decorations keyed by absolute item path. Re-renders the list
  // when set for the active workspace so badges/colors appear immediately.
  setDecorations(workspaceId, decorations) {
    const normalizedWorkspaceId = String(workspaceId || "").trim();
    if (!normalizedWorkspaceId) return null;

    const next = this.store.setDecorations(normalizedWorkspaceId, decorations);

    if (normalizedWorkspaceId === this.currentWorkspaceId) {
      this.renderList();
    }
    return next;
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

  async deleteItem(path, isDir = false, workspaceId = this.currentWorkspaceId) {
    const targetPath = normalizeExplorerPath(path);
    const normalizedWorkspaceId = String(workspaceId || "").trim();
    if (!this.fetchImpl || !targetPath || !normalizedWorkspaceId) return false;

    const shouldDelete = this.confirmImpl(
      `Delete ${isDir ? "folder" : "file"}?\n${targetPath}`,
    );
    if (!shouldDelete) return false;

    try {
      const res = await this.fetchImpl(
        `/api/files?path=${encodeURIComponent(targetPath)}`,
        { method: "DELETE" },
      );
      const payload = await res.json().catch(() => ({}));
      // Disposed mid-delete: store/DOM are gone — stop before touching them.
      if (this.disposed) return false;
      if (!res.ok) {
        this.alertImpl(explainApiError(payload, "Failed to delete"));
        return false;
      }

      const selectedItem = this.getSelectedItem(normalizedWorkspaceId);
      if (selectedItem?.path === targetPath) {
        this.setSelectedItem(normalizedWorkspaceId, null);
      }

      await this.loadDir(
        this.getWorkspacePath(normalizedWorkspaceId) || "/",
        normalizedWorkspaceId,
      );
      return true;
    } catch (err) {
      this.alertImpl(`Failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  async createFolder(
    path = null,
    folderName = null,
    workspaceId = this.currentWorkspaceId,
  ) {
    const normalizedWorkspaceId = String(workspaceId || "").trim();
    const basePath =
      normalizeExplorerPath(path) ||
      this.getWorkspacePath(normalizedWorkspaceId);
    if (!this.fetchImpl || !basePath) return false;

    const nextFolderName =
      typeof folderName === "string" ? folderName.trim() : "";
    const resolvedFolderName =
      nextFolderName || String(this.promptImpl("Folder name:") || "").trim();

    if (!resolvedFolderName) return false;

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
}

const FileExplorerModule = {
  FILE_EXPLORER_MOBILE_BREAKPOINT,
  FileExplorerController,
  resolveFileExplorerMode,
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
}
