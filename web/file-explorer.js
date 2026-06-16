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

function cloneSelection(item) {
  if (!item || typeof item !== "object") return null;
  return { ...item };
}

function cloneItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) =>
    item && typeof item === "object" ? { ...item } : item,
  );
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
  } = {}) {
    this.root =
      root ||
      (typeof document !== "undefined"
        ? document.getElementById("file-explorer")
        : null);
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

    this.isOpen = false;
    this.mode = resolveFileExplorerMode(this.viewport, this.breakpoint);
    this.currentWorkspaceId = null;
    this.currentPathByWorkspace = new Map();
    this.selectedItemByWorkspace = new Map();
    this.itemsByWorkspace = new Map();
    this.pendingLoadByWorkspace = new Map();
    this.loading = false;
    this.error = null;
    this.dragActive = false;
    this.loadSequence = 0;
    this.decorationsByWorkspace = new Map();

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

    this.handleClose = this.close.bind(this);
    this.handleBackdropClick = this.handleBackdropClick.bind(this);
    this.handleUpload = this.handleUpload.bind(this);
    this.handleDragOver = this.handleDragOver.bind(this);
    this.handleDragLeave = this.handleDragLeave.bind(this);
    this.handleDropEvent = this.handleDropEvent.bind(this);

    this.bindDom();
    this.syncDom();
  }

  get currentPath() {
    if (!this.currentWorkspaceId) return null;
    return this.getWorkspacePath(this.currentWorkspaceId);
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
    this.uploadBtnEl?.addEventListener("click", () =>
      this.uploadInputEl?.click(),
    );
    this.uploadInputEl?.addEventListener("change", this.handleUpload);
    this.mkdirBtnEl?.addEventListener("click", () => void this.createFolder());
    this.refreshBtnEl?.addEventListener("click", () => {
      if (!this.currentPath) return;
      void this.loadDir(this.currentPath);
    });

    const dropTarget = this.shellEl || this.root;
    dropTarget?.addEventListener("dragover", this.handleDragOver);
    dropTarget?.addEventListener("dragleave", this.handleDragLeave);
    dropTarget?.addEventListener("drop", this.handleDropEvent);
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
      decorations: workspaceId
        ? this.decorationsByWorkspace.get(workspaceId) || {}
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
      editBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        this.onOpenFile(item.path);
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
    });

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

    this.currentPathByWorkspace.set(normalizedWorkspaceId, rememberedPath);
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

    this.currentPathByWorkspace.set(normalizedWorkspaceId, normalizedPath);
    if (normalizedWorkspaceId === this.currentWorkspaceId) {
      this.render();
    }
    return normalizedPath;
  }

  getWorkspacePath(workspaceId) {
    const normalizedWorkspaceId = String(workspaceId || "").trim();
    if (!normalizedWorkspaceId) return null;
    return this.currentPathByWorkspace.get(normalizedWorkspaceId) || null;
  }

  setSelectedItem(workspaceId, item) {
    const normalizedWorkspaceId = String(workspaceId || "").trim();
    if (!normalizedWorkspaceId) return null;

    const nextSelection = cloneSelection(item);
    if (nextSelection) {
      this.selectedItemByWorkspace.set(normalizedWorkspaceId, nextSelection);
    } else {
      this.selectedItemByWorkspace.delete(normalizedWorkspaceId);
    }

    if (normalizedWorkspaceId === this.currentWorkspaceId) {
      this.renderList();
    }
    return nextSelection;
  }

  getSelectedItem(workspaceId) {
    const normalizedWorkspaceId = String(workspaceId || "").trim();
    if (!normalizedWorkspaceId) return null;
    return cloneSelection(
      this.selectedItemByWorkspace.get(normalizedWorkspaceId),
    );
  }

  setWorkspaceItems(workspaceId, items) {
    const normalizedWorkspaceId = String(workspaceId || "").trim();
    if (!normalizedWorkspaceId) return [];

    const nextItems = cloneItems(items);
    this.itemsByWorkspace.set(normalizedWorkspaceId, nextItems);

    if (normalizedWorkspaceId === this.currentWorkspaceId) {
      this.renderList();
    }
    return nextItems;
  }

  getWorkspaceItems(workspaceId) {
    const normalizedWorkspaceId = String(workspaceId || "").trim();
    if (!normalizedWorkspaceId) return [];
    return cloneItems(this.itemsByWorkspace.get(normalizedWorkspaceId));
  }

  // Git status decorations keyed by absolute item path. Re-renders the list
  // when set for the active workspace so badges/colors appear immediately.
  setDecorations(workspaceId, decorations) {
    const normalizedWorkspaceId = String(workspaceId || "").trim();
    if (!normalizedWorkspaceId) return null;

    const next =
      decorations && typeof decorations === "object" ? { ...decorations } : {};
    this.decorationsByWorkspace.set(normalizedWorkspaceId, next);

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
      this.currentPathByWorkspace.set(normalizedWorkspaceId, nextPath);
      this.setLoading(true);
      this.setError(null);
      this.render();
    } else {
      this.currentPathByWorkspace.set(normalizedWorkspaceId, nextPath);
    }

    try {
      const res = await this.fetchImpl(
        `/api/browse?path=${encodeURIComponent(nextPath)}&files=true`,
      );
      const data = await res.json().catch(() => ({}));
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

      this.currentPathByWorkspace.set(normalizedWorkspaceId, resolvedPath);
      this.itemsByWorkspace.set(normalizedWorkspaceId, items);
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
