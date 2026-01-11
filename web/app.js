// OpenCode Web Terminal - Floating Tiling Window Manager
// Version 2.0 - Complete rewrite with smart tiling, groups, and mobile support

// =============================================================================
// CONSTANTS
// =============================================================================

const KEY_SEQUENCES = {
  ESC: "\x1b",
  TAB: "\t",
  UP: "\x1b[A",
  DOWN: "\x1b[B",
  LEFT: "\x1b[D",
  RIGHT: "\x1b[C",
  HOME: "\x1b[H",
  END: "\x1b[F",
  PGUP: "\x1b[5~",
  PGDN: "\x1b[6~",
  INS: "\x1b[2~",
  DEL: "\x1b[3~",
  F1: "\x1bOP",
  F2: "\x1bOQ",
  F3: "\x1bOR",
  F4: "\x1bOS",
  F5: "\x1b[15~",
  F6: "\x1b[17~",
  F7: "\x1b[18~",
  F8: "\x1b[19~",
  F9: "\x1b[20~",
  F10: "\x1b[21~",
  F11: "\x1b[23~",
  F12: "\x1b[24~",
};

const TILE_CONFIG = {
  MIN_WIDTH: 250,
  MIN_HEIGHT: 180,
  RESIZE_HANDLE: 8,
  SNAP_THRESHOLD: 12,
  GAP: 4,
  ANIMATION_MS: 200,
};

const GROUP_COLORS = [
  "#58a6ff",
  "#3fb950",
  "#d29922",
  "#bc8cff",
  "#f778ba",
  "#79c0ff",
  "#7ee787",
];

// =============================================================================
// RECONNECTING WEBSOCKET
// =============================================================================

class ReconnectingWebSocket {
  constructor(url, terminalId, callbacks) {
    this.url = url;
    this.terminalId = terminalId;
    this.callbacks = callbacks;
    this.ws = null;
    this.retryCount = 0;
    this.maxRetries = 10;
    this.baseDelay = 1000;
    this.maxDelay = 30000;
    this.reconnectTimer = null;
    this.heartbeatInterval = null;
    this.heartbeatTimeout = null;
    this.intentionallyClosed = false;
    this.connect();
  }

  connect() {
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {
      this.retryCount = 0;
      this.startHeartbeat();
      this.callbacks.onStatusChange("connected");
    };
    this.ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "ping") {
          this.send(JSON.stringify({ type: "pong" }));
          return;
        }
        if (data.type === "pong") {
          this.clearHeartbeatTimeout();
          return;
        }
        if (data.type === "exit") {
          this.callbacks.onStatusChange("exited", data.code);
          this.intentionallyClosed = true;
          return;
        }
        if (data.type === "terminal_dead") {
          this.callbacks.onStatusChange("dead");
          this.intentionallyClosed = true;
          return;
        }
      } catch {}
      this.callbacks.onMessage(e.data);
    };
    this.ws.onclose = () => {
      this.stopHeartbeat();
      if (!this.intentionallyClosed) this.scheduleReconnect();
    };
    this.ws.onerror = () => {};
  }

  scheduleReconnect() {
    if (this.retryCount >= this.maxRetries) {
      this.callbacks.onStatusChange("failed");
      return;
    }
    const delay = Math.min(
      this.baseDelay * Math.pow(2, this.retryCount),
      this.maxDelay,
    );
    this.retryCount++;
    this.callbacks.onStatusChange("reconnecting", {
      attempt: this.retryCount,
      maxRetries: this.maxRetries,
      delay,
    });
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  send(data) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
      return true;
    }
    return false;
  }

  close() {
    this.intentionallyClosed = true;
    this.stopHeartbeat();
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  retry() {
    this.retryCount = 0;
    this.intentionallyClosed = false;
    this.connect();
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send(JSON.stringify({ type: "ping" }));
        this.heartbeatTimeout = setTimeout(() => this.ws.close(), 5000);
      }
    }, 25000);
  }

  stopHeartbeat() {
    clearInterval(this.heartbeatInterval);
    this.clearHeartbeatTimeout();
  }

  clearHeartbeatTimeout() {
    clearTimeout(this.heartbeatTimeout);
    this.heartbeatTimeout = null;
  }

  get readyState() {
    return this.ws?.readyState ?? WebSocket.CLOSED;
  }
}

// =============================================================================
// TILE - Individual floating window
// =============================================================================

class Tile {
  constructor(id, terminalId, container) {
    this.id = id;
    this.terminalId = terminalId;
    this.container = container;
    this.groupId = null;
    this.element = null;
    this.terminalWrapper = null;

    // Bounds in percentages (0-100)
    this.bounds = { x: 0, y: 0, width: 50, height: 100 };

    this.isResizing = false;
    this.resizeEdge = null;
    this.dragStartBounds = null;
    this.dragStartMouse = null;

    this.createElement();
  }

  createElement() {
    this.element = document.createElement("div");
    this.element.className = "tile";
    this.element.dataset.tileId = this.id;
    this.element.dataset.terminalId = this.terminalId;

    this.terminalWrapper = document.createElement("div");
    this.terminalWrapper.className = "terminal-wrapper";
    this.terminalWrapper.id = `terminal-${this.terminalId}`;
    this.element.appendChild(this.terminalWrapper);

    // Resize handles
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
    edges.forEach((edge) => {
      const handle = document.createElement("div");
      handle.className = `tile-resize-handle tile-resize-${edge}`;
      handle.dataset.edge = edge;
      this.element.appendChild(handle);
    });

    this.setupResizeHandlers();
    this.container.appendChild(this.element);
  }

  setupResizeHandlers() {
    const handles = this.element.querySelectorAll(".tile-resize-handle");

    handles.forEach((handle) => {
      handle.addEventListener("mousedown", (e) =>
        this.startResize(e, handle.dataset.edge),
      );
      handle.addEventListener(
        "touchstart",
        (e) => {
          e.preventDefault();
          const touch = e.touches[0];
          this.startResize(
            {
              clientX: touch.clientX,
              clientY: touch.clientY,
              preventDefault: () => {},
            },
            handle.dataset.edge,
          );
        },
        { passive: false },
      );
    });
  }

  startResize(e, edge) {
    e.preventDefault();
    this.isResizing = true;
    this.resizeEdge = edge;
    this.dragStartBounds = { ...this.bounds };
    this.dragStartMouse = { x: e.clientX, y: e.clientY };
    this.element.classList.add("resizing");

    document.addEventListener("mousemove", this.onResize);
    document.addEventListener("mouseup", this.endResize);
    document.addEventListener("touchmove", this.onTouchResize, {
      passive: false,
    });
    document.addEventListener("touchend", this.endResize);
  }

  onResize = (e) => {
    if (!this.isResizing) return;

    const containerRect = this.container.getBoundingClientRect();
    const deltaX =
      ((e.clientX - this.dragStartMouse.x) / containerRect.width) * 100;
    const deltaY =
      ((e.clientY - this.dragStartMouse.y) / containerRect.height) * 100;

    const minW = (TILE_CONFIG.MIN_WIDTH / containerRect.width) * 100;
    const minH = (TILE_CONFIG.MIN_HEIGHT / containerRect.height) * 100;

    const newBounds = { ...this.dragStartBounds };

    // Calculate new bounds based on edge
    if (this.resizeEdge.includes("right")) {
      newBounds.width = Math.max(minW, this.dragStartBounds.width + deltaX);
    }
    if (this.resizeEdge.includes("left")) {
      const newWidth = Math.max(minW, this.dragStartBounds.width - deltaX);
      newBounds.x =
        this.dragStartBounds.x + this.dragStartBounds.width - newWidth;
      newBounds.width = newWidth;
    }
    if (this.resizeEdge.includes("bottom")) {
      newBounds.height = Math.max(minH, this.dragStartBounds.height + deltaY);
    }
    if (this.resizeEdge.includes("top")) {
      const newHeight = Math.max(minH, this.dragStartBounds.height - deltaY);
      newBounds.y =
        this.dragStartBounds.y + this.dragStartBounds.height - newHeight;
      newBounds.height = newHeight;
    }

    // Emit resize event for TileManager to handle pushing
    this.element.dispatchEvent(
      new CustomEvent("tileresize", {
        bubbles: true,
        detail: { tile: this, newBounds, edge: this.resizeEdge },
      }),
    );
  };

  onTouchResize = (e) => {
    e.preventDefault();
    const touch = e.touches[0];
    this.onResize({ clientX: touch.clientX, clientY: touch.clientY });
  };

  endResize = () => {
    this.isResizing = false;
    this.resizeEdge = null;
    this.element.classList.remove("resizing");

    document.removeEventListener("mousemove", this.onResize);
    document.removeEventListener("mouseup", this.endResize);
    document.removeEventListener("touchmove", this.onTouchResize);
    document.removeEventListener("touchend", this.endResize);

    window.dispatchEvent(new Event("resize"));
  };

  updatePosition() {
    this.element.style.left = `${this.bounds.x}%`;
    this.element.style.top = `${this.bounds.y}%`;
    this.element.style.width = `${this.bounds.width}%`;
    this.element.style.height = `${this.bounds.height}%`;
  }

  setActive(active) {
    this.element.classList.toggle("active", active);
  }

  setGroupColor(color) {
    this.element.style.setProperty("--group-color", color || "transparent");
    this.element.classList.toggle("grouped", !!color);
  }

  destroy() {
    this.element.remove();
  }
}

// =============================================================================
// TILE GROUP - Visual grouping of tiles
// =============================================================================

class TileGroup {
  constructor(id, color) {
    this.id = id;
    this.color = color;
    this.tileIds = new Set();
  }

  addTile(tileId) {
    this.tileIds.add(tileId);
  }

  removeTile(tileId) {
    this.tileIds.delete(tileId);
    return this.tileIds.size === 0;
  }

  get size() {
    return this.tileIds.size;
  }
}

// =============================================================================
// WORKSPACE - Container for one or more terminals
// =============================================================================

class Workspace {
  constructor(id, tabNum) {
    this.id = id;
    this.tabNum = tabNum;
    this.terminalIds = new Set();
    this.label = `Tab ${tabNum}`;
  }

  addTerminal(terminalId) {
    this.terminalIds.add(terminalId);
  }

  removeTerminal(terminalId) {
    this.terminalIds.delete(terminalId);
    return this.terminalIds.size === 0;
  }

  get count() {
    return this.terminalIds.size;
  }

  get isMulticolor() {
    return this.terminalIds.size > 1;
  }
}

// =============================================================================
// TILE MANAGER - Smart tiling window manager
// =============================================================================

class TileManager {
  constructor(container) {
    this.container = container;
    this.tiles = new Map(); // terminalId -> Tile
    this.groups = new Map(); // groupId -> TileGroup
    this.workspaces = new Map(); // workspaceId -> Workspace
    this.activeTileId = null;
    this.activeWorkspaceId = null;
    this.colorIndex = 0;
    this.workspaceIndex = 0;
    this.isMobile = window.innerWidth < 768;

    // Undo stack
    this.undoStack = [];
    this.undoTimeout = null;

    this.init();
  }

  init() {
    // Listen for tile resize events
    this.container.addEventListener("tileresize", (e) => {
      this.handleTileResize(e.detail.tile, e.detail.newBounds, e.detail.edge);
    });

    // Handle window resize
    window.addEventListener("resize", () => {
      const wasMobile = this.isMobile;
      this.isMobile = window.innerWidth < 768;

      if (wasMobile !== this.isMobile) {
        this.relayout();
      }
    });

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.key === "z") {
        e.preventDefault();
        this.undo();
      }
    });
  }

  // Create a new tile for a terminal
  // split=false means new independent workspace, split=true means split current workspace
  createTile(terminalId, workspaceId, split = false) {
    const tileId = `tile-${terminalId}`;
    const tile = new Tile(tileId, terminalId, this.container);
    tile.workspaceId = workspaceId;
    this.tiles.set(terminalId, tile);

    if (split && this.activeTileId) {
      // Split: position next to active tile
      this.positionNewTile(tile);
    } else {
      // New workspace: take full space, hide other workspaces
      tile.bounds = { x: 0, y: 0, width: 100, height: 100 };
    }

    tile.updatePosition();
    this.showWorkspace(workspaceId);

    return tile.terminalWrapper;
  }

  // Show only tiles from specific workspace
  showWorkspace(workspaceId) {
    this.activeWorkspaceId = workspaceId;
    this.tiles.forEach((tile) => {
      if (tile.workspaceId === workspaceId) {
        tile.element.style.display = "block";
      } else {
        tile.element.style.display = "none";
      }
    });
  }

  // Get tiles for a workspace
  getWorkspaceTiles(workspaceId) {
    const tiles = [];
    this.tiles.forEach((tile) => {
      if (tile.workspaceId === workspaceId) {
        tiles.push(tile);
      }
    });
    return tiles;
  }

  // Merge two workspaces
  mergeWorkspaces(fromWorkspaceId, toWorkspaceId) {
    this.tiles.forEach((tile) => {
      if (tile.workspaceId === fromWorkspaceId) {
        tile.workspaceId = toWorkspaceId;
      }
    });
    // Relayout the merged workspace
    this.relayoutWorkspace(toWorkspaceId);
  }

  // Relayout tiles in a specific workspace
  relayoutWorkspace(workspaceId) {
    const tiles = this.getWorkspaceTiles(workspaceId);
    if (tiles.length === 0) return;

    const count = tiles.length;
    if (count === 1) {
      tiles[0].bounds = { x: 0, y: 0, width: 100, height: 100 };
      tiles[0].updatePosition();
      return;
    }

    // Grid layout
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    const cellWidth = 100 / cols;
    const cellHeight = 100 / rows;

    tiles.forEach((tile, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      tile.bounds = {
        x: col * cellWidth,
        y: row * cellHeight,
        width: cellWidth,
        height: cellHeight,
      };
      tile.updatePosition();
    });
  }

  // Position a new tile next to the active one
  positionNewTile(newTile) {
    if (this.tiles.size === 1) {
      // First tile takes full space
      newTile.bounds = { x: 0, y: 0, width: 100, height: 100 };
      return;
    }

    const activeTile = this.tiles.get(this.activeTileId);
    if (!activeTile) {
      // No active tile, fill remaining space
      newTile.bounds = { x: 0, y: 0, width: 100, height: 100 };
      this.relayout();
      return;
    }

    // Determine split direction based on active tile shape
    const containerRect = this.container.getBoundingClientRect();
    const tileW = (activeTile.bounds.width / 100) * containerRect.width;
    const tileH = (activeTile.bounds.height / 100) * containerRect.height;

    const splitHorizontal = tileW >= tileH;

    this.saveUndo();

    if (splitHorizontal) {
      // Split horizontally (new tile to the right)
      const newWidth = activeTile.bounds.width / 2;
      activeTile.bounds.width = newWidth;
      newTile.bounds = {
        x: activeTile.bounds.x + newWidth,
        y: activeTile.bounds.y,
        width: newWidth,
        height: activeTile.bounds.height,
      };
    } else {
      // Split vertically (new tile below)
      const newHeight = activeTile.bounds.height / 2;
      activeTile.bounds.height = newHeight;
      newTile.bounds = {
        x: activeTile.bounds.x,
        y: activeTile.bounds.y + newHeight,
        width: activeTile.bounds.width,
        height: newHeight,
      };
    }

    activeTile.updatePosition();
  }

  // Handle tile resize with push neighbors
  handleTileResize(tile, newBounds, edge) {
    const containerRect = this.container.getBoundingClientRect();
    const minW = (TILE_CONFIG.MIN_WIDTH / containerRect.width) * 100;
    const minH = (TILE_CONFIG.MIN_HEIGHT / containerRect.height) * 100;

    // Find neighbors that would be affected
    const neighbors = this.findNeighbors(tile, edge);

    // Calculate how much we need to push
    let canResize = true;

    for (const neighbor of neighbors) {
      const pushAmount = this.calculatePushAmount(
        tile,
        neighbor,
        newBounds,
        edge,
      );

      if (pushAmount !== 0) {
        const newNeighborBounds = this.applyPush(neighbor, pushAmount, edge);

        // Check if neighbor can be pushed (min size constraint)
        if (newNeighborBounds.width < minW || newNeighborBounds.height < minH) {
          // Try to push neighbor's neighbors recursively
          const canPushFurther = this.tryPushChain(
            neighbor,
            pushAmount,
            edge,
            minW,
            minH,
          );
          if (!canPushFurther) {
            canResize = false;
            break;
          }
        }
      }
    }

    if (canResize) {
      // Apply the resize
      tile.bounds = { ...newBounds };

      // Push all affected neighbors
      for (const neighbor of neighbors) {
        const pushAmount = this.calculatePushAmount(
          tile,
          neighbor,
          newBounds,
          edge,
        );
        if (pushAmount !== 0) {
          this.pushTile(neighbor, pushAmount, edge);
        }
      }

      // Update all tile positions
      this.tiles.forEach((t) => t.updatePosition());
    }
  }

  findNeighbors(tile, edge) {
    const neighbors = [];
    const tolerance = 2; // percentage tolerance for adjacency

    this.tiles.forEach((other) => {
      if (other === tile) return;

      // Check adjacency based on edge being resized
      if (
        edge.includes("right") &&
        Math.abs(other.bounds.x - (tile.bounds.x + tile.bounds.width)) <
          tolerance
      ) {
        if (this.overlapsVertically(tile, other)) neighbors.push(other);
      }
      if (
        edge.includes("left") &&
        Math.abs(other.bounds.x + other.bounds.width - tile.bounds.x) <
          tolerance
      ) {
        if (this.overlapsVertically(tile, other)) neighbors.push(other);
      }
      if (
        edge.includes("bottom") &&
        Math.abs(other.bounds.y - (tile.bounds.y + tile.bounds.height)) <
          tolerance
      ) {
        if (this.overlapsHorizontally(tile, other)) neighbors.push(other);
      }
      if (
        edge.includes("top") &&
        Math.abs(other.bounds.y + other.bounds.height - tile.bounds.y) <
          tolerance
      ) {
        if (this.overlapsHorizontally(tile, other)) neighbors.push(other);
      }
    });

    return neighbors;
  }

  overlapsVertically(a, b) {
    return !(
      a.bounds.y + a.bounds.height <= b.bounds.y ||
      b.bounds.y + b.bounds.height <= a.bounds.y
    );
  }

  overlapsHorizontally(a, b) {
    return !(
      a.bounds.x + a.bounds.width <= b.bounds.x ||
      b.bounds.x + b.bounds.width <= a.bounds.x
    );
  }

  calculatePushAmount(tile, neighbor, newBounds, edge) {
    if (edge.includes("right")) {
      return newBounds.x + newBounds.width - neighbor.bounds.x;
    }
    if (edge.includes("left")) {
      return tile.bounds.x - newBounds.x;
    }
    if (edge.includes("bottom")) {
      return newBounds.y + newBounds.height - neighbor.bounds.y;
    }
    if (edge.includes("top")) {
      return tile.bounds.y - newBounds.y;
    }
    return 0;
  }

  applyPush(tile, amount, edge) {
    const newBounds = { ...tile.bounds };

    if (edge.includes("right")) {
      newBounds.x += amount;
      newBounds.width -= amount;
    } else if (edge.includes("left")) {
      newBounds.width -= amount;
    } else if (edge.includes("bottom")) {
      newBounds.y += amount;
      newBounds.height -= amount;
    } else if (edge.includes("top")) {
      newBounds.height -= amount;
    }

    return newBounds;
  }

  pushTile(tile, amount, edge) {
    const newBounds = this.applyPush(tile, amount, edge);
    tile.bounds = newBounds;
  }

  tryPushChain(tile, amount, edge, minW, minH) {
    // Simplified: just check if there's room
    const newBounds = this.applyPush(tile, amount, edge);
    return newBounds.width >= minW && newBounds.height >= minH;
  }

  // Remove a tile
  removeTile(terminalId) {
    const tile = this.tiles.get(terminalId);
    if (!tile) return;

    this.saveUndo();

    // Remove from group if grouped
    if (tile.groupId) {
      this.removeFromGroup(terminalId);
    }

    tile.destroy();
    this.tiles.delete(terminalId);

    // Redistribute space to remaining tiles
    if (this.tiles.size > 0) {
      this.relayout();
    }
  }

  // Relayout all tiles to fill space
  relayout() {
    const tileArray = Array.from(this.tiles.values());
    if (tileArray.length === 0) return;

    if (this.isMobile) {
      // Mobile: stack mode - one tile takes full space
      tileArray.forEach((tile, i) => {
        tile.bounds = { x: 0, y: 0, width: 100, height: 100 };
        tile.element.style.display =
          tile.terminalId === this.activeTileId ? "block" : "none";
        tile.updatePosition();
      });
      return;
    }

    // Desktop: distribute tiles in a grid
    const count = tileArray.length;

    if (count === 1) {
      tileArray[0].bounds = { x: 0, y: 0, width: 100, height: 100 };
      tileArray[0].element.style.display = "block";
      tileArray[0].updatePosition();
      return;
    }

    // Calculate optimal grid
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    const cellWidth = 100 / cols;
    const cellHeight = 100 / rows;

    tileArray.forEach((tile, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);

      tile.bounds = {
        x: col * cellWidth,
        y: row * cellHeight,
        width: cellWidth,
        height: cellHeight,
      };
      tile.element.style.display = "block";
      tile.updatePosition();
    });
  }

  // Set active tile
  setActive(terminalId) {
    this.activeTileId = terminalId;

    this.tiles.forEach((tile, id) => {
      tile.setActive(id === terminalId);

      if (this.isMobile) {
        tile.element.style.display = id === terminalId ? "block" : "none";
      }
    });
  }

  // Create a group from tiles
  createGroup(terminalIds) {
    const groupId = `group-${Date.now()}`;
    const color = GROUP_COLORS[this.colorIndex % GROUP_COLORS.length];
    this.colorIndex++;

    const group = new TileGroup(groupId, color);

    terminalIds.forEach((id) => {
      const tile = this.tiles.get(id);
      if (tile) {
        tile.groupId = groupId;
        tile.setGroupColor(color);
        group.addTile(id);
      }
    });

    this.groups.set(groupId, group);
    return group;
  }

  // Add tile to existing group
  addToGroup(terminalId, groupId) {
    const tile = this.tiles.get(terminalId);
    const group = this.groups.get(groupId);

    if (!tile || !group) return;

    // Remove from previous group if any
    if (tile.groupId && tile.groupId !== groupId) {
      this.removeFromGroup(terminalId);
    }

    tile.groupId = groupId;
    tile.setGroupColor(group.color);
    group.addTile(terminalId);
  }

  // Remove tile from its group
  removeFromGroup(terminalId) {
    const tile = this.tiles.get(terminalId);
    if (!tile || !tile.groupId) return;

    const group = this.groups.get(tile.groupId);
    if (group) {
      const isEmpty = group.removeTile(terminalId);
      if (isEmpty) {
        this.groups.delete(tile.groupId);
      }
    }

    tile.groupId = null;
    tile.setGroupColor(null);
  }

  // Get group for a terminal
  getGroup(terminalId) {
    const tile = this.tiles.get(terminalId);
    if (!tile || !tile.groupId) return null;
    return this.groups.get(tile.groupId);
  }

  // Merge two tiles into a group
  mergeTiles(terminalId1, terminalId2) {
    this.saveUndo();

    const tile1 = this.tiles.get(terminalId1);
    const tile2 = this.tiles.get(terminalId2);

    if (!tile1 || !tile2) return;

    // Check if either is already in a group
    if (tile2.groupId) {
      // Add tile1 to tile2's group
      this.addToGroup(terminalId1, tile2.groupId);
    } else if (tile1.groupId) {
      // Add tile2 to tile1's group
      this.addToGroup(terminalId2, tile1.groupId);
    } else {
      // Create new group
      this.createGroup([terminalId1, terminalId2]);
    }
  }

  // Save state for undo
  saveUndo() {
    const state = {
      tiles: new Map(),
      groups: new Map(),
    };

    this.tiles.forEach((tile, id) => {
      state.tiles.set(id, {
        bounds: { ...tile.bounds },
        groupId: tile.groupId,
      });
    });

    this.groups.forEach((group, id) => {
      state.groups.set(id, {
        color: group.color,
        tileIds: new Set(group.tileIds),
      });
    });

    this.undoStack.push(state);
    if (this.undoStack.length > 10) this.undoStack.shift();

    // Clear undo after 5 seconds
    clearTimeout(this.undoTimeout);
    this.undoTimeout = setTimeout(() => {
      this.undoStack = [];
    }, 5000);
  }

  // Undo last action
  undo() {
    const state = this.undoStack.pop();
    if (!state) return;

    // Restore tile positions
    state.tiles.forEach((data, id) => {
      const tile = this.tiles.get(id);
      if (tile) {
        tile.bounds = data.bounds;
        tile.updatePosition();
      }
    });

    // Restore groups
    this.groups.clear();
    state.groups.forEach((data, id) => {
      const group = new TileGroup(id, data.color);
      data.tileIds.forEach((tileId) => group.addTile(tileId));
      this.groups.set(id, group);

      // Update tile colors
      data.tileIds.forEach((tileId) => {
        const tile = this.tiles.get(tileId);
        if (tile) {
          tile.groupId = id;
          tile.setGroupColor(data.color);
        }
      });
    });
  }

  // Get wrapper element for terminal
  getWrapper(terminalId) {
    return this.tiles.get(terminalId)?.terminalWrapper;
  }
}

// =============================================================================
// EXTRA KEYS MANAGER
// =============================================================================

class ExtraKeysManager {
  constructor(terminalManager) {
    this.tm = terminalManager;
    this.modifiers = { ctrl: false, alt: false, shift: false };
    this.init();
  }

  init() {
    const extraKeys = document.getElementById("extra-keys");
    if (!extraKeys) return;

    const toggle = document.getElementById("extra-keys-toggle");
    const row2 = document.querySelector(".extra-keys-row-2");

    let touchedKey = null;

    extraKeys.addEventListener(
      "touchstart",
      (e) => {
        const btn = e.target.closest(".ek-btn, .ek-toggle");
        if (btn) {
          e.preventDefault();
          e.stopImmediatePropagation();
          touchedKey =
            btn.dataset.key ||
            (btn.id === "extra-keys-toggle" ? "TOGGLE" : null);
        }
      },
      { passive: false, capture: true },
    );

    extraKeys.addEventListener(
      "touchend",
      (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (touchedKey) {
          if (touchedKey === "TOGGLE") {
            row2.classList.toggle("hidden");
            toggle.textContent = row2.classList.contains("hidden") ? "⋯" : "⋮";
          } else {
            this.handleKey(touchedKey);
          }
          touchedKey = null;
        }
        setTimeout(() => this.refocusTerminal(), 10);
      },
      { passive: false, capture: true },
    );

    extraKeys.addEventListener("mousedown", (e) => {
      if (e.target.closest(".ek-btn, .ek-toggle")) {
        e.preventDefault();
      }
    });

    extraKeys.addEventListener("click", (e) => {
      const btn = e.target.closest(".ek-btn");
      const tog = e.target.closest(".ek-toggle");
      if (btn && btn.dataset.key) {
        e.preventDefault();
        this.handleKey(btn.dataset.key);
      } else if (tog && row2 && toggle) {
        e.preventDefault();
        row2.classList.toggle("hidden");
        toggle.textContent = row2.classList.contains("hidden") ? "⋯" : "⋮";
      }
    });
  }

  handleKey(key) {
    if (!key) return;
    const active = this.tm.terminals.get(this.tm.activeId);
    if (!active?.ws) return;

    const upperKey = key.toUpperCase();
    if (upperKey === "CTRL" || upperKey === "ALT" || upperKey === "SHIFT") {
      this.toggleModifier(upperKey.toLowerCase());
      return;
    }

    let sequence = KEY_SEQUENCES[key] || key;

    if (this.modifiers.ctrl && key.length === 1) {
      const charCode = key.toUpperCase().charCodeAt(0);
      if (charCode >= 65 && charCode <= 90) {
        sequence = String.fromCharCode(charCode - 64);
      }
    }

    if (this.modifiers.alt) sequence = "\x1b" + sequence;

    if (this.modifiers.shift && key.length === 1) {
      sequence = sequence.toUpperCase();
    }

    active.ws.send(JSON.stringify({ type: "input", data: sequence }));
    this.resetModifiers();
  }

  toggleModifier(mod) {
    this.modifiers[mod] = !this.modifiers[mod];
    this.updateModifierUI();
  }

  resetModifiers() {
    this.modifiers = { ctrl: false, alt: false, shift: false };
    this.updateModifierUI();
  }

  updateModifierUI() {
    document.querySelectorAll(".ek-btn.ek-modifier").forEach((btn) => {
      const mod = btn.dataset.key.toLowerCase();
      btn.classList.toggle("active", this.modifiers[mod] || false);
    });
  }

  refocusTerminal() {
    const active = this.tm.terminals.get(this.tm.activeId);
    if (active?.terminal) {
      active.terminal.focus();
    }
  }
}

// =============================================================================
// FILE MANAGER
// =============================================================================

class FileManager {
  constructor() {
    this.currentPath = "/";
    this.init();
  }

  init() {
    document
      .querySelector('[data-action="file-manager"]')
      ?.addEventListener("click", () => this.open());
    document
      .getElementById("file-close")
      ?.addEventListener("click", () => this.close());
    document
      .getElementById("file-modal-close")
      ?.addEventListener("click", () => this.close());
    document
      .getElementById("file-upload-btn")
      ?.addEventListener("click", () => {
        document.getElementById("file-upload-input")?.click();
      });
    document
      .getElementById("file-upload-input")
      ?.addEventListener("change", (e) => this.handleUpload(e));
    document
      .getElementById("file-mkdir-btn")
      ?.addEventListener("click", () => this.createFolder());
    document
      .getElementById("file-refresh-btn")
      ?.addEventListener("click", () => this.loadDir(this.currentPath));

    const modal = document.getElementById("file-modal");
    const dropZone = document.getElementById("file-drop-zone");
    if (modal && dropZone) {
      modal.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropZone.classList.remove("hidden");
      });
      modal.addEventListener("dragleave", (e) => {
        if (!modal.contains(e.relatedTarget)) dropZone.classList.add("hidden");
      });
      modal.addEventListener("drop", (e) => {
        e.preventDefault();
        dropZone.classList.add("hidden");
        this.handleDrop(e.dataTransfer.files);
      });
    }
  }

  open() {
    document.getElementById("file-modal")?.classList.remove("hidden");
    const dir = document.getElementById("directory")?.value || "/";
    this.loadDir(dir);
  }

  close() {
    document.getElementById("file-modal")?.classList.add("hidden");
  }

  async loadDir(path) {
    try {
      const res = await fetch(
        `/api/browse?path=${encodeURIComponent(path)}&files=true`,
      );
      const data = await res.json();
      if (data.error) return alert(data.error);

      this.currentPath = data.path;
      this.renderBreadcrumb(data.path);
      this.renderFileList(data);
    } catch (err) {
      console.error("Failed to load directory:", err);
    }
  }

  renderBreadcrumb(path) {
    const parts = path.split("/").filter(Boolean);
    let html = '<a data-path="/">/</a>';
    let currentPath = "";
    for (const part of parts) {
      currentPath += "/" + part;
      html += ` / <a data-path="${currentPath}">${part}</a>`;
    }

    const breadcrumb = document.getElementById("file-breadcrumb");
    if (breadcrumb) {
      breadcrumb.innerHTML = html;
      breadcrumb.querySelectorAll("a").forEach((a) => {
        a.addEventListener("click", () => this.loadDir(a.dataset.path));
      });
    }
  }

  renderFileList(data) {
    const list = document.getElementById("file-list");
    if (!list) return;
    list.innerHTML = "";

    if (data.path !== "/") {
      const parent = data.path.split("/").slice(0, -1).join("/") || "/";
      list.appendChild(
        this.createItem({ name: "..", isDir: true, path: parent }),
      );
    }

    const dirs = (data.dirs || []).map((name) => ({
      name,
      isDir: true,
      path: data.path + "/" + name,
    }));
    const files = (data.files || []).map((f) => ({
      ...f,
      isDir: false,
      path: data.path + "/" + f.name,
    }));

    dirs.forEach((item) => list.appendChild(this.createItem(item)));
    files.forEach((item) => list.appendChild(this.createItem(item)));
  }

  createItem(item) {
    const el = document.createElement("div");
    el.className = "file-item";

    const icons = {
      js: "📜",
      ts: "📜",
      json: "📋",
      md: "📝",
      txt: "📝",
      html: "🌐",
      css: "🎨",
      png: "🖼",
      jpg: "🖼",
      pdf: "📕",
      zip: "📦",
      sh: "⚙️",
      py: "🐍",
    };
    const ext = item.name.split(".").pop()?.toLowerCase() || "";
    const icon = item.isDir ? "📁" : icons[ext] || "📄";
    const size = item.size ? this.formatSize(item.size) : "";

    el.innerHTML = `
      <span class="file-icon">${icon}</span>
      <span class="file-name">${item.name}</span>
      <span class="file-size">${size}</span>
      <div class="file-actions">
        ${!item.isDir ? `<button class="download" title="Download">⬇</button>` : ""}
        ${item.name !== ".." ? `<button class="delete danger" title="Delete">🗑</button>` : ""}
      </div>
    `;

    el.addEventListener("click", () => item.isDir && this.loadDir(item.path));
    el.querySelector(".download")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.downloadFile(item.path);
    });
    el.querySelector(".delete")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.deleteItem(item.path, item.isDir);
    });

    return el;
  }

  formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  downloadFile(path) {
    window.open(
      `/api/files/download?path=${encodeURIComponent(path)}`,
      "_blank",
    );
  }

  async deleteItem(path, isDir) {
    if (!confirm(`Delete ${isDir ? "folder" : "file"}?\n${path}`)) return;
    try {
      const res = await fetch(`/api/files?path=${encodeURIComponent(path)}`, {
        method: "DELETE",
      });
      if (res.ok) this.loadDir(this.currentPath);
      else alert((await res.json()).error || "Failed to delete");
    } catch (err) {
      alert("Failed: " + err.message);
    }
  }

  async createFolder() {
    const name = prompt("Folder name:");
    if (!name) return;
    try {
      const res = await fetch(
        `/api/files/mkdir?path=${encodeURIComponent(this.currentPath + "/" + name)}`,
        { method: "POST" },
      );
      if (res.ok) this.loadDir(this.currentPath);
      else alert((await res.json()).error || "Failed");
    } catch (err) {
      alert("Failed: " + err.message);
    }
  }

  async handleUpload(e) {
    const files = e.target.files;
    if (files?.length) await this.uploadFiles(files);
    e.target.value = "";
  }

  handleDrop(files) {
    if (files?.length) this.uploadFiles(files);
  }

  async uploadFiles(files) {
    for (const file of files) {
      const formData = new FormData();
      formData.append("file", file);
      try {
        const res = await fetch(
          `/api/files/upload?path=${encodeURIComponent(this.currentPath)}`,
          { method: "POST", body: formData },
        );
        if (!res.ok) alert(`Upload failed: ${(await res.json()).error}`);
      } catch (err) {
        alert(`Upload failed: ${err.message}`);
      }
    }
    this.loadDir(this.currentPath);
  }
}

// =============================================================================
// STATS MANAGER
// =============================================================================

class StatsManager {
  constructor() {
    this.cpuEl = document.getElementById("stat-cpu");
    this.ramEl = document.getElementById("stat-ram");
    this.diskEl = document.getElementById("stat-disk");
    this.init();
  }

  init() {
    this.fetchStats();
    setInterval(() => this.fetchStats(), 5000);
  }

  async fetchStats() {
    try {
      const res = await fetch("/api/stats");
      if (!res.ok) return;
      const stats = await res.json();
      this.updateUI(stats);
    } catch {}
  }

  updateUI(stats) {
    if (this.cpuEl) {
      this.cpuEl.textContent = `${stats.cpu.usage}%`;
      this.cpuEl.title = `CPU: ${stats.cpu.usage}%`;
      this.updateClass(this.cpuEl, stats.cpu.usage);
    }
    if (this.ramEl) {
      this.ramEl.textContent = `${stats.memory.percent}%`;
      this.ramEl.title = `RAM: ${stats.memory.percent}%`;
      this.updateClass(this.ramEl, stats.memory.percent);
    }
    if (this.diskEl) {
      this.diskEl.textContent = `${stats.disk.percent}%`;
      this.diskEl.title = `Disk: ${stats.disk.percent}%`;
      this.updateClass(this.diskEl, stats.disk.percent, 80, 95);
    }
  }

  updateClass(el, value, warn = 70, danger = 90) {
    el.classList.remove("warning", "danger");
    if (value >= danger) el.classList.add("danger");
    else if (value >= warn) el.classList.add("warning");
  }
}

// =============================================================================
// CLIPBOARD MANAGER - OSC52 + History
// =============================================================================

class ClipboardManager {
  constructor() {
    this.history = [];
    this.maxHistory = 20;
    this.maxItemSize = 200 * 1024; // 200KB
    this.panel = null;
    this.toast = null;
    this.pendingCopy = null;
    this.init();
  }

  init() {
    this.createPanel();
    this.createToast();
  }

  createPanel() {
    this.panel = document.createElement("div");
    this.panel.id = "clipboard-panel";
    this.panel.className = "clipboard-panel hidden";
    this.panel.innerHTML = `
      <div class="clipboard-header">
        <h3>Clipboard History</h3>
        <button class="clipboard-close">&times;</button>
      </div>
      <div class="clipboard-list"></div>
    `;
    document.getElementById("app").appendChild(this.panel);

    this.panel
      .querySelector(".clipboard-close")
      .addEventListener("click", () => this.hidePanel());
  }

  createToast() {
    this.toast = document.createElement("div");
    this.toast.className = "clipboard-toast hidden";
    this.toast.innerHTML = `
      <span class="toast-message"></span>
      <button class="toast-copy">Copy</button>
    `;
    document.getElementById("app").appendChild(this.toast);

    this.toast.querySelector(".toast-copy").addEventListener("click", () => {
      if (this.pendingCopy) {
        this.copyWithGesture(this.pendingCopy);
      }
    });
  }

  // Handle OSC52 from terminal
  handleOsc52(data) {
    // Parse: c;<base64>
    const parts = data.split(";");
    if (parts.length < 2) return;

    const base64Data = parts.slice(1).join(";");

    try {
      // UTF-8 safe base64 decode - CRITICAL: Don't use atob() directly!
      const bytes = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));
      const text = new TextDecoder("utf-8").decode(bytes);

      // Size limit check
      if (text.length > this.maxItemSize) {
        this.showToast(
          "Content too large. Click to download.",
          "download",
          text,
        );
        return;
      }

      // Try clipboard API
      this.copyToClipboard(text);
    } catch (e) {
      console.error("OSC52 decode error:", e);
    }
  }

  async copyToClipboard(text) {
    // Add to history first
    this.addToHistory(text);

    try {
      await navigator.clipboard.writeText(text);
      this.showToast("Copied to clipboard!", "success");
    } catch (err) {
      // Clipboard API failed (no user gesture)
      console.warn("Clipboard API failed, showing fallback:", err);
      this.pendingCopy = text;
      this.showToast("Click to copy", "pending", text);
    }
  }

  copyWithGesture(text) {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        this.showToast("Copied!", "success");
        this.pendingCopy = null;
      })
      .catch((err) => {
        console.error("Copy failed even with gesture:", err);
        this.showToast("Copy failed", "error");
      });
  }

  addToHistory(text) {
    // Prevent duplicates
    const existing = this.history.findIndex((h) => h.text === text);
    if (existing !== -1) {
      this.history.splice(existing, 1);
    }

    this.history.unshift({
      text,
      timestamp: Date.now(),
      preview: text.substring(0, 100) + (text.length > 100 ? "..." : ""),
    });

    // Trim history
    if (this.history.length > this.maxHistory) {
      this.history.pop();
    }

    this.renderHistory();
  }

  renderHistory() {
    const list = this.panel.querySelector(".clipboard-list");
    list.innerHTML = this.history
      .map(
        (item, i) => `
      <div class="clipboard-item" data-index="${i}">
        <span class="item-preview">${this.escapeHtml(item.preview)}</span>
        <span class="item-time">${this.formatTime(item.timestamp)}</span>
        <button class="item-copy" data-index="${i}">Copy</button>
      </div>
    `,
      )
      .join("");

    list.querySelectorAll(".item-copy").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const idx = parseInt(e.target.dataset.index);
        this.copyWithGesture(this.history[idx].text);
      });
    });
  }

  showToast(message, type, data = null) {
    const toast = this.toast;
    const msgEl = toast.querySelector(".toast-message");
    const copyBtn = toast.querySelector(".toast-copy");

    msgEl.textContent = message;
    toast.className = `clipboard-toast ${type}`;
    copyBtn.style.display = type === "pending" ? "inline-block" : "none";

    toast.classList.remove("hidden");

    if (type === "success" || type === "error") {
      setTimeout(() => toast.classList.add("hidden"), 2000);
    }
  }

  hideToast() {
    this.toast.classList.add("hidden");
  }

  showPanel() {
    this.panel.classList.remove("hidden");
    this.renderHistory();
  }

  hidePanel() {
    this.panel.classList.add("hidden");
  }

  togglePanel() {
    this.panel.classList.toggle("hidden");
    if (!this.panel.classList.contains("hidden")) {
      this.renderHistory();
    }
  }

  escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  formatTime(timestamp) {
    const now = Date.now();
    const diff = now - timestamp;
    if (diff < 60000) return "just now";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return new Date(timestamp).toLocaleTimeString();
  }
}

// =============================================================================
// OPENCODE MANAGER - OpenCode panel integration
// =============================================================================

class OpenCodeManager {
  constructor() {
    this.panel = document.getElementById("opencode-panel");
    this.iframe = document.getElementById("opencode-iframe");
    this.status = document.getElementById("opencode-status");
    this.init();
  }

  init() {
    document
      .querySelector('[data-action="opencode"]')
      ?.addEventListener("click", () => this.toggle());
    this.panel
      ?.querySelector(".app-panel-close")
      ?.addEventListener("click", () => this.hide());
    this.checkHealth();
    setInterval(() => this.checkHealth(), 30000);
  }

  async checkHealth() {
    try {
      const res = await fetch("/api/apps/opencode/health");
      const data = await res.json();
      this.status.textContent =
        data.status === "running" ? "running" : "offline";
      this.status.className = `app-status ${data.status === "running" ? "online" : "offline"}`;
    } catch {
      this.status.textContent = "error";
      this.status.className = "app-status offline";
    }
  }

  show() {
    this.panel?.classList.remove("hidden");
    if (this.iframe && !this.iframe.src) {
      this.iframe.src = "/apps/opencode/";
    }
  }

  hide() {
    this.panel?.classList.add("hidden");
  }

  toggle() {
    this.panel?.classList.contains("hidden") ? this.show() : this.hide();
  }
}

// =============================================================================
// GIT MANAGER - Git panel integration
// =============================================================================

class GitManager {
  constructor() {
    this.panel = null;
    this.currentCwd = null;
    this.init();
  }

  init() {
    this.createPanel();
    document
      .querySelector('[data-action="git"]')
      ?.addEventListener("click", () => this.toggle());
  }

  createPanel() {
    this.panel = document.createElement("div");
    this.panel.id = "git-panel";
    this.panel.className = "side-panel hidden";
    this.panel.innerHTML = `
      <div class="panel-header">
        <h3>Git</h3>
        <span id="git-branch" class="git-branch"></span>
        <button class="panel-refresh" title="Refresh">↻</button>
        <button class="panel-close">&times;</button>
      </div>
      <div id="git-status" class="git-status"></div>
      <div id="git-diff" class="git-diff"></div>
      <div class="git-commit">
        <textarea id="git-message" placeholder="Commit message..."></textarea>
        <button id="git-commit-btn" class="btn btn-primary">Commit</button>
      </div>
    `;
    document.getElementById("app").appendChild(this.panel);

    this.panel
      .querySelector(".panel-close")
      .addEventListener("click", () => this.hide());
    this.panel
      .querySelector(".panel-refresh")
      .addEventListener("click", () => this.refresh());
    this.panel
      .querySelector("#git-commit-btn")
      .addEventListener("click", () => this.commit());
  }

  async show(cwd) {
    this.currentCwd =
      cwd || document.getElementById("directory")?.value || process.env.HOME;
    this.panel.classList.remove("hidden");
    await this.refresh();
  }

  hide() {
    this.panel.classList.add("hidden");
  }

  toggle() {
    this.panel.classList.contains("hidden") ? this.show() : this.hide();
  }

  async refresh() {
    if (!this.currentCwd) return;

    try {
      const res = await fetch(
        `/api/git/status?cwd=${encodeURIComponent(this.currentCwd)}`,
      );
      const data = await res.json();

      if (data.error) {
        this.panel.querySelector("#git-branch").textContent = "not a repo";
        this.panel.querySelector("#git-status").innerHTML =
          `<p class="error">${data.error}</p>`;
        return;
      }

      this.panel.querySelector("#git-branch").textContent = data.branch;
      this.renderStatus(data.files);
    } catch (err) {
      console.error("Git status error:", err);
    }
  }

  renderStatus(files) {
    const container = this.panel.querySelector("#git-status");
    if (files.length === 0) {
      container.innerHTML = '<p class="muted">No changes</p>';
      return;
    }

    container.innerHTML = files
      .map(
        (f) => `
      <div class="git-file" data-path="${f.path}">
        <span class="git-file-status ${this.statusClass(f.status)}">${f.status}</span>
        <span class="git-file-path">${f.path}</span>
        <button class="git-file-diff" title="View diff">diff</button>
        <button class="git-file-stage" title="Stage/Unstage">+/-</button>
      </div>
    `,
      )
      .join("");

    container.querySelectorAll(".git-file-diff").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const path = e.target.closest(".git-file").dataset.path;
        this.showDiff(path);
      });
    });

    container.querySelectorAll(".git-file-stage").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const path = e.target.closest(".git-file").dataset.path;
        const status = e.target
          .closest(".git-file")
          .querySelector(".git-file-status").textContent;
        this.toggleStage(path, status);
      });
    });
  }

  statusClass(status) {
    if (status.includes("M")) return "modified";
    if (status.includes("A")) return "added";
    if (status.includes("D")) return "deleted";
    if (status.includes("?")) return "untracked";
    return "";
  }

  async showDiff(path) {
    const url = `/api/git/diff?cwd=${encodeURIComponent(this.currentCwd)}&path=${encodeURIComponent(path)}`;
    const res = await fetch(url);
    const data = await res.json();

    const diffContainer = this.panel.querySelector("#git-diff");
    diffContainer.innerHTML = `<pre class="diff-content">${this.escapeHtml(data.diff || "No diff")}</pre>`;
  }

  async toggleStage(path, status) {
    const isStaged = !status.startsWith(" ") && !status.startsWith("?");
    const endpoint = isStaged ? "/api/git/unstage" : "/api/git/stage";

    await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: this.currentCwd, paths: [path] }),
    });

    await this.refresh();
  }

  async commit() {
    const message = this.panel.querySelector("#git-message").value.trim();
    if (!message) {
      alert("Commit message required");
      return;
    }

    const res = await fetch("/api/git/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: this.currentCwd, message }),
    });

    const data = await res.json();
    if (data.error) {
      alert(data.error + ": " + data.message);
    } else {
      this.panel.querySelector("#git-message").value = "";
      await this.refresh();
    }
  }

  escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
}

// =============================================================================
// TERMINAL MANAGER - Main orchestrator
// =============================================================================

class TerminalManager {
  constructor() {
    this.terminals = new Map();
    this.activeId = null;
    this.tabIndex = 0;
    this.workspaceIndex = 0;
    this.fontSize = parseInt(localStorage.getItem("opencode-font-size")) || 14;
    this.draggingTabId = null;
    this.draggingWorkspaceId = null;

    this.container = document.getElementById("terminal-container");
    this.tabs = document.getElementById("terminals-tabs");
    this.directoryInput = document.getElementById("directory");
    this.connectionStatus = document.getElementById("connection-status");

    this.tileManager = new TileManager(this.container);
    this.clipboardManager = new ClipboardManager();

    this.init();
  }

  init() {
    const lastDir = localStorage.getItem("opencode-web-dir");
    if (lastDir) this.directoryInput.value = lastDir;

    // Button handlers
    document
      .getElementById("new-terminal")
      ?.addEventListener("click", () => this.createTerminal());
    document
      .getElementById("browse")
      ?.addEventListener("click", () => this.openDirPicker());
    document
      .getElementById("dir-close")
      ?.addEventListener("click", () => this.closeDirPicker());
    document
      .getElementById("dir-cancel")
      ?.addEventListener("click", () => this.closeDirPicker());
    document
      .getElementById("dir-select")
      ?.addEventListener("click", () => this.selectDir());

    this.directoryInput?.addEventListener("change", () => {
      localStorage.setItem("opencode-web-dir", this.directoryInput.value);
    });

    // Toolbar action buttons
    this.setupToolbarActions();

    // Fullscreen
    document
      .getElementById("fullscreen-exit")
      ?.addEventListener("click", () => this.toggleFullscreen());

    // Mobile toolbar toggle
    const toolbarToggle = document.getElementById("toolbar-toggle");
    if (toolbarToggle) {
      toolbarToggle.addEventListener("click", () => {
        document.querySelector(".toolbar").classList.toggle("expanded");
        toolbarToggle.classList.toggle("active");
      });
    }

    // Help modal
    this.setupHelpModal();

    // Keyboard shortcuts
    this.setupKeyboardShortcuts();

    // Window resize
    let resizeTimeout;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        const active = this.terminals.get(this.activeId);
        if (active) {
          active.fitAddon.fit();
          this.sendResize(this.activeId);
        }
      }, 150);
    });

    // Virtual keyboard detection
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", () =>
        this.handleViewportResize(),
      );
    }

    // Initialize sub-managers
    this.extraKeys = new ExtraKeysManager(this);
    this.fileManager = new FileManager();

    // Mobile swipe support
    this.setupMobileSwipe();

    // Check for existing terminals
    this.checkExistingTerminals();
  }

  setupToolbarActions() {
    // Handle all buttons with data-action attribute (visible toolbar buttons)
    document.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.dataset.action;
        if (action === "file-manager") this.fileManager.open();
        else if (action === "clipboard") this.clipboardManager.togglePanel();
        else if (action === "copy") this.copySelection();
        else if (action === "paste") this.pasteClipboard();
        else if (action === "font-decrease") this.changeFontSize(-1);
        else if (action === "font-increase") this.changeFontSize(1);
        else if (action === "fullscreen") this.toggleFullscreen();
      });
    });
  }

  setupHelpModal() {
    const helpBtn = document.getElementById("help-btn");
    const helpModal = document.getElementById("help-modal");
    const helpClose = document.getElementById("help-close");
    const helpModalClose = document.getElementById("help-modal-close");

    if (helpBtn && helpModal) {
      helpBtn.addEventListener("click", () => this.openHelp());
    }

    if (helpClose) {
      helpClose.addEventListener("click", () => this.closeHelp());
    }

    if (helpModalClose) {
      helpModalClose.addEventListener("click", () => this.closeHelp());
    }

    // Close on modal background click
    if (helpModal) {
      helpModal.addEventListener("click", (e) => {
        if (e.target === helpModal) this.closeHelp();
      });
    }
  }

  openHelp() {
    document.getElementById("help-modal")?.classList.remove("hidden");
  }

  closeHelp() {
    document.getElementById("help-modal")?.classList.add("hidden");
  }

  setupKeyboardShortcuts() {
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.key === "n") {
        e.preventDefault();
        this.createTerminal();
      }
      if (e.ctrlKey && e.key === "w" && this.activeId) {
        e.preventDefault();
        this.closeTerminal(this.activeId);
      }
      if (e.ctrlKey && e.key === "g" && this.terminals.size >= 2) {
        e.preventDefault();
        this.groupWithPrevious();
      }
      if (e.ctrlKey && e.shiftKey && e.key === "G") {
        e.preventDefault();
        this.ungroupCurrent();
      }
      if (e.ctrlKey && e.shiftKey && e.key === "D") {
        e.preventDefault();
        this.splitWorkspace();
      }
      if (e.ctrlKey && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        this.switchToIndex(parseInt(e.key));
      }
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        this.switchToNext(e.shiftKey ? -1 : 1);
      }
      if (e.ctrlKey && e.key === "f") {
        e.preventDefault();
        this.toggleSearch();
      }
      if (e.key === "F11") {
        e.preventDefault();
        this.toggleFullscreen();
      }
      if (
        e.key === "Escape" &&
        document.body.classList.contains("fullscreen")
      ) {
        e.preventDefault();
        this.toggleFullscreen();
      }
      if (e.ctrlKey && (e.key === "+" || e.key === "=")) {
        e.preventDefault();
        this.changeFontSize(1);
      }
      if (e.ctrlKey && e.key === "-") {
        e.preventDefault();
        this.changeFontSize(-1);
      }
      if (e.key === "F1" || e.key === "?") {
        e.preventDefault();
        this.openHelp();
      }
    });
  }

  setupMobileSwipe() {
    let touchStartX = 0;
    let touchStartY = 0;

    this.container.addEventListener(
      "touchstart",
      (e) => {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
      },
      { passive: true },
    );

    this.container.addEventListener(
      "touchend",
      (e) => {
        const touchEndX = e.changedTouches[0].clientX;
        const touchEndY = e.changedTouches[0].clientY;
        const deltaX = touchEndX - touchStartX;
        const deltaY = touchEndY - touchStartY;

        // Only swipe if horizontal movement is dominant
        if (Math.abs(deltaX) > 50 && Math.abs(deltaX) > Math.abs(deltaY) * 2) {
          if (deltaX > 0)
            this.switchToNext(-1); // Swipe right = previous
          else this.switchToNext(1); // Swipe left = next
        }
      },
      { passive: true },
    );
  }

  async checkExistingTerminals() {
    try {
      const res = await fetch("/api/terminals");
      const terminals = await res.json();

      if (terminals.length > 0) {
        const reconnect = confirm(
          `Found ${terminals.length} existing terminal(s). Reconnect?`,
        );
        if (reconnect) {
          for (const t of terminals) {
            await this.reconnectToTerminal(t.id, t.cwd);
          }
          return;
        }
      }
    } catch (err) {
      console.error("Failed to check existing terminals:", err);
    }
    this.createTerminal();
  }

  async reconnectToTerminal(id, cwd) {
    // Each reconnected terminal gets its own workspace
    this.workspaceIndex++;
    const workspaceId = `ws-${this.workspaceIndex}`;

    const element = this.tileManager.createTile(id, workspaceId, false);
    const overlay = this.createOverlay(element.parentElement);

    const terminal = this.createXtermInstance();
    terminal.open(element);

    const fitAddon = terminal._fitAddon;
    fitAddon.fit();

    terminal.write("\x1b[33m[Reconnecting to existing terminal...]\x1b[0m\r\n");

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new ReconnectingWebSocket(
      `${protocol}//${location.host}/ws/terminals/${id}`,
      id,
      {
        onMessage: (data) => terminal.write(data),
        onStatusChange: (status, extra) =>
          this.handleStatusChange(id, status, extra),
      },
    );

    terminal.onData((data) => {
      let finalData = data;
      const mods = this.extraKeys?.modifiers;
      if (this.extraKeys && data.length === 1 && mods) {
        if (mods.ctrl) {
          const charCode = data.toUpperCase().charCodeAt(0);
          if (charCode >= 65 && charCode <= 90) {
            finalData = String.fromCharCode(charCode - 64);
          }
          this.extraKeys.resetModifiers();
        } else if (mods.alt) {
          finalData = "\x1b" + data;
          this.extraKeys.resetModifiers();
        } else if (mods.shift) {
          finalData = data.toUpperCase();
          this.extraKeys.resetModifiers();
        }
      }
      ws.send(JSON.stringify({ type: "input", data: finalData }));
    });

    this.tabIndex++;
    const tabNum = this.tabIndex;
    this.terminals.set(id, {
      terminal,
      fitAddon,
      ws,
      element,
      overlay,
      cwd,
      tabNum,
      workspaceId,
    });
    this.addTab(id, cwd, tabNum, workspaceId);
    this.switchTo(id);

    setTimeout(() => {
      fitAddon.fit();
      this.sendResize(id);

      const textarea = element.querySelector(".xterm-helper-textarea");
      if (textarea) {
        textarea.autocomplete = "off";
        textarea.autocorrect = "off";
        textarea.autocapitalize = "off";
        textarea.spellcheck = false;
      }
    }, 200);
  }

  createXtermInstance() {
    const terminal = new Terminal({
      theme: {
        background: "#0d1117",
        foreground: "#c9d1d9",
        cursor: "#58a6ff",
        cursorAccent: "#0d1117",
        selectionBackground: "#264f78",
        black: "#484f58",
        red: "#ff7b72",
        green: "#3fb950",
        yellow: "#d29922",
        blue: "#58a6ff",
        magenta: "#bc8cff",
        cyan: "#39c5cf",
        white: "#b1bac4",
        brightBlack: "#6e7681",
        brightRed: "#ffa198",
        brightGreen: "#56d364",
        brightYellow: "#e3b341",
        brightBlue: "#79c0ff",
        brightMagenta: "#d2a8ff",
        brightCyan: "#56d4dd",
        brightWhite: "#f0f6fc",
      },
      fontFamily:
        '"JetBrains Mono", "Symbols Nerd Font", "Cascadia Code", "Fira Code", Menlo, Monaco, "Courier New", monospace',
      fontSize: this.fontSize,
      lineHeight: 1.2,
      scrollback: 10000,
      cursorBlink: true,
      allowProposedApi: true,
      scrollOnUserInput: true,
      smoothScrollDuration: 0,
    });

    const fitAddon = new FitAddon.FitAddon();
    const webLinksAddon = new WebLinksAddon.WebLinksAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal._fitAddon = fitAddon;

    // OSC52 clipboard support (xterm.js 6.0+)
    if (terminal.parser?.registerOscHandler) {
      terminal.parser.registerOscHandler(52, (data) => {
        this.clipboardManager.handleOsc52(data);
        return true;
      });
    }

    return terminal;
  }

  createOverlay(parentElement) {
    const overlay = document.createElement("div");
    overlay.className = "terminal-overlay hidden";
    overlay.innerHTML = `
      <div class="overlay-content">
        <div class="overlay-icon"></div>
        <div class="overlay-message"></div>
        <div class="overlay-actions"></div>
      </div>
    `;
    parentElement.appendChild(overlay);
    return overlay;
  }

  updateOverlay(id, status, extra = {}) {
    const t = this.terminals.get(id);
    if (!t?.overlay) return;

    const overlay = t.overlay;
    const icon = overlay.querySelector(".overlay-icon");
    const message = overlay.querySelector(".overlay-message");
    const actions = overlay.querySelector(".overlay-actions");

    const overlayConfigs = {
      connected: { hidden: true },
      reconnecting: {
        icon: "🔄",
        message: `Reconnecting... (attempt ${extra.attempt}/${extra.maxRetries})`,
        actions: "",
      },
      failed: {
        icon: "❌",
        message: "Connection lost",
        actions: `
        <button class="btn" onclick="terminalManager.retryConnection('${id}')">Retry</button>
        <button class="btn" onclick="terminalManager.closeTerminal('${id}')">Close</button>
      `,
      },
      dead: {
        icon: "💀",
        message: "Terminal no longer exists",
        actions: `
        <button class="btn btn-primary" onclick="terminalManager.closeTerminal('${id}'); terminalManager.createTerminal()">New Terminal</button>
        <button class="btn" onclick="terminalManager.closeTerminal('${id}')">Close</button>
      `,
      },
      exited: {
        icon: "⏹️",
        message: `Process exited with code ${extra}`,
        actions: `
        <button class="btn btn-primary" onclick="terminalManager.closeTerminal('${id}'); terminalManager.createTerminal()">New Terminal</button>
        <button class="btn" onclick="terminalManager.closeTerminal('${id}')">Close</button>
      `,
      },
    };

    const config = overlayConfigs[status];
    if (config?.hidden) {
      overlay.classList.add("hidden");
    } else if (config) {
      overlay.classList.remove("hidden");
      icon.textContent = config.icon;
      message.textContent = config.message;
      actions.innerHTML = config.actions;
    }
  }

  handleStatusChange(id, status, extra) {
    this.updateOverlay(id, status, extra);
    this.updateConnectionStatus(status);

    const tab = this.tabs.querySelector(`[data-id="${id}"]`);
    if (tab) {
      tab.classList.remove("reconnecting", "disconnected");
      if (status === "reconnecting") tab.classList.add("reconnecting");
      else if (status === "failed" || status === "dead")
        tab.classList.add("disconnected");
    }
  }

  retryConnection(id) {
    this.terminals.get(id)?.ws?.retry();
  }

  // Create a new terminal in a new workspace (split=false) or current workspace (split=true)
  async createTerminal(split = false) {
    const cwd = this.directoryInput?.value.trim() || undefined;

    try {
      const res = await fetch("/api/terminals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, cols: 120, rows: 30 }),
      });

      if (!res.ok) throw new Error("Failed to create terminal");

      const { id } = await res.json();

      // Determine workspace ID
      let workspaceId;
      if (split && this.activeId) {
        // Add to current workspace
        workspaceId = this.terminals.get(this.activeId)?.workspaceId;
      }
      if (!workspaceId) {
        // New workspace
        this.workspaceIndex++;
        workspaceId = `ws-${this.workspaceIndex}`;
      }

      const element = this.tileManager.createTile(id, workspaceId, split);
      const overlay = this.createOverlay(element.parentElement);

      const terminal = this.createXtermInstance();
      terminal.open(element);

      const fitAddon = terminal._fitAddon;
      fitAddon.fit();

      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new ReconnectingWebSocket(
        `${protocol}//${location.host}/ws/terminals/${id}`,
        id,
        {
          onMessage: (data) => terminal.write(data),
          onStatusChange: (status, extra) =>
            this.handleStatusChange(id, status, extra),
        },
      );

      terminal.onData((data) => {
        let finalData = data;
        if (this.extraKeys && data.length === 1) {
          const mods = this.extraKeys.modifiers;
          if (mods.ctrl) {
            const charCode = data.toUpperCase().charCodeAt(0);
            if (charCode >= 65 && charCode <= 90) {
              finalData = String.fromCharCode(charCode - 64);
            }
            this.extraKeys.resetModifiers();
          } else if (mods.alt) {
            finalData = "\x1b" + data;
            this.extraKeys.resetModifiers();
          } else if (mods.shift) {
            finalData = data.toUpperCase();
            this.extraKeys.resetModifiers();
          }
        }
        ws.send(JSON.stringify({ type: "input", data: finalData }));
      });

      this.tabIndex++;
      const tabNum = this.tabIndex;
      this.terminals.set(id, {
        terminal,
        fitAddon,
        ws,
        element,
        overlay,
        cwd,
        tabNum,
        workspaceId,
      });

      // Only add tab for new workspaces, not splits
      if (!split) {
        this.addTab(id, cwd, tabNum, workspaceId);
      } else {
        // Update tab badge count for split workspaces
        this.updateTabGroups();
      }
      this.switchTo(id);
    } catch (err) {
      console.error("Failed to create terminal:", err);
      alert("Failed to create terminal: " + err.message);
    }
  }

  addTab(id, cwd, tabNum, workspaceId) {
    const tab = document.createElement("div");
    tab.className = "tab";
    tab.dataset.id = id;
    tab.dataset.workspaceId = workspaceId;
    tab.dataset.index = tabNum % 9 || 9;

    const label = cwd ? cwd.split("/").pop() || "/" : "Terminal";
    tab.innerHTML = `
      <span class="tab-dot"></span>
      <span class="tab-index">${tabNum}</span>
      <span class="tab-label">${label}</span>
      <span class="tab-count"></span>
      <button class="tab-close" title="Close (Ctrl+W)">&times;</button>
    `;

    tab
      .querySelector(".tab-label")
      .addEventListener("click", () => this.switchTo(id));
    tab
      .querySelector(".tab-index")
      .addEventListener("click", () => this.switchTo(id));
    tab.querySelector(".tab-close").addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeWorkspace(workspaceId);
    });

    // Drag and drop for merging workspaces
    tab.draggable = true;
    tab.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", workspaceId);
      tab.classList.add("dragging");
      this.draggingTabId = id;
      this.draggingWorkspaceId = workspaceId;
    });
    tab.addEventListener("dragend", () => {
      tab.classList.remove("dragging");
      this.draggingTabId = null;
      this.draggingWorkspaceId = null;
      this.clearDropTargets();
    });
    tab.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (
        this.draggingWorkspaceId &&
        this.draggingWorkspaceId !== workspaceId
      ) {
        tab.classList.add("drop-target");
      }
    });
    tab.addEventListener("dragleave", () => {
      tab.classList.remove("drop-target");
    });
    tab.addEventListener("drop", (e) => {
      e.preventDefault();
      const draggedWsId = e.dataTransfer.getData("text/plain");
      if (draggedWsId && draggedWsId !== workspaceId) {
        // Merge dragged workspace into this workspace
        this.mergeWorkspacesUI(draggedWsId, workspaceId);
      }
      this.clearDropTargets();
    });

    this.tabs.appendChild(tab);
    this.updateTabGroups();
  }

  clearDropTargets() {
    this.tabs
      .querySelectorAll(".tab")
      .forEach((t) => t.classList.remove("drop-target", "dragging"));
  }

  updateTabGroups() {
    // Count terminals per workspace
    const workspaceCounts = new Map();
    this.terminals.forEach((t) => {
      if (t.workspaceId) {
        const count = workspaceCounts.get(t.workspaceId) || 0;
        workspaceCounts.set(t.workspaceId, count + 1);
      }
    });

    // Update tab colors based on terminal count
    this.tabs.querySelectorAll(".tab").forEach((tab) => {
      const workspaceId = tab.dataset.workspaceId;
      const dot = tab.querySelector(".tab-dot");
      const countBadge = tab.querySelector(".tab-count");
      const count = workspaceCounts.get(workspaceId) || 0;

      if (count > 1) {
        // Multicolor workspace tab (multiple terminals)
        tab.classList.add("multicolor");
        tab.classList.remove("grouped");
        // Use predefined colors for gradient
        const colorIndex = parseInt(workspaceId?.replace("ws-", "") || "1") - 1;
        const color1 = GROUP_COLORS[colorIndex % GROUP_COLORS.length];
        const color2 = GROUP_COLORS[(colorIndex + 1) % GROUP_COLORS.length];
        const color3 = GROUP_COLORS[(colorIndex + 2) % GROUP_COLORS.length];
        tab.style.setProperty("--color-1", color1);
        tab.style.setProperty("--color-2", color2);
        tab.style.setProperty("--color-3", color3);

        if (countBadge) countBadge.textContent = count;
        if (dot) dot.style.backgroundColor = "transparent";
      } else {
        // Single terminal workspace
        tab.classList.remove("multicolor", "grouped");
        if (dot) dot.style.backgroundColor = "#58a6ff";
        tab.style.removeProperty("--group-color");
        if (countBadge) countBadge.textContent = "";
      }
    });
  }

  groupWithPrevious() {
    const ids = Array.from(this.terminals.keys());
    const currentIndex = ids.indexOf(this.activeId);
    if (currentIndex > 0) {
      const prevId = ids[currentIndex - 1];
      this.tileManager.mergeTiles(this.activeId, prevId);
      this.updateTabGroups();
    }
  }

  ungroupCurrent() {
    if (this.activeId) {
      this.tileManager.removeFromGroup(this.activeId);
      this.updateTabGroups();
    }
  }

  splitWorkspace() {
    // Create a new terminal in the same workspace (splits the active tile)
    if (!this.activeId) return;
    this.createTerminal(true); // true = split current workspace
  }

  // Close all terminals in a workspace
  closeWorkspace(workspaceId) {
    const terminalsToClose = [];
    this.terminals.forEach((t, id) => {
      if (t.workspaceId === workspaceId) {
        terminalsToClose.push(id);
      }
    });

    // Close all terminals in this workspace
    for (const id of terminalsToClose) {
      this.closeTerminal(id);
    }

    // Remove the tab
    this.tabs.querySelector(`[data-workspace-id="${workspaceId}"]`)?.remove();
    this.updateTabGroups();
  }

  // Merge one workspace into another (for drag-drop merging)
  mergeWorkspacesUI(fromWorkspaceId, toWorkspaceId) {
    // Update all terminals from the source workspace to the target workspace
    this.terminals.forEach((t, id) => {
      if (t.workspaceId === fromWorkspaceId) {
        t.workspaceId = toWorkspaceId;
      }
    });

    // Merge tiles in tile manager
    this.tileManager.mergeWorkspaces(fromWorkspaceId, toWorkspaceId);

    // Remove the old tab
    this.tabs
      .querySelector(`[data-workspace-id="${fromWorkspaceId}"]`)
      ?.remove();

    // Update tab display
    this.updateTabGroups();

    // Show the merged workspace
    this.tileManager.showWorkspace(toWorkspaceId);
  }

  switchTo(id) {
    if (!this.terminals.has(id)) return;

    this.activeId = id;
    const t = this.terminals.get(id);
    if (t?.workspaceId) {
      this.tileManager.showWorkspace(t.workspaceId);
    }
    this.tileManager.setActive(id);

    // Highlight tab by workspaceId (works for multi-terminal workspaces)
    const activeWorkspaceId = t?.workspaceId;
    this.tabs.querySelectorAll(".tab").forEach((tab) => {
      tab.classList.toggle(
        "active",
        tab.dataset.workspaceId === activeWorkspaceId,
      );
    });

    const active = this.terminals.get(id);
    if (active) {
      active.fitAddon.fit();
      active.terminal.focus();
      this.sendResize(id);
      this.updateConnectionStatus(
        active.ws?.readyState === WebSocket.OPEN ? "connected" : "disconnected",
      );
    }
  }

  switchToIndex(index) {
    const tab = this.tabs.querySelector(`[data-index="${index}"]`);
    if (tab) this.switchTo(tab.dataset.id);
  }

  switchToNext(direction) {
    const ids = Array.from(this.terminals.keys());
    if (ids.length < 2) return;
    const currentIndex = ids.indexOf(this.activeId);
    const newIndex = (currentIndex + direction + ids.length) % ids.length;
    this.switchTo(ids[newIndex]);
  }

  async closeTerminal(id) {
    const t = this.terminals.get(id);
    if (!t) return;

    t.ws?.close();
    this.tileManager.removeTile(id);

    this.tabs.querySelector(`[data-id="${id}"]`)?.remove();
    this.updateTabGroups();

    try {
      await fetch(`/api/terminals/${id}`, { method: "DELETE" });
    } catch {}

    this.terminals.delete(id);

    if (this.activeId === id) {
      const remaining = Array.from(this.terminals.keys());
      if (remaining.length > 0) this.switchTo(remaining[0]);
      else {
        this.activeId = null;
        this.updateConnectionStatus("disconnected");
      }
    }
  }

  sendResize(id) {
    const t = this.terminals.get(id);
    if (!t?.ws) return;
    const { cols, rows } = t.terminal;
    t.ws.send(JSON.stringify({ type: "resize", cols, rows }));
  }

  updateConnectionStatus(status) {
    if (!this.connectionStatus) return;
    this.connectionStatus.className = "status-dot " + status;
    this.connectionStatus.title =
      status.charAt(0).toUpperCase() + status.slice(1);
  }

  changeFontSize(delta) {
    this.fontSize = Math.max(8, Math.min(24, this.fontSize + delta));
    localStorage.setItem("opencode-font-size", this.fontSize.toString());
    for (const [, t] of this.terminals) {
      t.terminal.options.fontSize = this.fontSize;
      t.fitAddon.fit();
    }
    if (this.activeId) this.sendResize(this.activeId);
  }

  handleViewportResize() {
    if (!window.visualViewport) return;

    const viewport = window.visualViewport;
    const windowHeight = window.innerHeight;
    const viewportHeight = viewport.height;
    const keyboardHeight = windowHeight - viewportHeight - viewport.offsetTop;

    const extraKeys = document.getElementById("extra-keys");

    if (keyboardHeight > 100) {
      extraKeys.style.position = "fixed";
      extraKeys.style.bottom = `${keyboardHeight}px`;
      extraKeys.style.left = "0";
      extraKeys.style.right = "0";
      extraKeys.style.zIndex = "1000";
      this.container.style.height = `calc(${viewportHeight}px - var(--toolbar-height, 50px) - var(--extra-keys-height, 52px))`;
      document.body.classList.add("virtual-keyboard-open");
    } else {
      extraKeys.style.cssText = "";
      this.container.style.height = "";
      document.body.classList.remove("virtual-keyboard-open");
    }

    const active = this.terminals.get(this.activeId);
    if (active) {
      setTimeout(() => {
        active.fitAddon.fit();
        this.sendResize(this.activeId);
      }, 50);
    }
  }

  copySelection() {
    const active = this.terminals.get(this.activeId);
    if (!active) return;
    const selection = active.terminal.getSelection();
    if (selection)
      navigator.clipboard.writeText(selection).catch(console.error);
  }

  async pasteClipboard() {
    const active = this.terminals.get(this.activeId);
    if (!active?.ws) return;
    try {
      const text = await navigator.clipboard.readText();
      active.ws.send(JSON.stringify({ type: "input", data: text }));
    } catch (err) {
      console.error("Paste failed:", err);
    }
  }

  toggleFullscreen() {
    document.body.classList.toggle("fullscreen");
    const exitBtn = document.getElementById("fullscreen-exit");
    if (exitBtn)
      exitBtn.classList.toggle(
        "hidden",
        !document.body.classList.contains("fullscreen"),
      );
    const active = this.terminals.get(this.activeId);
    if (active)
      setTimeout(() => {
        active.fitAddon.fit();
        this.sendResize(this.activeId);
      }, 100);
  }

  toggleSearch() {
    const searchBar = document.getElementById("search-bar");
    searchBar?.classList.toggle("hidden");
    if (!searchBar?.classList.contains("hidden"))
      document.getElementById("search-input")?.focus();
  }

  async openDirPicker() {
    document.getElementById("dir-modal")?.classList.remove("hidden");
    await this.loadDir(this.directoryInput?.value || "/");
  }

  closeDirPicker() {
    document.getElementById("dir-modal")?.classList.add("hidden");
  }

  async loadDir(path) {
    try {
      const res = await fetch(`/api/browse?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (data.error) return alert(data.error);

      this.currentDirPath = data.path;
      this.renderDirBreadcrumb(data.path);
      this.renderDirList(data);
    } catch (err) {
      console.error("Failed to load directory:", err);
    }
  }

  renderDirBreadcrumb(path) {
    const parts = path.split("/").filter(Boolean);
    let html = '<a data-path="/">/</a>';
    let currentPath = "";
    for (const part of parts) {
      currentPath += "/" + part;
      html += ` / <a data-path="${currentPath}">${part}</a>`;
    }

    const breadcrumb = document.getElementById("dir-breadcrumb");
    if (breadcrumb) {
      breadcrumb.innerHTML = html;
      breadcrumb
        .querySelectorAll("a")
        .forEach((a) =>
          a.addEventListener("click", () => this.loadDir(a.dataset.path)),
        );
    }
  }

  renderDirList(data) {
    const list = document.getElementById("dir-list");
    if (!list) return;
    list.innerHTML = "";

    if (data.path !== "/") {
      const parent = data.path.split("/").slice(0, -1).join("/") || "/";
      const parentEl = document.createElement("div");
      parentEl.className = "dir-item";
      parentEl.innerHTML = "📁 ..";
      parentEl.addEventListener("dblclick", () => this.loadDir(parent));
      list.appendChild(parentEl);
    }

    for (const dir of data.dirs) {
      const el = document.createElement("div");
      el.className = "dir-item";
      el.innerHTML = `📁 ${dir}`;
      el.addEventListener("click", () => {
        list
          .querySelectorAll(".dir-item")
          .forEach((i) => i.classList.remove("selected"));
        el.classList.add("selected");
        this.selectedDir = data.path + "/" + dir;
      });
      el.addEventListener("dblclick", () =>
        this.loadDir(data.path + "/" + dir),
      );
      list.appendChild(el);
    }
  }

  selectDir() {
    const dir = this.selectedDir || this.currentDirPath;
    if (dir) {
      this.directoryInput.value = dir;
      localStorage.setItem("opencode-web-dir", dir);
    }
    this.closeDirPicker();
  }
}

// =============================================================================
// INITIALIZATION
// =============================================================================

function initLucideIcons() {
  if (typeof lucide !== "undefined") {
    lucide.createIcons();
    return true;
  }
  return false;
}

document.addEventListener("DOMContentLoaded", () => {
  if (!initLucideIcons()) {
    let retries = 0;
    const tryInit = () => {
      if (initLucideIcons()) return;
      retries++;
      if (retries < 5) {
        setTimeout(tryInit, 100 * Math.pow(2, retries));
      } else {
        // Fallback icons
        const fallbacks = {
          plus: "+",
          menu: "≡",
          folder: "📁",
          "folder-open": "📂",
          "more-horizontal": "⋯",
          "chevron-up": "↑",
          "chevron-down": "↓",
          "chevron-left": "←",
          "chevron-right": "→",
          x: "×",
          copy: "📋",
          "clipboard-paste": "📥",
          "zoom-in": "+",
          "zoom-out": "-",
          "maximize-2": "⛶",
          "minimize-2": "⛶",
          upload: "↑",
          "folder-plus": "📁+",
          "refresh-cw": "↻",
        };
        document.querySelectorAll("[data-lucide]").forEach((el) => {
          const icon = el.getAttribute("data-lucide");
          if (fallbacks[icon]) {
            el.textContent = fallbacks[icon];
            el.style.fontSize = "16px";
          }
        });
      }
    };
    setTimeout(tryInit, 100);
  }

  window.terminalManager = new TerminalManager();
  window.statsManager = new StatsManager();
  window.openCodeManager = new OpenCodeManager();
  window.gitManager = new GitManager();
});
