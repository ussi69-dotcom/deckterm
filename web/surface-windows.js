// Content-agnostic floating windows for workspace surfaces (Files, Git,
// Tasks, Editor). Gives every surface the chrome terminals already have via
// TileManager — title-bar drag, 8-edge resize, edge/half/quadrant snapping,
// z-order — without TileManager's neighbor-pushing tiling semantics, which
// only make sense for terminals.
//
// Coordinates are percentages of the windowing layer (the manager's
// container), so windows keep their relative place when the layer shrinks —
// e.g. when the sessions area is docked to the bottom.
//
// Pure geometry helpers are exported for bun tests; the DOM classes are only
// exercised in the browser (Playwright covers them).

const SURFACE_WINDOW_DEFAULT_MIN_WIDTH_PX = 320;
const SURFACE_WINDOW_DEFAULT_MIN_HEIGHT_PX = 240;
const SURFACE_WINDOW_SNAP_THRESHOLD_PCT = 4;
const SURFACE_WINDOW_LAYOUT_SETTINGS_KEY = "windows.layout";

const SNAP_ZONE_BOUNDS = Object.freeze({
  left: Object.freeze({ x: 0, y: 0, width: 50, height: 100 }),
  right: Object.freeze({ x: 50, y: 0, width: 50, height: 100 }),
  top: Object.freeze({ x: 0, y: 0, width: 100, height: 100 }),
  bottom: Object.freeze({ x: 0, y: 50, width: 100, height: 50 }),
  "top-left": Object.freeze({ x: 0, y: 0, width: 50, height: 50 }),
  "top-right": Object.freeze({ x: 50, y: 0, width: 50, height: 50 }),
  "bottom-left": Object.freeze({ x: 0, y: 50, width: 50, height: 50 }),
  "bottom-right": Object.freeze({ x: 50, y: 50, width: 50, height: 50 }),
});

function normalizeWindowBounds(
  bounds,
  { minWidthPct = 10, minHeightPct = 10 } = {},
) {
  const width = Math.max(minWidthPct, Math.min(100, Number(bounds.width) || 0));
  const height = Math.max(
    minHeightPct,
    Math.min(100, Number(bounds.height) || 0),
  );
  const x = Math.max(0, Math.min(100 - width, Number(bounds.x) || 0));
  const y = Math.max(0, Math.min(100 - height, Number(bounds.y) || 0));
  return { x, y, width, height };
}

function computeSnapZone(
  pointer,
  thresholdPct = SURFACE_WINDOW_SNAP_THRESHOLD_PCT,
) {
  const x = Number(pointer?.x);
  const y = Number(pointer?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  const nearLeft = x < thresholdPct;
  const nearRight = x > 100 - thresholdPct;
  const nearTop = y < thresholdPct;
  const nearBottom = y > 100 - thresholdPct;

  if (nearTop && nearLeft) return "top-left";
  if (nearTop && nearRight) return "top-right";
  if (nearBottom && nearLeft) return "bottom-left";
  if (nearBottom && nearRight) return "bottom-right";
  if (nearLeft) return "left";
  if (nearRight) return "right";
  if (nearTop) return "top";
  if (nearBottom) return "bottom";
  return null;
}

function boundsForSnapZone(zone) {
  const bounds = SNAP_ZONE_BOUNDS[zone];
  return bounds ? { ...bounds } : null;
}

function isValidBoundsValue(value) {
  return Number.isFinite(Number(value));
}

function serializeWindowLayout(layout) {
  const result = {};
  for (const [id, entry] of Object.entries(layout || {})) {
    if (!entry || typeof entry !== "object") continue;
    result[id] = {
      x: entry.x,
      y: entry.y,
      width: entry.width,
      height: entry.height,
      snapZone: entry.snapZone || null,
    };
  }
  return result;
}

function deserializeWindowLayout(value) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const layout = {};
  for (const [id, entry] of Object.entries(parsed)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (
      !isValidBoundsValue(entry.x) ||
      !isValidBoundsValue(entry.y) ||
      !isValidBoundsValue(entry.width) ||
      !isValidBoundsValue(entry.height)
    ) {
      continue;
    }
    layout[id] = {
      x: Number(entry.x),
      y: Number(entry.y),
      width: Number(entry.width),
      height: Number(entry.height),
      snapZone: SNAP_ZONE_BOUNDS[entry.snapZone] ? entry.snapZone : null,
    };
  }
  return layout;
}

// --- Sessions bottom dock (VS Code panel semantics) ------------------------

const DOCK_DEFAULT_HEIGHT_PCT = 35;
const DOCK_MIN_HEIGHT_PCT = 15;
const DOCK_MAX_HEIGHT_PCT = 75;

function clampDockHeight(pct) {
  const value = Number(pct);
  if (!Number.isFinite(value)) return DOCK_DEFAULT_HEIGHT_PCT;
  return Math.max(DOCK_MIN_HEIGHT_PCT, Math.min(DOCK_MAX_HEIGHT_PCT, value));
}

function dockStateFromSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { enabled: false, heightPct: DOCK_DEFAULT_HEIGHT_PCT };
  }
  return {
    enabled: Boolean(value.enabled),
    heightPct: clampDockHeight(value.heightPct),
  };
}

// ---------------------------------------------------------------------------
// DOM classes (browser only)
// ---------------------------------------------------------------------------

class SurfaceWindow {
  constructor({
    id,
    title,
    icon = "",
    contentEl,
    manager,
    bounds,
    minWidthPx = SURFACE_WINDOW_DEFAULT_MIN_WIDTH_PX,
    minHeightPx = SURFACE_WINDOW_DEFAULT_MIN_HEIGHT_PX,
    onClose = null,
  }) {
    this.id = id;
    this.manager = manager;
    this.minWidthPx = minWidthPx;
    this.minHeightPx = minHeightPx;
    this.onClose = onClose;
    this.bounds = { x: 20, y: 10, width: 60, height: 75, ...bounds };
    this.snapZone = this.bounds.snapZone || null;
    this.restoreBounds = null;
    this.isOpen = false;

    this.dragState = null;
    this.resizeState = null;

    this.element = document.createElement("section");
    this.element.className = "surface-window hidden";
    this.element.dataset.windowId = id;
    this.element.setAttribute("role", "dialog");
    this.element.setAttribute("aria-label", title);

    this.titlebarEl = document.createElement("header");
    this.titlebarEl.className = "surface-window-titlebar";
    // Static template; icon and title are injected via textContent below.
    this.titlebarEl.innerHTML = `
      <span class="surface-window-icon"></span>
      <span class="surface-window-title"></span>
      <span class="surface-window-actions">
        <button class="surface-window-btn surface-window-maximize" title="Maximize / restore">⛶</button>
        <button class="surface-window-btn surface-window-close" title="Close">×</button>
      </span>
    `;
    this.titlebarEl.querySelector(".surface-window-icon").textContent = icon;
    this.titlebarEl.querySelector(".surface-window-title").textContent = title;

    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "surface-window-body";
    if (contentEl) this.bodyEl.appendChild(contentEl);

    this.element.appendChild(this.titlebarEl);
    this.element.appendChild(this.bodyEl);
    this.createResizeHandles();
    this.bindEvents();
  }

  setTitle(title) {
    const el = this.titlebarEl.querySelector(".surface-window-title");
    if (el) el.textContent = title;
  }

  createResizeHandles() {
    const edges = [
      "top",
      "right",
      "bottom",
      "left",
      "top-left",
      "top-right",
      "bottom-left",
      "bottom-right",
    ];
    for (const edge of edges) {
      const handle = document.createElement("div");
      handle.className = `surface-window-resize surface-window-resize-${edge}`;
      handle.dataset.edge = edge;
      this.element.appendChild(handle);
    }
  }

  bindEvents() {
    this.element.addEventListener("pointerdown", () => {
      this.manager?.bringToFront(this.id);
    });

    this.titlebarEl.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".surface-window-btn")) return;
      e.preventDefault();
      this.startDrag(e);
    });
    this.titlebarEl.addEventListener("dblclick", (e) => {
      if (e.target.closest(".surface-window-btn")) return;
      this.toggleMaximize();
    });

    this.titlebarEl
      .querySelector(".surface-window-maximize")
      .addEventListener("click", () => this.toggleMaximize());
    this.titlebarEl
      .querySelector(".surface-window-close")
      .addEventListener("click", () => {
        if (typeof this.onClose === "function") this.onClose();
        else this.manager?.close(this.id);
      });

    for (const handle of this.element.querySelectorAll(
      ".surface-window-resize",
    )) {
      handle.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.manager?.bringToFront(this.id);
        this.startResize(e, handle.dataset.edge);
      });
    }
  }

  containerRect() {
    return this.manager.container.getBoundingClientRect();
  }

  pointerPct(e) {
    const rect = this.containerRect();
    return {
      x: ((e.clientX - rect.left) / Math.max(rect.width, 1)) * 100,
      y: ((e.clientY - rect.top) / Math.max(rect.height, 1)) * 100,
    };
  }

  minPctConstraints() {
    const rect = this.containerRect();
    return {
      minWidthPct: Math.min(
        100,
        (this.minWidthPx / Math.max(rect.width, 1)) * 100,
      ),
      minHeightPct: Math.min(
        100,
        (this.minHeightPx / Math.max(rect.height, 1)) * 100,
      ),
    };
  }

  startDrag(e) {
    // Dragging a snapped/maximized window releases it at its remembered size,
    // centered under the cursor (Windows/VS Code behavior).
    if (this.snapZone && this.restoreBounds) {
      const pointer = this.pointerPct(e);
      const width = this.restoreBounds.width;
      const height = this.restoreBounds.height;
      this.bounds = normalizeWindowBounds(
        { x: pointer.x - width / 2, y: pointer.y - 2, width, height },
        this.minPctConstraints(),
      );
      this.snapZone = null;
      this.applyBounds();
    }
    this.dragState = {
      startBounds: { ...this.bounds },
      startPointer: { x: e.clientX, y: e.clientY },
      activeZone: null,
    };
    this.element.classList.add("dragging");
    this.onDragMove = (ev) => this.handleDragMove(ev);
    this.onDragEnd = (ev) => this.endDrag(ev);
    document.addEventListener("pointermove", this.onDragMove);
    document.addEventListener("pointerup", this.onDragEnd, { once: true });
  }

  handleDragMove(e) {
    if (!this.dragState) return;
    const rect = this.containerRect();
    const deltaX =
      ((e.clientX - this.dragState.startPointer.x) / Math.max(rect.width, 1)) *
      100;
    const deltaY =
      ((e.clientY - this.dragState.startPointer.y) / Math.max(rect.height, 1)) *
      100;
    this.bounds = normalizeWindowBounds(
      {
        ...this.dragState.startBounds,
        x: this.dragState.startBounds.x + deltaX,
        y: this.dragState.startBounds.y + deltaY,
      },
      this.minPctConstraints(),
    );
    this.applyBounds();

    const zone = computeSnapZone(this.pointerPct(e));
    if (zone !== this.dragState.activeZone) {
      this.dragState.activeZone = zone;
      this.manager?.showSnapPreview(zone);
    }
  }

  endDrag(e) {
    document.removeEventListener("pointermove", this.onDragMove);
    this.element.classList.remove("dragging");
    const zone = this.dragState?.activeZone;
    this.dragState = null;
    this.manager?.showSnapPreview(null);
    if (zone) this.applySnapZone(zone);
    this.manager?.persistLayout();
  }

  applySnapZone(zone) {
    const bounds = boundsForSnapZone(zone);
    if (!bounds) return;
    if (!this.snapZone) this.restoreBounds = { ...this.bounds };
    this.snapZone = zone;
    this.bounds = bounds;
    this.applyBounds();
  }

  toggleMaximize() {
    if (this.snapZone === "top") {
      // restore
      this.bounds = this.restoreBounds
        ? normalizeWindowBounds(this.restoreBounds, this.minPctConstraints())
        : { x: 20, y: 10, width: 60, height: 75 };
      this.snapZone = null;
    } else {
      this.applySnapZone("top");
    }
    this.applyBounds();
    this.manager?.persistLayout();
  }

  startResize(e, edge) {
    this.resizeState = {
      edge,
      startBounds: { ...this.bounds },
      startPointer: { x: e.clientX, y: e.clientY },
    };
    this.snapZone = null;
    this.element.classList.add("resizing");
    this.onResizeMove = (ev) => this.handleResizeMove(ev);
    this.onResizeEnd = () => this.endResize();
    document.addEventListener("pointermove", this.onResizeMove);
    document.addEventListener("pointerup", this.onResizeEnd, { once: true });
  }

  handleResizeMove(e) {
    if (!this.resizeState) return;
    const rect = this.containerRect();
    const { edge, startBounds, startPointer } = this.resizeState;
    const deltaX =
      ((e.clientX - startPointer.x) / Math.max(rect.width, 1)) * 100;
    const deltaY =
      ((e.clientY - startPointer.y) / Math.max(rect.height, 1)) * 100;
    const { minWidthPct, minHeightPct } = this.minPctConstraints();
    const next = { ...startBounds };

    if (edge.includes("right")) {
      next.width = Math.max(minWidthPct, startBounds.width + deltaX);
    }
    if (edge.includes("left")) {
      const width = Math.max(minWidthPct, startBounds.width - deltaX);
      next.x = startBounds.x + startBounds.width - width;
      next.width = width;
    }
    if (edge.includes("bottom")) {
      next.height = Math.max(minHeightPct, startBounds.height + deltaY);
    }
    if (edge.includes("top")) {
      const height = Math.max(minHeightPct, startBounds.height - deltaY);
      next.y = startBounds.y + startBounds.height - height;
      next.height = height;
    }

    this.bounds = normalizeWindowBounds(next, { minWidthPct, minHeightPct });
    this.applyBounds();
  }

  endResize() {
    document.removeEventListener("pointermove", this.onResizeMove);
    this.element.classList.remove("resizing");
    this.resizeState = null;
    this.manager?.persistLayout();
  }

  applyBounds() {
    this.element.style.left = `${this.bounds.x}%`;
    this.element.style.top = `${this.bounds.y}%`;
    this.element.style.width = `${this.bounds.width}%`;
    this.element.style.height = `${this.bounds.height}%`;
  }

  open() {
    this.isOpen = true;
    this.element.classList.remove("hidden");
    this.applyBounds();
  }

  close() {
    this.isOpen = false;
    this.element.classList.add("hidden");
  }
}

class SurfaceWindowManager {
  constructor({ container, settingsStore = null, baseZIndex = 640 }) {
    this.container = container;
    this.settingsStore = settingsStore;
    this.baseZIndex = baseZIndex;
    this.windows = new Map();
    this.zOrder = [];

    this.snapPreviewEl = document.createElement("div");
    this.snapPreviewEl.className = "surface-window-snap-preview hidden";
    this.container.appendChild(this.snapPreviewEl);

    const stored = this.settingsStore?.get(
      SURFACE_WINDOW_LAYOUT_SETTINGS_KEY,
      null,
    );
    this.savedLayout = deserializeWindowLayout(stored);
  }

  register({
    id,
    title,
    icon,
    contentEl,
    bounds,
    minWidthPx,
    minHeightPx,
    onClose,
  }) {
    if (this.windows.has(id)) return this.windows.get(id);
    const saved = this.savedLayout[id];
    const win = new SurfaceWindow({
      id,
      title,
      icon,
      contentEl,
      manager: this,
      bounds: saved || bounds,
      minWidthPx,
      minHeightPx,
      onClose,
    });
    if (saved?.snapZone) {
      win.snapZone = saved.snapZone;
      win.restoreBounds = bounds ? { ...bounds } : null;
    }
    this.windows.set(id, win);
    this.container.appendChild(win.element);
    return win;
  }

  get(id) {
    return this.windows.get(id) || null;
  }

  isOpen(id) {
    return Boolean(this.windows.get(id)?.isOpen);
  }

  open(id) {
    const win = this.windows.get(id);
    if (!win) return;
    win.open();
    this.bringToFront(id);
  }

  close(id) {
    const win = this.windows.get(id);
    if (!win) return;
    win.close();
  }

  toggle(id) {
    if (this.isOpen(id)) this.close(id);
    else this.open(id);
  }

  bringToFront(id) {
    if (!this.windows.has(id)) return;
    this.zOrder = this.zOrder.filter((entry) => entry !== id);
    this.zOrder.push(id);
    this.zOrder.forEach((windowId, index) => {
      const win = this.windows.get(windowId);
      if (win) win.element.style.zIndex = String(this.baseZIndex + index);
      if (win) win.element.classList.toggle("active", windowId === id);
    });
  }

  showSnapPreview(zone) {
    const bounds = zone ? boundsForSnapZone(zone) : null;
    if (!bounds) {
      this.snapPreviewEl.classList.add("hidden");
      return;
    }
    this.snapPreviewEl.style.left = `${bounds.x}%`;
    this.snapPreviewEl.style.top = `${bounds.y}%`;
    this.snapPreviewEl.style.width = `${bounds.width}%`;
    this.snapPreviewEl.style.height = `${bounds.height}%`;
    this.snapPreviewEl.classList.remove("hidden");
  }

  persistLayout() {
    if (!this.settingsStore) return;
    const layout = {};
    for (const [id, win] of this.windows) {
      layout[id] = { ...win.bounds, snapZone: win.snapZone };
    }
    this.savedLayout = { ...this.savedLayout, ...layout };
    this.settingsStore.set(
      SURFACE_WINDOW_LAYOUT_SETTINGS_KEY,
      serializeWindowLayout(this.savedLayout),
    );
  }
}

const SurfaceWindows = {
  normalizeWindowBounds,
  computeSnapZone,
  boundsForSnapZone,
  serializeWindowLayout,
  deserializeWindowLayout,
  clampDockHeight,
  dockStateFromSettings,
  DOCK_DEFAULT_HEIGHT_PCT,
  SURFACE_WINDOW_LAYOUT_SETTINGS_KEY,
  SURFACE_WINDOW_SNAP_THRESHOLD_PCT,
};

if (typeof document !== "undefined") {
  SurfaceWindows.SurfaceWindow = SurfaceWindow;
  SurfaceWindows.SurfaceWindowManager = SurfaceWindowManager;
}

if (typeof window !== "undefined") {
  window.SurfaceWindows = SurfaceWindows;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = SurfaceWindows;
}
