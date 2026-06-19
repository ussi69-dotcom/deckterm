// File-tree model store for the explorer (IDE shell phase 5, slice 1).
//
// Holds the explorer's data/model independent of any DOM: which workspace is
// active, the open/mode/loading/error/drag flags, and per-workspace path,
// selection, directory items, and git-status decorations. Because the model
// lives here rather than on a DOM-bound controller instance, an unmount() +
// mount(newContainer) can re-render the same UI from the store.
//
// DOM-free + an onChange(listener) => unsubscribe mechanism, mirroring
// web/git-status-store.js so it works in both the browser and bun:test.

function normalizeWorkspaceId(workspaceId) {
  return String(workspaceId || "").trim();
}

function normalizePath(value) {
  const next = String(value || "").trim();
  return next || null;
}

function cloneSelectionValue(item) {
  if (!item || typeof item !== "object") return null;
  return { ...item };
}

function cloneItemsValue(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) =>
    item && typeof item === "object" ? { ...item } : item,
  );
}

class FileTreeStore {
  constructor() {
    // Global (active-view) flags.
    this.currentWorkspaceId = null;
    this.isOpen = false;
    this.mode = "docked";
    this.loading = false;
    this.error = null;
    this.dragActive = false;

    // Per-workspace model.
    this.pathByWorkspace = new Map();
    this.selectedItemByWorkspace = new Map();
    this.itemsByWorkspace = new Map();
    this.decorationsByWorkspace = new Map();

    this.listeners = new Set();
  }

  // Register a change listener (store) => void. Returns an unsubscribe. Emitted
  // after any mutation so a view can re-render from the current model.
  onChange(listener) {
    if (typeof listener !== "function") return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _emit() {
    for (const listener of this.listeners) {
      try {
        listener(this);
      } catch {
        // Listener failures must not break the store.
      }
    }
  }

  setCurrentWorkspaceId(workspaceId) {
    this.currentWorkspaceId = normalizeWorkspaceId(workspaceId) || null;
    this._emit();
    return this.currentWorkspaceId;
  }

  setOpen(isOpen) {
    this.isOpen = Boolean(isOpen);
    this._emit();
    return this.isOpen;
  }

  setMode(mode) {
    this.mode = mode === "overlay" ? "overlay" : "docked";
    this._emit();
    return this.mode;
  }

  setLoading(loading) {
    this.loading = Boolean(loading);
    this._emit();
    return this.loading;
  }

  setError(error) {
    this.error = error ? String(error) : null;
    this._emit();
    return this.error;
  }

  setDragActive(dragActive) {
    this.dragActive = Boolean(dragActive);
    this._emit();
    return this.dragActive;
  }

  setWorkspacePath(workspaceId, path) {
    const id = normalizeWorkspaceId(workspaceId);
    const nextPath = normalizePath(path);
    if (!id || !nextPath) return null;
    this.pathByWorkspace.set(id, nextPath);
    this._emit();
    return nextPath;
  }

  getWorkspacePath(workspaceId) {
    const id = normalizeWorkspaceId(workspaceId);
    if (!id) return null;
    return this.pathByWorkspace.get(id) || null;
  }

  setSelectedItem(workspaceId, item) {
    const id = normalizeWorkspaceId(workspaceId);
    if (!id) return null;
    const next = cloneSelectionValue(item);
    if (next) this.selectedItemByWorkspace.set(id, next);
    else this.selectedItemByWorkspace.delete(id);
    this._emit();
    return next;
  }

  getSelectedItem(workspaceId) {
    const id = normalizeWorkspaceId(workspaceId);
    if (!id) return null;
    return cloneSelectionValue(this.selectedItemByWorkspace.get(id));
  }

  setWorkspaceItems(workspaceId, items) {
    const id = normalizeWorkspaceId(workspaceId);
    if (!id) return [];
    const next = cloneItemsValue(items);
    this.itemsByWorkspace.set(id, next);
    this._emit();
    return next;
  }

  getWorkspaceItems(workspaceId) {
    const id = normalizeWorkspaceId(workspaceId);
    if (!id) return [];
    return cloneItemsValue(this.itemsByWorkspace.get(id));
  }

  setDecorations(workspaceId, decorations) {
    const id = normalizeWorkspaceId(workspaceId);
    if (!id) return null;
    const next =
      decorations && typeof decorations === "object" ? { ...decorations } : {};
    this.decorationsByWorkspace.set(id, next);
    this._emit();
    return next;
  }

  getDecorations(workspaceId) {
    const id = normalizeWorkspaceId(workspaceId);
    if (!id) return {};
    return { ...(this.decorationsByWorkspace.get(id) || {}) };
  }
}

const FileTreeStoreModule = { FileTreeStore };

if (typeof window !== "undefined") {
  window.FileTreeStore = FileTreeStoreModule;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = FileTreeStoreModule;
}

if (typeof exports !== "undefined") {
  exports.FileTreeStore = FileTreeStore;
}
