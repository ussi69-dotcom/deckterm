// DeckTerm - Floating Tiling Window Manager
// Version 2.0 - Complete rewrite with smart tiling, groups, and mobile support

// =============================================================================
// DEBUG PANEL (temporary - remove after fixing)
// =============================================================================
(function () {
  const APP_VERSION = "20260119a";
  const DEBUG_MODE = location.search.includes("debug=1");
  if (!DEBUG_MODE) return;

  const originalLog = console.log;
  console.log = function (...args) {
    originalLog.apply(console, args);
    const msg = args
      .map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a)))
      .join(" ");
    if (msg.includes("[ExtraKeys]") || msg.includes("[Debug]")) {
      const panel = document.getElementById("debug-panel");
      const log = document.getElementById("debug-log");
      if (panel && log) {
        panel.classList.add("visible");
        const line = document.createElement("div");
        line.textContent = new Date().toLocaleTimeString() + " " + msg;
        log.appendChild(line);
        log.scrollTop = log.scrollHeight;
        // Keep only last 20 lines
        while (log.children.length > 20) log.removeChild(log.firstChild);
      }
    }
  };

  // Track where keyboard input goes
  document.addEventListener(
    "input",
    (e) => {
      console.log(
        "[Debug] INPUT event on:",
        e.target.tagName,
        e.target.className,
        "value:",
        e.data,
      );
    },
    true,
  );

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key.length === 1 || e.key === "Enter") {
        console.log(
          "[Debug] KEYDOWN:",
          e.key,
          "target:",
          e.target.tagName,
          e.target.className,
        );
      }
    },
    true,
  );

  console.log("[Debug] App version:", APP_VERSION);
})();

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

const TERMINAL_FONT_FAMILY =
  '"JetBrains Mono", "Symbols Nerd Font", "Cascadia Code", "Fira Code", Menlo, Monaco, "Courier New", monospace';
const TERMINAL_LINE_HEIGHT = 1.2;
// Scrollback-search match highlighting (GitHub-dark yellows; the overview
// ruler colors are required fields of the SearchAddon decorations API).
const TERMINAL_SEARCH_DECORATIONS = {
  matchBackground: "#5a4a00",
  matchOverviewRuler: "#d29922",
  activeMatchBackground: "#9e6a03",
  activeMatchColorOverviewRuler: "#f0c674",
};
const TERMINAL_PADDING_X = 16;
const TERMINAL_PADDING_Y = 16;
const FONT_METRIC_WAIT_MS = 350;
const DESKTOP_MAX_TERMINAL_COLS = 240;
const DESKTOP_MAX_TERMINAL_ROWS = 60;
const DIRECTORY_DRAFT_LOCK_MS = 800;
// Quick-open (Ctrl+P) file-tree cache TTL — the git branch cache never
// expires (branch switches invalidate it explicitly), but the tree fetch
// walks the live filesystem, so it is re-fetched after this window.
const COMMAND_PALETTE_TREE_TTL_MS = 30000;
// SurfaceWindow id for the IDE Explorer pop-out (slice 3). Distinct from the
// terminal-mode "files" window so their persisted geometries don't collide.
const IDE_EXPLORER_WINDOW_ID = "ide-explorer";
const APP_DEFAULT_TERMINAL_COLS =
  window.TerminalSizing?.DEFAULT_TERMINAL_COLS || 120;
const APP_DEFAULT_TERMINAL_ROWS =
  window.TerminalSizing?.DEFAULT_TERMINAL_ROWS || 30;

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

const DEBUG = location.search.includes("debug=1");
const dbg = (...args) => {
  if (DEBUG) console.log("[deckterm]", ...args);
};

// WebGL2 capability probe for the `terminal.renderer` "auto" setting — cached
// after the first call so it only runs once per page load, not once per
// terminal. A throwaway canvas never gets attached to the DOM.
let _cachedWebgl2ProbeResult = null;
function probeWebgl2Support() {
  if (_cachedWebgl2ProbeResult !== null) return _cachedWebgl2ProbeResult;
  try {
    const canvas = document.createElement("canvas");
    _cachedWebgl2ProbeResult = Boolean(canvas.getContext("webgl2"));
  } catch {
    _cachedWebgl2ProbeResult = false;
  }
  return _cachedWebgl2ProbeResult;
}
const TerminalColors =
  window.TerminalColors ||
  (() => {
    const SIGNAL_PRIORITIES = {
      agent: 1,
      running: 2,
      ports: 3,
      worktree: 4,
    };
    const palette = [
      "#58a6ff",
      "#3fb950",
      "#d29922",
      "#bc8cff",
      "#f778ba",
      "#79c0ff",
      "#7ee787",
      "#ffa657",
      "#ff7b72",
      "#a371f7",
    ];

    const hashCwdToColor = (cwd) => {
      const input = cwd || "terminal";
      let hash = 2166136261;
      for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      const index = (hash >>> 0) % palette.length;
      return palette[index];
    };

    const blendWorkspaceColors = (colors, maxColors = 3) => {
      const unique = [];
      const seen = new Set();
      for (const color of colors) {
        if (!color || seen.has(color)) continue;
        seen.add(color);
        unique.push(color);
        if (unique.length >= maxColors) break;
      }
      return unique.length > 0 ? unique : [palette[0]];
    };

    const hexToRgba = (hex, alpha = 1) => {
      const raw = (hex || "#58a6ff").replace("#", "");
      if (raw.length !== 6) return `rgba(88, 166, 255, ${alpha})`;
      const r = parseInt(raw.slice(0, 2), 16);
      const g = parseInt(raw.slice(2, 4), 16);
      const b = parseInt(raw.slice(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    };

    const normalizePorts = (ports) => {
      if (!Array.isArray(ports)) return [];
      return [
        ...new Set(
          ports
            .map((port) => Number(port))
            .filter((port) => Number.isInteger(port) && port > 0),
        ),
      ].sort((left, right) => left - right);
    };

    const formatAgentLabel = (agentName, agentState) => {
      if (!agentName || !agentState) return null;
      const normalizedAgent =
        String(agentName).trim().toLowerCase() === "claude"
          ? "Claude"
          : String(agentName).trim().toLowerCase() === "codex"
            ? "Codex"
            : null;
      if (!normalizedAgent) return null;
      return normalizedAgent;
    };

    const getWorkspaceSignalDescriptors = ({
      running = false,
      busy = false,
      agentName = null,
      agentState = null,
      ports = [],
      isWorktree = false,
    } = {}) => {
      const isRunning = Boolean(running || busy);
      const descriptors = [];
      const agentLabel = formatAgentLabel(agentName, agentState);
      if (agentLabel) {
        const normalizedAgentState = String(agentState).trim().toLowerCase();
        descriptors.push({
          key:
            normalizedAgentState === "responding"
              ? "agent-responding"
              : "agent",
          label: agentLabel,
          priority: SIGNAL_PRIORITIES.agent,
        });
      }
      if (isRunning) {
        descriptors.push({
          key: "running",
          label: "Running",
          priority: SIGNAL_PRIORITIES.running,
        });
      }

      const normalizedPorts = normalizePorts(ports);
      if (normalizedPorts.length > 0) {
        descriptors.push({
          key: `ports:${normalizedPorts.join(",")}`,
          label: `Ports ${normalizedPorts.join(", ")}`,
          priority: SIGNAL_PRIORITIES.ports,
        });
      }

      if (isWorktree) {
        descriptors.push({
          key: "worktree",
          label: "Worktree",
          priority: SIGNAL_PRIORITIES.worktree,
        });
      }

      return descriptors;
    };

    const getPrimaryWorkspaceSignal = ({
      running = false,
      busy = false,
      agentName = null,
      agentState = null,
      ports = [],
      isWorktree = false,
      cwd,
    } = {}) => ({
      color: hashCwdToColor(cwd),
      primarySignal:
        getWorkspaceSignalDescriptors({
          running,
          busy,
          agentName,
          agentState,
          ports,
          isWorktree,
        })[0] || null,
    });

    return {
      hashCwdToColor,
      blendWorkspaceColors,
      hexToRgba,
      normalizePorts,
      getWorkspaceSignalDescriptors,
      getPrimaryWorkspaceSignal,
    };
  })();

if (!window.TerminalColors) {
  window.TerminalColors = TerminalColors;
}

const inputFallbackHelpers =
  window.InputFallback ||
  (() => {
    const shouldUseMobileInputFallback = ({
      isMobile = false,
      hasTouch = false,
      isVirtualKeyboardOpen = false,
    } = {}) => Boolean((isMobile && hasTouch) || isVirtualKeyboardOpen);

    return { shouldUseMobileInputFallback };
  })();

const normalizeWorkspacePorts = (ports) => {
  if (typeof TerminalColors.normalizePorts === "function") {
    return TerminalColors.normalizePorts(ports);
  }
  if (!Array.isArray(ports)) return [];
  return [
    ...new Set(
      ports
        .map((port) => Number(port))
        .filter((port) => Number.isInteger(port) && port > 0),
    ),
  ].sort((left, right) => left - right);
};

const ACTION_BUTTON_CONFIG = Object.freeze({
  files: Object.freeze({
    label: "Files",
    icon: "folder-open",
    action: "file-manager",
    desktopId: "desktop-files-btn",
    mobileId: "mobile-files-btn",
    toolsId: "tools-sheet-files",
    desktopTone: "primary",
  }),
  git: Object.freeze({
    label: "Git",
    icon: "git-branch",
    action: "git",
    desktopId: "desktop-git-btn",
    mobileId: "mobile-git-btn",
    toolsId: "tools-sheet-git",
    desktopTone: "primary",
  }),
  palette: Object.freeze({
    label: "Palette",
    icon: "search",
    action: "palette",
    desktopId: "command-palette-trigger",
    toolsId: "tools-sheet-palette",
    desktopTone: "secondary",
  }),
  tasks: Object.freeze({
    label: "Tasks",
    icon: "list-checks",
    action: "tasks",
    toolsId: "tools-sheet-tasks",
    desktopTone: "secondary",
  }),
  setup: Object.freeze({
    label: "Setup",
    icon: "shield-check",
    action: "setup",
    toolsId: "tools-sheet-setup",
    desktopTone: "secondary",
  }),
  settings: Object.freeze({
    label: "Settings",
    icon: "settings",
    action: "settings",
    toolsId: "tools-sheet-settings",
    desktopTone: "secondary",
  }),
  clipboard: Object.freeze({
    label: "Clipboard",
    icon: "clipboard",
    action: "clipboard",
    toolsId: "tools-sheet-clipboard",
    desktopTone: "secondary",
  }),
  "toggle-extra-keys": Object.freeze({
    label: "Extra Keys",
    icon: "keyboard",
    action: "toggle-extra-keys",
    toolsId: "tools-sheet-extra-keys",
    desktopTone: "secondary",
  }),
  "wrap-lines": Object.freeze({
    label: "Wrap",
    icon: "wrap-text",
    action: "wrap-lines",
    toolsId: "tools-sheet-wrap",
    desktopTone: "secondary",
  }),
  "dock-sessions": Object.freeze({
    label: "Dock",
    icon: "panel-bottom",
    action: "dock-sessions",
    toolsId: "tools-sheet-dock-sessions",
    desktopTone: "secondary",
  }),
  fullscreen: Object.freeze({
    label: "Fullscreen",
    icon: "maximize-2",
    action: "fullscreen",
    toolsId: "tools-sheet-fullscreen",
    desktopTone: "secondary",
  }),
  help: Object.freeze({
    label: "Help",
    icon: "help-circle",
    action: "help",
    toolsId: "tools-sheet-help",
    desktopTone: "secondary",
  }),
  "linked-view": Object.freeze({
    label: "Linked View",
    icon: "copy-plus",
    action: "linked-view",
    toolsId: "tools-sheet-linked-view",
    desktopTone: "secondary",
  }),
  paste: Object.freeze({
    label: "Paste",
    icon: "clipboard-paste",
    action: "paste",
    mobileId: "mobile-paste-btn",
    toolsId: "tools-sheet-paste",
    desktopTone: "secondary",
  }),
  copy: Object.freeze({
    label: "Copy",
    icon: "copy",
    action: "copy",
    toolsId: "tools-sheet-copy",
    desktopTone: "secondary",
  }),
  more: Object.freeze({
    label: "More",
    icon: "ellipsis",
    action: "toggle-tools-sheet",
    desktopId: "desktop-more-btn",
    mobileId: "mobile-more-btn",
    desktopTone: "secondary",
  }),
});

const FIXED_TOOLS_SHEET_ACTION_IDS = Object.freeze(["copy"]);

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
    this.heartbeatSocket = null;
    this.intentionallyClosed = false;
    this.openedOnce = false;
    this.awaitingReconnectReady = false;
    this.connect();
  }

  connect() {
    if (this.intentionallyClosed) return;
    const isReconnectTransport = this.openedOnce || this.retryCount > 0;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();

    const previousSocket = this.ws;
    this.ws = null;

    // Replacing a connecting/open transport must invalidate it before close
    // can synchronously fire. Every callback below is generation-bound, so a
    // late event from this previous socket cannot mutate the new connection.
    if (
      previousSocket &&
      previousSocket.readyState < WebSocket.CLOSING
    ) {
      try {
        previousSocket.close();
      } catch {}
    }

    const socket = new WebSocket(this.url);
    this.ws = socket;

    socket.onopen = () => {
      if (!this.isCurrentSocket(socket)) return;
      this.startHeartbeat(socket);
      this.openedOnce = true;
      this.awaitingReconnectReady = isReconnectTransport;
      this.callbacks.onTransportOpen?.(isReconnectTransport);
      if (!isReconnectTransport && this.isCurrentSocket(socket)) {
        this.markConnectionReady(false, socket);
      }
    };
    socket.onmessage = (e) => {
      if (!this.isCurrentSocket(socket)) return;
      try {
        const data = JSON.parse(e.data);
        if (data.type === "ping") {
          socket.send(JSON.stringify({ type: "pong" }));
          return;
        }
        if (data.type === "pong") {
          this.clearHeartbeatTimeout(socket);
          return;
        }
        if (data.type === "reconnect_lifecycle") {
          this.callbacks.onLifecycle?.(data);
          if (
            data.phase === "ready" &&
            this.awaitingReconnectReady &&
            this.isCurrentSocket(socket)
          ) {
            this.markConnectionReady(true, socket);
          }
          return;
        }
        if (data.type === "terminal_state") {
          this.callbacks.onTerminalState?.(data);
          return;
        }
        if (data.type === "exit") {
          this.intentionallyClosed = true;
          this.awaitingReconnectReady = false;
          this.stopHeartbeat(socket);
          this.callbacks.onStatusChange("exited", data.code);
          return;
        }
        if (data.type === "terminal_dead") {
          this.intentionallyClosed = true;
          this.awaitingReconnectReady = false;
          this.stopHeartbeat(socket);
          this.callbacks.onStatusChange("dead");
          return;
        }
        if (data.type === "session_handoff") {
          this.intentionallyClosed = true;
          this.awaitingReconnectReady = false;
          this.stopHeartbeat(socket);
          this.callbacks.onStatusChange("taken_over", data);
          socket.close();
          return;
        }
      } catch {}
      this.callbacks.onMessage(e.data);
    };
    socket.onclose = () => {
      if (socket !== this.ws) return;
      this.awaitingReconnectReady = false;
      this.stopHeartbeat(socket);
      if (!this.intentionallyClosed) this.scheduleReconnect(socket);
    };
    socket.onerror = () => {};
  }

  isCurrentSocket(socket) {
    return Boolean(socket && socket === this.ws && !this.intentionallyClosed);
  }

  scheduleReconnect(socket = this.ws) {
    if (!this.isCurrentSocket(socket)) return;
    if (this.retryCount >= this.maxRetries) {
      this.awaitingReconnectReady = false;
      this.callbacks.onStatusChange("failed");
      return;
    }
    const delay = Math.min(
      this.baseDelay * Math.pow(2, this.retryCount),
      this.maxDelay,
    );
    this.retryCount++;

    // From the 3rd failed attempt on, classify whether this is permanent
    // (terminal gone, or access blocked because the server isn't
    // bootstrapped / denies us) versus a transient drop. A failed WS upgrade
    // surfaces only as "Expected 101", so we probe over HTTP instead of
    // looping pointlessly. Re-classifying every later attempt matters: when
    // the outage starts server-side, attempt 3's probe also fails (→ retry),
    // and the server may come back only to report the terminal as ended —
    // without re-checking, the client would churn to 10/10 "Connection lost"
    // instead of switching to the accurate dead/blocked overlay.
    if (this.retryCount >= 3) {
      this.classifyReconnect().then((outcome) => {
        if (!this.isCurrentSocket(socket)) return;
        if (outcome === "gone") {
          this.intentionallyClosed = true;
          this.awaitingReconnectReady = false;
          this.callbacks.onStatusChange("dead");
          return;
        }
        if (outcome === "blocked") {
          this.intentionallyClosed = true;
          this.awaitingReconnectReady = false;
          this.callbacks.onStatusChange("setup_required");
          return;
        }
        // Genuinely transient — continue reconnecting.
        this.callbacks.onStatusChange("reconnecting", {
          attempt: this.retryCount,
          maxRetries: this.maxRetries,
          delay,
        });
        if (!this.isCurrentSocket(socket)) return;
        this.reconnectTimer = setTimeout(() => {
          if (this.isCurrentSocket(socket)) this.connect();
        }, delay);
      });
      return;
    }

    this.callbacks.onStatusChange("reconnecting", {
      attempt: this.retryCount,
      maxRetries: this.maxRetries,
      delay,
    });
    if (!this.isCurrentSocket(socket)) return;
    this.reconnectTimer = setTimeout(() => {
      if (this.isCurrentSocket(socket)) this.connect();
    }, delay);
  }

  async classifyReconnect() {
    let catalogOk = false;
    let catalogStatus = 0;
    let terminalInCatalog = false;
    let terminalEnded = false;
    let bootstrapped = null;
    try {
      const res = await fetch(`/api/terminals`);
      catalogOk = res.ok;
      catalogStatus = res.status;
      if (res.ok) {
        const terminals = await res.json();
        const entry = terminals.find((t) => t.id === this.terminalId);
        terminalInCatalog = Boolean(entry);
        terminalEnded = Boolean(
          entry && !window.SessionActions.isSessionLive(entry),
        );
      }
    } catch {
      // Network error — treat as transient, keep retrying.
      return "retry";
    }
    // Only the ambiguous "terminal still listed but socket won't open" case
    // needs the extra probe; resolve it against the bootstrap gate.
    if (catalogOk && terminalInCatalog && !terminalEnded) {
      try {
        const sres = await fetch(`/api/foundation/status`);
        if (sres.ok) {
          const status = await sres.json();
          bootstrapped = status?.bootstrap?.bootstrapped ?? null;
        }
      } catch {
        /* leave bootstrapped null → classified as retry */
      }
    }
    return window.ReconnectClassify.classifyReconnectFailure({
      catalogOk,
      catalogStatus,
      terminalInCatalog,
      terminalEnded,
      bootstrapped,
    });
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
    this.reconnectTimer = null;
    const socket = this.ws;
    this.ws = null;
    socket?.close();
  }

  retry() {
    this.retryCount = 0;
    this.intentionallyClosed = false;
    this.awaitingReconnectReady = false;
    this.connect();
  }

  markConnectionReady(resumed, socket = this.ws) {
    if (!this.isCurrentSocket(socket)) return;
    this.retryCount = 0;
    this.awaitingReconnectReady = false;
    this.callbacks.onStatusChange(
      "connected",
      resumed ? { resumed: true } : {},
    );
  }

  startHeartbeat(socket = this.ws) {
    if (!this.isCurrentSocket(socket)) return;
    this.stopHeartbeat();
    this.heartbeatSocket = socket;
    this.heartbeatInterval = setInterval(() => {
      if (
        !this.isCurrentSocket(socket) ||
        socket !== this.heartbeatSocket ||
        socket.readyState !== WebSocket.OPEN
      ) {
        return;
      }
      socket.send(JSON.stringify({ type: "ping" }));
      this.clearHeartbeatTimeout(socket);
      this.heartbeatTimeout = setTimeout(() => {
        if (
          this.isCurrentSocket(socket) &&
          socket === this.heartbeatSocket &&
          socket.readyState === WebSocket.OPEN
        ) {
          socket.close();
        }
      }, 5000);
    }, 25000);
  }

  stopHeartbeat(socket = null) {
    if (socket && socket !== this.heartbeatSocket) return;
    clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = null;
    this.clearHeartbeatTimeout(socket);
    this.heartbeatSocket = null;
  }

  clearHeartbeatTimeout(socket = null) {
    if (socket && socket !== this.heartbeatSocket) return;
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
  constructor(
    id,
    terminalId,
    container,
    onCloseRequest,
    onDetachRequest,
  ) {
    this.id = id;
    this.terminalId = terminalId;
    this.container = container;
    this.onCloseRequest = onCloseRequest;
    this.onDetachRequest = onDetachRequest;
    this.groupId = null;
    this.element = null;
    this.terminalWrapper = null;
    this.paneStatus = null;
    this.paneStatusDot = null;
    this.paneStatusConnection = null;
    this.paneStatusFolder = null;
    this.paneStatusActivity = null;
    this.closeConfirmVisible = false;
    this.onDocumentClick = null;

    this.bounds = { x: 0, y: 0, width: 100, height: 100 };

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
    this.element.setAttribute("role", "group");

    this.terminalWrapper = document.createElement("div");
    this.terminalWrapper.className = "terminal-wrapper";
    this.terminalWrapper.id = `terminal-${this.terminalId}`;
    this.element.appendChild(this.terminalWrapper);

    this.createPaneStatus();
    this.createCloseButton();
    this.createResizeHandles();
    this.setupResizeHandlers();
    this.container.appendChild(this.element);
  }

  createPaneStatus() {
    const status = document.createElement("div");
    status.className = "tile-pane-status";
    status.setAttribute("aria-hidden", "true");

    const dot = document.createElement("span");
    dot.className = "tile-pane-status-dot";

    const folder = document.createElement("span");
    folder.className = "tile-pane-status-folder";

    const connection = document.createElement("span");
    connection.className = "tile-pane-status-connection";

    const activity = document.createElement("span");
    activity.className = "tile-pane-status-activity";

    status.appendChild(dot);
    status.appendChild(connection);
    status.appendChild(folder);
    status.appendChild(activity);
    this.element.appendChild(status);

    this.paneStatus = status;
    this.paneStatusDot = dot;
    this.paneStatusConnection = connection;
    this.paneStatusFolder = folder;
    this.paneStatusActivity = activity;
  }

  createCloseButton() {
    const closeContainer = document.createElement("div");
    closeContainer.className = "tile-close-container";

    const detachBtn = document.createElement("button");
    detachBtn.className = "tile-detach-btn";
    detachBtn.type = "button";
    detachBtn.textContent = "↗";
    detachBtn.title = "Move pane to a new tab";
    detachBtn.setAttribute("aria-label", "Move pane to a new tab");

    const closeBtn = document.createElement("button");
    closeBtn.className = "tile-close-btn";
    closeBtn.type = "button";
    closeBtn.innerHTML = "&times;";
    closeBtn.title = "Close terminal";
    closeBtn.setAttribute("aria-label", "Close terminal");

    const confirmPopup = document.createElement("div");
    confirmPopup.className = "tile-close-confirm";
    confirmPopup.innerHTML = `
      <button class="confirm-close">Close</button>
      <button class="confirm-cancel">Cancel</button>
    `;

    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showCloseConfirm();
    });

    detachBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.onDetachRequest) this.onDetachRequest(this.terminalId);
    });

    confirmPopup
      .querySelector(".confirm-close")
      .addEventListener("click", (e) => {
        e.stopPropagation();
        this.hideCloseConfirm();
        if (this.onCloseRequest) this.onCloseRequest(this.terminalId);
      });

    confirmPopup
      .querySelector(".confirm-cancel")
      .addEventListener("click", (e) => {
        e.stopPropagation();
        this.hideCloseConfirm();
      });

    this.onDocumentClick = (e) => {
      if (this.closeConfirmVisible && !closeContainer.contains(e.target)) {
        this.hideCloseConfirm();
      }
    };
    document.addEventListener("click", this.onDocumentClick);

    closeContainer.appendChild(detachBtn);
    closeContainer.appendChild(closeBtn);
    closeContainer.appendChild(confirmPopup);
    this.element.appendChild(closeContainer);
    this.detachButton = detachBtn;
    this.closeConfirm = confirmPopup;
  }

  showCloseConfirm() {
    this.closeConfirmVisible = true;
    this.element.classList.add("close-confirm-open");
    this.closeConfirm.classList.add("visible");
  }

  hideCloseConfirm() {
    this.closeConfirmVisible = false;
    this.element.classList.remove("close-confirm-open");
    this.closeConfirm.classList.remove("visible");
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
    edges.forEach((edge) => {
      const handle = document.createElement("div");
      handle.className = `tile-resize-handle tile-resize-${edge}`;
      handle.dataset.edge = edge;
      this.element.appendChild(handle);
    });
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
    const isMobile = platformDetector.isMobile;

    if (isMobile) {
      const containerRect = this.container.getBoundingClientRect();
      const minWidth = Math.min(TILE_CONFIG.MIN_WIDTH, containerRect.width);
      const minHeight = Math.min(TILE_CONFIG.MIN_HEIGHT, containerRect.height);

      const width = Math.max(
        minWidth,
        (this.bounds.width / 100) * containerRect.width,
      );
      const height = Math.max(
        minHeight,
        (this.bounds.height / 100) * containerRect.height,
      );
      const left = (this.bounds.x / 100) * containerRect.width;
      const top = (this.bounds.y / 100) * containerRect.height;

      this.element.style.left = `${left}px`;
      this.element.style.top = `${top}px`;
      this.element.style.width = `${width}px`;
      this.element.style.height = `${height}px`;
    } else {
      this.element.style.left = `${this.bounds.x}%`;
      this.element.style.top = `${this.bounds.y}%`;
      this.element.style.width = `${this.bounds.width}%`;
      this.element.style.height = `${this.bounds.height}%`;
    }
  }

  setActive(active) {
    this.element.classList.toggle("active", active);
  }

  setGroupColor(color) {
    this.element.style.setProperty("--group-color", color || "transparent");
    this.element.classList.toggle("grouped", !!color);
  }

  destroy() {
    if (this.onDocumentClick) {
      document.removeEventListener("click", this.onDocumentClick);
    }
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
// PLATFORM DETECTOR - Enhanced mobile/desktop detection
// =============================================================================

class PlatformDetector {
  constructor() {
    this.hasTouch = navigator.maxTouchPoints > 0;
    this.isCoarsePointer = window.matchMedia("(pointer: coarse)").matches;
    this.noHover = window.matchMedia("(hover: none)").matches;
    this.smallScreen = window.innerWidth < 768;

    // Listen for changes
    window.matchMedia("(pointer: coarse)").addEventListener("change", (e) => {
      this.isCoarsePointer = e.matches;
      this.notifyChange();
    });

    window.addEventListener("resize", () => {
      this.smallScreen = window.innerWidth < 768;
      this.notifyChange();
    });

    this.listeners = [];
  }

  get isMobile() {
    return (
      (this.isCoarsePointer && this.noHover) ||
      (this.hasTouch && this.smallScreen)
    );
  }

  get isDesktop() {
    return !this.isMobile;
  }

  onChange(callback) {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((cb) => cb !== callback);
    };
  }

  notifyChange() {
    this.listeners.forEach((cb) => cb(this));
  }
}

const platformDetector = new PlatformDetector();

function syncInteractionModeClasses() {
  document.body.classList.toggle("touch-input-mode", platformDetector.hasTouch);
}

// True when the event target is a text-entry surface (input/textarea/select or
// any contenteditable region). Used to stop single-character global shortcuts
// like `?` from firing while the user is typing into a field.
function isEditableTarget(target) {
  if (!target || typeof target.tagName !== "string") return false;
  const tag = target.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable === true;
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
    this.isMobile = platformDetector.isMobile;

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
      this.isMobile = platformDetector.isMobile;
      if (!this.activeWorkspaceId) return;
      if (wasMobile !== this.isMobile) {
        const activeWorkspaceId = this.activeWorkspaceId;
        const workspaceIds = new Set(
          Array.from(this.tiles.values(), (tile) => tile.workspaceId).filter(
            Boolean,
          ),
        );
        workspaceIds.forEach((workspaceId) => this.relayout(workspaceId));
        this.showWorkspace(activeWorkspaceId);
        if (this.isMobile && this.activeTileId) {
          this.setActive(this.activeTileId);
        }
      } else {
        // Mobile uses pixel geometry derived from percentage bounds. Refresh
        // those pixels on portrait/landscape changes even when the interaction
        // mode remains mobile, otherwise the old portrait width survives.
        this.normalizeWorkspaceTiles(this.activeWorkspaceId);
      }
    });

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.key === "z") {
        e.preventDefault();
        this.undo();
      }
    });

    this.setupTouchGestures();
  }

  getBoundsConstraints() {
    const rect = this.container.getBoundingClientRect();
    const safeWidth = Math.max(rect.width, 1);
    const safeHeight = Math.max(rect.height, 1);
    const minWidthPct = Math.min(
      100,
      (TILE_CONFIG.MIN_WIDTH / safeWidth) * 100,
    );
    const minHeightPct = Math.min(
      100,
      (TILE_CONFIG.MIN_HEIGHT / safeHeight) * 100,
    );
    return { minWidthPct, minHeightPct };
  }

  normalizeBounds(bounds) {
    const width = Math.max(1, Math.min(100, bounds.width));
    const height = Math.max(1, Math.min(100, bounds.height));
    const x = Math.max(0, Math.min(100 - width, bounds.x));
    const y = Math.max(0, Math.min(100 - height, bounds.y));
    return { x, y, width, height };
  }

  normalizeWorkspaceTiles(workspaceId = null) {
    const targetWorkspaceId = workspaceId || this.activeWorkspaceId;
    const tiles = targetWorkspaceId
      ? this.getWorkspaceTiles(targetWorkspaceId)
      : Array.from(this.tiles.values());
    tiles.forEach((tile) => {
      tile.bounds = this.normalizeBounds(tile.bounds);
      tile.updatePosition();
    });
  }

  ensureTileVisible(terminalId) {
    const tile = this.tiles.get(terminalId);
    if (!tile || tile.element.style.display === "none") return;
    tile.element.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: "smooth",
    });
  }

  setupTouchGestures() {
    if (!this.isMobile) return;

    let touchStartX = 0;
    let touchStartY = 0;
    let scrollLeft = 0;
    let scrollTop = 0;
    let isTwoFingerPan = false;

    this.container.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length === 2) {
          isTwoFingerPan = true;
          touchStartX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
          touchStartY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
          scrollLeft = this.container.scrollLeft;
          scrollTop = this.container.scrollTop;
        }
      },
      { passive: true },
    );

    this.container.addEventListener(
      "touchmove",
      (e) => {
        if (isTwoFingerPan && e.touches.length === 2) {
          const touchX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
          const touchY = (e.touches[0].clientY + e.touches[1].clientY) / 2;

          const deltaX = touchStartX - touchX;
          const deltaY = touchStartY - touchY;

          this.container.scrollLeft = scrollLeft + deltaX;
          this.container.scrollTop = scrollTop + deltaY;
        }
      },
      { passive: true },
    );

    this.container.addEventListener(
      "touchend",
      () => {
        isTwoFingerPan = false;
      },
      { passive: true },
    );
  }

  createTile(
    terminalId,
    workspaceId,
    split = false,
    onCloseRequest = null,
    onDetachRequest = null,
  ) {
    const tileId = `tile-${terminalId}`;
    const tile = new Tile(
      tileId,
      terminalId,
      this.container,
      onCloseRequest,
      onDetachRequest,
    );
    tile.workspaceId = workspaceId;
    this.tiles.set(terminalId, tile);

    if (split && this.activeTileId) {
      // Split: position next to active tile
      this.positionNewTile(tile);
    } else {
      // New workspace: take full space, hide other workspaces
      tile.bounds = { x: 0, y: 0, width: 100, height: 100 };
    }

    tile.bounds = this.normalizeBounds(tile.bounds);
    tile.updatePosition();
    this.normalizeWorkspaceTiles(workspaceId);
    this.showWorkspace(workspaceId);

    if (DEBUG) {
      const rect = this.container.getBoundingClientRect();
      dbg("createTile", {
        terminalId,
        workspaceId,
        split,
        bounds: { ...tile.bounds },
        container: { w: rect.width, h: rect.height },
      });
    }

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
    this.normalizeWorkspaceTiles(workspaceId);
    if (DEBUG) {
      dbg("showWorkspace", {
        workspaceId,
        tiles: this.getWorkspaceTiles(workspaceId).length,
      });
    }
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
    this.relayout(toWorkspaceId);
  }

  moveTileToWorkspace(terminalId, workspaceId) {
    const tile = this.tiles.get(terminalId);
    if (!tile || !workspaceId) return null;
    const previousWorkspaceId = tile.workspaceId;
    tile.workspaceId = workspaceId;
    tile.bounds = { x: 0, y: 0, width: 100, height: 100 };
    if (previousWorkspaceId) this.relayout(previousWorkspaceId);
    this.relayout(workspaceId);
    return previousWorkspaceId;
  }

  // Relayout tiles in a specific workspace
  relayoutWorkspace(workspaceId) {
    const tiles = this.getWorkspaceTiles(workspaceId);
    if (tiles.length === 0) return;

    const count = tiles.length;
    if (count === 1) {
      tiles[0].bounds = this.normalizeBounds({
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      });
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
      tile.bounds = this.normalizeBounds(tile.bounds);
      tile.updatePosition();
    });
    if (DEBUG) {
      dbg("relayoutWorkspace", { workspaceId, count: tiles.length });
    }
  }

  // Position a new tile next to the active one
  positionNewTile(newTile) {
    if (this.tiles.size === 1) {
      // First tile takes full space
      newTile.bounds = this.normalizeBounds({
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      });
      return;
    }

    const activeTile = this.tiles.get(this.activeTileId);
    if (!activeTile) {
      // No active tile, fill remaining space
      newTile.bounds = this.normalizeBounds({
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      });
      this.relayout(newTile.workspaceId);
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

    activeTile.bounds = this.normalizeBounds(activeTile.bounds);
    newTile.bounds = this.normalizeBounds(newTile.bounds);
    activeTile.updatePosition();
    newTile.updatePosition();
  }

  // Handle tile resize with push neighbors
  handleTileResize(tile, newBounds, edge) {
    const containerRect = this.container.getBoundingClientRect();
    const safeWidth = Math.max(containerRect.width, 1);
    const safeHeight = Math.max(containerRect.height, 1);
    const minW = (TILE_CONFIG.MIN_WIDTH / safeWidth) * 100;
    const minH = (TILE_CONFIG.MIN_HEIGHT / safeHeight) * 100;
    const normalizedNewBounds = this.normalizeBounds(newBounds);

    // Find neighbors that would be affected
    const neighbors = this.findNeighbors(tile, edge);

    // Calculate how much we need to push
    let canResize = true;

    for (const neighbor of neighbors) {
      const pushAmount = this.calculatePushAmount(
        tile,
        neighbor,
        normalizedNewBounds,
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
      tile.bounds = { ...normalizedNewBounds };

      // Push all affected neighbors
      for (const neighbor of neighbors) {
        const pushAmount = this.calculatePushAmount(
          tile,
          neighbor,
          normalizedNewBounds,
          edge,
        );
        if (pushAmount !== 0) {
          this.pushTile(neighbor, pushAmount, edge);
        }
      }

      // Update all tile positions
      this.normalizeWorkspaceTiles(tile.workspaceId);
    }
  }

  findNeighbors(tile, edge) {
    const neighbors = [];
    const tolerance = 2; // percentage tolerance for adjacency

    this.tiles.forEach((other) => {
      if (other === tile) return;
      if (other.workspaceId !== tile.workspaceId) return;

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
    tile.bounds = this.normalizeBounds(newBounds);
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
    const workspaceId = tile.workspaceId;

    this.saveUndo();

    // Remove from group if grouped
    if (tile.groupId) {
      this.removeFromGroup(terminalId);
    }

    tile.destroy();
    this.tiles.delete(terminalId);

    // Redistribute space to remaining tiles
    if (workspaceId) this.relayout(workspaceId);
  }

  // Relayout tiles to fill space, scoped to workspace if provided
  relayout(workspaceId = null) {
    const targetWorkspaceId = workspaceId || this.activeWorkspaceId;
    const tileArray = targetWorkspaceId
      ? this.getWorkspaceTiles(targetWorkspaceId)
      : Array.from(this.tiles.values());
    if (tileArray.length === 0) return;

    if (this.isMobile) {
      // Mobile: stack mode - one tile takes full space
      tileArray.forEach((tile, i) => {
        tile.bounds = this.normalizeBounds({
          x: 0,
          y: 0,
          width: 100,
          height: 100,
        });
        tile.element.style.display =
          tile.terminalId === this.activeTileId ? "block" : "none";
        tile.updatePosition();
      });
      return;
    }

    // Desktop: distribute tiles in a grid
    const count = tileArray.length;

    if (count === 1) {
      tileArray[0].bounds = this.normalizeBounds({
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      });
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
      tile.bounds = this.normalizeBounds(tile.bounds);
      tile.element.style.display = "block";
      tile.updatePosition();
    });
    if (DEBUG) {
      dbg("relayout", {
        workspaceId: targetWorkspaceId || "all",
        count: tileArray.length,
      });
    }
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

    if (this.isMobile) {
      const workspaceId = this.tiles.get(terminalId)?.workspaceId;
      if (workspaceId) this.relayout(workspaceId);
    }

    this.ensureTileVisible(terminalId);
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
    this.visible = this.loadVisibilityState();
    this.extraKeysEl = null;
    this.debugEl = null;
    this.lastInput = "";
    this.init();
  }

  createDebugOverlay() {
    // Create visible debug overlay for mobile testing
    const el = document.createElement("div");
    el.id = "modifier-debug";
    el.style.cssText = `
      position: fixed;
      top: 50px;
      right: 10px;
      background: rgba(0,0,0,0.9);
      color: #0f0;
      font-family: monospace;
      font-size: 12px;
      padding: 8px;
      border-radius: 4px;
      z-index: 99999;
      max-width: 200px;
      pointer-events: none;
    `;
    el.textContent = "MOD: --- | IN: --- | OUT: ---";
    document.body.appendChild(el);
    this.debugEl = el;
  }

  updateDebug(input = null, output = null) {
    if (!this.debugEl) return;
    const m = this.modifiers;
    const modStr =
      [m.ctrl ? "CTRL" : "", m.alt ? "ALT" : "", m.shift ? "SHIFT" : ""]
        .filter(Boolean)
        .join("+") || "---";

    let text = `MOD: ${modStr}`;
    if (input !== null) {
      this.lastInput = input;
      text += ` | IN: "${input}"`;
    }
    if (output !== null) {
      text += ` | OUT: "${output}"`;
      if (output !== input) {
        text += " ✓";
      }
    }
    this.debugEl.textContent = text;
  }

  init() {
    const extraKeys = document.getElementById("extra-keys");
    if (!extraKeys) return;

    // Only create debug overlay when ?debug=1 is in URL
    if (DEBUG) {
      this.createDebugOverlay();
    }

    // GLOBAL input listener to catch ALL input events
    document.addEventListener(
      "input",
      (e) => {
        const dbg = document.getElementById("modifier-debug");
        if (dbg) {
          const mods = this.modifiers;
          const modStr =
            [mods.ctrl ? "C" : "", mods.alt ? "A" : "", mods.shift ? "S" : ""]
              .filter(Boolean)
              .join("+") || "-";
          dbg.textContent = `[INPUT] data="${e.data}" mod=${modStr} tgt=${e.target?.className?.slice(0, 15)}`;
        }
      },
      true,
    );

    const toggle = document.getElementById("extra-keys-toggle");
    const row2 = document.querySelector(".extra-keys-row-2");

    let touchedKey = null;

    extraKeys.addEventListener(
      "touchstart",
      (e) => {
        const btn = e.target.closest(".ek-btn, .ek-toggle");
        dbg("[ExtraKeys] touchstart, btn:", btn?.dataset?.key || btn?.id);
        if (btn) {
          e.preventDefault();
          e.stopImmediatePropagation();
          touchedKey =
            btn.dataset.key ||
            (btn.id === "extra-keys-toggle" ? "TOGGLE" : null);
          dbg("[ExtraKeys] touchedKey set to:", touchedKey);
        }
      },
      { passive: false, capture: true },
    );

    extraKeys.addEventListener(
      "touchend",
      (e) => {
        dbg("[ExtraKeys] touchend, touchedKey:", touchedKey);
        e.preventDefault();
        e.stopImmediatePropagation();
        if (touchedKey) {
          if (touchedKey === "TOGGLE") {
            this.setExtraKeysRow2Collapsed(!row2.classList.contains("hidden"));
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
        this.setExtraKeysRow2Collapsed(!row2.classList.contains("hidden"));
      }
    });

    // Store reference and apply initial visibility
    this.extraKeysEl = extraKeys;

    // Apply initial visibility state
    // On desktop: load from localStorage (default: hidden)
    // On mobile: always visible
    this.updateVisibility();

    // Restore the persisted secondary-row collapsed state (default: expanded).
    // settingsStore's cache is empty until settingsReady resolves (a server
    // round-trip), so applying it synchronously here always reads the
    // fallback on a fresh browser/profile — apply now (so there's no flash
    // of the wrong state once localStorage IS warm) and re-apply once
    // settingsReady resolves in case the synchronous read missed a
    // server-persisted value.
    this.setExtraKeysRow2Collapsed(
      Boolean(
        this.tm?.settingsStore?.get("terminal.extraKeysRow2Collapsed", false),
      ),
      { persist: false },
    );
    void this.tm?.settingsReady?.then(() => {
      this.setExtraKeysRow2Collapsed(
        Boolean(
          this.tm?.settingsStore?.get("terminal.extraKeysRow2Collapsed", false),
        ),
        { persist: false },
      );
    });

    // Setup toggle button handler
    document
      .querySelector('[data-action="toggle-extra-keys"]')
      ?.addEventListener("click", () => this.toggle());

    // Keyboard shortcut: Ctrl+.
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.key === ".") {
        e.preventDefault();
        this.toggle();
      }
    });
  }

  handleKey(key) {
    dbg("[ExtraKeys] handleKey called:", key);
    if (!key) return;

    // Handle modifiers FIRST - they don't need an active terminal
    const upperKey = key.toUpperCase();
    if (upperKey === "CTRL" || upperKey === "ALT" || upperKey === "SHIFT") {
      dbg("[ExtraKeys] Toggling modifier:", upperKey);
      this.toggleModifier(upperKey.toLowerCase());
      return;
    }

    // For actual key sequences, we need an active terminal
    const active = this.tm.terminals.get(this.tm.activeId);
    dbg("[ExtraKeys] Active terminal:", this.tm.activeId, "ws:", !!active?.ws);
    if (!active?.ws) return;

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
    // Snap the view back to the prompt on synthetic key input, except for
    // scrollback-navigation keys (PgUp/PgDn). Single source of truth lives in
    // extra-keys-scroll.js; if it somehow isn't loaded, fall back to a
    // conservative inline denylist so PgUp/PgDn still never snap.
    const scrollPred = window.ExtraKeysScroll?.shouldScrollToPromptForKey;
    const shouldScroll = scrollPred
      ? scrollPred(key)
      : key !== "PGUP" && key !== "PGDN";
    if (shouldScroll) this.tm.scrollActiveTerminalToPrompt();
  }

  toggleModifier(mod) {
    this.modifiers[mod] = !this.modifiers[mod];
    dbg(
      "[ExtraKeys] toggleModifier:",
      mod,
      "->",
      this.modifiers[mod],
      "all:",
      JSON.stringify(this.modifiers),
    );
    this.updateModifierUI();
    this.updateDebug(); // Update visible debug overlay
  }

  resetModifiers() {
    dbg(
      "[ExtraKeys] resetModifiers called (stack):",
      new Error().stack?.split("\n").slice(1, 4).join(" <- "),
    );
    this.modifiers = { ctrl: false, alt: false, shift: false };
    this.updateModifierUI();
    this.updateDebug(); // Update visible debug overlay
  }

  updateModifierUI() {
    const btns = document.querySelectorAll(".ek-btn.ek-modifier");
    dbg(
      "[ExtraKeys] updateModifierUI, found buttons:",
      btns.length,
      "modifiers:",
      this.modifiers,
    );
    btns.forEach((btn) => {
      const mod = btn.dataset.key.toLowerCase();
      btn.classList.toggle("active", this.modifiers[mod] || false);
    });
  }

  refocusTerminal() {
    const active = this.tm.terminals.get(this.tm.activeId);
    dbg("[ExtraKeys] refocusTerminal, activeId:", this.tm.activeId);
    if (active?.terminal) {
      // MUST use terminal.focus() so xterm.js processes input correctly
      active.terminal.focus();
      dbg("[ExtraKeys] terminal.focus() called");
    }
  }

  loadVisibilityState() {
    // Mobile respects the same persisted terminal.extraKeysVisible pref as
    // desktop (bug: extra-keys-visibility-pref-ignored-on-mobile) — but its
    // OWN default is visible=true (an on-screen keyboard row a mobile user
    // can't otherwise get to), unlike the desktop schema default of hidden.
    // Read the raw store value with that mobile-specific fallback instead of
    // going through the schema default (false), which is desktop-oriented.
    if (platformDetector.isMobile) {
      return Boolean(
        this.tm?.settingsStore?.get("terminal.extraKeysVisible", true) ?? true,
      );
    }

    // On desktop, read the canonical terminal.extraKeysVisible from the store
    // (schema default: hidden). No legacy localStorage read — migration owns it.
    const defaults =
      window.SettingsSchema?.defaultsOf?.(
        window.SettingsSchema.SETTINGS_SCHEMA,
      ) || {};
    const fallback = Boolean(defaults["terminal.extraKeysVisible"]);
    return Boolean(
      this.tm?.settingsStore?.get("terminal.extraKeysVisible", fallback) ??
      fallback,
    );
  }

  // Apply visibility WITHOUT persisting (the runtime side effect entry point).
  applyVisibility(visible) {
    this.visible = Boolean(visible);
    this.updateVisibility();
    // Showing/hiding the row (and its ⋯ toggle) changes how much vertical
    // space the terminal has. The container-height calc in
    // handleViewportResize is otherwise only re-run on the next
    // visualViewport resize/scroll event — trigger it now so a toggle (e.g.
    // via the More-sheet action) reclaims/consumes the freed space
    // synchronously, same as setExtraKeysRow2Collapsed already does.
    this.tm?.handleViewportResize?.();
  }

  setVisible(visible) {
    // Persist through the settings runtime/store; the side effect applies it.
    // Both platforms route through the same terminal.extraKeysVisible pref
    // now (bug: extra-keys-visibility-pref-ignored-on-mobile) — only the
    // DEFAULT differs by platform (see loadVisibilityState).
    if (this.tm?.settingsRuntime) {
      this.tm.settingsRuntime.apply(
        "terminal.extraKeysVisible",
        Boolean(visible),
      );
      return;
    }
    this.applyVisibility(visible);
    this.tm?.settingsStore?.set("terminal.extraKeysVisible", this.visible);
  }

  toggle() {
    this.setVisible(!this.visible);
  }

  updateVisibility() {
    if (!this.extraKeysEl) return;

    const toggleBtn = document.getElementById("extra-keys-toggle-btn");

    if (this.visible) {
      this.extraKeysEl.classList.remove("hidden");
      toggleBtn?.classList.add("active");
    } else {
      this.extraKeysEl.classList.add("hidden");
      toggleBtn?.classList.remove("active");
    }
  }

  // Collapse/expand the secondary extra-keys row + sync the toggle glyph, and
  // persist the choice (per-actor) so it survives reloads. The compact
  // keyboard-open CSS hides the row independently; this governs the resting state.
  setExtraKeysRow2Collapsed(collapsed, { persist = true } = {}) {
    const row2 = document.querySelector(".extra-keys-row-2");
    const toggle = document.getElementById("extra-keys-toggle");
    if (!row2) return;
    row2.classList.toggle("hidden", Boolean(collapsed));
    if (toggle) toggle.textContent = collapsed ? "⋯" : "⋮";
    if (persist) {
      this.tm?.settingsStore?.set(
        "terminal.extraKeysRow2Collapsed",
        Boolean(collapsed),
      );
    }
    // The container-height calc that accounts for the extra-keys row (see
    // handleViewportResize) is otherwise only re-run on the next
    // visualViewport resize/scroll event. Trigger it immediately so a
    // row-2 collapse/expand while the on-screen keyboard is already open
    // reclaims/consumes the freed vertical space right away, not on the
    // next keyboard toggle.
    this.tm?.handleViewportResize?.();
  }

  // Called by viewport resize handler for mobile keyboard. Mobile no longer
  // forces visibility here (bug: extra-keys-visibility-pref-ignored-on-mobile)
  // — the keyboard opening only REPOSITIONS the row (handleViewportResize's
  // own inline-style bottom offset, applied unconditionally regardless of
  // this.visible). Whether the row shows at all is governed solely by the
  // persisted terminal.extraKeysVisible pref now, same as desktop, so a user
  // who explicitly hid it (via Settings or the More-sheet action) stays hidden
  // across keyboard open/close.
  showForKeyboard() {
    // No-op: see comment above.
  }

  hideForKeyboard() {
    // Visibility is owned by terminal.extraKeysVisible on every platform.
    // A viewport resize (including applyVisibility()'s immediate layout pass)
    // must never overwrite an explicit user preference.
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
  constructor(manager = null) {
    this.manager = manager;
    this.history = [];
    this.maxHistory = 20;
    this.maxItemSize = 200 * 1024; // 200KB
    this.panel = null;
    this.toast = null;
    this.pendingCopy = null;
    this.lastToastTime = 0;
    this.toastDebounceMs = 2000; // 2 seconds
    // Seed with the schema default for terminal.autoCopy; the settings runtime
    // applies the canonical (and migrated) value once the store resolves. No
    // legacy localStorage read here — the migration owns that.
    const defaults =
      window.SettingsSchema?.defaultsOf?.(
        window.SettingsSchema.SETTINGS_SCHEMA,
      ) || {};
    this.autoCopyEnabled = Boolean(defaults["terminal.autoCopy"]);
    this.selectionDebounceTimer = null;
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

    // Build panel structure using DOM methods for security
    const header = document.createElement("div");
    header.className = "clipboard-header";

    const title = document.createElement("h3");
    title.textContent = "Clipboard";
    header.appendChild(title);

    const closeBtn = document.createElement("button");
    closeBtn.className = "clipboard-close";
    closeBtn.textContent = "\u00D7"; // &times;
    closeBtn.addEventListener("click", () => this.hidePanel());
    header.appendChild(closeBtn);

    const settings = document.createElement("div");
    settings.className = "clipboard-settings";

    const label = document.createElement("label");
    label.className = "setting-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = "auto-copy-toggle";
    checkbox.checked = this.autoCopyEnabled;
    checkbox.addEventListener("change", (e) => {
      this.setAutoCopyEnabled(e.target.checked);
    });

    const labelText = document.createElement("span");
    labelText.textContent = "Auto-copy on selection";

    label.appendChild(checkbox);
    label.appendChild(labelText);
    settings.appendChild(label);

    const list = document.createElement("div");
    list.className = "clipboard-list";

    this.panel.appendChild(header);
    this.panel.appendChild(settings);
    this.panel.appendChild(list);

    document.getElementById("app").appendChild(this.panel);
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
      this.copyToClipboardOsc52(text);
    } catch (e) {
      console.error("OSC52 decode error:", e);
    }
  }

  // Separate method for OSC52 to show different message
  async copyToClipboardOsc52(text) {
    // Add to history first
    this.addToHistory(text);

    try {
      await navigator.clipboard.writeText(text);
      // Non-blocking notification for OSC52
      this.showToast("Clipboard updated by terminal", "success");
    } catch (err) {
      console.warn("Clipboard API failed, showing fallback:", err);
      this.pendingCopy = text;
      this.showToast("Click to copy", "pending", text);
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
    const now = Date.now();

    // Debounce success toasts (2 second cooldown)
    if (type === "success" && now - this.lastToastTime < this.toastDebounceMs) {
      return; // Skip toast, too soon
    }

    if (type === "success") {
      this.lastToastTime = now;
    }

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

  setAutoCopyEnabled(enabled) {
    // Persist through the settings runtime/store; the terminal.autoCopy side
    // effect (applyAutoCopy) updates local state + the checkbox.
    const runtime = this.manager?.settingsRuntime;
    if (runtime) {
      runtime.apply("terminal.autoCopy", Boolean(enabled));
    } else {
      this.applyAutoCopy(Boolean(enabled));
      this.manager?.settingsStore?.set(
        "terminal.autoCopy",
        this.autoCopyEnabled,
      );
    }
  }

  // Side effect for terminal.autoCopy. `enabled` is already coerced to bool.
  applyAutoCopy(enabled) {
    this.autoCopyEnabled = Boolean(enabled);
    const checkbox = document.getElementById("auto-copy-toggle");
    if (checkbox) checkbox.checked = this.autoCopyEnabled;
  }

  // Called when terminal selection changes
  handleSelectionChange(terminal) {
    if (!this.autoCopyEnabled) return;

    // Clear previous timer
    if (this.selectionDebounceTimer) {
      clearTimeout(this.selectionDebounceTimer);
    }

    // Debounce 300ms
    this.selectionDebounceTimer = setTimeout(() => {
      const selection = terminal.getSelection();
      if (selection && selection.length > 0) {
        this.copyToClipboard(selection);
      }
    }, 300);
  }

  // Handle Ctrl+V paste with size warning and image support
  async handlePaste(terminalWs, clipboardData = null) {
    if (clipboardData) {
      const handled = await this.handleClipboardDataTransfer(
        clipboardData,
        terminalWs,
      );
      if (handled) return;
    }

    const clipboardApi = navigator.clipboard;
    let clipboardReadError = null;

    try {
      if (typeof clipboardApi?.read === "function") {
        const clipboardItems = await clipboardApi.read();
        if (await this.handleClipboardItems(clipboardItems, terminalWs)) return;
      }
    } catch (err) {
      clipboardReadError = err;
      console.warn("Clipboard item read failed:", err);
    }

    try {
      if (typeof clipboardApi?.readText === "function") {
        const text = await clipboardApi.readText();
        if (text) {
          this.handleTextPaste(text, terminalWs);
          return;
        }
      }
    } catch (readErr) {
      const effectiveError = readErr || clipboardReadError;
      if (effectiveError) {
        console.warn("Clipboard text read failed:", effectiveError);
      }
      this.showClipboardUnavailableToast();
      return;
    }

    if (
      clipboardReadError ||
      !clipboardApi ||
      (typeof clipboardApi.read !== "function" &&
        typeof clipboardApi.readText !== "function")
    ) {
      this.showClipboardUnavailableToast();
    }
  }

  showClipboardUnavailableToast() {
    this.showToast(
      "Clipboard unavailable here. Use system paste in terminal.",
      "pending",
    );
  }

  async handleClipboardItems(clipboardItems, terminalWs) {
    for (const item of clipboardItems) {
      const imageType = item.types.find((t) => t.startsWith("image/"));
      if (imageType) {
        const blob = await item.getType(imageType);
        await this.handleImagePaste(blob, terminalWs);
        return true;
      }

      if (item.types.includes("text/plain")) {
        const blob = await item.getType("text/plain");
        const text = await blob.text();
        if (!text) continue;
        this.handleTextPaste(text, terminalWs);
        return true;
      }
    }

    return false;
  }

  async handleClipboardDataTransfer(clipboardData, terminalWs) {
    if (!clipboardData) return false;

    const items = Array.from(clipboardData.items || []);
    const imageItem = items.find(
      (item) => item.kind === "file" && item.type.startsWith("image/"),
    );
    if (imageItem) {
      const file = imageItem.getAsFile?.();
      if (file) {
        await this.handleImagePaste(file, terminalWs);
        return true;
      }
    }

    const text = clipboardData.getData?.("text/plain");
    if (text) {
      this.handleTextPaste(text, terminalWs);
      return true;
    }

    return false;
  }

  handleTextPaste(text, terminalWs) {
    const sizeBytes = new Blob([text]).size;
    const sizeKB = sizeBytes / 1024;

    if (sizeKB > 5) {
      this.showPasteConfirmation(text, sizeBytes, terminalWs);
    } else {
      this.executePaste(text, terminalWs);
    }
  }

  async handleImagePaste(blob, terminalWs) {
    this.showToast("Uploading image...", "pending");

    try {
      const formData = new FormData();
      formData.append("image", blob, "clipboard-image.png");

      const response = await fetch("/api/clipboard/image", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Upload failed");
      }

      const result = await response.json();

      // Send path to terminal
      this.executePaste(result.path + " ", terminalWs);
      this.showToast(`Image saved: ${result.filename}`, "success");
    } catch (err) {
      console.error("Image upload failed:", err);
      this.showToast("Image upload failed: " + err.message, "error");
    }
  }

  showPasteConfirmation(text, sizeBytes, terminalWs) {
    const modal = document.getElementById("paste-modal");
    const sizeEl = document.getElementById("paste-size");
    const previewEl = document.getElementById("paste-preview");
    const confirmBtn = document.getElementById("paste-confirm");
    const cancelBtn = document.getElementById("paste-cancel");
    const closeBtn = modal.querySelector(".modal-close");

    // Format size
    const sizeStr =
      sizeBytes < 1024
        ? `${sizeBytes} bytes`
        : sizeBytes < 1024 * 1024
          ? `${(sizeBytes / 1024).toFixed(1)} KB`
          : `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;

    // SECURITY: Use textContent to prevent XSS from clipboard content
    sizeEl.textContent = sizeStr;
    const preview = text.substring(0, 500) + (text.length > 500 ? "\n..." : "");
    previewEl.textContent = preview;

    modal.classList.remove("hidden");

    // Cleanup previous listeners
    const cleanup = () => {
      modal.classList.add("hidden");
      confirmBtn.onclick = null;
      cancelBtn.onclick = null;
      closeBtn.onclick = null;
    };

    confirmBtn.onclick = () => {
      cleanup();
      this.executePaste(text, terminalWs);
    };

    cancelBtn.onclick = cleanup;
    closeBtn.onclick = cleanup;
  }

  executePaste(text, terminalWs) {
    if (terminalWs && terminalWs.readyState === WebSocket.OPEN) {
      terminalWs.send(JSON.stringify({ type: "input", data: text }));
    }
  }

  escapeHtml(text) {
    // Delegate to the shared escaper (escapes & < > " ' — safe for the quoted
    // attribute interpolation sites in the legacy git panel: data-branch,
    // data-path, data-folder-key, title="${message}", etc.). The old
    // textContent→innerHTML round-trip left " and ' intact → attribute-breakout
    // stored XSS when a branch/file/commit/stash value contained a quote.
    if (typeof window !== "undefined" && window.HtmlEscape?.escapeHtml) {
      return window.HtmlEscape.escapeHtml(text);
    }
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
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
// GIT MANAGER - Git panel integration
// =============================================================================

class GitManager {
  constructor() {
    this.panel = null;
    this.state = {
      cwd: null,
      files: { staged: [], changes: [] },
      branches: { current: "", list: [] },
      commits: [],
      stashes: [],
      selectedIndex: 0,
      selectedPath: null,
      activePanel: "files", // 'files' | 'history' | 'branches'
      diff: null,
      diffMode: "working", // 'working' | 'staged' | 'commit'
      rightView: "diff", // 'diff' | 'timeline'
      timelineEntries: [],
      timelinePath: null,
      selectedCommit: null,
      collapsedFolders: new Set(),
      loading: false,
    };
    // Keep currentCwd for backward compatibility with existing methods
    this.currentCwd = null;
    // Monotonic refresh() generation: a slow response from a superseded
    // refresh() (stale cwd) must not clobber the state/DOM a newer refresh()
    // already wrote. See refresh() below.
    this._refreshGeneration = 0;
    this.init();
  }

  init() {
    this.createPanel();
    this.setupKeyboardShortcuts();
  }

  createPanel() {
    this.panel = document.createElement("div");
    this.panel.id = "git-panel";
    this.panel.className = "side-panel hidden";
    // Static HTML template - no user input, safe for innerHTML
    this.panel.innerHTML = `
      <div class="git-panel-layout">
        <div class="git-left-panel">
          <div class="panel-header">
            <h3>Git</h3>
            <span id="git-branch" class="git-branch clickable" title="Click to switch branch"></span>
            <span id="git-sync-label" class="git-sync-label" title="Commits behind↓ / ahead↑"></span>
            <button id="git-pull-btn" class="panel-refresh git-sync-btn" title="Pull">↓</button>
            <button id="git-push-btn" class="panel-refresh git-sync-btn" title="Push">↑</button>
            <button id="git-fetch-btn" class="panel-refresh git-sync-btn" title="Fetch">⇣</button>
            <button id="git-stash-btn" class="panel-refresh git-sync-btn" title="Stash changes">≡</button>
            <button class="panel-refresh" title="Refresh (r)">&#x21bb;</button>
            <button class="panel-close" title="Close (Esc)">&times;</button>
          </div>
          <div id="git-files" class="git-files"></div>
          <div id="git-stashes" class="git-stashes"></div>
          <div id="git-branches" class="git-branches hidden"></div>
        </div>
        <div class="git-right-panel">
          <div class="git-diff-header">
            <span id="git-diff-title">Diff</span>
            <div class="git-right-views">
              <button class="git-right-view active" data-view="diff" title="Diff of the selected file">Diff</button>
              <button class="git-right-view" data-view="timeline" title="Commit history of the selected file">Timeline</button>
            </div>
            <div class="git-diff-modes">
              <button class="git-diff-mode active" data-mode="working">Working Tree</button>
              <button class="git-diff-mode" data-mode="staged">Staged</button>
              <button class="git-diff-mode" data-mode="commit">Commit</button>
              <button id="git-diff-layout" class="git-diff-mode git-diff-layout" title="Toggle split / inline diff">⫿⫿</button>
            </div>
          </div>
          <div id="git-timeline" class="git-timeline hidden"></div>
          <div id="git-diff" class="git-diff"></div>
          <div class="git-history-header">
            <span>History</span>
          </div>
          <div id="git-history" class="git-history"></div>
        </div>
      </div>
      <div class="git-bottom-bar">
        <div class="git-commit-area">
          <textarea id="git-message" placeholder="Commit message..." rows="2"></textarea>
          <label class="git-amend" title="Amend the last commit"><input type="checkbox" id="git-amend" /> Amend</label>
          <button id="git-commit-btn" class="btn btn-primary">Commit</button>
          <span id="git-commit-status" class="git-commit-status"></span>
        </div>
        <div class="git-shortcuts">
          <span><kbd>j</kbd>/<kbd>k</kbd> navigate</span>
          <span><kbd>Space</kbd> stage</span>
          <span><kbd>Enter</kbd> diff</span>
          <span><kbd>c</kbd> commit</span>
          <span><kbd>b</kbd> branches</span>
        </div>
      </div>
    `;
    document.getElementById("app").appendChild(this.panel);

    // Event listeners
    this.panel
      .querySelector(".panel-close")
      .addEventListener("click", () => this.hide());
    this.panel
      .querySelector(".panel-refresh")
      .addEventListener("click", () => this.refresh());
    this.panel
      .querySelector("#git-commit-btn")
      .addEventListener("click", () => this.commit());
    this.panel
      .querySelector("#git-branch")
      .addEventListener("click", () => this.toggleBranches());
    this.panel
      .querySelector("#git-pull-btn")
      .addEventListener("click", () => this.syncAction("pull"));
    this.panel
      .querySelector("#git-push-btn")
      .addEventListener("click", () => this.syncAction("push"));
    this.panel
      .querySelector("#git-fetch-btn")
      .addEventListener("click", () => this.syncAction("fetch"));
    this.panel
      .querySelector("#git-stash-btn")
      .addEventListener("click", () => this.stashPush());
    this.panel.querySelector("#git-amend").addEventListener("change", (e) => {
      const messageEl = this.panel.querySelector("#git-message");
      if (e.target.checked && !messageEl.value.trim()) {
        messageEl.value = this.state.commits[0]?.message || "";
      }
    });
    this.panel
      .querySelectorAll(".git-diff-mode:not(.git-diff-layout)")
      .forEach((btn) => {
        btn.addEventListener("click", () => this.setDiffMode(btn.dataset.mode));
      });
    this.panel
      .querySelector("#git-diff-layout")
      .addEventListener("click", () => {
        const next = this.getDiffLayout() === "split" ? "inline" : "split";
        window.terminalManager?.settingsStore?.set("git.diffLayout", next);
        if (this.state.selectedPath) {
          this.showDiff(this.state.selectedPath);
        }
      });
    this.panel.querySelectorAll(".git-right-view").forEach((btn) => {
      btn.addEventListener("click", () => this.setRightView(btn.dataset.view));
    });
  }

  // Switches the right pane between the Diff editor and the per-file Timeline.
  setRightView(view) {
    if (!view || view === this.state.rightView) {
      if (view === "timeline") this.showTimeline(this.state.selectedPath);
      return;
    }
    this.state.rightView = view;
    this.updateRightViewUI();
    if (view === "timeline") {
      this.showTimeline(this.state.selectedPath);
    } else if (this.state.selectedPath) {
      this.showDiff(this.state.selectedPath);
    }
  }

  updateRightViewUI() {
    const view = this.state.rightView || "diff";
    this.panel.querySelectorAll(".git-right-view").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === view);
    });
    const isTimeline = view === "timeline";
    const timelineEl = this.panel.querySelector("#git-timeline");
    const diffEl = this.panel.querySelector("#git-diff");
    const modesEl = this.panel.querySelector(".git-diff-modes");
    if (timelineEl) timelineEl.classList.toggle("hidden", !isTimeline);
    // Diff editor stays visible in timeline mode (a clicked commit renders into
    // it); only the working/staged/commit mode buttons are hidden, since they
    // do not apply to a historical revision.
    if (modesEl) modesEl.classList.toggle("hidden", isTimeline);
    if (diffEl && !this.state.selectedPath) {
      diffEl.classList.toggle("hidden", isTimeline);
    } else if (diffEl) {
      diffEl.classList.remove("hidden");
    }
  }

  setupKeyboardShortcuts() {
    document.addEventListener("keydown", (e) => {
      // Only handle when git panel is open and not typing in textarea
      if (this.panel.classList.contains("hidden")) return;
      if (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT") {
        if (e.key === "Escape") {
          e.target.blur();
          return;
        }
        return;
      }

      switch (e.key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          this.navigateFiles(1);
          break;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          this.navigateFiles(-1);
          break;
        case " ":
          e.preventDefault();
          this.stageSelectedFile();
          break;
        case "Enter":
          e.preventDefault();
          this.showSelectedDiff();
          break;
        case "c":
          e.preventDefault();
          this.panel.querySelector("#git-message").focus();
          break;
        case "b":
          e.preventDefault();
          this.toggleBranches();
          break;
        case "r":
          e.preventDefault();
          this.refresh();
          break;
        case "Tab":
          e.preventDefault();
          this.switchPanel();
          break;
        case "Escape":
          e.preventDefault();
          this.hide();
          break;
      }
    });
  }

  navigateFiles(delta) {
    const fileElements = this.panel.querySelectorAll(".git-file");
    if (fileElements.length === 0) return;

    this.state.selectedIndex = Math.max(
      0,
      Math.min(fileElements.length - 1, this.state.selectedIndex + delta),
    );
    this.highlightSelectedFile();
  }

  highlightSelectedFile() {
    const fileElements = this.panel.querySelectorAll(".git-file");
    fileElements.forEach((el) => {
      const elIndex = Number(el.dataset.index || -1);
      const isSelected =
        elIndex === this.state.selectedIndex ||
        el.dataset.path === this.state.selectedPath;
      el.classList.toggle("selected", isSelected);
    });

    // Scroll into view
    const selected = this.panel.querySelector(".git-file.selected");
    if (selected) {
      this.state.selectedPath =
        selected.dataset.path || this.state.selectedPath;
      this.state.selectedIndex = Number(
        selected.dataset.index || this.state.selectedIndex,
      );
      selected.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  stageSelectedFile() {
    const files = this.getAllFiles();
    const file = files[this.state.selectedIndex];
    if (file) {
      this.toggleStage(file.path, file.staged);
    }
  }

  showSelectedDiff() {
    const fileElements = this.panel.querySelectorAll(".git-file");
    const selectedFile = fileElements[this.state.selectedIndex];
    if (selectedFile) {
      const path = selectedFile.dataset.path;
      this.showDiff(path);
    }
  }

  switchPanel() {
    const panels = ["files", "history", "branches"];
    const currentIndex = panels.indexOf(this.state.activePanel);
    this.state.activePanel = panels[(currentIndex + 1) % panels.length];
    this.updateActivePanelUI();
  }

  updateActivePanelUI() {
    // Visual feedback for active panel
    this.panel
      .querySelectorAll(".git-left-panel > div, .git-right-panel > div")
      .forEach((el) => {
        el.classList.remove("panel-active");
      });

    const activeEl = this.panel.querySelector(`#git-${this.state.activePanel}`);
    if (activeEl) {
      activeEl.classList.add("panel-active");
    }
  }

  setDiffMode(mode) {
    if (!mode) return;
    this.state.diffMode = mode;
    this.updateDiffModeUI();

    if (mode !== "commit") {
      this.state.selectedCommit = null;
    }

    if (this.state.selectedPath) {
      this.showDiff(this.state.selectedPath);
    }
  }

  updateDiffModeUI() {
    this.panel.querySelectorAll(".git-diff-mode").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === this.state.diffMode);
    });
  }

  toggleBranches() {
    const branchesEl = this.panel.querySelector("#git-branches");
    branchesEl.classList.toggle("hidden");
    if (!branchesEl.classList.contains("hidden")) {
      this.loadBranches();
    }
  }

  async loadBranches() {
    try {
      const cwd = this.state.cwd || this.currentCwd;
      const res = await fetch(
        `/api/git/branches?cwd=${encodeURIComponent(cwd)}`,
      );
      const data = await res.json();

      if (data.error) {
        return;
      }

      this.state.branches.list = data.branches || [];
      this.state.branches.current = data.current || this.state.branches.current;
      this.renderBranches();
    } catch (err) {
      console.error("Load branches error:", err);
    }
  }

  renderBranches() {
    const container = this.panel.querySelector("#git-branches");

    const html = this.state.branches.list
      .map((branch) => {
        const isCurrent = branch === this.state.branches.current;
        return `
        <div class="git-branch-item ${isCurrent ? "current" : ""}" data-branch="${this.escapeHtml(branch)}">
          <span class="git-branch-icon">${isCurrent ? "●" : "○"}</span>
          <span class="git-branch-name">${this.escapeHtml(branch)}</span>
        </div>
      `;
      })
      .join("");

    container.innerHTML = html || '<p class="muted">No branches</p>';

    // Add click handlers
    container
      .querySelectorAll(".git-branch-item:not(.current)")
      .forEach((el) => {
        el.addEventListener("click", () => {
          this.switchBranch(el.dataset.branch);
        });
      });
  }

  async switchBranch(branch) {
    if (branch === this.state.branches.current) return;

    try {
      const cwd = this.state.cwd || this.currentCwd;
      const res = await fetch("/api/git/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, branch }),
      });

      const data = await res.json();

      if (data.error) {
        alert(formatGitCheckoutError(data));
        return;
      }

      // Refresh everything
      await this.refresh();
      this.toggleBranches(); // Hide branch list
    } catch (err) {
      console.error("Switch branch error:", err);
      alert("Failed to switch branch");
    }
  }

  async show(cwd) {
    // An explicit cwd arg still wins (existing call sites always pass the
    // active workspace's cwd); otherwise resolve the canonical LIVE cwd
    // (explorer path / active workspace) instead of trusting a stale DOM read.
    this.state.cwd =
      cwd ||
      window.terminalManager?.getGitCwd?.() ||
      document.getElementById("directory")?.value ||
      "~";
    this.currentCwd = this.state.cwd; // Keep backward compatibility
    this.panel.classList.remove("hidden");
    this.state.selectedIndex = 0;
    await this.refresh();
  }

  hide() {
    this.panel.classList.add("hidden");
    // In windowed mode the panel lives inside a SurfaceWindow that must
    // close with it (the in-panel × and Esc call hide() directly).
    window.terminalManager?.surfaceWindowManager?.close("git");
    window.terminalManager?.syncSurfaceButtonState?.();
  }

  toggle() {
    this.panel.classList.contains("hidden") ? this.show() : this.hide();
  }

  // ── ViewHost contract (IDE shell slice 5) ───────────────────────────────────
  // GitManager conforms to the ViewHost lifecycle so the live instance can be
  // re-hosted (its #git-panel moved into another container) without recreation.
  // The IDE sidebar SCM presentation is a separate re-skin (git-scm-view.js) that
  // reuses this instance's git OPERATIONS; these methods cover the legacy
  // floating-window / terminal-mode panel re-host. mount(container) moves the
  // panel element into the container + reveals it; unmount() returns it home +
  // hides it (model state lives in this.state, so a re-mount restores from it).
  mount(container) {
    if (!container || !this.panel) return;
    if (this.panel.parentElement !== container)
      container.appendChild(this.panel);
    this.panel.classList.remove("hidden");
  }

  unmount() {
    if (!this.panel) return;
    const home = document.getElementById("app");
    if (home && this.panel.parentElement !== home) home.appendChild(this.panel);
    this.panel.classList.add("hidden");
  }

  dispose() {
    this.unmount();
  }

  // The diff editor (#git-diff) is a CodeMirror MergeView that needs a measure
  // pass when its container resizes. Trigger a cheap re-measure on the live
  // view rather than re-fetching the whole diff over the network — the diff
  // CONTENT does not change on a layout resize, only the rendered geometry.
  // For a split MergeView the sub-editors are on .a/.b; for an inline
  // EditorView requestMeasure() is directly on the view.
  resize() {
    if (this.panel?.classList.contains("hidden")) return;
    const mv = this._mergeView;
    if (!mv) return;
    // EditorView (inline unified mode) exposes requestMeasure() directly.
    if (typeof mv.requestMeasure === "function") {
      mv.requestMeasure();
      return;
    }
    // MergeView (split mode) exposes .a and .b EditorViews.
    mv.a?.requestMeasure?.();
    mv.b?.requestMeasure?.();
  }

  async refresh() {
    // Resolve the cwd LIVE every call — explorer navigation / a committed
    // working-dir field change moves the canonical cwd AFTER this panel first
    // mounted, and trusting the cached state.cwd is exactly the stuck-cwd bug
    // (the old set-once guard). Falls back to the cached field only when no
    // live source is available (e.g. GitManager used standalone in a test).
    const tm = window.terminalManager;
    const liveCwd = tm?.getGitCwd?.();
    const cwd = liveCwd || this.state.cwd || this.currentCwd;
    if (!cwd) return;
    this.state.cwd = cwd;
    this.currentCwd = cwd;
    this.state.loading = true;

    // Monotonic generation guard: if a NEWER refresh() starts before this one's
    // network round trips land, this (now-stale) call must not clobber the
    // newer state it would otherwise overwrite.
    const generation = ++this._refreshGeneration;
    const stale = () => generation !== this._refreshGeneration;

    try {
      // Fetch status through the shared, deduping GitStatusStore instead of a
      // raw fetch. refreshStatus() force-refetches + repopulates the cache +
      // EMITS onChange (the IDE SCM view's subscriber re-renders from it) — the
      // same effect the old separate force-refresh call below used to produce
      // as a SECOND, redundant fetch; that call is gone (see below).
      const statusData = tm?.gitStatusStore
        ? await tm.gitStatusStore.refreshStatus(cwd)
        : await fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`).then(
            (r) => r.json(),
          );
      if (stale()) return;

      if (statusData.error) {
        this.state.error = statusData.error;
        this.panel.querySelector("#git-branch").textContent = "not a repo";
        this.panel.querySelector("#git-files").innerHTML =
          `<p class="error">${this.escapeHtml(statusData.error)}</p>`;
        return;
      }
      this.state.error = null;

      const prevSelectedPath = this.state.selectedPath;
      const prevDiffMode = this.state.diffMode;

      // groupStatusFiles (git-scm.js) splits into staged/changes/untracked
      // with VS Code semantics; sync state powers the push/pull header UI.
      this.state.files = groupStatusFiles(statusData.files);
      this.state.sync = {
        upstream: statusData.upstream || null,
        ahead: statusData.ahead || 0,
        behind: statusData.behind || 0,
      };
      this.state.branches.current = statusData.branch;

      this.panel.querySelector("#git-branch").textContent = statusData.branch;
      this.renderSyncState();
      this.renderFiles();

      if (prevSelectedPath) {
        const allFiles = this.getAllFiles();
        const nextIndex = allFiles.findIndex(
          (f) => f.path === prevSelectedPath,
        );
        if (nextIndex !== -1) {
          this.state.selectedIndex = nextIndex;
          this.state.selectedPath = prevSelectedPath;
          this.highlightSelectedFile();
          this.state.diffMode = prevDiffMode;
          this.updateDiffModeUI();
        }
      }

      // Keep explorer git decorations in sync with the panel. The store's
      // refreshStatus() above already repopulated the cache + emitted
      // onChange, so this just re-derives decorations from the now-fresh
      // cache (no extra network call).
      if (tm) void tm.refreshExplorerDecorations();

      if (stale()) return;

      // Fetch commit history
      const logRes = await fetch(
        `/api/git/log?cwd=${encodeURIComponent(cwd)}&limit=30`,
      );
      const logData = await logRes.json();
      if (stale()) return;

      if (!logData.error) {
        this.state.commits = logData.commits || [];
        this.renderHistory();
      }

      // Fetch stash list (pop/apply/drop UI lives in #git-stashes)
      const stashRes = await fetch(
        `/api/git/stash?cwd=${encodeURIComponent(cwd)}`,
      );
      const stashData = await stashRes.json();
      if (stale()) return;

      if (!stashData.error) {
        this.state.stashes = stashData.stashes || [];
        this.renderStashes();
      }
    } catch (err) {
      console.error("Git refresh error:", err);
    } finally {
      if (!stale()) this.state.loading = false;
    }
  }

  renderStatus(files) {
    const container = this.panel.querySelector("#git-files");
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
        const el = e.target.closest(".git-file");
        const files = this.getAllFiles();
        const file = files[parseInt(el.dataset.index)];
        if (file) {
          this.toggleStage(file.path, file.staged);
        }
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

  getAllFiles() {
    // Order must match renderFiles() section order — row data-index points
    // into this list.
    return [
      ...(this.state.files.merge || []),
      ...this.state.files.staged,
      ...this.state.files.changes,
      ...(this.state.files.untracked || []),
    ];
  }

  renderFiles() {
    const container = this.panel.querySelector("#git-files");
    const sections = [
      {
        // Merge conflicts are read-only here (visibility only — accept
        // actions live in the IDE SCM view; the terminal is the mobile
        // resolve tool). Without this section a conflicted file, which the
        // server now classifies as section:"merge", would show NOWHERE in
        // the classic panel (pre-D3 it mis-showed under Staged).
        key: "merge",
        label: "Merge Conflicts",
        icon: "!",
        files: this.state.files.merge || [],
        groupAction: null,
        groupActionGlyph: "",
        groupActionTitle: "",
      },
      {
        key: "staged",
        label: "Staged Changes",
        icon: "\u2713",
        files: this.state.files.staged,
        groupAction: "unstage-all",
        groupActionGlyph: "\u2212",
        groupActionTitle: "Unstage all",
      },
      {
        key: "changes",
        label: "Changes",
        icon: "\u2022",
        files: this.state.files.changes,
        groupAction: "stage-all",
        groupActionGlyph: "+",
        groupActionTitle: "Stage all",
      },
      {
        key: "untracked",
        label: "Untracked",
        icon: "\u25cb",
        files: this.state.files.untracked || [],
        groupAction: "stage-all",
        groupActionGlyph: "+",
        groupActionTitle: "Stage all",
      },
    ];

    let html = "";
    let globalIndex = 0;

    sections.forEach((section) => {
      const files = section.files;
      // The merge section is conflict-only visibility: hidden entirely when
      // there is no conflict (unlike the three permanent groups).
      if (section.key === "merge" && files.length === 0) return;
      const { html: treeHtml, nextIndex } = this.renderSectionTree(
        files,
        section,
        globalIndex,
      );
      globalIndex = nextIndex;

      html += `
        <div class="git-file-group git-file-group-${section.key}">
          <div class="git-file-group-header">
            <span class="git-file-group-icon ${section.key}">${section.icon}</span>
            <span class="git-file-group-label">${section.label}</span>
            <span class="git-file-group-count">(${files.length})</span>
            ${
              files.length > 0 && section.groupAction
                ? `<button class="git-group-action" data-group="${section.key}" data-group-action="${section.groupAction}" title="${section.groupActionTitle}">${section.groupActionGlyph}</button>`
                : ""
            }
          </div>
          <div class="git-file-group-items">
            ${treeHtml}
          </div>
        </div>
      `;
    });

    if (this.getAllFiles().length === 0) {
      html = '<p class="muted centered">No changes</p>';
    }

    container.innerHTML = html;

    if (!this.state.selectedPath) {
      const firstFile = this.getAllFiles()[0];
      if (firstFile) {
        this.state.selectedPath = firstFile.path;
        this.state.selectedIndex = 0;
      }
    }
    this.highlightSelectedFile();

    container.querySelectorAll(".git-tree-folder").forEach((el) => {
      el.addEventListener("click", () => {
        const key = el.dataset.folderKey;
        if (!key) return;
        if (this.state.collapsedFolders.has(key)) {
          this.state.collapsedFolders.delete(key);
        } else {
          this.state.collapsedFolders.add(key);
        }
        this.renderFiles();
      });
    });

    // Add event listeners
    container.querySelectorAll(".git-file").forEach((el) => {
      el.addEventListener("click", (e) => {
        const files = this.getAllFiles();
        const file = files[parseInt(el.dataset.index, 10)];

        if (e.target.classList.contains("git-file-stage")) {
          this.toggleStage(el.dataset.path, file?.staged);
          return;
        }

        if (e.target.classList.contains("git-file-open")) {
          const cwd = (this.state.cwd || this.currentCwd || "").replace(
            /\/$/,
            "",
          );
          window.terminalManager?.openFileInEditor?.(
            `${cwd}/${el.dataset.path}`,
          );
          return;
        }

        if (e.target.classList.contains("git-file-discard")) {
          this.discardFile(file || { path: el.dataset.path });
          return;
        }

        this.state.selectedIndex = parseInt(el.dataset.index, 10);
        this.state.selectedPath = el.dataset.path;
        this.highlightSelectedFile();
        if (this.state.rightView === "timeline") {
          this.showTimeline(el.dataset.path);
        } else {
          this.showDiff(el.dataset.path);
        }
      });
    });

    container.querySelectorAll(".git-group-action").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const group = btn.dataset.group;
        const action = btn.dataset.groupAction;
        const files = this.state.files[group] || [];
        if (files.length === 0) return;
        this.stagePaths(
          files.map((f) => f.path),
          action === "unstage-all",
        );
      });
    });
  }

  renderSyncState() {
    const el = this.panel.querySelector("#git-sync-label");
    if (!el) return;
    const sync = this.state.sync || { ahead: 0, behind: 0, upstream: null };
    el.textContent = syncLabel(sync.ahead, sync.behind);
    // Pull only makes sense with an upstream; Push without one publishes the
    // branch (-u origin <branch>), VS Code-style.
    this.panel.querySelector("#git-pull-btn").disabled = !sync.upstream;
    this.panel
      .querySelector("#git-push-btn")
      .setAttribute(
        "title",
        sync.upstream ? "Push" : "Publish branch (push -u origin)",
      );
  }

  async syncAction(op) {
    const btn = this.panel.querySelector(`#git-${op}-btn`);
    if (btn?.disabled) return;
    const cwd = this.state.cwd || this.currentCwd;
    const body = { cwd };
    if (op === "push" && !this.state.sync?.upstream) {
      body.setUpstream = true;
      body.remote = "origin";
      body.branch = this.state.branches.current;
    }
    if (btn) btn.disabled = true;
    try {
      const res = await fetch(`/api/git/${op}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.error) {
        this.showCommitStatus(
          formatGitError(data, `${op[0].toUpperCase()}${op.slice(1)} failed`),
          "error",
        );
        return;
      }
      this.showCommitStatus(
        `${op[0].toUpperCase()}${op.slice(1)} done`,
        "success",
      );
      await this.refresh();
    } catch (err) {
      console.error(`Git ${op} error:`, err);
      this.showCommitStatus(`${op} failed: network error`, "error");
    } finally {
      if (btn) btn.disabled = false;
      this.renderSyncState();
    }
  }

  async stashPush() {
    const message = window.prompt("Stash message (optional):");
    if (message === null) return; // cancelled
    const cwd = this.state.cwd || this.currentCwd;
    try {
      const res = await fetch("/api/git/stash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          action: "push",
          message: message.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (data.error) {
        this.showCommitStatus(formatGitError(data, "Stash failed"), "error");
        return;
      }
      this.showCommitStatus("Stashed", "success");
      await this.refresh();
    } catch (err) {
      console.error("Stash error:", err);
    }
  }

  async stashAction(action, index) {
    if (
      action === "drop" &&
      !window.confirm("Drop this stash? This cannot be undone.")
    ) {
      return;
    }
    const cwd = this.state.cwd || this.currentCwd;
    try {
      const res = await fetch("/api/git/stash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, action, index }),
      });
      const data = await res.json();
      if (data.error) {
        this.showCommitStatus(formatGitError(data, "Stash failed"), "error");
        return;
      }
      await this.refresh();
    } catch (err) {
      console.error("Stash action error:", err);
    }
  }

  renderStashes() {
    const container = this.panel.querySelector("#git-stashes");
    if (!container) return;
    const stashes = this.state.stashes || [];
    if (stashes.length === 0) {
      container.innerHTML = "";
      return;
    }
    const rows = stashes
      .map(
        (s) => `
      <div class="git-stash-item" data-index="${s.index}">
        <span class="git-stash-icon" title="Stash">${"≡"}</span>
        <span class="git-stash-msg" title="${this.escapeHtml(s.message)}">${this.escapeHtml(s.message)}</span>
        <button class="git-stash-action" data-action="apply" title="Apply (keep stash)">apply</button>
        <button class="git-stash-action" data-action="pop" title="Pop (apply + drop)">pop</button>
        <button class="git-stash-action git-stash-drop" data-action="drop" title="Drop">${"×"}</button>
      </div>`,
      )
      .join("");
    container.innerHTML = `<div class="git-stash-header">Stashes (${stashes.length})</div>${rows}`;

    container.querySelectorAll(".git-stash-action").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const item = e.target.closest(".git-stash-item");
        const index = parseInt(item.dataset.index, 10);
        this.stashAction(e.target.dataset.action, index);
      });
    });
  }

  async stagePaths(paths, unstage) {
    try {
      const cwd = this.state.cwd || this.currentCwd;
      const res = await fetch(unstage ? "/api/git/unstage" : "/api/git/stage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, paths }),
      });
      const data = await res.json();
      if (data.error) {
        this.showCommitStatus(
          formatGitError(data, unstage ? "Unstage failed" : "Stage failed"),
          "error",
        );
        return;
      }
      await this.refresh();
    } catch (err) {
      console.error("Stage paths error:", err);
    }
  }

  async discardFile(file) {
    const untracked = statusLetter(file) === "U";
    const question = untracked
      ? `Delete untracked file ${file.path}?`
      : `Discard changes to ${file.path}? This cannot be undone.`;
    if (!window.confirm(question)) return;
    try {
      const cwd = this.state.cwd || this.currentCwd;
      const res = await fetch("/api/git/discard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, paths: [file.path], confirm: true }),
      });
      const data = await res.json();
      if (data.error) {
        this.showCommitStatus(formatGitError(data, "Discard failed"), "error");
        return;
      }
      if (this.state.selectedPath === file.path) {
        this.state.selectedPath = null;
      }
      await this.refresh();
    } catch (err) {
      console.error("Discard error:", err);
    }
  }

  // Resolves a merge conflict for `path` (Track D slice D3): a CLIENT-side
  // transform of the working file's conflict markers — no new broker argv
  // surface. Fetch the working content → resolveConflicts() (pure parser,
  // web/merge-conflicts.js) picks ours/theirs/both → write back through the
  // EXISTING mtime-guarded PUT /api/files/content (atomic, mapped-uid,
  // audited there as file.write) → stage the resolved path through the new
  // POST /api/git/resolve-stage (writes the explicit merge.resolve audit row).
  // mode: "ours" | "theirs" | "both". Returns { ok, error? }; never throws.
  async resolveConflict(path, mode) {
    const cwd = this.state.cwd || this.currentCwd;
    const absCwd = (cwd || "").replace(/\/$/, "");
    const abs = `${absCwd}/${path}`;
    try {
      const getRes = await fetch(
        `/api/files/content?path=${encodeURIComponent(abs)}`,
      );
      const getData = await getRes.json().catch(() => ({}));
      if (!getRes.ok || typeof getData.content !== "string") {
        this.showCommitStatus(
          formatGitError(getData, "Could not read the conflicted file"),
          "error",
        );
        return { ok: false, error: getData.error };
      }

      const resolver = window.MergeConflicts?.resolveConflicts;
      const resolved = resolver ? resolver(getData.content, mode) : null;
      if (!resolved || !resolved.ok) {
        const message =
          resolved?.error ||
          "Could not parse conflict markers — resolve in the terminal";
        this.showCommitStatus(message, "error");
        return { ok: false, error: message };
      }

      const putRes = await fetch("/api/files/content", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: abs,
          content: resolved.content,
          expectedMtimeMs: getData.mtimeMs,
        }),
      });
      const putData = await putRes.json().catch(() => ({}));
      if (!putRes.ok) {
        const fallback =
          putData?.reason === "mtime_conflict"
            ? "File changed on disk since it was opened — reload and try again"
            : "Failed to save the resolved file";
        this.showCommitStatus(formatGitError(putData, fallback), "error");
        return { ok: false, error: putData?.error };
      }

      const stageRes = await fetch("/api/git/resolve-stage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, paths: [path], resolution: mode }),
      });
      const stageData = await stageRes.json().catch(() => ({}));
      if (!stageRes.ok) {
        this.showCommitStatus(
          formatGitError(stageData, "Resolved file saved, but staging failed"),
          "error",
        );
        return { ok: false, error: stageData?.error };
      }

      this.showCommitStatus("Resolved", "success");
      if (this.state.selectedPath === path) {
        this.state.selectedPath = null;
      }
      await this.refresh();
      return { ok: true };
    } catch (err) {
      console.error("Resolve conflict error:", err);
      this.showCommitStatus("Resolve failed: network error", "error");
      return { ok: false, error: String(err) };
    }
  }

  renderSectionTree(files, section, startIndex) {
    if (files.length === 0) {
      return {
        html: '<p class="muted centered">No files</p>',
        nextIndex: startIndex,
      };
    }

    const root = this.buildFileTree(files);
    const rendered = this.renderTreeNode(root, section.key, 0, startIndex);
    return { html: rendered.html, nextIndex: rendered.nextIndex };
  }

  buildFileTree(files) {
    const root = { folders: new Map(), files: [] };

    files.forEach((file) => {
      const parts = file.path.split("/");
      let node = root;
      let prefix = "";

      for (let i = 0; i < parts.length - 1; i++) {
        const folder = parts[i];
        prefix = prefix ? `${prefix}/${folder}` : folder;
        if (!node.folders.has(folder)) {
          node.folders.set(folder, {
            name: folder,
            fullPath: prefix,
            folders: new Map(),
            files: [],
          });
        }
        node = node.folders.get(folder);
      }

      node.files.push(file);
    });

    return root;
  }

  renderTreeNode(node, sectionKey, depth, startIndex) {
    let html = "";
    let index = startIndex;

    const folders = Array.from(node.folders?.values?.() || []).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    folders.forEach((folder) => {
      const folderKey = `${sectionKey}:${folder.fullPath}`;
      const collapsed = this.state.collapsedFolders.has(folderKey);
      html += `
        <div class="git-tree-folder" data-node-type="folder" data-folder-key="${this.escapeHtml(folderKey)}" style="--tree-depth:${depth}">
          <span class="git-tree-chevron">${collapsed ? "\u25b8" : "\u25be"}</span>
          <span class="git-tree-folder-name">${this.escapeHtml(folder.name)}</span>
        </div>
      `;
      if (!collapsed) {
        const rendered = this.renderTreeNode(
          folder,
          sectionKey,
          depth + 1,
          index,
        );
        html += rendered.html;
        index = rendered.nextIndex;
      }
    });

    const files = [...(node.files || [])].sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    files.forEach((file) => {
      const isSelected =
        this.state.selectedPath === file.path ||
        index === this.state.selectedIndex;
      const fileName = file.path.split("/").pop() || file.path;
      const letter = statusLetter(file);
      const colorClass = statusClass(letter);
      const discardTitle =
        letter === "U" ? "Delete untracked file" : "Discard changes";
      html += `
        <div class="git-file ${isSelected ? "selected" : ""}" data-path="${this.escapeHtml(file.path)}" data-index="${index}" style="--tree-depth:${depth}">
          <span class="git-file-path ${colorClass}" title="${this.escapeHtml(file.path)}">${this.escapeHtml(fileName)}</span>
          <div class="git-file-actions">
            <button class="git-file-open" title="Open file">⤢</button>
            <button class="git-file-discard" title="${discardTitle}">⟲</button>
            <button class="git-file-stage" title="${file.staged ? "Unstage" : "Stage"}">${file.staged ? "−" : "+"}</button>
          </div>
          <span class="git-file-status ${colorClass}">${this.escapeHtml(letter)}</span>
        </div>
      `;
      index++;
    });

    return { html, nextIndex: index };
  }

  getStatusGlyph(file) {
    if (file.stagedStatus) return file.stagedStatus;
    if (file.unstagedStatus) return file.unstagedStatus;
    if (file.status) return file.status;
    return "?";
  }

  truncatePath(path, maxLen = 30) {
    if (path.length <= maxLen) return path;
    return "..." + path.slice(-maxLen + 3);
  }

  async showDiff(path) {
    const mode = this.state.diffMode || "working";
    this.state.selectedPath = path || this.state.selectedPath;
    const resolvedPath = path || this.state.selectedPath;
    const titlePath = resolvedPath || "Diff";
    const modeLabel =
      mode === "staged"
        ? "Staged"
        : mode === "commit"
          ? "Commit"
          : "Working Tree";
    this.panel.querySelector("#git-diff-title").textContent =
      `${titlePath} (${modeLabel})`;
    this.panel.querySelector("#git-diff").innerHTML =
      '<p class="muted">Loading...</p>';

    // Whole-commit view (no file selected) stays a raw patch — the merge
    // editor compares exactly one file.
    if (!resolvedPath || (mode === "commit" && !this.state.selectedCommit)) {
      await this.showPatchDiff(resolvedPath);
      return;
    }

    try {
      const file = this.getAllFiles().find((f) => f.path === resolvedPath) || {
        path: resolvedPath,
      };
      const sources = diffSources(mode, file, this.state.selectedCommit);
      const [original, modified] = await Promise.all([
        this.fetchDiffSource(sources.original, resolvedPath),
        this.fetchDiffSource(sources.modified, resolvedPath),
      ]);
      if (original === null || modified === null) {
        // Binary/unreadable on either side — the unified patch still renders.
        await this.showPatchDiff(resolvedPath);
        return;
      }
      await this.renderMergeDiff(original, modified, resolvedPath);
    } catch (err) {
      console.warn("Merge diff failed, falling back to patch:", err);
      await this.showPatchDiff(resolvedPath);
    }
  }

  // Legacy unified-patch rendering (diff2html / plain text) — fallback path.
  async showPatchDiff(path) {
    try {
      const cwd = this.state.cwd || this.currentCwd;
      const mode = this.state.diffMode || "working";
      const params = new URLSearchParams({ cwd });
      if (path) {
        params.set("path", path);
      }
      if (mode === "staged") {
        params.set("staged", "1");
      } else if (mode === "commit" && this.state.selectedCommit) {
        params.set("commit", this.state.selectedCommit);
      }

      const res = await fetch(`/api/git/diff?${params.toString()}`);
      const data = await res.json();

      if (data.error) {
        this.panel.querySelector("#git-diff").innerHTML =
          `<p class="error">${this.escapeHtml(data.error)}</p>`;
        return;
      }

      this.showDiffContent(data.diff, path || "");
    } catch (err) {
      console.error("Diff error:", err);
      this.panel.querySelector("#git-diff").innerHTML =
        '<p class="error">Failed to load diff</p>';
    }
  }

  // Resolves a diffSources() descriptor to document text. null = unreadable
  // (binary, too large) → caller falls back to the patch view. A git-show 404
  // means "file absent at that ref" (new file) and maps to "".
  async fetchDiffSource(source, relPath) {
    const cwd = this.state.cwd || this.currentCwd;
    if (source.kind === "empty") return "";
    if (source.kind === "worktree") {
      const abs = `${cwd.replace(/\/$/, "")}/${relPath}`;
      const res = await fetch(
        `/api/files/content?path=${encodeURIComponent(abs)}`,
      );
      if (!res.ok) return null;
      const data = await res.json();
      return typeof data.content === "string" ? data.content : null;
    }
    const params = new URLSearchParams({
      cwd,
      commit: source.ref,
      path: relPath,
    });
    const res = await fetch(`/api/git/show?${params.toString()}`);
    if (res.status === 404) return "";
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.content === "string" ? data.content : "";
  }

  getDiffLayout() {
    // Narrow screens always get the inline diff; otherwise the persisted
    // preference (settings KV, phase 1) decides.
    if (window.innerWidth < 768) return "inline";
    return (
      window.terminalManager?.settingsStore?.get("git.diffLayout", "split") ||
      "split"
    );
  }

  async renderMergeDiff(original, modified, relPath) {
    const container = this.panel.querySelector("#git-diff");
    this._mergeView?.destroy?.();
    this._mergeView = null;
    this._mergeView = await this.buildMergeView(
      container,
      original,
      modified,
      relPath,
    );
  }

  // Render a merge diff into an editor TAB body (IDE slice 4). Returns the view
  // so the tab controller can keep it; reuses the exact CodeMirror machinery as
  // the git panel diff. Each call owns its own view (no shared _mergeView).
  async renderMergeDiffInto(container, original, modified, relPath) {
    return this.buildMergeView(container, original, modified, relPath);
  }

  // Shared merge-view builder (git panel + editor tab). Reads the diff-layout
  // preference (split vs inline). Returns the live view/MergeView.
  async buildMergeView(container, original, modified, relPath) {
    this.cm ||= await import("/vendor/codemirror.js");
    if (!container) return null;
    container.innerHTML = "";

    const langName = window.FileEditorModule?.detectEditorLanguage?.(relPath);
    const langExt =
      langName && typeof this.cm[langName] === "function"
        ? [this.cm[langName]()]
        : [];
    const shared = [
      this.cm.EditorView.editable.of(false),
      this.cm.EditorState.readOnly.of(true),
      this.cm.oneDark,
      ...langExt,
    ];

    if (this.getDiffLayout() === "inline") {
      return new this.cm.EditorView({
        doc: modified,
        extensions: [
          ...shared,
          this.cm.unifiedMergeView({
            original,
            mergeControls: false,
            collapseUnchanged: { margin: 3, minSize: 4 },
          }),
        ],
        parent: container,
      });
    }

    return new this.cm.MergeView({
      a: { doc: original, extensions: shared },
      b: { doc: modified, extensions: shared },
      parent: container,
      collapseUnchanged: { margin: 3, minSize: 4 },
    });
  }

  // Per-file timeline: lists the commit history of the selected file and lets
  // the user diff any revision against its previous revision (root commit ->
  // empty tree). Reuses renderMergeDiff for the diff itself.
  async showTimeline(path) {
    const container = this.panel.querySelector("#git-timeline");
    if (!container) return;
    const resolvedPath = path || this.state.selectedPath;

    if (!resolvedPath) {
      this.state.timelineEntries = [];
      this.state.timelinePath = null;
      container.innerHTML =
        '<p class="muted centered">Select a file to see its history</p>';
      return;
    }

    container.innerHTML = '<p class="muted centered">Loading history…</p>';
    try {
      const cwd = this.state.cwd || this.currentCwd;
      const params = new URLSearchParams({ cwd, path: resolvedPath });
      const res = await fetch(`/api/git/log?${params.toString()}`);
      const data = await res.json();
      if (data.error) {
        container.innerHTML = `<p class="error">${this.escapeHtml(data.error)}</p>`;
        return;
      }
      const entries = window.GitTimeline.buildTimelineEntries(data.commits);
      this.state.timelineEntries = entries;
      this.state.timelinePath = resolvedPath;
      this.renderTimeline(resolvedPath);
    } catch (err) {
      console.error("Timeline error:", err);
      container.innerHTML = '<p class="error">Failed to load history</p>';
    }
  }

  renderTimeline(path) {
    const container = this.panel.querySelector("#git-timeline");
    if (!container) return;
    const entries = this.state.timelineEntries || [];

    if (entries.length === 0) {
      container.innerHTML =
        '<p class="muted centered">No commit history for this file</p>';
      return;
    }

    const rows = entries
      .map(
        (e, i) => `
      <div class="git-timeline-row" data-index="${i}" title="${this.escapeHtml(e.message)}">
        <span class="git-timeline-hash">${this.escapeHtml(e.shortHash)}</span>
        <span class="git-timeline-message">${this.escapeHtml(this.truncateMessage(e.message))}</span>
        <span class="git-timeline-meta">${this.escapeHtml(e.author)} · ${this.escapeHtml(e.relativeDate)}</span>
      </div>`,
      )
      .join("");
    container.innerHTML = `<div class="git-timeline-path">${this.escapeHtml(path)}</div>${rows}`;

    container.querySelectorAll(".git-timeline-row").forEach((el) => {
      el.addEventListener("click", () => {
        container
          .querySelectorAll(".git-timeline-row")
          .forEach((r) => r.classList.remove("selected"));
        el.classList.add("selected");
        this.showTimelineDiff(parseInt(el.dataset.index, 10));
      });
    });
  }

  async showTimelineDiff(index) {
    const entries = this.state.timelineEntries || [];
    const entry = entries[index];
    const path = this.state.timelinePath || this.state.selectedPath;
    if (!entry || !path) return;

    // IDE mode (slice 5): open the revision diff as a commit-mode EDITOR TAB
    // (keyed on the commit sha) instead of the legacy in-panel #git-diff pane.
    const tm = window.terminalManager;
    if (tm?.isIdeModeActive?.() && tm.openDiffTab) {
      tm.openDiffTab({
        relPath: path,
        mode: "commit",
        cwd: this.state.cwd || this.currentCwd,
        commit: entry.hash || entry.shortHash,
        title: `${path} @ ${entry.shortHash}`,
      });
      return;
    }

    const diffEl = this.panel.querySelector("#git-diff");
    if (diffEl) diffEl.classList.remove("hidden");
    diffEl.innerHTML = '<p class="muted">Loading…</p>';
    this.panel.querySelector("#git-diff-title").textContent =
      `${path} @ ${entry.shortHash}`;

    // prevCommit = next-older revision of THIS file (or undefined at root).
    const prevEntry = entries[index + 1];
    const { ref, prevRef } = window.GitTimeline.revPairForCommit(
      entry,
      entry.isRoot,
      prevEntry,
    );

    try {
      const [original, modified] = await Promise.all([
        this.fetchRevisionContent(prevRef, path),
        this.fetchRevisionContent(ref, path),
      ]);
      await this.renderMergeDiff(original, modified, path);
    } catch (err) {
      console.error("Timeline diff error:", err);
      diffEl.innerHTML = '<p class="error">Failed to load revision diff</p>';
    }
  }

  // Fetches a file's content at a git ref via /api/git/show. A 404 (path absent
  // at that ref — additions/deletions/empty-tree side) and any other failure
  // map to "" so the diff renders as a clean add/delete instead of erroring.
  async fetchRevisionContent(ref, relPath) {
    try {
      const cwd = this.state.cwd || this.currentCwd;
      const params = new URLSearchParams({ cwd, commit: ref, path: relPath });
      const res = await fetch(`/api/git/show?${params.toString()}`);
      if (!res.ok) return "";
      const data = await res.json();
      return typeof data.content === "string" ? data.content : "";
    } catch (err) {
      return "";
    }
  }

  async toggleStage(path, isCurrentlyStaged) {
    try {
      const cwd = this.state.cwd || this.currentCwd;
      const endpoint = isCurrentlyStaged
        ? "/api/git/unstage"
        : "/api/git/stage";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, paths: [path] }),
      });

      const data = await res.json();

      if (data.error) {
        console.error("Stage/unstage error:", data.error);
        return;
      }

      // Refresh file list
      await this.refresh();
    } catch (err) {
      console.error("Toggle stage error:", err);
    }
  }

  // Legacy panel commit: reads the hidden #git-message / #git-amend controls,
  // then delegates to the parameterized commitWith() op. The IDE SCM view calls
  // commitWith() directly (no hidden-DOM mirroring).
  async commit() {
    const message = this.panel.querySelector("#git-message").value.trim();
    const amendEl = this.panel.querySelector("#git-amend");
    const amend = !!amendEl?.checked;
    const result = await this.commitWith({ message, amend });
    // On success the legacy panel clears its own controls (commitWith doesn't
    // touch DOM, so the caller owns its inputs).
    if (result?.ok) {
      this.panel.querySelector("#git-message").value = "";
      if (amendEl) amendEl.checked = false;
    }
    return result;
  }

  // Parameterized commit op (DOM-free): POST /api/git/commit with an explicit
  // message + amend flag, surface status, refresh on success. Returns
  // { ok: true } | { ok: false, error } so any caller (legacy panel OR the IDE
  // SCM view) can reflect the outcome in its own UI without reading DOM nodes.
  async commitWith({ message, amend } = {}) {
    const trimmed = (message || "").trim();
    if (!trimmed) {
      this.showCommitStatus("Commit message required", "error");
      return { ok: false, error: "Commit message required" };
    }

    const cwd = this.state.cwd || this.currentCwd;
    const doAmend = Boolean(amend);
    try {
      const res = await fetch("/api/git/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, message: trimmed, amend: doAmend }),
      });

      const data = await res.json();
      if (data.error) {
        // git puts "nothing to commit" on stdout; the backend now folds that
        // into `message`, so surface the real reason instead of a bare error.
        const formatGit =
          typeof formatGitError === "function"
            ? formatGitError
            : (p) => (p && p.error) || "Commit failed";
        const msg = formatGit(data, "Commit failed");
        this.showCommitStatus(msg, "error");
        return { ok: false, error: msg };
      }

      this.showCommitStatus(doAmend ? "Amended" : "Committed", "success");
      await this.refresh();
      return { ok: true };
    } catch (err) {
      console.error("Commit error:", err);
      this.showCommitStatus("Commit failed: network error", "error");
      return { ok: false, error: "Commit failed: network error" };
    }
  }

  showCommitStatus(text, kind = "info") {
    const el = this.panel.querySelector("#git-commit-status");
    if (!el) return;
    el.textContent = text;
    el.className = `git-commit-status ${kind}`;
    clearTimeout(this._commitStatusTimer);
    if (kind === "success") {
      this._commitStatusTimer = setTimeout(() => {
        el.textContent = "";
        el.className = "git-commit-status";
      }, 3000);
    }
  }

  escapeHtml(text) {
    // Delegate to the shared escaper (escapes & < > " ' — safe in quoted
    // attributes, e.g. the timeline/commit title="${message}" sites). See the
    // matching note on the other escapeHtml: the old round-trip left quotes
    // intact → attribute-breakout stored XSS.
    if (typeof window !== "undefined" && window.HtmlEscape?.escapeHtml) {
      return window.HtmlEscape.escapeHtml(text);
    }
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  renderHistory() {
    const container = this.panel.querySelector("#git-history");

    if (this.state.commits.length === 0) {
      container.innerHTML = '<p class="muted centered">No commits</p>';
      return;
    }

    const html = this.state.commits
      .map(
        (commit) => `
      <div class="git-commit-item" data-hash="${this.escapeHtml(commit.hash)}" title="${this.escapeHtml(commit.message)}">
        <span class="git-commit-graph">${this.escapeHtml(commit.graph)}</span>
        <span class="git-commit-hash">${this.escapeHtml(commit.hash)}</span>
        <span class="git-commit-message">${this.escapeHtml(this.truncateMessage(commit.message))}</span>
        <span class="git-commit-date">${this.formatDate(commit.date)}</span>
      </div>
    `,
      )
      .join("");

    container.innerHTML = html;

    // Click to show commit diff
    container.querySelectorAll(".git-commit-item").forEach((el) => {
      el.addEventListener("click", () => {
        this.showCommitDiff(el.dataset.hash);
      });
    });
  }

  truncateMessage(msg, maxLen = 50) {
    if (msg.length <= maxLen) return msg;
    return msg.slice(0, maxLen - 3) + "...";
  }

  formatDate(isoDate) {
    const date = new Date(isoDate);
    const now = new Date();
    const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return "today";
    if (diffDays === 1) return "yesterday";
    if (diffDays < 7) return `${diffDays}d ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
    return `${Math.floor(diffDays / 30)}mo ago`;
  }

  async showCommitDiff(hash) {
    this.state.selectedCommit = hash;
    this.state.diffMode = "commit";
    this.updateDiffModeUI();
    await this.showDiff(this.state.selectedPath);
  }

  showDiffContent(diffText, filename = "") {
    const container = this.panel.querySelector("#git-diff");

    if (!diffText || diffText.trim() === "") {
      container.innerHTML = '<p class="muted centered">No changes</p>';
      return;
    }

    // Check if diff2html is available
    if (typeof Diff2Html !== "undefined") {
      try {
        const diffHtml = Diff2Html.html(diffText, {
          drawFileList: false,
          matching: "lines",
          outputFormat: "line-by-line",
          renderNothingWhenEmpty: false,
        });
        container.innerHTML = diffHtml;
        return;
      } catch (err) {
        console.warn("diff2html error, falling back to plain text:", err);
      }
    }

    // Fallback to plain text with basic highlighting
    const lines = diffText
      .split("\n")
      .map((line) => {
        let className = "";
        if (line.startsWith("+") && !line.startsWith("+++"))
          className = "diff-add";
        else if (line.startsWith("-") && !line.startsWith("---"))
          className = "diff-del";
        else if (line.startsWith("@")) className = "diff-hunk";
        return `<div class="diff-line ${className}">${this.escapeHtml(line)}</div>`;
      })
      .join("");

    container.innerHTML = `<pre class="diff-plain">${lines}</pre>`;
  }
}

// =============================================================================
// SESSION REGISTRY - Persistent session tracking for reconnection
// =============================================================================

class SessionRegistry {
  constructor() {
    this.storageKey = "deckterm-session-registry";
    this.sessions = this.load();
  }

  load() {
    try {
      const stored = localStorage.getItem(this.storageKey);
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  }

  save() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.sessions));
    } catch (err) {
      console.warn("[SessionRegistry] Failed to save:", err);
    }
  }

  // Register a new terminal session
  register(terminalId, data) {
    this.sessions[terminalId] = {
      workspaceId: data.workspaceId,
      cwd: data.cwd,
      tabNum: data.tabNum,
      createdAt: Date.now(),
      ...data,
    };
    this.save();
    dbg("[SessionRegistry] Registered:", terminalId, this.sessions[terminalId]);
  }

  // Update session data (e.g., when cwd changes)
  update(terminalId, data) {
    if (this.sessions[terminalId]) {
      Object.assign(this.sessions[terminalId], data);
      this.save();
    }
  }

  // Remove a session when terminal is closed
  remove(terminalId) {
    delete this.sessions[terminalId];
    this.save();
    dbg("[SessionRegistry] Removed:", terminalId);
  }

  // Get session data for a terminal ID (for reconnection)
  get(terminalId) {
    return this.sessions[terminalId] || null;
  }

  // Check if we have saved state for a terminal ID
  has(terminalId) {
    return terminalId in this.sessions;
  }

  // Get all saved session IDs
  getAllIds() {
    return Object.keys(this.sessions);
  }

  // Clean up sessions that don't exist on server
  cleanup(serverTerminalIds) {
    const serverIdSet = new Set(serverTerminalIds);
    let removed = 0;
    for (const id of Object.keys(this.sessions)) {
      if (!serverIdSet.has(id)) {
        delete this.sessions[id];
        removed++;
      }
    }
    if (removed > 0) {
      this.save();
      dbg("[SessionRegistry] Cleaned up", removed, "stale sessions");
    }
  }

  // Clear all sessions
  clear() {
    this.sessions = {};
    this.save();
  }
}

// =============================================================================
// SETTINGS MANAGER - VS Code-style two-pane settings window
// =============================================================================

// Renders the settings window content (category sidebar + search + a control
// per setting + a read-only Server Config section). Reads/writes through the
// shared settingsStore; live changes flow through the settings runtime so side
// effects apply even when the window is closed. Pure render helpers live in
// settings-ui.js; coercion + schema in settings-schema.js.
class SettingsManager {
  constructor({ settingsStore, runtime, fetchImpl } = {}) {
    this.settingsStore = settingsStore || null;
    this.runtime = runtime || null;
    this.fetchImpl =
      fetchImpl ||
      (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    this.schema = window.SettingsSchema?.SETTINGS_SCHEMA || [];
    this.ui = window.SettingsUI || null;
    this.activeCategory = null;
    this.query = "";
    this.envLoaded = false;
    this.envRows = [];
    this.root = null;
    // B3-S5: role-gated "Users" category, appended after the schema-derived
    // categories (never disturbs their order). Visibility + the resolved
    // actor come from GET /api/foundation/status (fetched once per open).
    this.usersAdmin = window.UsersAdmin || null;
    this.usersAdminVisible = false;
    this.usersAdminCurrentUser = null;
    this.usersAdminController = null;
  }

  // Build (once) the detached content element the SurfaceWindow will host.
  buildContent() {
    if (this.root) return this.root;
    const root = document.createElement("div");
    root.className = "settings-panel";
    root.innerHTML = `
      <aside class="settings-sidebar" role="tablist" aria-label="Settings categories"></aside>
      <div class="settings-main">
        <div class="settings-search">
          <input type="search" class="settings-search-input"
            placeholder="Search settings" aria-label="Search settings" />
        </div>
        <div class="settings-list" role="region" aria-label="Settings"></div>
      </div>
    `;
    this.sidebarEl = root.querySelector(".settings-sidebar");
    this.searchInputEl = root.querySelector(".settings-search-input");
    this.listEl = root.querySelector(".settings-list");

    this.searchInputEl.addEventListener("input", () => {
      this.query = this.searchInputEl.value || "";
      this.renderList();
    });
    this.sidebarEl.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-settings-category]");
      if (!btn) return;
      this.activeCategory = btn.dataset.settingsCategory;
      this.query = "";
      if (this.searchInputEl) this.searchInputEl.value = "";
      this.renderSidebar();
      this.renderList();
    });
    this.listEl.addEventListener("change", (e) => this.handleControlChange(e));

    this.root = root;
    return root;
  }

  renderSidebar() {
    if (!this.sidebarEl) return;
    const categories = window.SettingsSchema?.categoriesOf?.(this.schema) || [];
    // Appended AFTER the schema-derived categories so their order/tests are
    // undisturbed; absent entirely for members/disabled/logged-out actors.
    if (this.usersAdminVisible) categories.push("Users");
    if (!this.activeCategory && categories.length) {
      this.activeCategory = categories[0];
    }
    this.sidebarEl.replaceChildren();
    for (const category of categories) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "settings-category-btn";
      btn.dataset.settingsCategory = category;
      btn.setAttribute("role", "tab");
      const active = !this.query && category === this.activeCategory;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
      btn.textContent = category;
      this.sidebarEl.appendChild(btn);
    }
  }

  // The list shows either the active category (no query) or the search results
  // across all categories (with a query).
  renderList() {
    if (!this.listEl || !this.ui) return;
    this.listEl.replaceChildren();

    // "Users" is a custom, non-schema category (B3-S5) — its panel is owned
    // by the users-admin module, not the settings-schema group/search view.
    if (this.activeCategory === "Users" && this.usersAdminVisible) {
      this.renderSidebar();
      this.renderUsersPanel();
      return;
    }

    const trimmed = this.query.trim();
    let groups;
    if (trimmed) {
      groups = this.ui.filterSchemaView(this.schema, trimmed);
    } else {
      groups = this.ui
        .groupByCategory(this.schema)
        .filter((g) => g.category === this.activeCategory);
    }
    this.renderSidebar();

    if (!groups.length) {
      const empty = document.createElement("p");
      empty.className = "settings-empty";
      empty.textContent = "No settings match your search.";
      this.listEl.appendChild(empty);
    }

    for (const group of groups) {
      if (trimmed) {
        const heading = document.createElement("h3");
        heading.className = "settings-group-heading";
        heading.textContent = group.category;
        this.listEl.appendChild(heading);
      }
      for (const def of group.entries) {
        const stored = this.settingsStore?.get(def.key, def.default);
        const descriptor = this.ui.buildControlDescriptor(def, stored);
        if (descriptor)
          this.listEl.appendChild(this.renderControlRow(descriptor));
      }
    }

    this.listEl.appendChild(this.renderServerConfig());
  }

  renderControlRow(descriptor) {
    const row = document.createElement("div");
    row.className = "settings-row";
    row.dataset.settingKey = descriptor.key;

    const labelWrap = document.createElement("div");
    labelWrap.className = "settings-row-label";
    const label = document.createElement("label");
    label.className = "settings-row-title";
    label.textContent = descriptor.label;
    labelWrap.appendChild(label);
    if (descriptor.description) {
      const desc = document.createElement("p");
      desc.className = "settings-row-desc";
      desc.textContent = descriptor.description;
      labelWrap.appendChild(desc);
    }

    const controlWrap = document.createElement("div");
    controlWrap.className = "settings-row-control";
    const control = this.buildControlElement(descriptor);
    if (control.id) label.setAttribute("for", control.id);
    controlWrap.appendChild(control);

    row.appendChild(labelWrap);
    row.appendChild(controlWrap);
    return row;
  }

  buildControlElement(descriptor) {
    const id = `setting-${descriptor.key.replace(/[^a-z0-9]+/gi, "-")}`;
    let el;
    switch (descriptor.type) {
      case "toggle": {
        el = document.createElement("input");
        el.type = "checkbox";
        el.className = "settings-control settings-toggle";
        el.checked = Boolean(descriptor.value);
        break;
      }
      case "number": {
        el = document.createElement("input");
        el.type = "number";
        el.className = "settings-control settings-number";
        if (typeof descriptor.min === "number") el.min = String(descriptor.min);
        if (typeof descriptor.max === "number") el.max = String(descriptor.max);
        el.value = String(descriptor.value);
        break;
      }
      case "select": {
        el = document.createElement("select");
        el.className = "settings-control settings-select";
        for (const opt of descriptor.options || []) {
          const option = document.createElement("option");
          option.value = opt.value;
          option.textContent = opt.label || opt.value;
          if (opt.value === descriptor.value) option.selected = true;
          el.appendChild(option);
        }
        break;
      }
      case "text":
      default: {
        el = document.createElement("input");
        el.type = "text";
        el.className = "settings-control settings-text";
        el.value = descriptor.value == null ? "" : String(descriptor.value);
        break;
      }
    }
    el.id = id;
    el.dataset.settingKey = descriptor.key;
    el.dataset.settingType = descriptor.type;
    return el;
  }

  handleControlChange(e) {
    const el = e.target.closest("[data-setting-key]");
    if (!el) return;
    const key = el.dataset.settingKey;
    const raw = el.type === "checkbox" ? el.checked : el.value;
    if (this.runtime) {
      this.runtime.apply(key, raw);
    } else if (this.settingsStore) {
      const def = this.schema.find((d) => d.key === key);
      const value = window.SettingsSchema?.coerceValue?.(def, raw) ?? raw;
      this.settingsStore.set(key, value);
    }
  }

  renderServerConfig() {
    const section = document.createElement("section");
    section.className = "settings-server-config";
    const heading = document.createElement("h3");
    heading.className = "settings-group-heading";
    heading.textContent = "Server Config";
    section.appendChild(heading);

    const note = document.createElement("p");
    note.className = "settings-server-note";
    note.textContent = "Read-only server configuration.";
    section.appendChild(note);

    const table = document.createElement("div");
    table.className = "settings-env-table";
    if (!this.envRows.length) {
      const empty = document.createElement("p");
      empty.className = "settings-empty";
      empty.textContent = this.envLoaded
        ? "No server config available."
        : "Loading server config…";
      table.appendChild(empty);
    }
    for (const row of this.envRows) {
      const envRow = document.createElement("div");
      envRow.className = "settings-env-row";
      const key = document.createElement("code");
      key.className = "settings-env-key";
      key.textContent = row.key;
      const value = document.createElement("span");
      value.className = "settings-env-value";
      value.textContent = row.value;
      const desc = document.createElement("p");
      desc.className = "settings-env-desc";
      desc.textContent = row.description || "";
      envRow.appendChild(key);
      envRow.appendChild(value);
      envRow.appendChild(desc);
      table.appendChild(envRow);
    }
    section.appendChild(table);
    return section;
  }

  // Fetches /api/foundation/status and derives Users-category visibility +
  // the resolved actor for the users-admin module's gate (shouldShowUsersCategory
  // — plan §7 Codex #15: non-null user, role owner|admin, disabled === false).
  // Any fetch/parse failure hides the category (fail-closed, matches the
  // server's own deny-by-default posture).
  async loadUsersAdminStatus() {
    this.usersAdminVisible = false;
    this.usersAdminCurrentUser = null;
    if (!this.fetchImpl || !this.usersAdmin) return;
    try {
      const res = await this.fetchImpl("/api/foundation/status");
      if (!res || !res.ok) return;
      const status = await res.json();
      this.usersAdminCurrentUser = status?.auth?.user || null;
      this.usersAdminVisible = Boolean(
        this.usersAdmin.shouldShowUsersCategory?.(status),
      );
    } catch {
      // Non-fatal — the category is simply absent.
    }
  }

  // Mounts the users-admin DOM controller into a fresh host inside the
  // settings list. The controller owns its own fetch/render/action wiring
  // (web/users-admin.js); this is intentionally the entire integration point.
  renderUsersPanel() {
    if (!this.usersAdmin) return;
    const host = document.createElement("div");
    host.className = "users-admin-host";
    this.listEl.appendChild(host);
    if (!this.usersAdminController) {
      this.usersAdminController = new this.usersAdmin.UsersAdminController({
        fetchImpl: this.fetchImpl,
        getCurrentUser: () => this.usersAdminCurrentUser,
      });
    }
    this.usersAdminController.mount(host);
  }

  async loadServerConfig() {
    if (this.envLoaded || !this.fetchImpl) return;
    try {
      const res = await this.fetchImpl("/api/settings/env-info");
      if (res && res.ok) {
        const body = await res.json();
        if (Array.isArray(body?.env)) this.envRows = body.env;
      }
    } catch {
      // Non-fatal — the section renders an empty/error state.
    } finally {
      this.envLoaded = true;
    }
  }

  async render() {
    this.buildContent();
    await this.loadUsersAdminStatus();
    this.renderSidebar();
    this.renderList();
    await this.loadServerConfig();
    // Re-render the server-config section now that rows are loaded.
    this.renderList();
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
    // Canonical settings (terminal.fontSize / terminal.wrapLines) are applied
    // by the settings runtime once the store + legacy migration resolve; seed
    // with the schema defaults here so terminals constructed before that have a
    // sane value. No legacy localStorage read — the migration owns that.
    const settingsDefaults =
      window.SettingsSchema?.defaultsOf?.(
        window.SettingsSchema.SETTINGS_SCHEMA,
      ) || {};
    this.fontSize =
      typeof settingsDefaults["terminal.fontSize"] === "number"
        ? settingsDefaults["terminal.fontSize"]
        : 14;
    this.wrapLines = Boolean(settingsDefaults["terminal.wrapLines"]);
    this.draggingTabId = null;
    this.draggingWorkspaceId = null;
    this.workspaceLastActive = new Map(); // workspaceId -> terminalId
    this.resizeDebounceMs = 80;
    this.debugMode = false;
    this.bootstrapPromise = null;
    this.bootstrapPending = false;
    this.telemetryRefreshTimer = null;
    this.telemetryRefreshPromise = null;
    this.telemetryRefreshInterval = null;
    this.viewportSyncFrame = 0;
    this.viewportFocusTimer = null;
    this.notificationsEnabled = true;
    this.clientInstanceId = this.getOrCreateClientInstanceId();
    this._sessionCatalog = [];
    this.sessionsReturnFocus = null;
    this.commandPaletteGitCache = new Map();
    this.handledPaneShortcutEvents = new WeakSet();
    // Quick-open (Ctrl+P) file tree cache, keyed by cwd. Providers are SYNC
    // (same constraint as the git cache above), so the tree is prefetched on
    // palette open (buildCommandPaletteContext) and read back synchronously
    // from here by the quick-open provider. TTL'd (not cached forever like
    // the git cache) since the filesystem can change underneath a long-lived
    // session; keyed by cwd so switching workspaces naturally misses the
    // cache and refetches rather than needing an explicit invalidation hook.
    this.commandPaletteTreeCache = new Map();
    this.rightSurface = "none";
    this.taskState = {
      items: [],
      selectedId: null,
      loading: false,
      messages: [],
      messagesTaskId: null,
    };
    this.setupState = {
      report: null,
      applyResult: null,
      loading: false,
      profile: "cloudflare",
    };

    // Session registry for reconnection persistence
    this.sessionRegistry = new SessionRegistry();

    this.container = document.getElementById("terminal-container");
    this.tabs = document.getElementById("terminals-tabs");
    this.directoryInput = document.getElementById("directory");
    this.toolsSheetDirectoryInput = document.getElementById(
      "tools-sheet-directory",
    );
    this.toolbar = document.querySelector(".toolbar");
    this.connectionStatus = document.getElementById("connection-status");
    this.toolsSheet = document.getElementById("tools-sheet");
    this.navigationSurface = window.NavigationSurface || {};
    this.actionLayoutState = null;
    this.layoutEditorMode = "desktop";
    this.layoutEditorOpen = false;
    this.layoutDragState = null;
    this.desktopToolbarDensityFrame = 0;
    this.handleSurfaceActionClick = this.handleSurfaceActionClick.bind(this);
    this.handleLayoutDragMove = this.handleLayoutDragMove.bind(this);
    this.handleLayoutDragEnd = this.handleLayoutDragEnd.bind(this);
    this.handleLayoutDragCancel = this.handleLayoutDragCancel.bind(this);

    this.tileManager = new TileManager(this.container);
    // Server-side actor-scoped settings (window layout, dock, prefs). The
    // load races nothing: window/dock consumers await settingsReady first.
    this.settingsStore = window.SettingsStore?.createSettingsStore?.() || null;
    // Load server-side settings, then run the one-time legacy-localStorage
    // migration BEFORE any consumer reads, so canonical keys are populated and
    // consumers never need a legacy fallback. The migrated flag is only set
    // after the flush resolves (so the debounced PUT can't be lost).
    this.settingsReady = this.settingsStore
      ? this.settingsStore
          .load()
          .catch(() => ({}))
          .then(() => this.runSettingsMigration())
          .catch(() => {})
      : Promise.resolve({});
    this.surfaceWindowManager = null;
    this.settingsRuntime = null;
    this.settingsManager = null;
    this.clipboardManager = new ClipboardManager(this);
    this.commandPaletteRegistry = null;
    this.commandPalette = null;

    this.init();
  }

  getOrCreateClientInstanceId() {
    try {
      const key = "deckterm-client-instance-id";
      const existing = sessionStorage.getItem(key);
      if (existing) return existing;
      const next = crypto.randomUUID();
      sessionStorage.setItem(key, next);
      return next;
    } catch {
      return `deckterm-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
  }

  init() {
    // The last directory is restored from the canonical files.defaultCwd via the
    // settings runtime (applyDefaultCwd) once the store + migration resolve — no
    // synchronous legacy localStorage read here.

    this.initTaskSignalBadge();
    this.initSessionsDock();
    this.initSettingsRuntime();
    this.initIdeShell();

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

    this.directoryInput?.addEventListener("input", (event) => {
      this.setDirectoryValue(event.target.value, {
        force: true,
        userDraft: true,
      });
    });
    this.directoryInput?.addEventListener("change", (event) => {
      this.setDirectoryValue(event.target.value, {
        force: true,
        userDraft: true,
      });
      // Committed value (change = blur/Enter commit for text inputs) — unlike
      // the input-event draft handler above, this one navigates.
      void this.commitWorkingDirectory(event.target.value);
    });
    this.toolsSheetDirectoryInput?.addEventListener("input", (event) => {
      this.setDirectoryValue(event.target.value, {
        force: true,
        userDraft: true,
      });
    });
    this.toolsSheetDirectoryInput?.addEventListener("change", (event) => {
      this.setDirectoryValue(event.target.value, {
        force: true,
        userDraft: true,
      });
      void this.commitWorkingDirectory(event.target.value);
    });

    // Toolbar action buttons
    this.setupToolbarActions();
    this.setupCommandPalette();
    this.updateWrapButton();
    this.updateLinkedViewButton();

    // Fullscreen
    document
      .getElementById("fullscreen-exit")
      ?.addEventListener("click", () => this.toggleFullscreen());

    // Mobile toolbar toggle
    const toolbarToggle = document.getElementById("toolbar-toggle");
    if (toolbarToggle) {
      toolbarToggle.addEventListener("click", () => this.toggleToolsSheet());
    }
    this.setupToolsSheet();
    this.setupTaskPanel();
    this.setupSetupPanel();
    this.setupSessionsPanel();

    // Sessions button trigger
    const sessionsBtn = document.getElementById("sessions-btn");
    if (sessionsBtn) {
      sessionsBtn.addEventListener("click", () => {
        const panel = this.getSessionsPanel();
        if (panel && !panel.classList.contains("hidden")) {
          this.closeSessionsPanel();
        } else {
          this.openSessionsPanel();
        }
      });
    }
    this.setupLayoutEditor();
    this.setupDesktopTabOverflowScroll();
    this.syncToolbarOverlayOffset();

    // Help modal
    this.setupHelpModal();

    // Keyboard shortcuts
    this.setupKeyboardShortcuts();

    // Window resize
    let resizeTimeout;
    let resizeBaseline = null;
    window.addEventListener("resize", () => {
      const resizeStartTerminal = this.terminals.get(this.activeId);
      if (!resizeBaseline && resizeStartTerminal?.terminal) {
        resizeBaseline = {
          id: this.activeId,
          cols: resizeStartTerminal.terminal.cols,
          rows: resizeStartTerminal.terminal.rows,
        };
      }
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        const active = this.terminals.get(this.activeId);
        const baseline = resizeBaseline;
        resizeBaseline = null;
        if (DEBUG) {
          dbg("window.resize", {
            activeId: this.activeId,
            workspaceId: active?.workspaceId || null,
            cols: active?.terminal?.cols,
            rows: active?.terminal?.rows,
          });
        }
        if (active) {
          const previousCols =
            baseline?.id === this.activeId
              ? baseline.cols
              : active.terminal?.cols;
          const previousRows =
            baseline?.id === this.activeId
              ? baseline.rows
              : active.terminal?.rows;
          this.fitTerminalState(active);
          this.syncTerminalSize(this.activeId);
          if (
            active.terminal?.cols !== previousCols ||
            active.terminal?.rows !== previousRows
          ) {
            this.showDimensionOverlay(this.activeId);
          } else if (this.debugMode) {
            // A sub-cell pixel resize can leave the grid unchanged while the
            // diagnostic container dimensions still need to be refreshed.
            this.updateDebugOverlay(this.activeId);
          }
        }
        this.scheduleDesktopToolbarDensitySync();
      }, 150);
    });

    this.setupViewportResizeHandling();

    // Initialize sub-managers
    this.extraKeys = new ExtraKeysManager(this);
    const FileExplorerCtor =
      window.FileExplorerController?.FileExplorerController;
    this.fileExplorer = FileExplorerCtor ? new FileExplorerCtor() : null;
    // Shared git-status cache feeding the explorer's VS Code-style decorations
    // (and reusable by the git panel). A git mutation can invalidate it later.
    const GitStatusStoreCtor = window.GitStatusStore?.GitStatusStore;
    this.gitStatusStore = GitStatusStoreCtor ? new GitStatusStoreCtor() : null;
    if (this.fileExplorer) {
      // Re-derive git decorations whenever the explorer navigates.
      this.fileExplorer.onDirLoaded = () =>
        void this.refreshExplorerDecorations();
    }
    // Both the header × and footer Close button route through the
    // controller's onRequestClose hook so they both run the full
    // closeFileExplorer() chokepoint (content + hosting SurfaceWindow +
    // right-surface bookkeeping) instead of only hiding the panel content.
    if (this.fileExplorer) {
      this.fileExplorer.onRequestClose = () => this.closeFileExplorer();
    }
    if (this.fileExplorer && window.FileEditorModule) {
      this.fileEditor = new window.FileEditorModule.FileEditor();
      // In IDE mode an explorer file click opens a preview editor TAB; outside
      // IDE mode it keeps the terminal-mode modal/SurfaceWindow behavior.
      this.fileExplorer.onOpenFile = (path, intent) =>
        this.handleExplorerOpenFile(path, intent);
    }
    platformDetector.onChange(() => {
      this.renderActionSurfaces();
      this.syncSurfaceButtonState();
    });
    this.renderActionSurfaces();

    // Mobile swipe support
    this.setupMobileSwipe();
    this.setupTerminalRenderRecovery();
    this.startTelemetryRefreshLoop();

    // Check for existing terminals
    this.startBootstrap();
  }

  startBootstrap() {
    if (this.bootstrapPromise) return this.bootstrapPromise;

    window.__decktermBootstrapReady = false;
    this.setBootstrapPending(true);

    this.bootstrapPromise = (async () => {
      try {
        await this.checkExistingTerminals();
      } finally {
        this.setBootstrapPending(false);
        window.__decktermBootstrapReady = true;
      }
    })();

    window.__decktermBootstrapPromise = this.bootstrapPromise;
    return this.bootstrapPromise;
  }

  async waitForBootstrap() {
    await (this.bootstrapPromise || Promise.resolve());
  }

  async waitForFontMetrics() {
    if (!document.fonts?.ready) return;
    await Promise.race([
      document.fonts.ready.catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, FONT_METRIC_WAIT_MS)),
    ]);
  }

  getActiveRenderCellSize() {
    const active = this.getActiveTerminal();
    const dims = active?.terminal?._core?._renderService?.dimensions;
    const cellWidth = dims?.css?.cell?.width;
    const cellHeight = dims?.css?.cell?.height;

    if (cellWidth > 0 && cellHeight > 0) {
      return { cellWidth, cellHeight };
    }

    return null;
  }

  measureTerminalCellSize() {
    const liveMetrics = this.getActiveRenderCellSize();
    if (liveMetrics) return liveMetrics;

    const probe = document.createElement("span");
    probe.textContent = "MMMMMMMMMM";
    probe.style.position = "absolute";
    probe.style.left = "-9999px";
    probe.style.top = "-9999px";
    probe.style.visibility = "hidden";
    probe.style.whiteSpace = "pre";
    probe.style.fontFamily = TERMINAL_FONT_FAMILY;
    probe.style.fontSize = `${this.fontSize}px`;
    probe.style.lineHeight = String(TERMINAL_LINE_HEIGHT);
    document.body.appendChild(probe);

    try {
      const rect = probe.getBoundingClientRect();
      const cellWidth = rect.width / probe.textContent.length;
      const cellHeight = rect.height;

      if (cellWidth > 0 && cellHeight > 0) {
        return { cellWidth, cellHeight };
      }
    } finally {
      probe.remove();
    }

    return null;
  }

  estimateInitialTerminalSize(split = false) {
    const active = this.getActiveTerminal();
    const predictedPixels = window.TerminalSizing?.predictInitialTilePixels?.({
      containerWidth: this.container?.clientWidth || window.innerWidth,
      containerHeight: this.container?.clientHeight || window.innerHeight,
      split,
      activeTileWidth: active?.element?.clientWidth || 0,
      activeTileHeight: active?.element?.clientHeight || 0,
    }) || {
      width: this.container?.clientWidth || window.innerWidth,
      height: this.container?.clientHeight || window.innerHeight,
    };
    const cellMetrics = this.measureTerminalCellSize();
    const estimated = window.TerminalSizing?.estimateTerminalGrid?.({
      width: predictedPixels.width,
      height: predictedPixels.height,
      cellWidth: cellMetrics?.cellWidth || 0,
      cellHeight: cellMetrics?.cellHeight || 0,
      horizontalPadding: TERMINAL_PADDING_X,
      verticalPadding: TERMINAL_PADDING_Y,
      fallbackCols: APP_DEFAULT_TERMINAL_COLS,
      fallbackRows: APP_DEFAULT_TERMINAL_ROWS,
    }) || {
      cols: APP_DEFAULT_TERMINAL_COLS,
      rows: APP_DEFAULT_TERMINAL_ROWS,
    };

    return this.normalizeTerminalGrid(estimated);
  }

  normalizeTerminalGrid({ cols, rows }) {
    return (
      window.TerminalSizing?.normalizeTerminalGrid?.({
        cols,
        rows,
        maxCols: platformDetector.isMobile
          ? Number.POSITIVE_INFINITY
          : DESKTOP_MAX_TERMINAL_COLS,
        maxRows: platformDetector.isMobile
          ? Number.POSITIVE_INFINITY
          : DESKTOP_MAX_TERMINAL_ROWS,
      }) || { cols, rows }
    );
  }

  normalizeTerminalGeometry(terminalState) {
    const terminal = terminalState?.terminal;
    if (!terminal) return null;

    const normalized = this.normalizeTerminalGrid({
      cols: terminal.cols,
      rows: terminal.rows,
    });

    if (
      normalized.cols !== terminal.cols ||
      normalized.rows !== terminal.rows
    ) {
      terminal.resize(normalized.cols, normalized.rows);
    }

    return normalized;
  }

  fitTerminalState(terminalState) {
    if (!terminalState?.fitAddon || !terminalState?.terminal) return null;
    terminalState.fitAddon.fit();
    return this.normalizeTerminalGeometry(terminalState);
  }

  fitTerminal(id) {
    return this.fitTerminalState(this.terminals.get(id));
  }

  setBootstrapPending(isPending) {
    this.bootstrapPending = isPending;
    document.body.dataset.bootstrapState = isPending ? "pending" : "ready";
    const newButton = document.getElementById("new-terminal");
    if (newButton) newButton.disabled = isPending;
  }

  setupViewportResizeHandling() {
    if (!window.visualViewport) return;

    const scheduleViewportSync = () => {
      if (this.viewportSyncFrame) return;
      this.viewportSyncFrame = requestAnimationFrame(() => {
        this.viewportSyncFrame = 0;
        this.handleViewportResize();
      });
    };

    const viewport = window.visualViewport;
    viewport.addEventListener("resize", scheduleViewportSync);
    viewport.addEventListener("scroll", scheduleViewportSync);
    if ("onscrollend" in viewport) {
      viewport.addEventListener("scrollend", scheduleViewportSync);
    }
  }

  setupTerminalRenderRecovery() {
    const recover = () => {
      if (!this.activeId) return;
      requestAnimationFrame(() => {
        this.performReconnectLayoutSync(this.activeId, {
          forceResize: true,
          scrollToPrompt: platformDetector.hasTouch,
        });
      });
    };

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) recover();
    });
    window.addEventListener("pageshow", recover);
    window.addEventListener("focus", recover);
  }

  setupToolbarActions() {
    document.addEventListener("click", this.handleSurfaceActionClick);
  }

  // Width alone (smallScreen) misses a phone in landscape — e.g. 844x390 is
  // >=768px wide but is still a touch device with no hover, so
  // platformDetector.isMobile is true (it ORs in isCoarsePointer && noHover
  // independent of width). Consult both so a landscape phone gets mobile
  // chrome while a narrow desktop *window* still does too (bug:
  // landscape-phone-gets-desktop-chrome). isWindowedSurfaces() already makes
  // the same isMobile check for Files/Git/Tasks/Editor; this keeps the
  // toolbar/action-bar chrome decision consistent with it.
  getActiveChromeMode() {
    return platformDetector.smallScreen || platformDetector.isMobile
      ? "mobile"
      : "desktop";
  }

  // Stamps body.chrome-mobile so CSS can key off the SAME mobile decision as
  // getActiveChromeMode() (isMobile OR smallScreen) instead of only the
  // width-based @media breakpoints, which a landscape phone slips past.
  syncChromeModeClass() {
    document.body.classList.toggle(
      "chrome-mobile",
      this.getActiveChromeMode() === "mobile",
    );
  }

  getActionButtonConfig(actionId) {
    return ACTION_BUTTON_CONFIG[actionId] || null;
  }

  getLayoutPinnedActionIds(mode) {
    const normalizedMode = mode === "mobile" ? "mobile" : "desktop";
    const state = this.getActionLayoutState();
    const key = normalizedMode === "mobile" ? "mobilePinned" : "desktopPinned";
    return Array.isArray(state[key]) ? [...state[key]] : [];
  }

  getToolsSheetActionIds(mode = this.getActiveChromeMode()) {
    const available =
      this.navigationSurface.getAvailableActionIds?.(
        mode,
        this.getLayoutPinnedActionIds(mode),
      ) || [];
    const actionIds = [...available];

    FIXED_TOOLS_SHEET_ACTION_IDS.forEach((actionId) => {
      if (!actionIds.includes(actionId)) {
        actionIds.push(actionId);
      }
    });

    return actionIds.filter((actionId) => this.getActionButtonConfig(actionId));
  }

  getPrimaryActionIds(mode) {
    const normalizedMode = mode === "mobile" ? "mobile" : "desktop";
    const actionIds = [...this.getLayoutPinnedActionIds(normalizedMode)];

    actionIds.push("more");

    return actionIds.filter((actionId) => this.getActionButtonConfig(actionId));
  }

  getActionButtonId(actionId, surface) {
    const config = this.getActionButtonConfig(actionId);
    if (!config) return null;
    if (surface === "desktop-primary") return config.desktopId || null;
    if (surface === "mobile-primary") return config.mobileId || null;
    if (surface === "tools-sheet") return config.toolsId || null;
    return null;
  }

  createActionButton(actionId, surface, density = "normal") {
    const config = this.getActionButtonConfig(actionId);
    if (!config) return null;

    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = config.action;
    button.dataset.actionId = actionId;
    button.dataset.actionSurface = surface;
    button.dataset.density = density;

    const elementId = this.getActionButtonId(actionId, surface);
    if (elementId) {
      button.id = elementId;
    }

    const label = config.label;
    button.title = label;
    button.setAttribute("aria-label", label);

    if (surface === "desktop-primary") {
      const toneClass =
        config.desktopTone === "primary"
          ? "toolbar-action-btn-primary"
          : "toolbar-action-btn-secondary";
      button.className = `toolbar-action-btn ${toneClass}`;
      if (actionId === "palette") {
        button.setAttribute("aria-haspopup", "dialog");
        button.setAttribute("aria-controls", "command-palette");
      }
    } else if (surface === "mobile-primary") {
      button.className = "mobile-action-btn";
    } else {
      button.className = "tools-sheet-btn";
    }

    const icon = document.createElement("i");
    icon.dataset.lucide = config.icon;
    button.appendChild(icon);

    const text = document.createElement("span");
    text.textContent = label;
    button.appendChild(text);

    return button;
  }

  renderPrimaryActionBar(root, mode, surface) {
    if (!root) return;

    const actionIds = this.getPrimaryActionIds(mode);
    const density =
      this.navigationSurface.getActionDensityTier?.(
        mode,
        Math.max(0, actionIds.length - 1),
      ) || "normal";

    root.replaceChildren();
    root.dataset.density = density;

    if (surface === "mobile-primary") {
      // actionIds always includes the non-removable "more" slot (see
      // getPrimaryActionIds), so actionIds.length is never 0 even when every
      // pin has been removed — check the PINNED ids only (bug:
      // empty-mobile-action-bar). Pure decision lives in navigationSurface so
      // it's covered without a DOM.
      const pinnedActionIds = actionIds.filter((id) => id !== "more");
      const wasHidden = root.hidden;
      const isEmpty = !(
        this.navigationSurface.shouldShowMobileActionBar?.(pinnedActionIds) ??
        pinnedActionIds.length > 0
      );
      root.hidden = isEmpty;
      root.setAttribute("aria-hidden", isEmpty ? "true" : "false");
      root.style.setProperty(
        "--mobile-action-bar-columns",
        String(actionIds.length || 1),
      );
      // Hiding/showing the bar changes how much vertical space the
      // terminal/extra-keys have (--mobile-action-bar-height reclaimed) —
      // xterm's pixel-fit needs an explicit resize pass, CSS reflow alone
      // won't trigger it (mirrors ExtraKeysManager's row-2 collapse doing
      // the same via handleViewportResize).
      if (wasHidden !== isEmpty) {
        this.handleViewportResize?.();
      }
    }

    actionIds.forEach((actionId) => {
      const button = this.createActionButton(actionId, surface, density);
      if (button) {
        root.appendChild(button);
      }
    });
  }

  measureDesktopActionWidthsByTier(root) {
    const toolbar = this.toolbar;
    if (!root || !toolbar) return null;

    const previousDensity = root.dataset.density || "normal";
    const previousTabDensity = toolbar.dataset.tabDensity || "";
    const widthsByTier = {};
    const tiers = ["normal", "compact", "tight", "icon-only"];

    tiers.forEach((tier) => {
      root.dataset.density = tier;
      toolbar.dataset.tabDensity = tier;
      widthsByTier[tier] = Math.ceil(root.scrollWidth);
    });

    root.dataset.density = previousDensity;
    if (previousTabDensity) {
      toolbar.dataset.tabDensity = previousTabDensity;
    } else {
      delete toolbar.dataset.tabDensity;
    }

    return widthsByTier;
  }

  getDesktopTabLayout() {
    const tabs = this.tabs;
    if (!tabs) {
      return {
        rowCount: 1,
        visibleCount: 0,
        overflowCount: 0,
        tabWidth: 160,
        mode: "single",
      };
    }

    const tabCount = tabs.querySelectorAll(".tab").length;
    const preferredTabWidth =
      tabCount <= 1 ? 280 : tabCount <= 2 ? 240 : tabCount <= 3 ? 200 : 160;
    return (
      this.navigationSurface.getDesktopTabLayoutByWidth?.({
        availableWidth: Math.floor(tabs.getBoundingClientRect().width || 0),
        tabCount,
        preferredTabWidth,
        minTabWidth: 96,
        wrapThresholdWidth: 118,
        maxRows: 2,
        gap: 4,
      }) || {
        rowCount: 1,
        visibleCount: tabCount,
        overflowCount: 0,
        tabWidth: 160,
        mode: "single",
      }
    );
  }

  getDesktopTabReserveWidth(tabCount) {
    const count = Math.max(0, Math.trunc(Number(tabCount) || 0));
    if (!count) return 0;

    const gap = 4;
    const widthFor = (columns, tabWidth) =>
      columns * tabWidth + Math.max(0, columns - 1) * gap;

    // Preserve four comfortable single-row tabs before spending horizontal
    // space on full action labels. Beyond four, reserve enough room for the
    // existing two-row layout at its 96px minimum.
    if (count <= 4) return widthFor(count, 144);
    return Math.max(
      widthFor(4, 144),
      widthFor(Math.ceil(count / 2), 96),
    );
  }

  syncDesktopTabLayout() {
    const toolbar = this.toolbar;
    const tabs = this.tabs;
    if (!toolbar || !tabs) return false;

    if (this.getActiveChromeMode() !== "desktop") {
      delete toolbar.dataset.tabRows;
      delete tabs.dataset.layout;
      delete tabs.dataset.rows;
      delete tabs.dataset.overflowCount;
      tabs.style.removeProperty("--desktop-tab-columns");
      tabs.style.removeProperty("--desktop-tab-width");
      return false;
    }

    const previousLayout = tabs.dataset.layout || "single";
    const previousRows = tabs.dataset.rows || "1";
    const layout = this.getDesktopTabLayout();
    const columnCount = Math.max(
      1,
      Math.ceil(layout.visibleCount / Math.max(1, layout.rowCount)),
    );

    tabs.dataset.layout = layout.mode;
    tabs.dataset.rows = String(layout.rowCount);
    tabs.dataset.overflowCount = String(layout.overflowCount);
    tabs.style.setProperty("--desktop-tab-columns", String(columnCount));
    tabs.style.setProperty("--desktop-tab-width", `${layout.tabWidth}px`);
    toolbar.dataset.tabRows = String(layout.rowCount);

    return (
      previousLayout !== layout.mode || previousRows !== String(layout.rowCount)
    );
  }

  tabCopyStageFits(tab, stage, slack = 0) {
    const copy = tab?.querySelector(".tab-copy");
    const label = tab?.querySelector(".tab-label");
    const meta = tab?.querySelector(".tab-meta");
    const badge = tab?.querySelector(".tab-signal-badge");
    const close = tab?.querySelector(".tab-close");
    if (!copy || !label) return true;

    if (stage === "truncated") {
      return copy.getBoundingClientRect().width >= 72 + slack;
    }

    const labelFits = label.scrollWidth <= label.clientWidth + 1 - slack;
    const secondary =
      meta && !meta.hidden ? meta : badge && !badge.hidden ? badge : null;
    const secondaryFits =
      !secondary || secondary.scrollWidth <= secondary.clientWidth + 1 - slack;
    if (!labelFits || !secondaryFits) {
      return false;
    }

    if (!close) {
      return true;
    }

    const closeRect = close.getBoundingClientRect();
    const labelRect = label.getBoundingClientRect();
    const secondaryRect = secondary
      ? secondary.getBoundingClientRect()
      : labelRect;

    return (
      Math.max(labelRect.right, secondaryRect.right) <=
      closeRect.left + 1 - slack
    );
  }

  // Copy-fit stage order, roomiest first. Index comparisons drive the
  // hysteresis below.
  static TAB_COPY_FIT_STATES = [
    "roomy",
    "compact",
    "wrapped",
    "truncated",
    "cramped",
  ];

  syncDesktopTabCopyFit(tab) {
    if (!tab) return false;

    const previous = tab.dataset.copyFit || "";
    const copy = tab.querySelector(".tab-copy");
    const label = tab.querySelector(".tab-label");
    if (!copy || !label) {
      delete tab.dataset.copyFit;
      return previous !== "";
    }

    const states = ["roomy", "compact", "wrapped"];
    let nextState = "truncated";

    for (const state of states) {
      tab.dataset.copyFit = state;
      if (this.tabCopyStageFits(tab, state)) {
        nextState = state;
        break;
      }
    }

    if (nextState === "truncated") {
      tab.dataset.copyFit = nextState;
      if (!this.tabCopyStageFits(tab, nextState)) {
        nextState = "cramped";
      }
    }

    // Hysteresis: borderline measurements would otherwise flip-flop a tab
    // between adjacent stages on successive syncs (each flip re-truncates
    // labels — visible flicker). Upgrading to a ROOMIER stage requires the
    // fit to pass with headroom; downgrades (content stopped fitting) apply
    // immediately.
    const order = TerminalManager.TAB_COPY_FIT_STATES;
    const prevIdx = order.indexOf(previous);
    const nextIdx = order.indexOf(nextState);
    if (prevIdx !== -1 && nextIdx !== -1 && nextIdx < prevIdx) {
      tab.dataset.copyFit = nextState;
      if (!this.tabCopyStageFits(tab, nextState, 12)) {
        nextState = previous;
      }
    }

    tab.dataset.copyFit = nextState;
    return previous !== nextState;
  }

  syncDesktopTabCopyFits() {
    const toolbar = this.toolbar;
    const tabs = this.tabs;
    if (!tabs) return false;

    if (this.getActiveChromeMode() !== "desktop") {
      let cleared = false;
      tabs.querySelectorAll(".tab").forEach((tab) => {
        if (tab.dataset.copyFit) {
          delete tab.dataset.copyFit;
          cleared = true;
        }
      });
      return cleared;
    }

    const beforeHeight = Math.ceil(
      toolbar?.getBoundingClientRect().height || 0,
    );
    let changed = false;
    tabs.querySelectorAll(".tab").forEach((tab) => {
      if (this.syncDesktopTabCopyFit(tab)) {
        changed = true;
      }
    });

    const afterHeight = Math.ceil(toolbar?.getBoundingClientRect().height || 0);
    return changed || beforeHeight !== afterHeight;
  }

  syncToolbarOverlayOffset() {
    const toolbarHeight = Math.ceil(
      this.toolbar?.getBoundingClientRect().height || 0,
    );
    if (toolbarHeight > 0) {
      document.documentElement.style.setProperty(
        "--toolbar-overlay-offset",
        `${toolbarHeight}px`,
      );
    }
  }

  syncDesktopToolbarDensity() {
    const toolbar = this.toolbar;
    const actionBar = document.getElementById("desktop-primary-actions");
    if (!toolbar || !actionBar) return;

    if (this.getActiveChromeMode() !== "desktop") {
      delete toolbar.dataset.tabDensity;
      this.syncDesktopTabLayout();
      this.syncToolbarOverlayOffset();
      return;
    }

    const widthsByTier = this.measureDesktopActionWidthsByTier(actionBar);
    const actionWidth = Math.ceil(
      actionBar.getBoundingClientRect().width || 0,
    );
    const tabsWidth = Math.ceil(
      this.tabs?.getBoundingClientRect().width || 0,
    );
    const tabCount = this.tabs?.querySelectorAll(".tab").length || 0;
    const availableWidth = Math.max(
      0,
      actionWidth + tabsWidth - this.getDesktopTabReserveWidth(tabCount),
    );
    const fallbackDensity =
      actionBar.dataset.density ||
      this.navigationSurface.getActionDensityTier?.(
        "desktop",
        Math.max(0, this.getPrimaryActionIds("desktop").length - 1),
      ) ||
      "normal";

    const nextDensity =
      widthsByTier &&
      this.navigationSurface.getDesktopActionDensityTierByWidth?.({
        availableWidth,
        normalWidth: widthsByTier.normal,
        compactWidth: widthsByTier.compact,
        tightWidth: widthsByTier.tight,
        iconOnlyWidth: widthsByTier["icon-only"],
      });

    const density = nextDensity || fallbackDensity;
    actionBar.dataset.density = density;
    toolbar.dataset.tabDensity = density;

    const tabLayoutChanged = this.syncDesktopTabLayout();
    const tabCopyFitChanged = this.syncDesktopTabCopyFits();
    if (tabLayoutChanged || tabCopyFitChanged) {
      requestAnimationFrame(() => {
        const active = this.getActiveTerminal();
        if (!active) return;
        this.fitTerminalState(active);
        this.syncTerminalSize(this.activeId);
      });
    }

    this.syncToolbarOverlayOffset();
  }

  scheduleDesktopToolbarDensitySync() {
    if (this.desktopToolbarDensityFrame) return;
    this.desktopToolbarDensityFrame = requestAnimationFrame(() => {
      this.desktopToolbarDensityFrame = 0;
      this.syncDesktopToolbarDensity();
    });
  }

  renderToolsSheetGrid() {
    const grid = this.toolsSheet?.querySelector("#tools-sheet-grid");
    if (!grid) return;

    const mode = this.getActiveChromeMode();
    const actionIds = this.getToolsSheetActionIds(mode);
    grid.replaceChildren();
    grid.dataset.mode = mode;
    grid.dataset.empty = "false";

    actionIds.forEach((actionId) => {
      const button = this.createActionButton(actionId, "tools-sheet");
      if (button) {
        grid.appendChild(button);
      }
    });

    grid.appendChild(this.createFontSizeStepper());
    this.syncFontSizeStepper();
    // The sheet is rebuilt at runtime, after the one-time page bootstrap icon
    // pass. Hydrate the newly inserted placeholders so the compact stepper and
    // dynamic action buttons never render as empty hit targets.
    if (window.lucide?.createIcons) {
      window.lucide.createIcons();
    }
  }

  createFontSizeStepper() {
    const group = document.createElement("div");
    group.id = "tools-sheet-font-size";
    group.className = "tools-sheet-font-stepper";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", "Font size");

    const label = document.createElement("span");
    label.className = "tools-sheet-font-label";
    label.textContent = "Font size";
    group.appendChild(label);

    const controls = document.createElement("span");
    controls.className = "tools-sheet-font-controls";

    const createStepButton = (action, labelText, iconName) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tools-sheet-font-button";
      button.dataset.action = action;
      button.dataset.actionSurface = "tools-sheet";
      button.setAttribute("aria-label", labelText);
      button.title = labelText;
      const icon = document.createElement("i");
      icon.dataset.lucide = iconName;
      button.appendChild(icon);
      return button;
    };

    controls.appendChild(
      createStepButton("font-decrease", "Decrease font size", "minus"),
    );
    const value = document.createElement("output");
    value.className = "tools-sheet-font-value";
    value.setAttribute("aria-live", "polite");
    controls.appendChild(value);
    controls.appendChild(
      createStepButton("font-increase", "Increase font size", "plus"),
    );
    group.appendChild(controls);
    return group;
  }

  syncFontSizeStepper() {
    const group = this.toolsSheet?.querySelector("#tools-sheet-font-size");
    if (!group) return;
    const value = group.querySelector("output");
    if (value) value.textContent = `${this.fontSize}px`;
    const decrease = group.querySelector('[data-action="font-decrease"]');
    const increase = group.querySelector('[data-action="font-increase"]');
    if (decrease) decrease.disabled = this.fontSize <= 8;
    if (increase) increase.disabled = this.fontSize >= 32;
  }

  setupDesktopTabOverflowScroll() {
    if (!this.tabs) return;

    this.tabs.addEventListener(
      "wheel",
      (event) => {
        if (this.getActiveChromeMode() !== "desktop") return;
        if (this.tabs.dataset.layout !== "scroll") return;
        if (this.tabs.scrollWidth <= this.tabs.clientWidth + 1) return;

        const primaryDelta =
          Math.abs(event.deltaX) > 0 ? event.deltaX : event.deltaY;
        if (!Number.isFinite(primaryDelta) || primaryDelta === 0) return;

        event.preventDefault();
        this.tabs.scrollLeft += primaryDelta;
      },
      { passive: false },
    );
  }

  renderActionSurfaces() {
    this.syncChromeModeClass();
    this.renderPrimaryActionBar(
      document.getElementById("desktop-primary-actions"),
      "desktop",
      "desktop-primary",
    );
    this.renderPrimaryActionBar(
      document.getElementById("mobile-action-bar"),
      "mobile",
      "mobile-primary",
    );
    this.renderToolsSheetGrid();
    initLucideIcons();
    this.syncSurfaceButtonState();
    this.updateWrapButton();
    this.updateLinkedViewButton();
    this.scheduleDesktopToolbarDensitySync();
  }

  syncSurfaceButtonState() {
    const surface = this.getRightSurface();
    const moreOpen = Boolean(
      this.toolsSheet && !this.toolsSheet.classList.contains("hidden"),
    );
    const tasksOpen = Boolean(
      document.getElementById("task-panel") &&
      !document.getElementById("task-panel").classList.contains("hidden"),
    );
    const setupOpen = Boolean(
      document.getElementById("setup-panel") &&
      !document.getElementById("setup-panel").classList.contains("hidden"),
    );
    const paletteOpen = this.isCommandPaletteOpen();

    // Windowed surfaces can be open simultaneously; the exclusive
    // right-surface notion only applies to the mobile sheets.
    const windowed = this.isWindowedSurfaces();
    const filesOpen = windowed
      ? Boolean(this.fileExplorer?.isOpen)
      : surface === "files";
    const gitOpen = windowed
      ? Boolean(
          window.gitManager &&
          !window.gitManager.panel?.classList.contains("hidden"),
        )
      : surface === "git";

    document.querySelectorAll("[data-action-id]").forEach((button) => {
      const actionId = button.dataset.actionId;
      if (actionId === "files") {
        button.classList.toggle("active", filesOpen);
      } else if (actionId === "git") {
        button.classList.toggle("active", gitOpen);
      } else if (actionId === "tasks") {
        button.classList.toggle("active", tasksOpen);
      } else if (actionId === "setup") {
        button.classList.toggle("active", setupOpen);
      } else if (actionId === "settings") {
        button.classList.toggle(
          "active",
          Boolean(this.surfaceWindowManager?.isOpen?.("settings")),
        );
      } else if (actionId === "more") {
        button.classList.toggle("active", moreOpen);
      } else if (actionId === "palette") {
        button.classList.toggle("active", paletteOpen);
      } else if (actionId === "dock-sessions") {
        button.classList.toggle("active", Boolean(this.dockState?.enabled));
      }
    });
  }

  async handleSurfaceAction(action, button) {
    if (action === "linked-view") this.createLinkedView();
    else if (action === "file-manager") await this.openFileExplorer();
    else if (action === "git") await this.openGitPanel();
    else if (action === "tasks") await this.openTaskPanel();
    else if (action === "setup") await this.openSetupPanel();
    else if (action === "settings") await this.openSettings();
    else if (action === "toggle-tools-sheet") this.toggleToolsSheet();
    else if (action === "open-dir-picker") this.openDirPicker();
    else if (action === "clipboard") this.clipboardManager.togglePanel();
    else if (action === "copy") this.copySelection();
    else if (action === "paste") await this.pasteClipboard();
    else if (action === "font-decrease") this.changeFontSize(-1);
    else if (action === "font-increase") this.changeFontSize(1);
    else if (action === "toggle-extra-keys") this.extraKeys?.toggle();
    else if (action === "fullscreen") this.toggleFullscreen();
    else if (action === "wrap-lines") this.toggleWrapLines();
    else if (action === "dock-sessions") this.toggleSessionsDock();
    else if (action === "toggle-ide") this.toggleIdeMode();
    else if (action === "help") this.openHelp();
    else if (action === "palette") this.toggleCommandPalette();

    if (
      button?.closest("#tools-sheet") &&
      action !== "toggle-tools-sheet" &&
      action !== "palette" &&
      action !== "font-decrease" &&
      action !== "font-increase"
    ) {
      this.closeToolsSheet();
    }

    if (button?.closest("#tools-sheet") && action === "palette") {
      this.closeToolsSheet();
    }

    this.syncSurfaceButtonState();
  }

  handleSurfaceActionClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button || button.disabled) return;
    void this.handleSurfaceAction(button.dataset.action, button);
  }

  getCurrentDirectoryValue() {
    return (
      this.directoryInput?.value.trim() ||
      this.toolsSheetDirectoryInput?.value.trim() ||
      ""
    );
  }

  markDirectoryDraftEdited() {
    this.directoryDraftEditedAt = Date.now();
  }

  shouldPreserveDirectoryDraft(nextValue) {
    const activeElement = document.activeElement;
    const directoryFocused =
      activeElement === this.directoryInput ||
      activeElement === this.toolsSheetDirectoryInput;
    const hasRecentDraft =
      Date.now() - (this.directoryDraftEditedAt || 0) < DIRECTORY_DRAFT_LOCK_MS;
    const currentValue = this.getCurrentDirectoryValue();

    return (
      (directoryFocused || hasRecentDraft) &&
      Boolean(currentValue) &&
      currentValue !== nextValue
    );
  }

  normalizeWorkspaceCwd(value) {
    const cwd = String(value || "").trim();
    if (!cwd) return "";
    if (cwd === "/") return cwd;
    return cwd.replace(/\/+$/, "");
  }

  setDirectoryValue(value, { force = false, userDraft = false } = {}) {
    const next = String(value || "");
    if (userDraft) {
      this.markDirectoryDraftEdited();
    } else if (!force && this.shouldPreserveDirectoryDraft(next)) {
      return this.getCurrentDirectoryValue();
    }

    if (this.directoryInput && this.directoryInput.value !== next) {
      this.directoryInput.value = next;
    }
    if (this.directoryInput) this.directoryInput.title = next;
    if (
      this.toolsSheetDirectoryInput &&
      this.toolsSheetDirectoryInput.value !== next
    ) {
      this.toolsSheetDirectoryInput.value = next;
    }
    if (this.toolsSheetDirectoryInput)
      this.toolsSheetDirectoryInput.title = next;
    // Persist the last directory as the canonical files.defaultCwd. Write
    // directly to the store (NOT via runtime.apply) to avoid re-dispatching the
    // applyDefaultCwd side effect on every cwd change / OSC7 update (which would
    // recurse). The value is only a navigation default; the backend file gates
    // remain the authorization boundary (Codex #4 — do not trust it).
    this.settingsStore?.set("files.defaultCwd", next);
  }

  setupToolsSheet() {
    if (!this.toolsSheet) return;

    const close = () => this.closeToolsSheet();

    this.toolsSheet
      .querySelector(".tools-sheet-backdrop")
      ?.addEventListener("click", close);
    this.toolsSheet
      .querySelector("#tools-sheet-close")
      ?.addEventListener("click", close);
  }

  setupTaskPanel() {
    const panel = document.getElementById("task-panel");
    if (!panel) return;

    panel
      .querySelector(".task-panel-backdrop")
      ?.addEventListener("click", () => this.closeTaskPanel());
    panel
      .querySelector("#task-panel-close")
      ?.addEventListener("click", () => this.closeTaskPanel());
    panel.querySelector("#task-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.createTaskFromForm();
    });
    panel.querySelector("#task-list")?.addEventListener("click", (event) => {
      const item = event.target.closest("[data-task-id]");
      if (!item) return;
      this.selectTask(item.dataset.taskId);
    });
    panel
      .querySelector("#task-view-toggle")
      ?.addEventListener("click", () => this.toggleTaskViewMode());
    panel.querySelector("#task-detail")?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-task-action]");
      if (!button) return;
      void this.handleTaskAction(button.dataset.taskAction);
    });
  }

  setupSetupPanel() {
    const panel = document.getElementById("setup-panel");
    if (!panel) return;

    panel
      .querySelector(".setup-panel-backdrop")
      ?.addEventListener("click", () => this.closeSetupPanel());
    panel
      .querySelector("#setup-panel-close")
      ?.addEventListener("click", () => this.closeSetupPanel());
    panel
      .querySelector("#setup-run-doctor")
      ?.addEventListener("click", () => this.runSetupDoctor());
    panel
      .querySelector("#setup-apply-safe")
      ?.addEventListener("click", () => this.applySetupProfile());
    panel
      .querySelector("#setup-profile")
      ?.addEventListener("change", (event) => {
        this.setupState.profile = event.target.value || "cloudflare";
        this.renderSetupReport(this.setupState.report);
      });
    panel.addEventListener("click", (event) => {
      const toggle = event.target.closest("[data-setup-details-toggle]");
      if (!toggle) return;
      const details = panel.querySelector("#setup-snippets");
      if (!details) return;
      const isHidden = details.hasAttribute("hidden");
      if (isHidden) {
        details.removeAttribute("hidden");
        toggle.textContent = "Hide details";
      } else {
        details.setAttribute("hidden", "");
        toggle.textContent = "Show details";
      }
    });
  }

  getTaskPanel() {
    return document.getElementById("task-panel");
  }

  getSetupPanel() {
    return document.getElementById("setup-panel");
  }

  getSessionsPanel() {
    return document.getElementById("sessions-panel");
  }

  setupSessionsPanel() {
    const panel = this.getSessionsPanel();
    if (!panel) return;
    panel
      .querySelector(".task-panel-backdrop")
      ?.addEventListener("click", () => this.closeSessionsPanel());
    panel
      .querySelector("#sessions-panel-close")
      ?.addEventListener("click", () => this.closeSessionsPanel());
    panel
      .querySelector("#sessions-refresh-btn")
      ?.addEventListener("click", () => this.refreshSessionsPanel());
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.closeSessionsPanel();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = this.getSessionsFocusableElements();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    const list = panel.querySelector("#sessions-list");
    list?.addEventListener("click", (event) => {
      const row = event.target.closest("[data-session-id]");
      if (!row) return;
      void this.handleSessionRowActivate(row.dataset.sessionId);
    });
    // Keyboard affordance: rows are role="button", so Enter/Space activate them.
    list?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const row = event.target.closest("[data-session-id]");
      if (!row) return;
      event.preventDefault();
      void this.handleSessionRowActivate(row.dataset.sessionId);
    });
  }

  getSessionsFocusableElements() {
    const panel = this.getSessionsPanel();
    if (!panel || panel.classList.contains("hidden")) return [];
    return Array.from(
      panel.querySelectorAll(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !element.hidden && element.offsetParent !== null);
  }

  async handleSessionRowActivate(sessionId) {
    if (!sessionId) return;
    const session = (this._sessionCatalog || []).find(
      (s) => s.id === sessionId,
    );
    if (!session) {
      // Catalog moved on under us — re-fetch rather than act on stale data.
      await this.refreshSessionsPanel();
      return;
    }
    const action = window.SessionActions.planSessionRowAction(session, {
      isLocallyOpen: this.terminals.has(sessionId),
    });
    switch (action.kind) {
      case "focus":
        this.switchTo(sessionId);
        break;
      case "attach":
        await this.reconnectToTerminal(
          sessionId,
          session.cwd,
          this.sessionRegistry.get(sessionId),
          {
            backendMode: session.backendMode || null,
            supportsLinkedView: Boolean(session.supportsLinkedView),
          },
        );
        this.switchTo(sessionId);
        break;
      case "open-here":
        await this.createTerminal(false, { cwd: session.cwd });
        break;
    }
    this.updateSessionsAvailableBadge();
    this.closeSessionsPanel({ restoreFocus: false });
  }

  openSessionsPanel() {
    const panel = this.getSessionsPanel();
    if (!panel) return;
    this.closeToolsSheet();
    this.closeTaskPanel();
    this.closeSetupPanel();
    this.sessionsReturnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : document.getElementById("sessions-btn");
    panel.classList.remove("hidden");
    panel.setAttribute("aria-hidden", "false");
    document
      .getElementById("sessions-btn")
      ?.setAttribute("aria-expanded", "true");
    void this.refreshSessionsPanel();
    this.syncSurfaceButtonState();
    panel
      .querySelector("#sessions-panel-close")
      ?.focus({ preventScroll: true });
  }

  closeSessionsPanel({ restoreFocus = true } = {}) {
    const panel = this.getSessionsPanel();
    if (!panel) return;
    panel.classList.add("hidden");
    panel.setAttribute("aria-hidden", "true");
    document
      .getElementById("sessions-btn")
      ?.setAttribute("aria-expanded", "false");
    this.syncSurfaceButtonState();
    const returnTarget = this.sessionsReturnFocus;
    this.sessionsReturnFocus = null;
    if (restoreFocus && returnTarget?.isConnected) {
      returnTarget.focus({ preventScroll: true });
    }
  }

  updateSessionsAvailableBadge(sessions = this._sessionCatalog || []) {
    const trigger = document.getElementById("sessions-btn");
    const badge = document.getElementById("sessions-available-badge");
    if (!trigger || !badge) return;
    const available = Array.isArray(sessions)
      ? sessions.filter((session) => {
          const live =
            session?.active === true ||
            session?.status === "active" ||
            session?.sessionStatus === "active";
          return live && session?.id && !this.terminals.has(session.id);
        }).length
      : 0;
    badge.hidden = available === 0;
    badge.textContent = available > 99 ? "99+" : String(available || "");
    const label = available
      ? `Sessions, ${available} available`
      : "Sessions";
    trigger.setAttribute("aria-label", label);
    trigger.title = label;
  }

  async refreshSessionsPanel() {
    const list = document.getElementById("sessions-list");
    if (!list) return;
    list.innerHTML = "<div class='task-item'>Loading sessions…</div>";
    try {
      const res = await fetch("/api/terminals", {
        headers: { "x-deckterm-client-id": this.clientInstanceId },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const sessions = await res.json();
      // Keep the catalog so the click handler can resolve cwd/flags per row.
      this._sessionCatalog = sessions;
      this.updateSessionsAvailableBadge(sessions);
      if (!sessions.length) {
        list.innerHTML = "<div class='task-item'>No sessions yet.</div>";
        return;
      }
      const esc = (v) => (this.escapeHtml ? this.escapeHtml(v) : v);
      list.innerHTML = sessions
        .map((s) => {
          const isLocallyOpen = this.terminals.has(s.id);
          const action = window.SessionActions.planSessionRowAction(s, {
            isLocallyOpen,
          });
          const status = s.sessionStatus || s.status || "unknown";
          const mode = s.mode || "write";
          const cwd = esc(s.cwd || "");
          const dot = action.statusClass === "active" ? "●" : "○";
          return `<div class="session-row" role="button" tabindex="0" data-session-id="${s.id}">
          <div class="session-row-main">
            <strong><span class="session-badge ${action.statusClass}">${dot}</span> ${s.id.slice(0, 8)}</strong>
            <div class="session-row-cwd">${cwd}</div>
            <small>${esc(status)} · ${esc(mode)}${s.sessionName ? " · tmux" : ""}</small>
          </div>
          <span class="session-row-action" aria-hidden="true">${action.label}</span>
        </div>`;
        })
        .join("");
    } catch (err) {
      list.innerHTML = `<div class='task-item'>Failed to load sessions: ${err.message}</div>`;
    }
  }

  setTaskStatus(message) {
    const status = document.getElementById("task-status");
    if (status) status.textContent = message || "";
  }

  async openTaskPanel({ focusTitle = false } = {}) {
    const panel = this.getTaskPanel();
    if (!panel) return;

    this.closeToolsSheet();
    this.closeSetupPanel();
    if (this.isWindowedSurfaces()) {
      await this.openSurfaceWindow("tasks", {
        title: "Tasks",
        icon: "▦",
        contentEl: panel,
        bounds: { x: 20, y: 8, width: 60, height: 80 },
        minWidthPx: 420,
        onClose: () => this.closeTaskPanel(),
      });
    } else {
      this.releaseSurfaceWindowContent("tasks", panel);
    }
    panel.classList.remove("hidden");
    panel.setAttribute("aria-hidden", "false");
    const rootInput = panel.querySelector("#task-project-root");
    if (rootInput && !rootInput.value) {
      rootInput.value = this.getCurrentDirectoryValue() || "";
    }
    await this.refreshTasks();
    await this.refreshHarnessOptions();
    if (focusTitle) {
      panel.querySelector("#task-title")?.focus();
    }
    this.syncSurfaceButtonState();
  }

  // Rebuild the worker/judge provider selects from live availability probes.
  // Best-effort only: on any failure the static claude/codex options baked
  // into index.html remain untouched as the no-JS/failure fallback.
  async refreshHarnessOptions() {
    const panel = this.getTaskPanel();
    if (!panel) return;
    const selects = [
      panel.querySelector("#task-worker-provider"),
      panel.querySelector("#task-judge-provider"),
    ].filter(Boolean);
    if (!selects.length) return;
    try {
      const payload = await this.fetchTaskJson("/api/harnesses");
      const harnesses = Array.isArray(payload?.harnesses)
        ? payload.harnesses
        : [];
      if (!harnesses.length) return;
      // Fallback when the current selection is gone/unavailable: claude if
      // available, else the first available harness, else claude (the server
      // re-validates on create either way).
      const claudeAvailable = harnesses.some(
        (harness) => harness.id === "claude" && harness.available !== false,
      );
      const firstAvailable = harnesses.find(
        (harness) => harness.available !== false,
      );
      const fallbackId = claudeAvailable
        ? "claude"
        : firstAvailable?.id || "claude";
      for (const select of selects) {
        const currentValue = select.value;
        const keepCurrent = harnesses.some(
          (harness) =>
            harness.id === currentValue && harness.available !== false,
        );
        while (select.firstChild) select.removeChild(select.firstChild);
        for (const harness of harnesses) {
          const option = document.createElement("option");
          option.value = harness.id;
          option.textContent =
            harness.available === false
              ? `${harness.label} (unavailable)`
              : harness.label;
          if (harness.available === false) option.disabled = true;
          select.appendChild(option);
        }
        select.value = keepCurrent ? currentValue : fallbackId;
      }
    } catch (err) {
      console.debug("Failed to load harness availability", err);
    }
  }

  closeTaskPanel() {
    const panel = this.getTaskPanel();
    if (!panel) return;
    panel.classList.add("hidden");
    panel.setAttribute("aria-hidden", "true");
    this.surfaceWindowManager?.close("tasks");
    this.syncSurfaceButtonState();
  }

  // --- Settings runtime + window ---------------------------------------------

  // Construct the app-level settings runtime and apply every setting once on
  // startup, so side effects (CSS vars, etc.) take hold even if the settings
  // window is never opened. Real consumers are registered in Task 3; here we
  // wire appearance.accent as a demo CSS-var side effect.
  // One-time migration of the six legacy localStorage keys onto the canonical
  // settings store. Flush-before-flag: only after the debounced PUT resolves do
  // we record `settings.migratedV1`, so the migrated values can't be lost if the
  // tab closes mid-flight. Idempotent (the migration helper no-ops when flagged).
  async runSettingsMigration() {
    if (
      !this.settingsStore ||
      !window.SettingsMigration?.migrateLegacySettings
    ) {
      return;
    }
    const storage = typeof localStorage !== "undefined" ? localStorage : null;
    if (!storage) return;
    const schema = window.SettingsSchema?.SETTINGS_SCHEMA || [];
    const flagKey =
      window.SettingsMigration.MIGRATED_FLAG_KEY || "settings.migratedV1";
    const result = window.SettingsMigration.migrateLegacySettings(
      storage,
      this.settingsStore,
      schema,
    );
    if (result.alreadyMigrated) return;
    try {
      // Flush whatever the migration enqueued, THEN mark the flag and flush it.
      await this.settingsStore.flush();
      this.settingsStore.set(flagKey, true);
      await this.settingsStore.flush();
    } catch {
      // A failed flush leaves the flag unset; the next load+migration retries.
    }
  }

  initSettingsRuntime() {
    if (!window.SettingsRuntime?.createSettingsRuntime || !this.settingsStore) {
      return;
    }
    this.settingsRuntime = window.SettingsRuntime.createSettingsRuntime({
      store: this.settingsStore,
      schema: window.SettingsSchema?.SETTINGS_SCHEMA || [],
      sideEffects: {
        "appearance.accent": (value) => this.applyAccentColor(value),
        // The six migrated legacy settings — applied live when changed in the
        // settings window AND once on startup via applyAll(). Each receives the
        // already-coerced value (numbers clamped to the schema range).
        "terminal.fontSize": (value) => this.applyFontSize(value),
        "terminal.wrapLines": (value) => this.applyWrapLines(value),
        "terminal.autoCopy": (value) =>
          this.clipboardManager?.applyAutoCopy(value),
        "terminal.extraKeysVisible": (value) =>
          this.applyExtraKeysVisible(value),
        "tasks.view": (value) => this.applyTaskView(value),
        "files.defaultCwd": (value) => this.applyDefaultCwd(value),
        "editor.autosave": (value) => this.applyEditorAutosave(value),
        "terminal.renderer": (value) => this.applyRendererSetting(value),
      },
    });
    // Settings load + migration are async; apply once they resolve so the store
    // is populated with the canonical (and migrated) values.
    void this.settingsReady.then(() => this.settingsRuntime?.applyAll());
  }

  applyAccentColor(name) {
    const map = {
      blue: "var(--accent-blue)",
      green: "var(--accent-green)",
      purple: "#a371f7",
      orange: "var(--accent-orange)",
      pink: "#f778ba",
    };
    const color = map[name] || map.blue;
    document.documentElement.style.setProperty("--color-accent", color);
  }

  // Side effect for terminal.extraKeysVisible (value coerced to bool).
  // Delegates to ExtraKeysManager without re-persisting. Fires from both an
  // explicit toggle (settingsRuntime.apply — value is already persisted) AND
  // the startup settingsRuntime.applyAll() sweep, which resolves an UNSET key
  // to the schema default (false, desktop-oriented). Mobile's own default is
  // true (see ExtraKeysManager.loadVisibilityState) — so on mobile, only
  // apply when the key is actually persisted; otherwise leave whatever
  // loadVisibilityState() already resolved synchronously untouched, instead
  // of letting the schema default clobber it to hidden on a fresh session.
  applyExtraKeysVisible(visible) {
    if (!this.extraKeys) return;
    if (platformDetector.isMobile) {
      const UNSET = Symbol("unset");
      const persisted = this.settingsStore?.get(
        "terminal.extraKeysVisible",
        UNSET,
      );
      if (persisted === UNSET) return;
    }
    this.extraKeys.applyVisibility(Boolean(visible));
  }

  // Side effect for files.defaultCwd. A path value used purely as a navigation
  // default — NOT trusted as authorized (Codex #4); the backend file gates still
  // apply on the resulting loadDir. Only restores a non-empty stored value.
  applyDefaultCwd(value) {
    const dir = typeof value === "string" ? value : "";
    if (dir) this.setDirectoryValue(dir, { force: true });
  }

  // Side effect for editor.autosave ("off"|"1000"|"5000"). Live-updates every
  // currently open editor-tab handle's debounce interval — new tabs pick up
  // the setting at mount time via mountEditorFileTab. A handle whose last save
  // failed stays non-autosaving regardless of this call (setAutosaveIntervalMs
  // only changes the interval, never clears the failed/re-arm state — see
  // createAutosaveController in file-editor.js).
  applyEditorAutosave(value) {
    const ms = window.FileEditorModule?.parseAutosaveMs?.(value) ?? null;
    this.editorAutosaveMs = ms;
    for (const handle of this.editorTabHandles?.values() || []) {
      handle?.setAutosaveIntervalMs?.(ms);
    }
  }

  // Side effect for terminal.renderer ("auto"|"default"). Switching TO
  // "default" tears down every currently loaded WebGL addon immediately
  // (cheap: dispose + fall back to xterm's default renderer). Switching to
  // "auto" is intentionally a no-op for terminals that already exist —
  // retrofitting a live terminal onto WebGL is non-trivial (re-fit/re-render
  // plumbing) and out of scope here; it only takes effect for new terminals
  // created after the switch (see setupTerminalRenderer).
  applyRendererSetting(value) {
    if (value !== "default") return;
    for (const [, t] of this.terminals) {
      if (!t.webglAddon) continue;
      const addon = t.webglAddon;
      try {
        addon.dispose();
      } catch (err) {
        if (DEBUG) dbg("webglAddon.dispose (setting switch) error", { err });
      }
      t.webglAddon = null;
      if (t.terminal?._webglAddon === addon) t.terminal._webglAddon = null;
    }
  }

  async openSettings() {
    this.closeToolsSheet();
    // IDE mode: open as an editor tab (singleton, pinned). SurfaceWindow is NOT
    // used — the tab IS the settings UI. (Codex fix 7: single UI per mode.)
    if (this.isIdeModeActive() && this.editorTabs) {
      this.editorTabs.openSettings();
      return;
    }
    if (!this.settingsManager) {
      this.settingsManager = new SettingsManager({
        settingsStore: this.settingsStore,
        runtime: this.settingsRuntime,
      });
    }
    const content = this.settingsManager.buildContent();
    if (this.isWindowedSurfaces()) {
      // Desktop: the existing SurfaceWindow path.
      await this.openSurfaceWindow("settings", {
        title: "Settings",
        icon: "⚙",
        contentEl: content,
        bounds: { x: 16, y: 8, width: 68, height: 82 },
        minWidthPx: 520,
        minHeightPx: 360,
        onClose: () => this.surfaceWindowManager?.close("settings"),
      });
    } else {
      // Mobile (or a narrow desktop window where windowed surfaces are off):
      // there is no floating-window host, so host the same detached content
      // in the static full-screen sheet (mirrors openFileExplorer/
      // openGitPanel's mobile-sheet fallback). releaseSurfaceWindowContent
      // reparents the content out of any SurfaceWindow body it was
      // previously mounted in (e.g. after a desktop->mobile resize).
      this.releaseSurfaceWindowContent("settings", content);
      const body = document.getElementById("settings-sheet-body");
      if (body && content && content.parentElement !== body) {
        body.appendChild(content);
      }
      this.openSettingsSheet();
    }
    await this.settingsManager.render();
    this.syncSurfaceButtonState();
  }

  // Static mobile sheet host for Settings (index.html #settings-sheet) —
  // the counterpart to FileExplorerController's own show()/hidden-class
  // toggling, which Settings has no equivalent controller for.
  openSettingsSheet() {
    const sheet = document.getElementById("settings-sheet");
    if (!sheet) return;
    sheet.classList.remove("hidden");
    sheet.setAttribute("aria-hidden", "false");
    if (!sheet.dataset.wired) {
      sheet.dataset.wired = "1";
      document
        .getElementById("settings-sheet-close")
        ?.addEventListener("click", () => this.closeSettingsSheet());
      sheet
        .querySelector(".settings-sheet-backdrop")
        ?.addEventListener("click", () => this.closeSettingsSheet());
    }
  }

  closeSettingsSheet() {
    const sheet = document.getElementById("settings-sheet");
    if (!sheet) return;
    sheet.classList.add("hidden");
    sheet.setAttribute("aria-hidden", "true");
  }

  setSetupStatus(message) {
    const status = document.getElementById("setup-status");
    if (status) status.textContent = message || "";
  }

  async openSetupPanel() {
    const panel = this.getSetupPanel();
    if (!panel) return;

    this.closeToolsSheet();
    this.closeTaskPanel();
    panel.classList.remove("hidden");
    panel.setAttribute("aria-hidden", "false");
    this.renderSetupReport(this.setupState.report);
    this.syncSurfaceButtonState();
  }

  closeSetupPanel() {
    const panel = this.getSetupPanel();
    if (!panel) return;
    panel.classList.add("hidden");
    panel.setAttribute("aria-hidden", "true");
    this.syncSurfaceButtonState();
  }

  renderSetupReport(report) {
    const summary = document.getElementById("setup-summary");
    const wizard = document.getElementById("setup-wizard");
    const remediations = document.getElementById("setup-remediations");
    const snippets = document.getElementById("setup-snippets");
    const checks = document.getElementById("setup-checks");
    const recommendations = document.getElementById("setup-recommendations");
    const output = document.getElementById("setup-output-text");
    if (
      !summary ||
      !wizard ||
      !remediations ||
      !snippets ||
      !checks ||
      !recommendations ||
      !output
    )
      return;
    output.closest(".setup-output")?.setAttribute("hidden", "");

    summary.replaceChildren();
    wizard.replaceChildren();
    remediations.replaceChildren();
    snippets.replaceChildren();
    snippets.setAttribute("hidden", "");
    checks.replaceChildren();
    recommendations.replaceChildren();
    output.textContent = "";

    if (!report) {
      const empty = document.createElement("div");
      empty.className = "setup-empty";
      empty.textContent = "Doctor has not run yet";
      summary.appendChild(empty);
      return;
    }

    this.renderSetupCurrentConfig(report, summary);
    this.renderSetupWizard(report.wizard, { wizard, remediations, snippets });

    const checkList = document.createElement("ul");
    (Array.isArray(report.checks) ? report.checks : []).forEach((check) => {
      const item = document.createElement("li");
      item.className = `setup-check ${check.status || "failed"}`;
      const badge = document.createElement("span");
      badge.textContent = check.status || "failed";
      const message = document.createElement("div");
      message.textContent = check.message || check.raw || "Unknown check";
      item.append(badge, message);
      checkList.appendChild(item);
    });
    if (!checkList.children.length) {
      const item = document.createElement("li");
      item.className = "setup-check failed";
      item.textContent = "No doctor checks were reported";
      checkList.appendChild(item);
    }
    checks.appendChild(checkList);

    const recommendationList = document.createElement("ul");
    (Array.isArray(report.recommendations)
      ? report.recommendations
      : []
    ).forEach((recommendation) => {
      const item = document.createElement("li");
      item.textContent = recommendation;
      recommendationList.appendChild(item);
    });
    recommendations.appendChild(recommendationList);

    output.textContent = [report.stdout, report.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    snippets.append(
      checks,
      recommendations,
      this.renderSetupOutputSection(output.textContent),
    );
  }

  renderSetupCurrentConfig(report, target) {
    const status = String(report.status || "failed");
    target.dataset.status = status;

    const section = document.createElement("section");
    section.className = "setup-current";

    const header = document.createElement("div");
    header.className = "setup-section-header";
    const title = document.createElement("h4");
    title.textContent = "Current config";
    const badge = document.createElement("span");
    badge.className = `setup-status-badge ${status}`;
    badge.textContent =
      status === "ok"
        ? "Ready"
        : status === "warning"
          ? "Needs changes"
          : "Blocked";
    header.append(title, badge);

    const rows = document.createElement("div");
    rows.className = "setup-state-grid";
    const bindLabel =
      report.config?.host === "0.0.0.0" ? "Public bind" : "Local bind";
    const requestContext = report.requestContext || {};
    const accessPath = requestContext.viaCloudflare
      ? "Cloudflare request detected"
      : "Local/direct request";
    const accessValidation = report.config?.cfAccessRequired
      ? "Required by DeckTerm"
      : "Not required by DeckTerm";
    const liveTunnel =
      requestContext.viaCloudflare && requestContext.cfAccessJwtPresent;
    const foundation = report.foundation || {};
    const actor = foundation.auth?.actor || null;
    const actorSource =
      actor?.source === "cloudflare_access"
        ? "Cloudflare Access"
        : actor?.source === "legacy_dev"
          ? "Dev anonymous"
          : "Unknown";
    const identity = actor
      ? `${actor.email || actor.id || "unknown"} (${actorSource})`
      : "Unknown";
    const runtimeEnv = foundation.runtime?.environment || "unknown";
    const backendMode = foundation.runtime?.backendMode || "unknown";
    const bootstrap = foundation.bootstrap
      ? foundation.bootstrap.bootstrapped
        ? "Complete"
        : `Pending (${foundation.bootstrap.mode || "token"})`
      : "Unknown";
    const warningLabels = {
      broad_home_root: "home root grant",
    };
    const roots = Array.isArray(foundation.roots) ? foundation.roots : [];
    const rootSummary = roots.length
      ? roots
          .map((root) => {
            const warning = root.warning
              ? `, ${warningLabels[root.warning] || root.warning}`
              : "";
            return `${root.name || "root"}: ${root.path || "?"} (${root.status || "unknown"}${warning})`;
          })
          .join(" · ")
      : "No registered roots";
    const stateRows = [
      ["Publishing mode", report.config?.publishMode || "local"],
      [
        "Network bind",
        `${bindLabel} (${report.config?.host || "?"}:${report.config?.port || "?"})`,
      ],
      ["Access path", accessPath],
      ["CF Access validation", accessValidation],
      ["Identity", identity],
      ["Runtime env", `${runtimeEnv} / ${backendMode}`],
      ["Bootstrap", bootstrap],
      ["Registered project roots", rootSummary],
      [
        "Persistent terminals",
        report.config?.tmuxBackend ? "tmux on" : "tmux off",
      ],
    ];
    if (liveTunnel) {
      stateRows.push(["Live tunnel", "JWT reaching DeckTerm"]);
    }
    stateRows.forEach(([label, value]) => {
      const row = document.createElement("div");
      row.className = "setup-state-row";
      if (label === "Registered project roots") {
        row.classList.add("setup-state-row-wide");
      }
      const rowLabel = document.createElement("span");
      rowLabel.textContent = label;
      const rowValue = document.createElement("strong");
      rowValue.textContent = value;
      row.append(rowLabel, rowValue);
      rows.appendChild(row);
    });

    const disclaimer = document.createElement("div");
    disclaimer.className = "setup-disclaimer";
    disclaimer.innerHTML = `⚠️ <strong>OS-Level Isolation Note:</strong> DeckTerm enforces multiuser boundaries at the application level. However, all terminal processes run under the same Unix user account on the host. Application permissions do not provide process or filesystem sandboxing between users.`;
    disclaimer.style.marginTop = "1rem";
    disclaimer.style.fontSize = "0.8rem";
    disclaimer.style.opacity = "0.75";
    disclaimer.style.lineHeight = "1.3";
    disclaimer.style.borderLeft = "2px solid var(--border-color, #30363d)";
    disclaimer.style.paddingLeft = "0.75rem";

    section.append(header, rows, disclaimer);
    target.appendChild(section);
  }

  renderSetupOutputSection(text) {
    const section = document.createElement("section");
    section.className = "setup-output";
    const title = document.createElement("h4");
    title.textContent = "Doctor Output";
    const pre = document.createElement("pre");
    pre.textContent = text;
    section.append(title, pre);
    return section;
  }

  renderSetupWizard(plan, targets) {
    if (!plan || !targets) return;
    const profileSelect = document.getElementById("setup-profile");
    if (profileSelect && plan.profile) {
      profileSelect.value = plan.profile;
      this.setupState.profile = plan.profile;
    }

    const header = document.createElement("section");
    header.className = "setup-target";
    const headerTop = document.createElement("div");
    headerTop.className = "setup-section-header";
    const title = document.createElement("h4");
    title.textContent = "Target profile";
    const badge = document.createElement("span");
    badge.className = "setup-target-badge";
    badge.textContent = plan.profileLabel || "Setup profile";
    headerTop.append(title, badge);
    header.appendChild(headerTop);
    targets.wizard.appendChild(header);

    const steps = document.createElement("section");
    steps.className = "setup-next-steps";
    const stepsHeader = document.createElement("div");
    stepsHeader.className = "setup-section-header";
    const remediationTitle = document.createElement("h4");
    remediationTitle.textContent = "Next steps";
    const stepsMeta = document.createElement("span");
    stepsMeta.textContent = "Apply in order";
    stepsHeader.append(remediationTitle, stepsMeta);
    steps.appendChild(stepsHeader);

    const remediationList = document.createElement("ol");
    remediationList.className = "setup-remediation-list";
    const rows = Array.isArray(plan.remediations) ? plan.remediations : [];
    rows.forEach((row) => {
      const item = document.createElement("li");
      item.className = "setup-remediation";
      const itemTitle = document.createElement("div");
      itemTitle.className = "setup-remediation-title";
      itemTitle.textContent = row.title || row.id || "Fix";
      const detail = document.createElement("div");
      detail.className = "setup-remediation-detail";
      detail.textContent = row.detail || "";
      item.append(itemTitle, detail);

      remediationList.appendChild(item);
    });
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "setup-empty";
      empty.textContent = "No fixes needed for this profile";
      remediationList.appendChild(empty);
    }
    steps.appendChild(remediationList);
    targets.remediations.appendChild(steps);

    const advanced = document.createElement("section");
    advanced.className = "setup-advanced";
    const advancedHeader = document.createElement("div");
    advancedHeader.className = "setup-section-header";
    const snippetsTitle = document.createElement("h4");
    snippetsTitle.textContent = "Full generated config";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "btn";
    toggle.dataset.setupDetailsToggle = "true";
    toggle.textContent = "Show details";
    advancedHeader.append(snippetsTitle, toggle);
    advanced.appendChild(advancedHeader);
    targets.remediations.appendChild(advanced);

    (Array.isArray(plan.snippetList) ? plan.snippetList : []).forEach(
      (snippet) => {
        const section = document.createElement("article");
        section.className = "setup-snippet";
        const label = document.createElement("div");
        label.className = "setup-snippet-label";
        label.textContent = snippet.label || "Snippet";
        const pre = document.createElement("pre");
        pre.textContent = snippet.content || "";
        section.append(label, pre);
        targets.snippets.appendChild(section);
      },
    );
  }

  async runSetupDoctor() {
    if (this.setupState.loading) return;
    this.setupState.loading = true;
    this.setSetupStatus("Running doctor...");
    try {
      const profile =
        document.getElementById("setup-profile")?.value ||
        this.setupState.profile ||
        "cloudflare";
      const publicOrigin =
        document.getElementById("setup-public-origin")?.value?.trim() || "";
      const params = new URLSearchParams({ profile });
      if (publicOrigin) params.set("publicOrigin", publicOrigin);
      const res = await fetch(`/api/onboarding/doctor?${params.toString()}`);
      const report = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          report.error || report.message || "Doctor request failed",
        );
      }
      this.setupState.report = report;
      this.renderSetupReport(report);
      this.setSetupStatus(`Doctor finished: ${report.status || "failed"}`);
    } catch (err) {
      this.setupState.report = null;
      this.renderSetupReport(null);
      this.setSetupStatus(err instanceof Error ? err.message : "Doctor failed");
    } finally {
      this.setupState.loading = false;
    }
  }

  async applySetupProfile() {
    if (this.setupState.loading) return;
    this.setupState.loading = true;
    this.setSetupStatus("Applying safe settings...");
    try {
      const profile =
        document.getElementById("setup-profile")?.value ||
        this.setupState.profile ||
        "cloudflare";
      const publicOrigin =
        document.getElementById("setup-public-origin")?.value?.trim() || "";
      const res = await fetch("/api/onboarding/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile,
          publicOrigin,
          allowedFileRoots: this.getCurrentDirectoryValue() || "",
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          payload.error || payload.message || "Setup apply failed",
        );
      }
      this.setupState.applyResult = payload;
      this.setupState.report = payload.report || null;
      this.renderSetupReport(this.setupState.report);
      this.setSetupStatus(
        "Safe settings written. Restart DeckTerm before opening it publicly.",
      );
    } catch (err) {
      this.setSetupStatus(
        err instanceof Error ? err.message : "Setup apply failed",
      );
    } finally {
      this.setupState.loading = false;
    }
  }

  async fetchTaskJson(url, options = {}) {
    const res = await fetch(url, options);
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        payload.error || payload.message || "Task request failed",
      );
    }
    return payload;
  }

  async refreshTasks({ selectedId = this.taskState.selectedId } = {}) {
    const panel = this.getTaskPanel();
    // Refresh when ANY task surface is live: the classic panel OR the IDE
    // sidebar tasks view. The old hidden-panel-only guard made every refresh
    // a no-op in IDE mode (the classic panel is hidden there), so the
    // sidebar rendered stale statuses forever — Start Worker kept showing
    // "ready" until the user left the IDE.
    const ideTasksMounted = Boolean(document.querySelector(".ide-tasks-view"));
    const panelVisible = Boolean(panel && !panel.classList.contains("hidden"));
    if (!panelVisible && !ideTasksMounted) return;
    this.taskState.loading = true;
    this.setTaskStatus("Loading tasks...");
    try {
      const tasks = await this.fetchTaskJson("/api/tasks");
      this.updateTaskSignals(tasks);
      this.taskState.items = Array.isArray(tasks) ? tasks : [];
      this.taskState.selectedId =
        selectedId &&
        this.taskState.items.some((task) => task.id === selectedId)
          ? selectedId
          : this.taskState.items[0]?.id || null;
      this.renderTasks();
      this.setTaskStatus("");
      if (this.taskState.selectedId) {
        await this.refreshTaskMessages();
      }
    } catch (err) {
      this.setTaskStatus(
        err instanceof Error ? err.message : "Failed to load tasks",
      );
    } finally {
      this.taskState.loading = false;
    }
  }

  // S8 (Traycer patterns): fetch the message timeline for the currently
  // selected task and re-render the detail panel. Guards against a stale
  // response landing after the selection changed mid-flight (checked BEFORE
  // writing to taskState, not just before the re-render) — a slow fetch for
  // task A must never overwrite messages while task B is now selected.
  // Failures are non-fatal: the last-known message list stays on screen.
  async refreshTaskMessages() {
    const taskId = this.taskState.selectedId;
    if (!taskId) return;
    try {
      const payload = await this.fetchTaskJson(
        `/api/tasks/${encodeURIComponent(taskId)}/messages`,
      );
      if (this.taskState.selectedId !== taskId) return;
      this.taskState.messages = Array.isArray(payload?.messages)
        ? payload.messages
        : [];
      this.taskState.messagesTaskId = taskId;
      this.renderTaskDetail(this.getSelectedTask());
    } catch (err) {
      console.debug("Failed to load task messages", err);
    }
  }

  // --- Global task-status badge + transition toasts -------------------------
  // The task panel stays poll-on-open; this badge polls cheaply in the
  // background so running/needs-user tasks are visible (and notable
  // transitions toast) while the panel is closed. Logic: web/task-signals.js.

  initTaskSignalBadge() {
    const status = this.connectionStatus;
    if (!status?.parentElement || !window.TaskSignals) return;
    const badge = document.createElement("button");
    badge.type = "button";
    badge.id = "task-signal-badge";
    badge.className = "task-signal-badge hidden";
    badge.addEventListener("click", () => void this.openTaskPanel());
    status.parentElement.insertBefore(badge, status);
    this.taskSignalBadge = badge;
    this.taskSignalLast = null;

    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/tasks");
        if (!res.ok) return;
        this.updateTaskSignals(await res.json());
      } catch {
        // Offline/transient — the reconnect overlay owns that messaging.
      }
    };
    this.taskSignalTimer = setInterval(() => void poll(), 15000);
    void poll();
  }

  updateTaskSignals(tasks) {
    if (!this.taskSignalBadge || !window.TaskSignals) return;
    const signals = window.TaskSignals.computeTaskSignals(tasks);
    this.taskSignalBadge.classList.toggle("hidden", !signals.badgeText);
    this.taskSignalBadge.textContent = signals.badgeText || "";
    this.taskSignalBadge.title = signals.title;

    if (this.taskSignalLast) {
      const transitions = window.TaskSignals.diffTaskTransitions(
        this.taskSignalLast,
        tasks,
      );
      for (const transition of transitions) {
        this.showTaskToast(transition);
      }
    }
    this.taskSignalLast = Array.isArray(tasks) ? tasks : [];
  }

  showTaskToast(transition) {
    let toast = document.getElementById("task-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "task-toast";
      toast.className = "task-toast hidden";
      toast.addEventListener("click", () => {
        toast.classList.add("hidden");
        void this.openTaskPanel();
      });
      document.getElementById("app")?.appendChild(toast);
    }
    const verb =
      transition.to === "complete"
        ? "completed ✅"
        : transition.to === "failed"
          ? "failed ❌"
          : "needs your input ⏸";
    toast.textContent = `Task "${transition.title}" ${verb}`;
    toast.classList.remove("hidden");
    clearTimeout(this.taskToastTimer);
    this.taskToastTimer = setTimeout(() => toast.classList.add("hidden"), 8000);
  }

  getTaskViewMode() {
    // Canonical tasks.view from the store (schema default "list").
    const defaults =
      window.SettingsSchema?.defaultsOf?.(
        window.SettingsSchema.SETTINGS_SCHEMA,
      ) || {};
    const fallback = defaults["tasks.view"] || "list";
    return this.settingsStore?.get("tasks.view", fallback) === "board"
      ? "board"
      : "list";
  }

  toggleTaskViewMode() {
    const next = this.getTaskViewMode() === "board" ? "list" : "board";
    // Persist + apply through the runtime; applyTaskView re-renders.
    if (this.settingsRuntime) {
      this.settingsRuntime.apply("tasks.view", next);
    } else {
      this.settingsStore?.set("tasks.view", next);
      this.renderTasks();
    }
  }

  // Side effect for tasks.view (value already coerced to a valid option).
  applyTaskView() {
    this.renderTasks();
  }

  syncTaskViewToggle() {
    const toggle = document.getElementById("task-view-toggle");
    if (!toggle) return;
    const mode = this.getTaskViewMode();
    toggle.textContent = mode === "board" ? "☰ List" : "▦ Board";
    toggle.title =
      mode === "board" ? "Switch to list view" : "Switch to board view";
  }

  renderTasks() {
    this.syncTaskViewToggle();
    if (this.getTaskViewMode() === "board") {
      this.renderTaskBoard();
      return;
    }
    const list = document.getElementById("task-list");
    if (!list) return;
    list.classList.remove("task-board");
    list.replaceChildren();

    if (this.taskState.items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "task-item-meta";
      empty.textContent = "No tasks";
      list.appendChild(empty);
      this.renderTaskDetail(null);
      return;
    }

    this.taskState.items.forEach((task) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "task-item";
      button.dataset.taskId = task.id;
      button.classList.toggle("active", task.id === this.taskState.selectedId);

      const header = document.createElement("div");
      header.className = "task-item-header";
      const title = document.createElement("div");
      title.className = "task-item-title";
      title.textContent = task.title || "Untitled task";
      const badge = document.createElement("span");
      badge.className = "task-badge";
      badge.textContent = task.status || "ready";
      header.append(title, badge);

      const meta = document.createElement("div");
      meta.className = "task-item-meta";
      meta.textContent = task.workingDirectory || task.projectRoot || "";

      button.append(header, meta);
      list.appendChild(button);
    });

    this.renderTaskDetail(
      this.taskState.items.find(
        (task) => task.id === this.taskState.selectedId,
      ) || null,
    );
  }

  // Kanban board view inside the task panel (read-only MVP, see
  // docs/plans/2026-06-12-task-board-design.md). Column logic: task-board.js.
  renderTaskBoard() {
    const list = document.getElementById("task-list");
    if (!list || !window.TaskBoard) return;
    list.classList.add("task-board");
    list.replaceChildren();

    const columns = window.TaskBoard.groupTasksForBoard(this.taskState.items);
    for (const column of columns) {
      const columnEl = document.createElement("div");
      columnEl.className = "task-board-column";

      const label = document.createElement("div");
      label.className = "task-board-column-label";
      label.textContent = `${column.label} (${column.tasks.length})`;
      columnEl.appendChild(label);

      for (const task of column.tasks) {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "task-item task-board-card";
        card.dataset.taskId = task.id;
        card.classList.toggle("active", task.id === this.taskState.selectedId);

        const title = document.createElement("div");
        title.className = "task-item-title";
        title.textContent = task.title || "Untitled task";

        const meta = document.createElement("div");
        meta.className = "task-item-meta";
        meta.textContent = `${task.status} · ${task.workerProvider || ""}`;

        card.append(title, meta);
        columnEl.appendChild(card);
      }

      list.appendChild(columnEl);
    }

    this.renderTaskDetail(
      this.taskState.items.find(
        (task) => task.id === this.taskState.selectedId,
      ) || null,
    );
  }

  renderTaskDetail(task) {
    const detail = document.getElementById("task-detail");
    if (!detail) return;
    detail.replaceChildren();
    if (!task) return;

    const header = document.createElement("div");
    header.className = "task-detail-header";
    const title = document.createElement("div");
    title.className = "task-detail-title";
    title.textContent = task.title || "Untitled task";
    const badge = document.createElement("span");
    badge.className = "task-badge";
    badge.textContent = task.status || "ready";
    header.append(title, badge);

    const meta = document.createElement("div");
    meta.className = "task-detail-meta";
    meta.textContent = task.workingDirectory || task.projectRoot || "";

    const checks = document.createElement("ul");
    checks.className = "task-checks";
    (task.checks || []).forEach((check) => {
      const item = document.createElement("li");
      item.textContent = `${check.label}: ${check.command}`;
      checks.appendChild(item);
    });
    if (!checks.children.length) {
      const item = document.createElement("li");
      item.textContent = "No checks";
      checks.appendChild(item);
    }

    const actions = document.createElement("div");
    actions.className = "task-actions";
    // Mirror the IDE sidebar: a running phase disables its trigger so the
    // primary button reflects the live status.
    const taskRunning =
      task.status === "worker-running" ||
      task.status === "checks-running" ||
      task.status === "judge-running";
    [
      ["start", "Start Worker"],
      ["checks", "Run Checks"],
      ["judge", "Run Judge"],
    ].forEach(([action, label]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = action === "start" ? "btn btn-primary" : "btn";
      button.dataset.taskAction = action;
      button.textContent = label;
      button.disabled =
        taskRunning || (action === "start" && task.status === "complete");
      actions.appendChild(button);
    });

    const checkOutput = this.renderTaskCheckOutput(task);
    const rounds = this.renderTaskRounds(task);
    const messages = this.renderTaskMessages(task);

    detail.append(header, meta, checks, checkOutput, rounds, messages, actions);
  }

  renderTaskCheckOutput(task) {
    const section = document.createElement("section");
    section.className = "task-check-output";
    const title = document.createElement("h4");
    title.textContent = "Last check output";
    section.appendChild(title);

    const results = task.lastCheckRun?.results || [];
    if (!results.length) {
      const empty = document.createElement("div");
      empty.className = "task-detail-meta";
      empty.textContent = "No check run yet";
      section.appendChild(empty);
      return section;
    }

    results.forEach((result) => {
      const item = document.createElement("div");
      item.className = "task-check-result";
      const label = document.createElement("div");
      label.className = "task-check-label";
      label.textContent = `${result.label || result.command} exited ${result.exitCode}`;
      const output = document.createElement("pre");
      output.textContent =
        [result.stdout, result.stderr].filter(Boolean).join("\n").trim() ||
        "(no output)";
      item.append(label, output);
      section.appendChild(item);
    });

    return section;
  }

  renderTaskRounds(task) {
    const section = document.createElement("section");
    section.className = "task-rounds";
    const title = document.createElement("h4");
    title.textContent = "Round history";
    section.appendChild(title);

    const rounds = Array.isArray(task.rounds) ? task.rounds : [];
    if (!rounds.length) {
      const empty = document.createElement("div");
      empty.className = "task-detail-meta";
      empty.textContent = "No rounds yet";
      section.appendChild(empty);
      return section;
    }

    const list = document.createElement("ol");
    rounds.forEach((round) => {
      const item = document.createElement("li");
      const type = round.type || "event";
      const status = round.status ? ` ${round.status}` : "";
      const success =
        typeof round.success === "boolean"
          ? round.success
            ? " success"
            : " failed"
          : "";
      item.textContent = `${type}${status}${success}`;
      list.appendChild(item);
    });
    section.appendChild(list);
    return section;
  }

  // S8 (Traycer patterns): message timeline + compose box for the selected
  // task. Messages live on this.taskState.messages (only valid when
  // messagesTaskId matches the task being painted — a stale set from a prior
  // selection is never shown). createElement/textContent only: message
  // bodies are user/judge-originated text, never innerHTML.
  renderTaskMessages(task) {
    const section = document.createElement("section");
    section.className = "task-messages";
    const title = document.createElement("h4");
    title.textContent = "Messages";
    section.appendChild(title);

    const messages =
      this.taskState.messagesTaskId === task.id ? this.taskState.messages : [];

    const list = document.createElement("div");
    list.className = "task-message-list";
    if (!messages.length) {
      const empty = document.createElement("div");
      empty.className = "task-detail-meta";
      empty.textContent = "No messages yet";
      list.appendChild(empty);
    } else {
      messages.forEach((msg) => {
        const formatted = window.TasksView?.formatTaskMessageRow
          ? window.TasksView.formatTaskMessageRow(msg)
          : {
              fromLabel: typeof msg?.from === "string" ? msg.from : "",
              bodyText: typeof msg?.body === "string" ? msg.body : "",
              deliveryLabel:
                msg?.delivery === "delivered"
                  ? "Delivered"
                  : msg?.delivery === "failed"
                    ? "Failed"
                    : "Pending",
              deliveryTitle:
                msg?.delivery === "failed" && msg?.failureReason
                  ? String(msg.failureReason)
                  : "",
            };

        const row = document.createElement("div");
        row.className = "task-message-row";

        const rowHeader = document.createElement("div");
        rowHeader.className = "task-message-row-header";

        const from = document.createElement("span");
        from.className = "task-message-from";
        const time = msg?.createdAt
          ? new Date(msg.createdAt).toLocaleTimeString()
          : "";
        from.textContent = time
          ? `${formatted.fromLabel} · ${time}`
          : formatted.fromLabel;

        const deliveryClass =
          msg?.delivery === "delivered" || msg?.delivery === "failed"
            ? msg.delivery
            : "pending";
        const delivery = document.createElement("span");
        delivery.className = `task-message-delivery task-message-delivery-${deliveryClass}`;
        delivery.textContent = formatted.deliveryLabel;
        if (formatted.deliveryTitle) delivery.title = formatted.deliveryTitle;

        rowHeader.append(from, delivery);

        const body = document.createElement("div");
        body.className = "task-message-body";
        body.textContent = formatted.bodyText;

        row.append(rowHeader, body);
        list.appendChild(row);
      });
    }
    section.appendChild(list);

    const compose = document.createElement("div");
    compose.className = "task-message-compose";

    const target = document.createElement("select");
    target.className = "task-message-target";
    [
      ["worker", "Worker"],
      ["judge", "Judge"],
    ].forEach(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      target.appendChild(option);
    });
    target.value = "worker";

    const input = document.createElement("textarea");
    input.className = "task-message-input";
    input.placeholder = "Message the running agent…";

    const send = document.createElement("button");
    send.type = "button";
    send.className = "btn btn-primary";
    send.textContent = "Send";
    send.addEventListener("click", () => {
      void this.sendTaskMessage(task, target, input, send);
    });

    compose.append(target, input, send);
    section.appendChild(compose);

    return section;
  }

  // POST a new task message, then refresh the timeline. A "delivered"/"failed"
  // response is still an HTTP success (the message was recorded either way) —
  // only a "failed" delivery surfaces via setTaskStatus; a request-level error
  // (bad `to`, empty body, 404) is caught and shown the same way.
  async sendTaskMessage(task, targetSelect, textarea, sendButton) {
    if (!task) return;
    const to = targetSelect?.value === "judge" ? "judge" : "worker";
    const body = textarea?.value || "";
    sendButton.disabled = true;
    try {
      const payload = await this.fetchTaskJson(
        `/api/tasks/${encodeURIComponent(task.id)}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to, body }),
        },
      );
      textarea.value = "";
      if (payload?.delivery === "failed") {
        this.setTaskStatus(
          `Delivery failed: ${payload.reason || "unknown reason"}`,
        );
      }
      await this.refreshTaskMessages();
    } catch (err) {
      this.setTaskStatus(
        err instanceof Error ? err.message : "Failed to send message",
      );
    } finally {
      sendButton.disabled = false;
    }
  }

  selectTask(taskId) {
    this.taskState.selectedId = taskId || null;
    this.renderTasks();
    if (this.taskState.selectedId) {
      void this.refreshTaskMessages();
    }
  }

  getSelectedTask() {
    return (
      this.taskState.items.find(
        (task) => task.id === this.taskState.selectedId,
      ) || null
    );
  }

  async createTaskFromForm() {
    const panel = this.getTaskPanel();
    if (!panel) return;
    const body = {
      projectRoot: panel.querySelector("#task-project-root")?.value || "",
      title: panel.querySelector("#task-title")?.value || "",
      description: panel.querySelector("#task-description")?.value || "",
      workerProvider:
        panel.querySelector("#task-worker-provider")?.value || "claude",
      judgeProvider:
        panel.querySelector("#task-judge-provider")?.value || "claude",
      useWorktree: Boolean(panel.querySelector("#task-use-worktree")?.checked),
    };

    this.setTaskStatus("Creating task...");
    try {
      const task = await this.fetchTaskJson("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const titleInput = panel.querySelector("#task-title");
      const descriptionInput = panel.querySelector("#task-description");
      if (titleInput) titleInput.value = "";
      if (descriptionInput) descriptionInput.value = "";
      await this.refreshTasks({ selectedId: task.id });
    } catch (err) {
      this.setTaskStatus(
        err instanceof Error ? err.message : "Failed to create task",
      );
    }
  }

  async handleTaskAction(action) {
    const task = this.getSelectedTask();
    if (!task) return;
    const endpoint =
      action === "start"
        ? "start"
        : action === "checks"
          ? "run-checks"
          : action === "judge"
            ? "judge"
            : "";
    if (!endpoint) return;

    this.setTaskStatus(
      `${action === "checks" ? "Running checks" : "Starting"}...`,
    );
    try {
      const payload = await this.fetchTaskJson(
        `/api/tasks/${encodeURIComponent(task.id)}/${endpoint}`,
        { method: "POST" },
      );
      if (payload.terminal) {
        await this.reconnectToTerminal(
          payload.terminal.id,
          payload.terminal.cwd,
          null,
          {
            showReconnectBanner: false,
            isReconnection: false,
            backendMode: payload.terminal.backendMode || null,
            supportsLinkedView: Boolean(payload.terminal.supportsLinkedView),
          },
        );
      }
      await this.refreshTasks({ selectedId: task.id });
    } catch (err) {
      this.setTaskStatus(
        err instanceof Error ? err.message : "Task action failed",
      );
    }
  }

  setupLayoutEditor() {
    if (!this.toolsSheet) return;

    this.toolsSheet
      .querySelector("#tools-sheet-edit-layout")
      ?.addEventListener("click", () => this.openLayoutEditor());

    this.toolsSheet
      .querySelector("#layout-editor-mode-desktop")
      ?.addEventListener("click", () => this.setLayoutEditorMode("desktop"));

    this.toolsSheet
      .querySelector("#layout-editor-mode-mobile")
      ?.addEventListener("click", () => this.setLayoutEditorMode("mobile"));

    this.toolsSheet
      .querySelector("#layout-editor-reset")
      ?.addEventListener("click", () => this.resetLayoutEditorDefaults());

    this.toolsSheet
      .querySelector("#layout-editor-done")
      ?.addEventListener("click", () => this.closeToolsSheet());

    this.toolsSheet
      .querySelector("#layout-editor")
      ?.addEventListener("pointerdown", (event) =>
        this.handleLayoutChipPointerDown(event),
      );

    this.renderToolsSheetView();
  }

  setOverflowToggleState(isOpen) {
    document
      .querySelectorAll('[data-action="toggle-tools-sheet"], #toolbar-toggle')
      .forEach((btn) => {
        btn.classList.toggle("active", isOpen);
      });
  }

  openToolsSheet({ preserveLayoutEditor = false } = {}) {
    if (!this.toolsSheet) return;
    if (!preserveLayoutEditor) {
      this.layoutEditorOpen = false;
    }
    this.toolsSheet.classList.remove("hidden");
    this.toolsSheet.setAttribute("aria-hidden", "false");
    this.setOverflowToggleState(true);
    this.renderToolsSheetView();
    this.syncSurfaceButtonState();
  }

  closeToolsSheet() {
    if (!this.toolsSheet) return;
    this.cleanupLayoutDrag({ rerender: false });
    this.layoutEditorOpen = false;
    this.toolsSheet.classList.add("hidden");
    this.toolsSheet.setAttribute("aria-hidden", "true");
    this.setOverflowToggleState(false);
    this.renderToolsSheetView();
    this.syncSurfaceButtonState();
  }

  toggleToolsSheet() {
    if (!this.toolsSheet) return;
    if (this.toolsSheet.classList.contains("hidden")) {
      this.openToolsSheet();
    } else {
      this.closeToolsSheet();
    }
  }

  getLayoutActionLabel(actionId) {
    return (
      this.getActionButtonConfig(actionId)?.label || actionId.replace(/-/g, " ")
    );
  }

  getDefaultLayoutEditorState() {
    const desktopPinned =
      this.navigationSurface.getDesktopPrimaryActionIds?.() || [];
    const mobilePinned =
      this.navigationSurface.getMobilePrimaryActionIds?.() || [];

    return {
      desktopPinned: desktopPinned.filter((actionId) => actionId !== "more"),
      mobilePinned: mobilePinned.filter((actionId) => actionId !== "more"),
    };
  }

  getActionLayoutState() {
    if (!this.actionLayoutState) {
      this.actionLayoutState =
        this.navigationSurface.loadActionLayoutState?.(localStorage) ||
        this.getDefaultLayoutEditorState();
    }
    return this.actionLayoutState;
  }

  setActionLayoutState(nextState, { persist = true } = {}) {
    const next =
      this.navigationSurface.validateActionLayoutState?.(nextState) ||
      nextState ||
      this.getDefaultLayoutEditorState();
    this.actionLayoutState = persist
      ? this.navigationSurface.saveActionLayoutState?.(localStorage, next) ||
        next
      : next;
    this.renderActionSurfaces();
    return this.actionLayoutState;
  }

  resetActionLayoutState() {
    this.actionLayoutState =
      this.navigationSurface.resetActionLayoutState?.(localStorage) ||
      this.getDefaultLayoutEditorState();
    this.renderActionSurfaces();
    return this.actionLayoutState;
  }

  getLayoutEditorMode() {
    return this.layoutEditorMode === "mobile" ? "mobile" : "desktop";
  }

  getLayoutEditorPinnedKey() {
    return this.getLayoutEditorMode() === "mobile"
      ? "mobilePinned"
      : "desktopPinned";
  }

  openLayoutEditor(mode = this.layoutEditorMode) {
    if (!this.toolsSheet) return;
    this.layoutEditorMode = mode === "mobile" ? "mobile" : "desktop";
    this.layoutEditorOpen = true;
    this.openToolsSheet({ preserveLayoutEditor: true });
    this.renderLayoutEditor();
  }

  setLayoutEditorMode(mode) {
    this.layoutEditorMode = mode === "mobile" ? "mobile" : "desktop";
    this.layoutEditorOpen = true;
    if (this.toolsSheet?.classList.contains("hidden")) {
      this.openToolsSheet({ preserveLayoutEditor: true });
    } else {
      this.renderToolsSheetView();
    }
    this.renderLayoutEditor();
  }

  renderLayoutEditorChips(container, actionIds, bucket) {
    if (!container) return;
    container.replaceChildren();
    container.dataset.layoutBucket = bucket;

    actionIds.forEach((actionId) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "tools-sheet-layout-chip";
      chip.dataset.layoutActionId = actionId;
      chip.dataset.layoutBucket = bucket;
      chip.textContent = this.getLayoutActionLabel(actionId);
      chip.title = this.getLayoutActionLabel(actionId);
      container.appendChild(chip);
    });
  }

  renderLayoutEditor() {
    if (!this.toolsSheet) return;
    const root = this.toolsSheet.querySelector("#layout-editor");
    const mode = this.getLayoutEditorMode();
    const state = this.getActionLayoutState();
    const pinnedKey = this.getLayoutEditorPinnedKey();
    const pinned = Array.isArray(state[pinnedKey]) ? state[pinnedKey] : [];
    const available =
      this.navigationSurface.getAvailableActionIds?.(mode, pinned) || [];

    if (root) {
      root.dataset.mode = mode;
      root.setAttribute(
        "aria-hidden",
        this.layoutEditorOpen ? "false" : "true",
      );
      root.classList.toggle("hidden", !this.layoutEditorOpen);
    }

    this.toolsSheet
      .querySelector("#layout-editor-mode-desktop")
      ?.classList.toggle("active", mode === "desktop");
    this.toolsSheet
      .querySelector("#layout-editor-mode-mobile")
      ?.classList.toggle("active", mode === "mobile");

    this.toolsSheet
      .querySelector("#layout-editor-mode-desktop")
      ?.setAttribute("aria-pressed", mode === "desktop" ? "true" : "false");
    this.toolsSheet
      .querySelector("#layout-editor-mode-mobile")
      ?.setAttribute("aria-pressed", mode === "mobile" ? "true" : "false");

    this.renderLayoutEditorChips(
      this.toolsSheet.querySelector("#layout-editor-pinned-actions"),
      pinned,
      "pinned",
    );
    this.renderLayoutEditorChips(
      this.toolsSheet.querySelector("#layout-editor-available-actions"),
      available,
      "available",
    );
    this.renderToolsSheetView();
  }

  renderToolsSheetView() {
    if (!this.toolsSheet) return;
    const editing = this.layoutEditorOpen;
    this.toolsSheet.classList.toggle("tools-sheet-editing", editing);
    this.renderToolsSheetGrid();

    const editButton = this.toolsSheet.querySelector(
      "#tools-sheet-edit-layout",
    );
    if (editButton) {
      editButton.hidden = editing;
      editButton.setAttribute("aria-hidden", editing ? "true" : "false");
    }

    const grid = this.toolsSheet.querySelector(".tools-sheet-grid");
    if (grid) {
      grid.hidden = editing;
      grid.setAttribute("aria-hidden", editing ? "true" : "false");
    }

    const editorRoot = this.toolsSheet.querySelector("#layout-editor");
    if (editorRoot) {
      editorRoot.hidden = !editing;
      editorRoot.setAttribute("aria-hidden", editing ? "false" : "true");
    }
  }

  resetLayoutEditorDefaults() {
    this.resetActionLayoutState();
    this.renderLayoutEditor();
  }

  handleLayoutChipPointerDown(event) {
    if (!this.layoutEditorOpen) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;

    const chip = event.target.closest(".tools-sheet-layout-chip");
    if (!chip) return;

    const actionId = chip.dataset.layoutActionId;
    const sourceBucket = chip.dataset.layoutBucket;
    if (!actionId || !sourceBucket) return;

    event.preventDefault();
    this.cleanupLayoutDrag({ rerender: false });

    const ghost = document.createElement("div");
    ghost.className = "tools-sheet-layout-ghost";
    ghost.textContent = this.getLayoutActionLabel(actionId);
    document.body.appendChild(ghost);

    const placeholder = document.createElement("div");
    placeholder.className = "tools-sheet-layout-placeholder";
    placeholder.setAttribute("aria-hidden", "true");

    chip.classList.add("is-dragging", "drag-source-hidden");
    chip.insertAdjacentElement("afterend", placeholder);

    this.layoutDragState = {
      actionId,
      sourceBucket,
      mode: this.getLayoutEditorMode(),
      sourceChip: chip,
      placeholder,
      ghost,
      dropBucket: sourceBucket,
      dropIndex: null,
    };

    this.updateLayoutDragTarget(event.clientX, event.clientY);
    document.addEventListener("pointermove", this.handleLayoutDragMove);
    document.addEventListener("pointerup", this.handleLayoutDragEnd);
    document.addEventListener("pointercancel", this.handleLayoutDragCancel);
  }

  getLayoutEditorBucket(bucket) {
    const suffix = bucket === "available" ? "available" : "pinned";
    return (
      this.toolsSheet?.querySelector(`#layout-editor-${suffix}-actions`) || null
    );
  }

  updateLayoutDragGhostPosition(clientX, clientY) {
    const ghost = this.layoutDragState?.ghost;
    if (!ghost) return;
    ghost.style.left = `${clientX}px`;
    ghost.style.top = `${clientY}px`;
  }

  getLayoutDropIndex(container, clientX, clientY) {
    const chips = Array.from(
      container.querySelectorAll(".tools-sheet-layout-chip"),
    ).filter((chip) => !chip.classList.contains("drag-source-hidden"));

    if (chips.length === 0) {
      return 0;
    }

    for (let index = 0; index < chips.length; index++) {
      const rect = chips[index].getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      const isAboveRow = clientY < rect.top;
      const isWithinRow = clientY >= rect.top && clientY <= rect.bottom;
      if (isAboveRow) {
        return index;
      }
      if (isWithinRow && clientX < midX) {
        return index;
      }
    }

    return chips.length;
  }

  getLayoutDropContext(clientX, clientY) {
    const buckets = [
      { bucket: "pinned", element: this.getLayoutEditorBucket("pinned") },
      { bucket: "available", element: this.getLayoutEditorBucket("available") },
    ].filter((entry) => entry.element);

    for (const entry of buckets) {
      const rect = entry.element.getBoundingClientRect();
      const inset = 18;
      const withinBounds =
        clientX >= rect.left - inset &&
        clientX <= rect.right + inset &&
        clientY >= rect.top - inset &&
        clientY <= rect.bottom + inset;

      if (!withinBounds) continue;

      return {
        bucket: entry.bucket,
        element: entry.element,
        index:
          entry.bucket === "pinned"
            ? this.getLayoutDropIndex(entry.element, clientX, clientY)
            : entry.element.querySelectorAll(".tools-sheet-layout-chip").length,
      };
    }

    return null;
  }

  moveLayoutPlaceholder(container, index) {
    const placeholder = this.layoutDragState?.placeholder;
    if (!placeholder || !container) return;

    const chips = Array.from(
      container.querySelectorAll(".tools-sheet-layout-chip"),
    ).filter((chip) => !chip.classList.contains("drag-source-hidden"));
    const target = chips[Math.max(0, Math.min(index, chips.length - 1))];

    if (!target) {
      container.appendChild(placeholder);
      return;
    }

    if (index >= chips.length) {
      container.appendChild(placeholder);
    } else {
      container.insertBefore(placeholder, target);
    }
  }

  updateLayoutDragTarget(clientX, clientY) {
    if (!this.layoutDragState) return;

    this.updateLayoutDragGhostPosition(clientX, clientY);

    const pinnedBucket = this.getLayoutEditorBucket("pinned");
    const availableBucket = this.getLayoutEditorBucket("available");
    [pinnedBucket, availableBucket].forEach((bucket) => {
      bucket?.classList.add("is-drop-target");
      bucket?.classList.remove("is-drop-active");
    });

    const dropContext = this.getLayoutDropContext(clientX, clientY);
    if (!dropContext) {
      this.layoutDragState.dropBucket = null;
      this.layoutDragState.dropIndex = null;
      return;
    }

    dropContext.element.classList.add("is-drop-active");
    this.layoutDragState.dropBucket = dropContext.bucket;
    this.layoutDragState.dropIndex = dropContext.index;
    this.moveLayoutPlaceholder(dropContext.element, dropContext.index);
  }

  layoutStatesEqual(left, right) {
    const leftDesktop = Array.isArray(left?.desktopPinned)
      ? left.desktopPinned
      : [];
    const leftMobile = Array.isArray(left?.mobilePinned)
      ? left.mobilePinned
      : [];
    const rightDesktop = Array.isArray(right?.desktopPinned)
      ? right.desktopPinned
      : [];
    const rightMobile = Array.isArray(right?.mobilePinned)
      ? right.mobilePinned
      : [];

    return (
      leftDesktop.join("\n") === rightDesktop.join("\n") &&
      leftMobile.join("\n") === rightMobile.join("\n")
    );
  }

  applyLayoutDragResult() {
    if (!this.layoutDragState) return false;

    const { actionId, sourceBucket, dropBucket, dropIndex, mode } =
      this.layoutDragState;
    const state = this.getActionLayoutState();
    let nextState = state;

    if (sourceBucket === "available" && dropBucket === "pinned") {
      nextState =
        this.navigationSurface.pinLayoutAction?.(
          state,
          mode,
          actionId,
          dropIndex,
        ) || state;
    } else if (sourceBucket === "pinned" && dropBucket === "available") {
      nextState =
        this.navigationSurface.unpinLayoutAction?.(state, mode, actionId) ||
        state;
    } else if (sourceBucket === "pinned" && dropBucket === "pinned") {
      nextState =
        this.navigationSurface.reorderLayoutAction?.(
          state,
          mode,
          actionId,
          dropIndex,
        ) || state;
    }

    if (this.layoutStatesEqual(state, nextState)) {
      return false;
    }

    this.setActionLayoutState(nextState);
    return true;
  }

  cleanupLayoutDrag({ rerender = true } = {}) {
    if (!this.layoutDragState) return;

    document.removeEventListener("pointermove", this.handleLayoutDragMove);
    document.removeEventListener("pointerup", this.handleLayoutDragEnd);
    document.removeEventListener("pointercancel", this.handleLayoutDragCancel);

    const { sourceChip, placeholder, ghost } = this.layoutDragState;
    sourceChip?.classList.remove("is-dragging", "drag-source-hidden");
    placeholder?.remove();
    ghost?.remove();

    [
      this.getLayoutEditorBucket("pinned"),
      this.getLayoutEditorBucket("available"),
    ].forEach((bucket) => {
      bucket?.classList.remove("is-drop-target", "is-drop-active");
    });

    this.layoutDragState = null;

    if (rerender && this.layoutEditorOpen) {
      this.renderLayoutEditor();
    }
  }

  handleLayoutDragMove(event) {
    if (!this.layoutDragState) return;
    event.preventDefault();
    this.updateLayoutDragTarget(event.clientX, event.clientY);
  }

  handleLayoutDragEnd(event) {
    if (!this.layoutDragState) return;
    this.updateLayoutDragTarget(event.clientX, event.clientY);
    this.applyLayoutDragResult();
    this.cleanupLayoutDrag({ rerender: true });
  }

  handleLayoutDragCancel() {
    this.cleanupLayoutDrag({ rerender: true });
  }

  setupCommandPalette() {
    const ActionRegistryCtor = window.ActionRegistry?.ActionRegistry;
    const CommandPaletteCtor =
      window.CommandPaletteController?.CommandPaletteController;
    const root = document.getElementById("command-palette");
    const input = document.getElementById("command-palette-input");
    const results = document.getElementById("command-palette-results");

    if (
      !ActionRegistryCtor ||
      !CommandPaletteCtor ||
      !root ||
      !input ||
      !results
    ) {
      return;
    }

    this.commandPaletteRegistry = new ActionRegistryCtor();
    this.commandPalette = new CommandPaletteCtor({
      root,
      input,
      results,
      registry: this.commandPaletteRegistry,
    });

    root.addEventListener("click", (event) => {
      if (event.target === root) {
        this.closeCommandPalette();
      }
    });

    this.registerCommandPaletteActions();
  }

  loadRecentWorkspaceEntries() {
    const loadRecentWorkspaceEntries =
      this.navigationSurface.loadRecentWorkspaceEntries;
    if (typeof loadRecentWorkspaceEntries !== "function") {
      return [];
    }

    return loadRecentWorkspaceEntries(window.localStorage);
  }

  saveRecentWorkspaceEntries(entries) {
    const saveRecentWorkspaceEntries =
      this.navigationSurface.saveRecentWorkspaceEntries;
    if (typeof saveRecentWorkspaceEntries !== "function") {
      return Array.isArray(entries) ? [...entries] : [];
    }

    return saveRecentWorkspaceEntries(window.localStorage, entries);
  }

  rememberRecentWorkspace({ cwd, label } = {}) {
    const upsertRecentWorkspaceEntry =
      this.navigationSurface.upsertRecentWorkspaceEntry;
    if (typeof upsertRecentWorkspaceEntry !== "function") {
      return [];
    }

    const normalizedCwd = this.normalizeWorkspaceCwd(cwd);
    if (!normalizedCwd) {
      return this.loadRecentWorkspaceEntries();
    }

    const nextEntries = upsertRecentWorkspaceEntry(
      this.loadRecentWorkspaceEntries(),
      {
        cwd: normalizedCwd,
        label: String(label || "").trim() || this.formatCwdLabel(normalizedCwd),
        lastUsedAt: Date.now(),
      },
    );

    return this.saveRecentWorkspaceEntries(nextEntries);
  }

  rememberWorkspaceById(workspaceId, preferredCwd = null) {
    if (!workspaceId) return [];
    const snapshot = this.getWorkspaceSnapshot(workspaceId, preferredCwd);
    return this.rememberRecentWorkspace({
      cwd: preferredCwd || snapshot.cwd,
      label: snapshot.label,
    });
  }

  findWorkspaceIdByCwd(cwd) {
    const targetCwd = this.normalizeWorkspaceCwd(cwd);
    if (!targetCwd) return null;

    for (const tab of this.tabs.querySelectorAll(".tab")) {
      const workspaceId = tab.dataset.workspaceId;
      if (!workspaceId) continue;

      const snapshot = this.getWorkspaceSnapshot(workspaceId);
      if (this.normalizeWorkspaceCwd(snapshot.cwd) === targetCwd) {
        return workspaceId;
      }
    }

    return null;
  }

  async switchOrCreateWorkspaceForCwd(cwd) {
    const targetCwd = this.normalizeWorkspaceCwd(cwd);
    if (!targetCwd) return false;

    this.setDirectoryValue(targetCwd, { force: true });

    const existingWorkspaceId = this.findWorkspaceIdByCwd(targetCwd);
    const existingTerminalId = existingWorkspaceId
      ? this.resolveWorkspaceTerminalId(existingWorkspaceId)
      : null;

    if (existingTerminalId) {
      this.switchTo(existingTerminalId);
      return true;
    }

    await this.createTerminal(false);
    return true;
  }

  getCommandPaletteQuery() {
    return String(this.commandPalette?.input?.value || "").trim();
  }

  isPaletteDirectoryQuery(query) {
    const value = String(query || "").trim();
    return value.startsWith("/") || value.startsWith("~/");
  }

  // Quick-open activates on a "bare" query: some non-empty text that isn't
  // one of the other prefix modes (directory jump "/" "~/", session switch
  // "@", saved command "$") — mirrors how those providers gate on their own
  // prefix/emptiness rather than overlapping with each other.
  isPaletteBareQuery(query) {
    const value = String(query || "").trim();
    if (!value) return false;
    if (this.isPaletteDirectoryQuery(value)) return false;
    if (value.startsWith("@") || value.startsWith("$")) return false;
    return true;
  }

  async resolvePaletteDirectory(path) {
    const targetPath = String(path || "").trim();
    if (!targetPath) return null;

    try {
      const res = await fetch(
        `/api/browse?path=${encodeURIComponent(targetPath)}&files=true`,
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload.error) {
        throw new Error(payload.error || "Cannot open directory");
      }

      return this.normalizeWorkspaceCwd(payload.path || targetPath);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Cannot open directory";
      alert(message);
      return null;
    }
  }

  async goToDirectoryFromPalette(path) {
    const resolvedPath = await this.resolvePaletteDirectory(path);
    if (!resolvedPath) return false;
    return this.switchOrCreateWorkspaceForCwd(resolvedPath);
  }

  async revealCurrentCwdInFilesFromPalette(cwd) {
    const targetCwd = this.normalizeWorkspaceCwd(cwd);
    if (!targetCwd) return false;

    const { workspaceId } = this.getActiveWorkspaceContext();
    if (!workspaceId || !this.fileExplorer) return false;

    this.setDirectoryValue(targetCwd, { force: true });

    if (
      window.gitManager &&
      !window.gitManager.panel?.classList.contains("hidden")
    ) {
      window.gitManager.hide();
    }

    const targetPath = this.fileExplorer.openForWorkspace(
      workspaceId,
      targetCwd,
    );
    this.rightSurface = "files";

    if (targetPath) {
      await this.fileExplorer.loadDir(targetPath, workspaceId);
    }

    this.syncSurfaceButtonState();
    return true;
  }

  async focusGitBranchCheckoutFromPalette(cwd) {
    const targetCwd = this.normalizeWorkspaceCwd(cwd);
    if (!targetCwd) return false;

    const gitContext = await this.ensureCommandPaletteGitContext(targetCwd);

    requestAnimationFrame(async () => {
      if (!this.commandPalette) return;
      this.closeToolsSheet();
      this.commandPalette.open({
        ...this.getCommandPaletteContext(),
        cwd: targetCwd,
        gitBranches: gitContext.gitBranches || [],
        currentGitBranch: gitContext.currentGitBranch || "",
        isGitRepo: Boolean(gitContext.isGitRepo),
      });
      this.commandPalette?.setQuery("branch");
      this.syncSurfaceButtonState();
    });

    return true;
  }

  registerCommandPaletteActions() {
    if (!this.commandPaletteRegistry) return;
    const NavigationSurface = window.NavigationSurface || {};
    const createNewFolderAction =
      NavigationSurface.createNewFolderAction || (() => null);
    const createOpenGitBranchesAction =
      NavigationSurface.createOpenGitBranchesAction || (() => null);
    const buildGitBranchActions =
      NavigationSurface.buildGitBranchActions || (() => []);

    const actions = [
      {
        id: "new-terminal",
        title: "New Terminal",
        group: "Actions",
        keywords: ["workspace", "shell", "tab"],
        priority: 50,
        run: () => this.createTerminal(),
      },
      {
        id: "split-workspace",
        title: "Split Workspace",
        group: "Actions",
        keywords: ["split", "pane", "terminal"],
        priority: 45,
        run: () => this.splitWorkspace(),
      },
      {
        id: "detach-terminal-pane",
        title: "Move Pane to New Tab",
        group: "Actions",
        keywords: ["detach", "unmerge", "ungroup", "pane", "tab"],
        priority: 45,
        run: () => this.detachTerminalToWorkspace(),
      },
      {
        id: "new-task-workspace",
        title: "New Task Workspace",
        group: "Actions",
        keywords: ["agent", "worker", "judge", "task"],
        priority: 44,
        run: () => this.openTaskPanel({ focusTitle: true }),
      },
      {
        id: "open-tasks",
        title: "Open Tasks",
        group: "Actions",
        keywords: ["agent", "runner", "worker", "judge"],
        priority: 43,
        run: () => this.openTaskPanel(),
      },
      {
        id: "open-git",
        title: "Open Git",
        group: "Actions",
        keywords: ["repo", "branch", "diff"],
        priority: 40,
        run: () => this.openGitPanel(),
      },
      {
        id: "open-file-manager",
        title: "Open File Manager",
        group: "Actions",
        keywords: ["files", "explorer", "browse"],
        priority: 40,
        run: () => this.openFileExplorer(),
      },
      {
        id: "open-clipboard",
        title: "Open Clipboard",
        group: "Actions",
        keywords: ["paste", "copy", "history"],
        priority: 30,
        run: () => this.clipboardManager.togglePanel(),
      },
      {
        id: "open-settings",
        title: "Open Settings",
        group: "Actions",
        keywords: ["settings", "preferences", "config", "options"],
        priority: 35,
        run: () => this.openSettings(),
      },
      {
        id: "search-terminal",
        title: "Search in Terminal",
        group: "Views",
        keywords: ["find", "search", "terminal"],
        run: () => this.openTerminalSearch(),
      },
      {
        id: "toggle-line-wrap",
        title: "Toggle Line Wrap",
        group: "Views",
        keywords: ["wrap", "lines", "overflow"],
        run: () => this.toggleWrapLines(),
      },
      {
        id: "toggle-sessions-dock",
        title: "Dock Sessions to Bottom",
        group: "Views",
        keywords: ["dock", "panel", "bottom", "sessions", "terminal"],
        run: () => this.toggleSessionsDock(),
      },
      {
        id: "toggle-fullscreen",
        title: "Toggle Fullscreen",
        group: "Views",
        keywords: ["fullscreen", "focus", "zen"],
        run: () => this.toggleFullscreen(),
      },
      {
        id: "font-increase",
        title: "Increase Font Size",
        group: "Views",
        keywords: ["zoom", "font", "larger"],
        run: () => this.changeFontSize(1),
      },
      {
        id: "font-decrease",
        title: "Decrease Font Size",
        group: "Views",
        keywords: ["zoom", "font", "smaller"],
        run: () => this.changeFontSize(-1),
      },
      {
        id: "open-help",
        title: "Open Help",
        group: "Views",
        keywords: ["shortcuts", "docs", "help"],
        run: () => this.openHelp(),
      },
      {
        id: "toggle-ide-mode",
        title: "Toggle IDE Mode",
        group: "Views",
        keywords: ["ide", "editor", "mode", "workspace"],
        run: () => this.toggleIdeMode(),
      },
    ];

    actions.forEach((action) => this.commandPaletteRegistry.register(action));

    this.commandPaletteRegistry.registerProvider(() => {
      const query = this.getCommandPaletteQuery();
      if (!this.isPaletteDirectoryQuery(query)) {
        return [];
      }

      return [
        {
          id: `go-to-directory:${query}`,
          title: "Go to Directory...",
          group: "Actions",
          keywords: [query, "directory", "cwd", "jump", "open path"],
          meta: [query],
          priority: 48,
          run: () => this.goToDirectoryFromPalette(query),
        },
      ];
    });

    // Quick-open (Ctrl+P default experience) — bare queries fuzzy-match file
    // paths from the per-cwd cached tree (prefetched in
    // buildCommandPaletteContext / ensureCommandPaletteTreeContext). The
    // query is carried as a keyword (same trick as go-to-directory/"@"/"$")
    // so results survive the registry's own title/keyword scoring; ordering
    // comes from this provider via descending priority.
    this.commandPaletteRegistry.registerProvider((context = {}) => {
      const query = this.getCommandPaletteQuery();
      if (!this.isPaletteBareQuery(query)) return [];

      const files = Array.isArray(context.quickOpenFiles)
        ? context.quickOpenFiles
        : [];
      const matches = window.PaletteProviders.filterQuickOpenFiles(
        query,
        files,
        50,
      );

      return matches.map((file, index) => ({
        id: `quick-open:${file.path}`,
        title: file.relativePath || file.path,
        group: "Files",
        keywords: [query],
        meta: [file.path],
        priority: 50 - index,
        run: () => this.handleExplorerOpenFile(file.path, { pinned: true }),
      }));
    });

    this.commandPaletteRegistry.registerProvider((context = {}) => {
      const contextualActions = [];
      const newFolderAction = createNewFolderAction(context, {
        createFolder: (cwd) => this.createFolderFromPalette(cwd),
      });

      if (newFolderAction) {
        contextualActions.push(newFolderAction);
      }

      if (context.canCreateLinkedView) {
        contextualActions.push({
          id: "open-linked-view",
          title: "Open Linked View",
          group: "Contextual",
          keywords: ["tmux", "linked", "shared"],
          run: () => this.createLinkedView(),
        });
      }

      if (context.hasExtraKeys) {
        contextualActions.push({
          id: "toggle-extra-keys",
          title: "Toggle Extra Keys",
          group: "Contextual",
          keywords: ["keyboard", "modifiers", "mobile"],
          meta: context.extraKeysVisible ? ["Visible"] : ["Hidden"],
          run: () => this.extraKeys?.toggle(),
        });
      }

      if (context.cwd) {
        contextualActions.push({
          id: `reveal-cwd:${context.cwd}`,
          title: "Reveal Current CWD in Files",
          group: "Contextual",
          keywords: ["files", "explorer", "cwd", "reveal", context.cwd],
          meta: [context.cwd],
          priority: 38,
          run: () => this.revealCurrentCwdInFilesFromPalette(context.cwd),
        });
      }

      if (context.isGitRepo && context.cwd) {
        contextualActions.push({
          id: `checkout-git-branch:${context.cwd}`,
          title: "Checkout Git Branch",
          group: "Contextual",
          keywords: ["checkout", "branch", "git", context.cwd],
          meta: context.currentGitBranch
            ? [`Current: ${context.currentGitBranch}`]
            : null,
          priority: 37,
          run: () => this.focusGitBranchCheckoutFromPalette(context.cwd),
        });
      }

      const openGitBranchesAction = createOpenGitBranchesAction(context, {
        openGitBranches: (cwd) => this.openGitBranchesFromPalette(cwd),
      });
      if (openGitBranchesAction) {
        contextualActions.push(openGitBranchesAction);
      }

      contextualActions.push(
        ...buildGitBranchActions(context, {
          switchBranch: (cwd, branch) =>
            this.switchGitBranchFromPalette(cwd, branch),
        }),
      );

      if (context.paneCount > 1) {
        contextualActions.push(
          {
            id: "focus-next-pane",
            title: "Focus Next Pane",
            group: "Contextual",
            keywords: ["pane", "terminal", "next", "down"],
            run: () => this.switchToAdjacentPane(1),
          },
          {
            id: "focus-previous-pane",
            title: "Focus Previous Pane",
            group: "Contextual",
            keywords: ["pane", "terminal", "previous", "up"],
            run: () => this.switchToAdjacentPane(-1),
          },
        );
      }

      // IDE-gated editor-tab commands: only meaningful with the IDE editor
      // area live and at least one open tab.
      if (context.isIdeMode && context.hasEditorTabs) {
        contextualActions.push({
          id: "close-editor-tab",
          title: "Close Editor Tab",
          group: "Contextual",
          keywords: ["editor", "tab", "close"],
          run: () => this.closeActiveEditorTabFromPalette(),
        });
        contextualActions.push({
          id: "next-editor-tab",
          title: "Next Editor Tab",
          group: "Contextual",
          keywords: ["editor", "tab", "next"],
          run: () => this.stepActiveEditorTab(1),
        });
        contextualActions.push({
          id: "previous-editor-tab",
          title: "Previous Editor Tab",
          group: "Contextual",
          keywords: ["editor", "tab", "previous", "prev"],
          run: () => this.stepActiveEditorTab(-1),
        });
      }

      if (this.canOpenTaskBoardTab()) {
        contextualActions.push({
          id: "open-task-board-tab",
          title: "Open Task Board",
          group: "Contextual",
          keywords: ["tasks", "board", "kanban", "agent"],
          run: () => this.openTaskBoardTab(),
        });
      }

      return contextualActions;
    });

    this.commandPaletteRegistry.registerProvider(() => {
      return this.loadRecentWorkspaceEntries()
        .map((entry) => {
          const cwd = this.normalizeWorkspaceCwd(entry.cwd);
          if (!cwd) return null;

          const existingWorkspaceId = this.findWorkspaceIdByCwd(cwd);
          const activeWorkspaceId = this.terminals.get(
            this.activeId,
          )?.workspaceId;
          const metadata = [entry.label];

          if (entry.label !== cwd) {
            metadata.push(cwd);
          }
          if (existingWorkspaceId === activeWorkspaceId) {
            metadata.push("Active");
          } else if (existingWorkspaceId) {
            metadata.push("Open");
          }

          return {
            id: `recent-workspace:${cwd}`,
            title: "Recent Workspace",
            group: "Workspaces",
            keywords: [
              entry.label,
              cwd,
              `recent ${entry.label}`,
              "recent workspace",
            ],
            meta: metadata,
            priority: 42,
            run: () => this.switchOrCreateWorkspaceForCwd(cwd),
          };
        })
        .filter(Boolean);
    });

    this.commandPaletteRegistry.registerProvider(() => {
      return Array.from(this.tabs.querySelectorAll(".tab"))
        .map((tab) => {
          const workspaceId = tab.dataset.workspaceId;
          if (!workspaceId) return null;

          const snapshot = this.getWorkspaceSnapshot(workspaceId);
          const targetId = this.resolveWorkspaceTerminalId(workspaceId);
          if (!targetId) return null;

          const rawTabText = tab.textContent?.trim() || "";
          const condensedTabText = rawTabText.replace(/\s+/g, "");
          const index = tab.dataset.index || "";
          const label = snapshot.label || "Workspace";
          const metadata = [];

          if (workspaceId === this.terminals.get(this.activeId)?.workspaceId) {
            metadata.push("Active");
          }
          if (snapshot.cwd) {
            metadata.push(snapshot.cwd);
          }
          if (snapshot.count > 1) {
            metadata.push(`${snapshot.count} terminals`);
          }
          snapshot.descriptors.forEach((descriptor) => {
            metadata.push(descriptor.label);
          });

          return {
            id: `workspace:${workspaceId}`,
            title: label,
            group: "Workspaces",
            keywords: [
              workspaceId,
              index,
              label,
              `${index} ${label}`,
              `${index}${label}`,
              rawTabText,
              condensedTabText,
              snapshot.cwd,
              this.formatCwdLabel(snapshot.cwd),
            ],
            meta: metadata,
            run: () => this.switchTo(targetId),
          };
        })
        .filter(Boolean);
    });

    // "@" mode — fuzzy session switch over the server catalog. Each action
    // carries the raw query as a keyword so it survives registry scoring
    // (same trick as the go-to-directory provider); ordering comes from the
    // provider via descending priority.
    this.commandPaletteRegistry.registerProvider(() => {
      const query = this.getCommandPaletteQuery();
      const text = window.PaletteProviders.parsePrefixQuery(query, "@");
      if (text === null) return [];

      const entries = window.PaletteProviders.filterSessions({
        sessions: this._sessionCatalog || [],
        text,
        isLocallyOpen: (id) => this.terminals.has(id),
        planAction: (session, options) =>
          window.SessionActions.planSessionRowAction(session, options),
      });

      return entries.map((entry, index) => ({
        id: `palette-session:${entry.session.id}`,
        title: this.formatCwdLabel(entry.session.cwd) || entry.session.id,
        group: "Sessions",
        keywords: [query],
        meta: [
          entry.plan.label,
          entry.plan.statusClass === "active" ? "● live" : "○ ended",
          entry.session.id,
        ],
        priority: 100 - index,
        run: () => void this.handleSessionRowActivate(entry.session.id),
      }));
    });

    // "$" mode — saved commands (localStorage), run in the active terminal.
    this.savedCommandsStore = window.PaletteProviders.createSavedCommandsStore(
      window.localStorage,
    );
    this.commandPaletteRegistry.registerProvider(() => {
      const query = this.getCommandPaletteQuery();
      const text = window.PaletteProviders.parsePrefixQuery(query, "$");
      if (text === null) return [];

      const commands = window.PaletteProviders.filterSavedCommands(
        this.savedCommandsStore.list(),
        text,
      );

      const actions = commands.map((entry, index) => ({
        id: `palette-command:${entry.name}`,
        title: entry.name,
        group: "Commands",
        keywords: [query],
        meta: [entry.command],
        priority: 100 - index,
        run: () => this.runSavedCommand(entry.command),
      }));

      actions.push({
        id: "palette-command-save",
        title: "Save command…",
        group: "Commands",
        keywords: [query],
        meta: ["new $ shortcut"],
        priority: 1,
        run: () => this.promptSaveCommand(text),
      });
      if (commands.length > 0) {
        actions.push({
          id: "palette-command-remove",
          title: "Remove command…",
          group: "Commands",
          keywords: [query],
          meta: ["delete a $ shortcut"],
          priority: 0,
          run: () => this.promptRemoveCommand(),
        });
      }
      return actions;
    });
  }

  runSavedCommand(command) {
    const active = this.getActiveTerminal();
    if (!active?.ws) return;
    active.ws.send(JSON.stringify({ type: "input", data: `${command}\r` }));
    active.terminal?.focus();
  }

  promptSaveCommand(prefillName = "") {
    const name = window.prompt("Command name (palette: $name)", prefillName);
    if (!name?.trim()) return;
    const existing = this.savedCommandsStore
      .list()
      .find((entry) => entry.name === name.trim());
    const command = window.prompt(
      `Shell command for "${name.trim()}"`,
      existing?.command || "",
    );
    if (!command?.trim()) return;
    this.savedCommandsStore.save(name, command);
  }

  promptRemoveCommand() {
    const names = this.savedCommandsStore
      .list()
      .map((entry) => entry.name)
      .join(", ");
    const name = window.prompt(`Remove which command? (${names})`);
    if (!name?.trim()) return;
    this.savedCommandsStore.remove(name.trim());
  }

  getCommandPaletteContext() {
    const activeTerminal = this.getActiveTerminal();
    const cwd = activeTerminal?.cwd || this.getCurrentDirectoryValue() || "";
    const gitContext = this.commandPaletteGitCache.get(cwd) || {
      isGitRepo: false,
      gitBranches: [],
      currentGitBranch: "",
    };
    const treeContext = this.commandPaletteTreeCache.get(cwd) || {
      files: [],
      truncated: false,
    };
    const isIdeMode = this.isIdeModeActive();

    return {
      activeId: this.activeId,
      cwd,
      canCreateLinkedView: this.canCreateLinkedView(activeTerminal),
      hasExtraKeys: Boolean(this.extraKeys),
      extraKeysVisible: Boolean(this.extraKeys?.visible),
      gitBranches: gitContext.gitBranches || [],
      currentGitBranch: gitContext.currentGitBranch || "",
      isGitRepo: Boolean(gitContext.isGitRepo),
      wrapLines: this.wrapLines,
      quickOpenFiles: treeContext.files || [],
      quickOpenTruncated: Boolean(treeContext.truncated),
      isIdeMode,
      hasEditorTabs: Boolean(isIdeMode && this.editorTabs?.model?.hasTabs()),
      paneCount: this.getActiveWorkspacePaneIds().length,
    };
  }

  isCommandPaletteOpen() {
    return Boolean(
      this.commandPalette &&
      !document.getElementById("command-palette")?.classList.contains("hidden"),
    );
  }

  refreshCommandPalette() {
    if (!this.commandPalette || !this.isCommandPaletteOpen()) return;
    this.commandPalette.context = this.getCommandPaletteContext();
    this.commandPalette.refreshResults();
  }

  async ensureCommandPaletteGitContext(cwd) {
    const nextCwd = String(cwd || "").trim();
    if (!nextCwd || this.commandPaletteGitCache.has(nextCwd)) {
      return (
        this.commandPaletteGitCache.get(nextCwd) || {
          isGitRepo: false,
          gitBranches: [],
          currentGitBranch: "",
        }
      );
    }

    try {
      const res = await fetch(
        `/api/git/branches?cwd=${encodeURIComponent(nextCwd)}`,
      );
      const data = await res.json().catch(() => ({}));
      const payload =
        res.ok && !data.error
          ? {
              isGitRepo: true,
              gitBranches: Array.isArray(data.branches) ? data.branches : [],
              currentGitBranch: String(data.current || ""),
            }
          : {
              isGitRepo: false,
              gitBranches: [],
              currentGitBranch: "",
            };

      this.commandPaletteGitCache.set(nextCwd, payload);
      return payload;
    } catch {
      const payload = {
        isGitRepo: false,
        gitBranches: [],
        currentGitBranch: "",
      };
      this.commandPaletteGitCache.set(nextCwd, payload);
      return payload;
    }
  }

  // Quick-open file tree: fetch on palette open, cache per-cwd with a 30s TTL
  // (the palette provider below is SYNC, same constraint as the git cache —
  // see ensureCommandPaletteGitContext). Keying by cwd means a workspace
  // switch is a natural cache miss (no separate invalidation hook needed);
  // the TTL re-fetches a still-cached cwd's tree if it has gone stale.
  async ensureCommandPaletteTreeContext(cwd) {
    const nextCwd = String(cwd || "").trim();
    const empty = { files: [], truncated: false, fetchedAt: 0 };
    if (!nextCwd) return empty;

    const cached = this.commandPaletteTreeCache.get(nextCwd);
    if (cached && Date.now() - cached.fetchedAt < COMMAND_PALETTE_TREE_TTL_MS) {
      return cached;
    }

    try {
      const res = await fetch(
        `/api/files/tree?cwd=${encodeURIComponent(nextCwd)}`,
      );
      const data = await res.json().catch(() => ({}));
      const payload = {
        files:
          res.ok && !data.error && Array.isArray(data.files) ? data.files : [],
        truncated: Boolean(data.truncated),
        fetchedAt: Date.now(),
      };
      this.commandPaletteTreeCache.set(nextCwd, payload);
      return payload;
    } catch {
      const payload = { files: [], truncated: false, fetchedAt: Date.now() };
      this.commandPaletteTreeCache.set(nextCwd, payload);
      return payload;
    }
  }

  async buildCommandPaletteContext() {
    const cwd =
      this.getActiveTerminal()?.cwd || this.getCurrentDirectoryValue() || "";
    await Promise.all([
      this.ensureCommandPaletteGitContext(cwd),
      this.ensureCommandPaletteTreeContext(cwd),
    ]);
    return this.getCommandPaletteContext();
  }

  async openCommandPalette() {
    if (!this.commandPalette) return;
    this.closeToolsSheet();
    // Fire-and-forget catalog refresh so the "@" sessions mode has fresh
    // entries by the time the user types; results re-render per keystroke.
    void this.refreshSessionsPanel();
    this.commandPalette.open(await this.buildCommandPaletteContext());
    this.syncSurfaceButtonState();
  }

  closeCommandPalette() {
    this.commandPalette?.close();
    this.syncSurfaceButtonState();
  }

  async toggleCommandPalette() {
    if (!this.commandPalette) return;
    if (this.isCommandPaletteOpen()) {
      this.closeCommandPalette();
      return;
    }
    await this.openCommandPalette();
  }

  async createFolderFromPalette(cwd) {
    const nextCwd = String(cwd || "").trim();
    if (!nextCwd) return;

    if (this.fileExplorer?.createFolder) {
      const { workspaceId } = this.getActiveWorkspaceContext();
      await this.fileExplorer.createFolder(nextCwd, null, workspaceId);
    }
  }

  async openGitBranchesFromPalette(cwd) {
    await this.openGitPanel();
    if (window.gitManager?.panel?.classList.contains("hidden")) return;
    const branchesEl = window.gitManager.panel.querySelector("#git-branches");
    if (branchesEl?.classList.contains("hidden")) {
      window.gitManager.toggleBranches();
    } else {
      await window.gitManager.loadBranches();
    }
  }

  async switchGitBranchFromPalette(cwd, branch) {
    const nextCwd = String(cwd || "").trim();
    const nextBranch = String(branch || "").trim();
    if (!nextCwd || !nextBranch) return;

    try {
      const res = await fetch("/api/git/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: nextCwd, branch: nextBranch }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload.error) {
        alert(formatGitCheckoutError(payload));
        return;
      }

      const cached = this.commandPaletteGitCache.get(nextCwd);
      this.commandPaletteGitCache.set(nextCwd, {
        isGitRepo: true,
        gitBranches: cached?.gitBranches || [],
        currentGitBranch: nextBranch,
      });

      if (
        window.gitManager &&
        !window.gitManager.panel?.classList.contains("hidden") &&
        (window.gitManager.state.cwd || window.gitManager.currentCwd) ===
          nextCwd
      ) {
        await window.gitManager.refresh();
      }
    } catch (err) {
      alert("Failed to switch branch");
      console.error("Switch branch error:", err);
    }
  }

  getTerminalTextarea(terminalState) {
    return terminalState?.element?.querySelector(".xterm-helper-textarea");
  }

  getTerminalViewport(terminalState) {
    return terminalState?.element?.querySelector(".xterm-viewport");
  }

  scheduleTerminalMetricStabilization(id) {
    const rerender = () => {
      const t = this.terminals.get(id);
      if (!t?.fitAddon || !t?.terminal) return;

      try {
        this.fitTerminalState(t);
        t.terminal.refresh(0, Math.max(0, t.terminal.rows - 1));
        this.syncTerminalSize(id);
      } catch (err) {
        console.warn(`[terminal] metric stabilization failed for ${id}:`, err);
      }
    };

    requestAnimationFrame(rerender);
    setTimeout(() => requestAnimationFrame(rerender), 150);

    if (document.fonts?.ready) {
      document.fonts.ready
        .then(() => requestAnimationFrame(rerender))
        .catch(() => {});
    }
  }

  focusTerminal(
    id,
    { syncSize = false, scrollToPrompt = false, ensureVisible = true } = {},
  ) {
    const terminalState = this.terminals.get(id);
    if (!terminalState?.terminal) return;

    if (ensureVisible) {
      this.tileManager.ensureTileVisible(id);
    }

    terminalState.terminal.focus();

    const syncPromptVisibility = () => {
      const textarea = this.getTerminalTextarea(terminalState);
      textarea?.focus?.({ preventScroll: true });

      if (scrollToPrompt) {
        terminalState.terminal.scrollToBottom();
        const viewport = this.getTerminalViewport(terminalState);
        if (viewport) {
          viewport.scrollTop = viewport.scrollHeight;
        }
      }
    };

    syncPromptVisibility();
    requestAnimationFrame(() => {
      syncPromptVisibility();
    });

    if (scrollToPrompt) {
      setTimeout(syncPromptVisibility, 32);
    }

    if (syncSize) {
      this.fitTerminalState(terminalState);
      this.syncTerminalSize(id);
    }
  }

  bindTerminalActivation(id, element) {
    if (!element) return null;
    const activate = () => this.activateTerminal(id);
    element.addEventListener("pointerdown", activate);
    element.addEventListener("focusin", activate);
    return () => {
      element.removeEventListener("pointerdown", activate);
      element.removeEventListener("focusin", activate);
    };
  }

  formatCwdLabel(cwd) {
    if (!cwd) return "Terminal";
    const cleaned = cwd.replace(/\/+$/, "");
    if (!cleaned) return "/";
    const parts = cleaned.split("/");
    const last = parts[parts.length - 1];
    return last || "/";
  }

  normalizeConnectionStatus(status) {
    const normalized = String(status || "").trim().toLowerCase();
    if (normalized === "connected") return "connected";
    if (normalized === "connecting" || normalized === "reconnecting") {
      return normalized;
    }
    if (
      [
        "disconnected",
        "failed",
        "dead",
        "exited",
        "taken_over",
        "setup_required",
      ].includes(normalized)
    ) {
      return "disconnected";
    }
    return "disconnected";
  }

  getTerminalConnectionStatus(terminal) {
    if (!terminal) return "disconnected";
    if (
      terminal.awaitingReconnectReady ||
      terminal.ws?.awaitingReconnectReady
    ) {
      return "reconnecting";
    }

    if (terminal.connectionStatus) {
      return this.normalizeConnectionStatus(terminal.connectionStatus);
    }

    // readyState is an initialization fallback only. Once DeckTerm has an
    // application-level status, reconnect replay readiness owns the truth.
    if (terminal.ws?.readyState === WebSocket.OPEN) return "connected";
    if (terminal.ws?.readyState === WebSocket.CONNECTING) return "connecting";
    return "disconnected";
  }

  getConnectionStatusLabel(status) {
    const normalized = this.normalizeConnectionStatus(status);
    if (normalized === "connected") return "Connected";
    if (normalized === "connecting") return "Connecting";
    if (normalized === "reconnecting") return "Reconnecting";
    return "Disconnected";
  }

  getPaneActivityState(terminal) {
    const agentState = String(terminal?.agentState || "")
      .trim()
      .toLowerCase();
    const rawAgentName = String(terminal?.agentName || "").trim();
    const agentName = rawAgentName
      ? rawAgentName.charAt(0).toUpperCase() + rawAgentName.slice(1)
      : "Agent";

    if (agentState === "responding") {
      return {
        key: "responding",
        label: "Responding",
        accessibleLabel: `${agentName} responding`,
      };
    }
    if (agentState === "thinking") {
      return {
        key: "thinking",
        label: "Thinking",
        accessibleLabel: `${agentName} thinking`,
      };
    }
    if (terminal?.running || terminal?.busy) {
      return {
        key: "running",
        label: "Running",
        accessibleLabel: "Command running",
      };
    }
    return { key: "idle", label: "Idle", accessibleLabel: "Idle" };
  }

  getActiveTerminal() {
    if (!this.activeId) return null;
    return this.terminals.get(this.activeId) || null;
  }

  canCreateLinkedView(terminal = this.getActiveTerminal()) {
    return Boolean(
      terminal &&
      terminal.backendMode === "tmux" &&
      terminal.supportsLinkedView,
    );
  }

  updateLinkedViewButton() {
    const isAvailable = this.canCreateLinkedView();
    document
      .querySelectorAll('#linked-view-btn, [data-action="linked-view"]')
      .forEach((button) => {
        button.hidden = !isAvailable;
        button.disabled = !isAvailable;
        button.setAttribute("aria-hidden", isAvailable ? "false" : "true");
      });
    this.refreshCommandPalette();
    this.scheduleDesktopToolbarDensitySync();
  }

  updateWorkspaceLabel(workspaceId, cwd) {
    if (!workspaceId) return;
    this.tabs.querySelectorAll(".tab").forEach((tab) => {
      if (tab.dataset.workspaceId === workspaceId) {
        this.renderWorkspaceTab(tab, cwd);
      }
    });
    this.scheduleDesktopToolbarDensitySync();
  }

  startTelemetryRefreshLoop() {
    this.queueTelemetryRefresh(0);
    if (this.telemetryRefreshInterval) {
      clearInterval(this.telemetryRefreshInterval);
    }
    this.telemetryRefreshInterval = setInterval(
      () => this.queueTelemetryRefresh(0),
      5000,
    );
  }

  queueTelemetryRefresh(delay = 150) {
    if (this.telemetryRefreshTimer) clearTimeout(this.telemetryRefreshTimer);
    this.telemetryRefreshTimer = setTimeout(() => {
      this.telemetryRefreshTimer = null;
      void this.refreshTerminalTelemetry();
    }, delay);
  }

  async refreshTerminalTelemetry() {
    if (this.telemetryRefreshPromise) return this.telemetryRefreshPromise;
    this.telemetryRefreshPromise = (async () => {
      try {
        const response = await fetch("/api/terminals");
        if (!response.ok) return;
        const serverTerminals = await response.json();
        this._sessionCatalog = Array.isArray(serverTerminals)
          ? serverTerminals
          : [];
        this.updateSessionsAvailableBadge(this._sessionCatalog);
        const telemetryById = new Map(
          serverTerminals
            .filter((terminal) => terminal?.id)
            .map((terminal) => [terminal.id, terminal]),
        );

        this.terminals.forEach((terminal, id) => {
          const next = telemetryById.get(id);
          if (!next) return;
          this.applyTerminalRuntimeState(id, {
            running: Boolean(next.running ?? next.busy),
            lastExitCode:
              typeof next.lastExitCode === "number" ? next.lastExitCode : null,
            agentName: next.agentName || null,
            agentState: next.agentState || null,
          });
          terminal.ports = normalizeWorkspacePorts(next.ports);
          terminal.isWorktree = Boolean(next.isWorktree);
          terminal.backendMode = next.backendMode || null;
          terminal.supportsLinkedView = Boolean(next.supportsLinkedView);
          terminal.recentTools = Array.isArray(next.recentTools)
            ? next.recentTools
            : [];
          const hasClientCwd =
            typeof terminal.cwd === "string" && terminal.cwd.trim().length > 0;
          if (!hasClientCwd && typeof next.cwd === "string" && next.cwd) {
            terminal.cwd = next.cwd;
            this.sessionRegistry.update(id, { cwd: next.cwd });
          }
        });

        this.updateTabGroups();
        this.updateLinkedViewButton();
      } catch (err) {
        dbg("telemetry refresh failed", err);
      } finally {
        this.telemetryRefreshPromise = null;
      }
    })();
    return this.telemetryRefreshPromise;
  }

  getWorkspaceTerminals(workspaceId) {
    if (!workspaceId) return [];
    const terminals = [];
    this.terminals.forEach((terminal, id) => {
      if (terminal.workspaceId === workspaceId) {
        terminals.push({ id, ...terminal });
      }
    });
    return terminals;
  }

  uniqueOrderedValues(values = []) {
    const result = [];
    const seen = new Set();
    values.forEach((value) => {
      const normalized = String(value || "").trim();
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      result.push(normalized);
    });
    return result;
  }

  summarizeWorkspaceValues(values = [], maxVisible = 2) {
    const ordered = this.uniqueOrderedValues(values);
    if (ordered.length === 0) return "";
    const visible = ordered.slice(0, maxVisible);
    const hiddenCount = Math.max(0, ordered.length - visible.length);
    return hiddenCount > 0
      ? `${visible.join(" • ")} +${hiddenCount}`
      : visible.join(" • ");
  }

  getWorkspaceFolderLabels(terminals = [], fallbackCwd = "") {
    return this.uniqueOrderedValues(
      terminals.map((terminal) =>
        this.formatCwdLabel(terminal.cwd || fallbackCwd || "Terminal"),
      ),
    );
  }

  getWorkspaceFolderPaths(terminals = [], fallbackCwd = "") {
    return this.uniqueOrderedValues(
      terminals.map((terminal) => terminal.cwd || fallbackCwd || "Terminal"),
    );
  }

  getWorkspaceSourceIds(terminals = [], fallbackWorkspaceId = "") {
    return this.uniqueOrderedValues(
      terminals.map(
        (terminal) =>
          terminal.originalWorkspaceId ||
          terminal.workspaceId ||
          fallbackWorkspaceId,
      ),
    );
  }

  getWorkspaceStatusLabels(terminals = []) {
    return this.uniqueOrderedValues(
      terminals.flatMap((terminal) =>
        TerminalColors.getWorkspaceSignalDescriptors({
          running: terminal.running,
          busy: terminal.busy,
          agentName: terminal.agentName,
          agentState: terminal.agentState,
          ports: terminal.ports,
          isWorktree: terminal.isWorktree,
        }).map((descriptor) => descriptor.label),
      ),
    );
  }

  getWorkspaceSnapshot(workspaceId, preferredCwd = null) {
    const terminals = this.getWorkspaceTerminals(workspaceId);
    const activeTerminalId = this.resolveWorkspaceTerminalId(workspaceId);
    const activeTerminal = activeTerminalId
      ? this.terminals.get(activeTerminalId)
      : null;
    const fallbackTerminal = terminals[0] || null;
    const cwd =
      preferredCwd || activeTerminal?.cwd || fallbackTerminal?.cwd || "";
    const ports = normalizeWorkspacePorts(
      terminals.flatMap((terminal) => terminal.ports || []),
    );
    const running = terminals.some((terminal) =>
      Boolean(terminal.running ?? terminal.busy),
    );
    const agentTerminal = activeTerminal?.agentState
      ? activeTerminal
      : terminals.find((terminal) => terminal.agentState) || null;
    const agentName = agentTerminal?.agentName || null;
    const agentState = agentTerminal?.agentState || null;
    const recentTools = agentTerminal?.recentTools || [];
    const isWorktree = terminals.some((terminal) =>
      Boolean(terminal.isWorktree),
    );
    const descriptors = TerminalColors.getWorkspaceSignalDescriptors({
      running,
      agentName,
      agentState,
      ports,
      isWorktree,
    });
    const primarySignalDescriptor = TerminalColors.getPrimaryWorkspaceSignal({
      running,
      agentName,
      agentState,
      ports,
      isWorktree,
      cwd,
    }).primarySignal;
    const folderLabels = this.getWorkspaceFolderLabels(terminals, cwd);
    const folderPaths = this.getWorkspaceFolderPaths(terminals, cwd);
    const sourceWorkspaceIds = this.getWorkspaceSourceIds(
      terminals,
      workspaceId,
    );
    const statusLabels = this.getWorkspaceStatusLabels(terminals);
    const isMergedWorkspace = sourceWorkspaceIds.length > 1;

    return {
      count: terminals.length,
      sourceWorkspaceIds,
      colors: terminals.map((terminal) =>
        TerminalColors.hashCwdToColor(terminal.cwd || cwd || "terminal"),
      ),
      cwd,
      label: this.formatCwdLabel(cwd),
      folderLabels,
      folderPaths,
      folderSummary: this.summarizeWorkspaceValues(folderLabels, 2),
      running,
      agentName,
      agentState,
      recentTools,
      ports,
      isWorktree,
      descriptors,
      statusLabels,
      statusSummary: this.summarizeWorkspaceValues(statusLabels, 2),
      tabLabel: isMergedWorkspace
        ? this.summarizeWorkspaceValues(folderLabels, 2)
        : this.formatCwdLabel(cwd),
      tabMeta: isMergedWorkspace
        ? this.summarizeWorkspaceValues(statusLabels, 2)
        : "",
      isMergedWorkspace,
      showSignalBadge: !isMergedWorkspace,
      primarySignal: primarySignalDescriptor?.key?.startsWith("ports:")
        ? "ports"
        : primarySignalDescriptor?.key || "none",
      primarySignalLabel: primarySignalDescriptor?.label || "",
    };
  }

  composeWorkspaceTooltip(snapshot) {
    const lines = [
      snapshot.isMergedWorkspace
        ? `Folders: ${snapshot.folderPaths.join(" • ") || "Terminal"}`
        : snapshot.cwd || "Terminal",
    ];
    lines.push(
      `Workspace: ${snapshot.count} terminal${snapshot.count === 1 ? "" : "s"}`,
    );
    if (snapshot.isMergedWorkspace) {
      lines.push(`Statuses: ${snapshot.statusLabels.join(" • ") || "none"}`);
    } else if (snapshot.descriptors.length > 0) {
      lines.push(
        `Signals: ${snapshot.descriptors.map((d) => d.label).join(" • ")}`,
      );
    } else {
      lines.push("Signals: none");
    }
    let tooltip = lines.join("\n");
    const toolsTooltip = window.TerminalColors?.formatRecentToolsTooltip?.(
      snapshot.recentTools,
    );
    if (toolsTooltip) {
      tooltip += `\n\nRecent tools:\n${toolsTooltip}`;
    }
    return tooltip;
  }

  applyWorkspaceSignals(tab, snapshot) {
    const signalBadge = tab.querySelector(".tab-signal-badge");

    tab.dataset.primarySignal = snapshot.primarySignal;
    tab.dataset.running = snapshot.running ? "true" : "false";
    tab.dataset.busy = snapshot.running ? "true" : "false";
    tab.dataset.agentName = snapshot.agentName || "";
    tab.dataset.agentState = snapshot.agentState || "none";
    tab.dataset.ports = snapshot.ports.join(",");
    tab.dataset.isWorktree = snapshot.isWorktree ? "true" : "false";
    tab.title = this.composeWorkspaceTooltip(snapshot);

    if (signalBadge) {
      signalBadge.textContent = snapshot.showSignalBadge
        ? snapshot.primarySignalLabel
        : "";
      signalBadge.dataset.signal = snapshot.primarySignal;
      signalBadge.hidden =
        !snapshot.showSignalBadge || !snapshot.primarySignalLabel;
      signalBadge.setAttribute(
        "aria-hidden",
        snapshot.showSignalBadge && snapshot.primarySignalLabel
          ? "false"
          : "true",
      );
    }
  }

  applyTerminalRuntimeState(id, nextState = {}) {
    const terminal = this.terminals.get(id);
    if (!terminal) return;

    const prevRunning = Boolean(terminal.running ?? terminal.busy);
    const nextRunning = Boolean(nextState.running);
    const nextExitCode =
      typeof nextState.lastExitCode === "number"
        ? nextState.lastExitCode
        : null;
    const nextAgentName =
      typeof nextState.agentName === "string" && nextState.agentName
        ? nextState.agentName
        : null;
    const nextAgentState =
      typeof nextState.agentState === "string" && nextState.agentState
        ? nextState.agentState
        : null;

    terminal.running = nextRunning;
    terminal.busy = nextRunning;
    terminal.lastExitCode = nextExitCode;
    terminal.agentName = nextAgentName;
    terminal.agentState = nextAgentState;

    if (prevRunning && !nextRunning) {
      this.maybeNotifyCommandFinished(terminal);
    }

    this.updateTabGroups();
  }

  maybeNotifyCommandFinished(terminal) {
    if (!this.notificationsEnabled) return;
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    if (!document.hidden) return;

    const label = this.formatCwdLabel(terminal.cwd || "Terminal");
    const exitCode =
      typeof terminal.lastExitCode === "number" ? terminal.lastExitCode : 0;
    const body =
      exitCode === 0
        ? `${label}: command completed successfully`
        : `${label}: command exited with code ${exitCode}`;

    try {
      new Notification("Command finished", { body });
    } catch (err) {
      console.warn("Command completion notification failed:", err);
    }
  }

  renderWorkspaceTab(tab, preferredCwd = null) {
    const dot = tab.querySelector(".tab-dot");
    const countBadge = tab.querySelector(".tab-count");
    const labelEl = tab.querySelector(".tab-label");
    const metaEl = tab.querySelector(".tab-meta");
    const snapshot = this.getWorkspaceSnapshot(
      tab.dataset.workspaceId,
      preferredCwd,
    );
    const blended = TerminalColors.blendWorkspaceColors(snapshot.colors);

    if (labelEl) labelEl.textContent = snapshot.tabLabel || snapshot.label;
    if (metaEl) {
      metaEl.textContent = snapshot.tabMeta || "";
      metaEl.hidden = !snapshot.tabMeta;
    }
    tab.dataset.summaryMode = snapshot.isMergedWorkspace ? "merged" : "single";

    if (snapshot.count > 1) {
      tab.classList.add("multicolor");
      tab.classList.remove("grouped");
      const color1 = blended[0] || "#58a6ff";
      const color2 = blended[1] || color1;
      const color3 = blended[2] || color2;
      tab.style.setProperty("--color-1", TerminalColors.hexToRgba(color1, 0.2));
      tab.style.setProperty("--color-2", TerminalColors.hexToRgba(color2, 0.2));
      tab.style.setProperty("--color-3", TerminalColors.hexToRgba(color3, 0.2));
      tab.style.setProperty("--color-1-solid", color1);
      tab.style.setProperty("--color-2-solid", color2);
      tab.style.setProperty("--color-3-solid", color3);
      tab.style.setProperty(
        "--tab-border",
        TerminalColors.hexToRgba(color1, 0.35),
      );
      if (countBadge) {
        countBadge.textContent = String(snapshot.count);
        countBadge.title = `${snapshot.count} panes`;
        countBadge.setAttribute("aria-label", `${snapshot.count} panes`);
      }
      if (dot) dot.style.removeProperty("background-color");
    } else {
      tab.classList.remove("multicolor", "grouped");
      const singleColor = blended[0] || "#58a6ff";
      if (dot) dot.style.backgroundColor = singleColor;
      tab.style.setProperty("--color-1-solid", singleColor);
      tab.style.removeProperty("--color-1");
      tab.style.removeProperty("--color-2");
      tab.style.removeProperty("--color-3");
      tab.style.removeProperty("--color-2-solid");
      tab.style.removeProperty("--color-3-solid");
      tab.style.removeProperty("--tab-border");
      tab.style.removeProperty("--group-color");
      if (countBadge) {
        countBadge.textContent = "";
        countBadge.removeAttribute("title");
        countBadge.removeAttribute("aria-label");
      }
    }

    this.applyWorkspaceSignals(tab, snapshot);
    this.applyWorkspaceConnectionState(tab, tab.dataset.workspaceId);
  }

  applyWorkspaceConnectionState(tab, workspaceId, fallbackStatuses = []) {
    if (!tab) return;
    const workspaceStatuses = workspaceId
      ? this.getWorkspaceTerminals(workspaceId).map((terminal) =>
          this.getTerminalConnectionStatus(terminal),
        )
      : fallbackStatuses;
    const normalizedStatuses = workspaceStatuses.map((paneStatus) =>
      this.normalizeConnectionStatus(paneStatus),
    );
    const hasDisconnectedPane = normalizedStatuses.includes("disconnected");
    const hasReconnectingPane = normalizedStatuses.some((paneStatus) =>
      ["connecting", "reconnecting"].includes(paneStatus),
    );

    tab.classList.toggle("disconnected", hasDisconnectedPane);
    tab.classList.toggle(
      "reconnecting",
      !hasDisconnectedPane && hasReconnectingPane,
    );
  }

  parseOsc7Cwd(data) {
    if (!data) return null;
    if (data.startsWith("file://")) {
      const withoutScheme = data.slice("file://".length);
      const slashIndex = withoutScheme.indexOf("/");
      if (slashIndex === -1) return null;
      return decodeURIComponent(withoutScheme.slice(slashIndex));
    }
    if (data.startsWith("/")) return decodeURIComponent(data);
    return null;
  }

  attachOsc7Handler(id, terminal) {
    if (!terminal?.parser?.registerOscHandler) return null;
    return terminal.parser.registerOscHandler(7, (data) => {
      const cwd = this.parseOsc7Cwd(data);
      if (!cwd) return false;
      const t = this.terminals.get(id);
      if (!t) return true;
      t.cwd = cwd;
      if (t.workspaceId && this.activeId === id) {
        this.setDirectoryValue(cwd);
        this.updateWorkspaceLabel(t.workspaceId, cwd);
        this.rememberWorkspaceById(t.workspaceId, cwd);
      }
      this.updateTabGroups();
      // Update session registry with new cwd
      this.sessionRegistry.update(id, { cwd });
      if (DEBUG) dbg("osc7 cwd", { id, cwd });
      return true;
    });
  }

  updateWrapButton() {
    document.querySelectorAll('[data-action="wrap-lines"]').forEach((btn) => {
      btn.classList.toggle("active", this.wrapLines);
      btn.title = this.wrapLines ? "Line wrap: on" : "Line wrap: off";
    });
    this.refreshCommandPalette();
  }

  toggleWrapLines() {
    const next = !this.wrapLines;
    // Persist + apply through the runtime so the change is live everywhere.
    if (this.settingsRuntime) {
      this.settingsRuntime.apply("terminal.wrapLines", next);
    } else {
      this.applyWrapLines(next);
      this.settingsStore?.set("terminal.wrapLines", this.wrapLines);
    }
  }

  // Side effect for terminal.wrapLines. `enabled` is already coerced to bool.
  applyWrapLines(enabled) {
    this.wrapLines = Boolean(enabled);
    this.updateWrapButton();
    for (const [, t] of this.terminals) {
      t.preferredCols = 0;
    }
    if (this.activeId) {
      const active = this.terminals.get(this.activeId);
      if (active) this.fitTerminalState(active);
      this.syncTerminalSize(this.activeId);
    }
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
    this.closeToolsSheet();
    document.getElementById("help-modal")?.classList.remove("hidden");
    this.syncSurfaceButtonState();
  }

  closeHelp() {
    document.getElementById("help-modal")?.classList.add("hidden");
  }

  getActiveWorkspaceContext() {
    const active = this.getActiveTerminal();
    return {
      workspaceId: active?.workspaceId || null,
      cwd: active?.cwd || this.getCurrentDirectoryValue() || "/",
    };
  }

  // Canonical LIVE cwd for the Git panel/SCM view — the single authoritative
  // source both the classic Git window and the IDE SCM view must resolve on
  // EVERY refresh (never cache once). Prefers the file explorer's live current
  // path (the most specific, user-navigated location); falls back to the
  // active workspace's terminal cwd when the explorer hasn't been opened yet.
  getGitCwd() {
    return (
      this.fileExplorer?.currentPath || this.getActiveWorkspaceContext().cwd
    );
  }

  // A COMMITTED working-dir value (change/Enter on the toolbar field, or a
  // Browse-picker selection — never a raw keystroke draft) atomically drives
  // explorer navigation + a git refresh, alongside the files.defaultCwd
  // persistence the call sites already do via setDirectoryValue(). One
  // authoritative cwd source driving explorer + git + new-terminal default,
  // per the VS Code-grade workspace plan's cwd invariant.
  async commitWorkingDirectory(value) {
    const cwd = this.normalizeWorkspaceCwd(value);
    if (!cwd) return;

    const { workspaceId } = this.getActiveWorkspaceContext();
    if (this.fileExplorer && workspaceId) {
      if (this.fileExplorer.currentWorkspaceId !== workspaceId) {
        // reveal:false — changing the working dir must navigate the explorer,
        // not pop it open (regression: Browse/toolbar commit opened Files).
        this.fileExplorer.openForWorkspace(workspaceId, cwd, null, {
          reveal: false,
        });
      }
      await this.fileExplorer.loadDir(cwd, workspaceId);
    }

    await window.gitManager?.refresh();
  }

  // Fetch git status for the explorer's current directory (via the shared
  // store), build the decoration map (git-decorations.js), and set it on the
  // explorer snapshot so rows render status badges/colors. Silently skips when
  // the dir is not a git repo (status error) or the store/explorer is absent.
  async refreshExplorerDecorations(options = {}) {
    if (!this.fileExplorer || !this.gitStatusStore) return;
    if (!window.GitDecorations?.buildDecorationMap) return;

    const workspaceId = this.fileExplorer.currentWorkspaceId;
    const cwd = this.fileExplorer.currentPath;
    if (!workspaceId || !cwd) return;

    let status;
    try {
      status = options.force
        ? await this.gitStatusStore.refreshStatus(cwd)
        : await this.gitStatusStore.getStatus(cwd);
    } catch {
      return;
    }

    // Not a git repo (or status failed) → clear decorations silently.
    if (!status || status.error || !status.root) {
      this.fileExplorer.setDecorations(workspaceId, {});
      return;
    }

    const decorations = window.GitDecorations.buildDecorationMap(
      status.files,
      status.root,
    );
    const folderDecorations = window.GitDecorations.buildFolderDecorationMap
      ? window.GitDecorations.buildFolderDecorationMap(
          status.files,
          status.root,
        )
      : {};
    this.fileExplorer.setDecorations(
      workspaceId,
      decorations,
      folderDecorations,
    );
  }

  getRightSurface() {
    const filesOpen = Boolean(this.fileExplorer?.isOpen);
    const gitOpen = Boolean(
      window.gitManager &&
      !window.gitManager.panel?.classList.contains("hidden"),
    );
    const nextSurface = filesOpen ? "files" : gitOpen ? "git" : "none";
    this.rightSurface = nextSurface;
    return nextSurface;
  }

  // Desktop mounts Files/Git/Tasks/Editor into movable, snappable
  // SurfaceWindows; mobile keeps the fullscreen sheets. The width check
  // matches the file explorer's own sheet breakpoint so a narrow desktop
  // window and the explorer agree on which mode is active.
  isWindowedSurfaces() {
    return (
      !platformDetector.isMobile &&
      (window.SurfaceWindows?.isDesktopSurfaceWidth?.(window.innerWidth) ??
        window.innerWidth >= 768) &&
      Boolean(window.SurfaceWindows?.SurfaceWindowManager)
    );
  }

  // isWindowedSurfaces() is only consulted at window-OPEN time, but
  // PlatformDetector fires on every resize. Without this, a floating
  // SurfaceWindow opened on desktop stays open (and overflows the viewport,
  // CSS min-width and all) after the viewport shrinks below the desktop
  // breakpoint. Closing here reuses each surface's own close chokepoint so
  // right-surface bookkeeping / aria / persisted layout all stay consistent.
  // No-op on desktop (isWindowedSurfaces() true) and a no-op per surface that
  // isn't open (each close path already tolerates being called when closed).
  reconcileSurfaceWindowsForViewport() {
    if (this.isWindowedSurfaces()) {
      // Growing past the desktop breakpoint: close the mobile Settings sheet
      // (its terminal-mode counterpart of a SurfaceWindow) so it isn't left
      // open/stuck underneath the now-available windowed surfaces.
      this.closeSettingsSheet?.();
      return;
    }
    this.closeFileExplorer?.();
    this.closeGitPanel?.();
    this.surfaceWindowManager?.close("tasks");
    this.surfaceWindowManager?.close("settings");
    this.fileEditor?.close();
  }

  async ensureSurfaceWindowManager() {
    if (!this.isWindowedSurfaces()) return null;
    if (this.surfaceWindowManager) return this.surfaceWindowManager;
    // Saved geometry must be loaded before the manager reads it.
    await this.settingsReady;
    if (!this.surfaceWindowManager) {
      const layer = document.getElementById("surface-windows-layer");
      if (!layer) return null;
      this.surfaceWindowManager =
        new window.SurfaceWindows.SurfaceWindowManager({
          container: layer,
          settingsStore: this.settingsStore,
        });
    }
    return this.surfaceWindowManager;
  }

  async openSurfaceWindow(id, config) {
    const manager = await this.ensureSurfaceWindowManager();
    if (!manager) return null;
    if (!manager.get(id)) manager.register({ id, ...config });
    const win = manager.get(id);
    // The content element may have been reparented back to #app by a
    // mode switch (viewport crossed the sheet breakpoint) — reclaim it.
    if (
      config?.contentEl &&
      win?.bodyEl &&
      config.contentEl.parentElement !== win.bodyEl
    ) {
      win.bodyEl.appendChild(config.contentEl);
    }
    manager.open(id);
    return win;
  }

  // --- Sessions bottom dock (VS Code panel semantics) -----------------------

  initSessionsDock() {
    this.dockState = { enabled: false, heightPct: 35 };
    // The IDE terminal-panel split height is persisted independently of the
    // sessions dock (its own --ide-terminal-height var + dock.ide key) so the two
    // docking modes never overwrite each other.
    this.ideDockHeightPct =
      window.SurfaceWindows?.DOCK_DEFAULT_HEIGHT_PCT || 35;
    // IDE sidebar width in px; null = the CSS default. Restored below.
    this.ideSidebarWidthPx = null;
    this.dockSash = document.getElementById("dock-sash");
    this.dockSash?.addEventListener("pointerdown", (e) =>
      this.startDockSashDrag(e),
    );
    this.dockSash?.addEventListener("dblclick", () =>
      this.setDockHeight(window.SurfaceWindows?.DOCK_DEFAULT_HEIGHT_PCT || 35),
    );
    void this.settingsReady.then(() => {
      const stored = window.SurfaceWindows?.dockStateFromSettings?.(
        this.settingsStore?.get("dock.sessions", null),
      );
      if (stored?.enabled) {
        this.dockState = stored;
        this.applyDockState({ persist: false });
      }
      const ideStored = this.settingsStore?.get("dock.ide", null);
      if (ideStored && Number.isFinite(Number(ideStored.heightPct))) {
        this.ideDockHeightPct =
          window.SurfaceWindows?.clampDockHeight?.(ideStored.heightPct) ??
          this.ideDockHeightPct;
      }
      this.applyIdeDockHeight();
      const sidebarStored = Number(
        this.settingsStore?.get("ide.sidebarWidth", null),
      );
      if (Number.isFinite(sidebarStored) && sidebarStored > 0) {
        this.ideSidebarWidthPx = this.clampIdeSidebarWidth(sidebarStored);
      }
      this.applyIdeSidebarWidth();
    });
  }

  // Pixel floor for the IDE terminal panel's height. Unlike the tiled/floating
  // terminal invariant of 24 rows (bug A3c, which protects a different UI —
  // see DEFAULT_MIN_PANEL_ROWS), the IDE bottom panel behaves like a VS Code
  // integrated terminal, so it uses the much smaller IDE_MIN_PANEL_ROWS floor
  // instead — otherwise the pixel floor eats far more height than the sash's
  // own 15% minimum (DOCK_MIN_HEIGHT_PCT), capping editor/Settings growth.
  // Computed from live cell metrics when a terminal is mounted, falling back
  // to a conservative estimate otherwise (see measureTerminalCellSize).
  // `chrome` accounts for the panel's border-top plus the terminal's own
  // vertical padding (TERMINAL_PADDING_Y), PLUS one extra cell of headroom:
  // the renderer's row-fit floors against real tile chrome that measurement
  // can't see (observed ~10px beyond padding+border), and without the margin
  // the floor lands exactly one row short (live-measured at 1440x900).
  getIdeTerminalPanelMinHeightPx() {
    const cellMetrics = this.measureTerminalCellSize();
    const cellHeight = cellMetrics?.cellHeight || 0;
    return (
      window.TerminalSizing?.minPanelHeightPx?.({
        cellHeight,
        minRows: window.TerminalSizing?.IDE_MIN_PANEL_ROWS,
        chrome: TERMINAL_PADDING_Y + 1 + Math.ceil(cellHeight || 20),
      }) ?? 0
    );
  }

  // Push the persisted IDE terminal-panel height into its CSS var (read by the
  // has-tabs split rule). Independent of the sessions dock's --dock-height.
  // The stored percentage is clamped against a live pixel floor here — not
  // rewritten into this.ideDockHeightPct — so neither the 35% default nor a
  // sash drag that lands below it can ever render fewer than 24 rows
  // (bug A3c; this is the single choke point both paths go through).
  applyIdeDockHeight() {
    const area = document.getElementById("workspace-area");
    if (!area) return;
    const colHeightPx =
      this.ideShell?.mainColumnEl?.getBoundingClientRect?.().height || 0;
    const pct =
      window.TerminalSizing?.clampPanelHeightPercent?.({
        pct: this.ideDockHeightPct,
        containerHeightPx: colHeightPx,
        minHeightPx: this.getIdeTerminalPanelMinHeightPx(),
      }) ?? this.ideDockHeightPct;
    area.style.setProperty("--ide-terminal-height", `${pct}%`);
  }

  // Reset the IDE terminal-panel split to the default height (double-click the
  // sash), mirroring the sessions-dock double-click-to-reset affordance.
  resetIdeTerminalSash() {
    this.ideDockHeightPct =
      window.SurfaceWindows?.DOCK_DEFAULT_HEIGHT_PCT || 35;
    this.applyIdeDockHeight();
    window.dispatchEvent(new Event("resize"));
    this.settingsStore?.set("dock.ide", { heightPct: this.ideDockHeightPct });
  }

  // --- IDE sidebar width (right-edge sash) ----------------------------------
  // Persisted separately (ide.sidebarWidth, px) from dock.ide so the two
  // writers can never clobber each other. Null = the CSS default (280px).

  clampIdeSidebarWidth(px) {
    const max = Math.min(640, Math.floor((window.innerWidth || 1280) * 0.5));
    return Math.min(Math.max(Math.round(px), 180), Math.max(180, max));
  }

  applyIdeSidebarWidth() {
    const root = document.documentElement;
    if (Number.isFinite(this.ideSidebarWidthPx)) {
      root.style.setProperty(
        "--ide-sidebar-width",
        `${Math.round(this.ideSidebarWidthPx)}px`,
      );
    } else {
      root.style.removeProperty("--ide-sidebar-width");
    }
  }

  startIdeSidebarSashDrag(e) {
    e.preventDefault();
    const sidebar = this.ideShell?.sidebarEl;
    if (!sidebar) return;
    const rect = sidebar.getBoundingClientRect();
    const sash = this.ideShell?.sidebarSashEl;
    sash?.classList.add("dragging");
    const apply = (clientX) => {
      this.ideSidebarWidthPx = this.clampIdeSidebarWidth(clientX - rect.left);
      this.applyIdeSidebarWidth();
      window.dispatchEvent(new Event("resize"));
    };
    const onMove = (ev) => apply(ev.clientX);
    const onEnd = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onEnd);
      document.removeEventListener("pointercancel", onEnd);
      sash?.classList.remove("dragging");
      this.settingsStore?.set("ide.sidebarWidth", this.ideSidebarWidthPx);
      // Same drag-end settle as the terminal sash (bug A3b): explicitly
      // refit every visible terminal instead of relying on the debounced
      // synthetic resize.
      for (const [id, t] of this.terminals) {
        if (!t?.element || t.element.offsetParent === null) continue;
        this.performReconnectLayoutSync(id, { forceResize: true });
      }
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onEnd);
    document.addEventListener("pointercancel", onEnd);
  }

  resetIdeSidebarSash() {
    this.ideSidebarWidthPx = null;
    this.applyIdeSidebarWidth();
    window.dispatchEvent(new Event("resize"));
    this.settingsStore?.set("ide.sidebarWidth", null);
  }

  applyDockState({ persist = true } = {}) {
    const enabled = this.dockState.enabled && this.isWindowedSurfaces();
    document.body.classList.toggle("sessions-docked", enabled);
    document
      .getElementById("workspace-area")
      ?.style.setProperty("--dock-height", `${this.dockState.heightPct}%`);
    if (persist) {
      this.settingsStore?.set("dock.sessions", {
        enabled: this.dockState.enabled,
        heightPct: this.dockState.heightPct,
      });
    }
    // xterm instances must refit to the resized terminal area.
    window.dispatchEvent(new Event("resize"));
    this.syncSurfaceButtonState();
  }

  toggleSessionsDock() {
    this.dockState.enabled = !this.dockState.enabled;
    this.applyDockState();
  }

  // --- IDE shell (phase 5, slice 2) -----------------------------------------

  // Build the IDE shell controller and apply the stored (viewport-gated) mode
  // once settings resolve. The controller reparents the single #file-explorer
  // element + toggles `body.ide-mode`; terminals are docked via CSS only (no
  // PTY/WebSocket teardown — the mode-transition contract).
  initIdeShell() {
    if (!window.IdeShell?.IdeShellController) return;
    this.ideShell = new window.IdeShell.IdeShellController({
      document,
      settingsStore: this.settingsStore,
      isDesktop: () => this.isWindowedSurfaces(),
      getExplorerView: () => this.fileExplorer,
      // Release-before-reparent: free the Files surface-window BEFORE the shell
      // moves #file-explorer into the sidebar (avoids racing stale window state).
      beforeEnterIde: () => this.beforeEnterIdeMode(),
      onEnterIde: () => this.onEnterIdeMode(),
      onExitIde: () => this.onExitIdeMode(),
      // Refit terminals + re-render the explorer after the container resizes.
      afterRender: () => {
        window.dispatchEvent(new Event("resize"));
        this.fileExplorer?.resize?.();
        this.ensureIdeExplorerLoaded();
        this.syncSurfaceButtonState();
        // Deferred refit after the terminal reparent + layout settle: fit the
        // active terminal once its container has a nonzero rect (fitting
        // immediately after a reparent can compute bad dimensions).
        requestAnimationFrame(() => {
          if (!this.activeId) return;
          if ((this.container?.clientHeight || 0) <= 0) return;
          this.fitTerminal(this.activeId);
          this.syncTerminalSize(this.activeId);
        });
      },
      // Focus preservation across the switch (contract: active focus is kept).
      captureFocus: () => this.captureIdeFocusTarget(),
      restoreFocus: (target) => this.restoreIdeFocusTarget(target),
      terminalExists: (id) => this.terminals.has(id),
      // Lossless explorer state: capture its prior presentation on enter and
      // restore the EXACT same state on exit.
      readExplorerState: () => this.readExplorerPresentation(),
      restoreExplorerState: (state) => this.restoreExplorerPresentation(state),
      // Slice-3 pop-out/dock: open/close a dedicated floating SurfaceWindow that
      // hosts the SAME #file-explorer element while detached (the controller does
      // the reparent + ViewHost rebind — these hooks only own window plumbing).
      detachExplorerWindow: (el) => this.detachIdeExplorerWindow(el),
      dockExplorerWindow: () => this.dockIdeExplorerWindow(),
      // Resize the IDE terminal panel by dragging the in-column sash; double-click
      // resets it to the default height.
      startTerminalSashDrag: (e) => this.startIdeTerminalSashDrag(e),
      resetTerminalSash: () => this.resetIdeTerminalSash(),
      // Resize the sidebar by dragging its right-edge sash; double-click
      // resets to the default width.
      startSidebarSashDrag: (e) => this.startIdeSidebarSashDrag(e),
      resetSidebarSash: () => this.resetIdeSidebarSash(),
    });
    this.initEditorTabs();
    this.initScmView();
    this.initTasksView();
    this.initSearchView();
    // The IDE toggle is desktop-only; reveal/hide it as the viewport crosses the
    // breakpoint and re-apply the resolved mode (a narrow viewport renders
    // terminal WITHOUT overwriting the stored desktop preference).
    platformDetector.onChange(() => this.syncIdeAffordance());
    // A floating SurfaceWindow is only closed/converted at open time
    // (isWindowedSurfaces()) — without this, one left open on desktop
    // survives a resize below the 768px breakpoint and overflows the mobile
    // viewport (A4a).
    platformDetector.onChange(() => this.reconcileSurfaceWindowsForViewport());
    void this.settingsReady.then(async () => {
      window.IdeShell.migrateLayoutState(this.settingsStore);
      // The Explorer can restore directly into a detached floating window on
      // reload, so the surface-window manager must exist BEFORE applyMode() runs
      // enterIde(). ensureSurfaceWindowManager no-ops off-desktop / when absent.
      // try/finally so a manager failure still applies IDE mode — a detached
      // restore just degrades to the docked sidebar (Codex slice-3 review #4).
      try {
        await this.ensureSurfaceWindowManager();
      } finally {
        this.syncIdeAffordance();
        this.ideShell?.applyMode();
        // Restore persisted editor tabs AFTER the shell is rendered (the editor
        // area exists only once enterIde() ran). Revalidates each tab through the
        // gated endpoints + silently drops dead ones.
        void this.restoreEditorTabs();
      }
    });
  }

  // --- IDE editor tabs (phase 5, slice 4) -----------------------------------

  // Build the editor-tabs controller that renders a tab bar + content host into
  // the IDE editor area. File bodies reuse FileEditor's CodeMirror machinery
  // (mountInto) + the phase-3 HEAD change-bar gutter; diff bodies reuse
  // renderMergeDiff. The controller never imports CodeMirror itself.
  initEditorTabs() {
    if (!window.EditorTabs?.EditorTabsController) return;
    // Per-tab live editor/diff handles, keyed by tabKey (for save/refresh/teardown).
    this.editorTabHandles = new Map();
    this.editorTabs = new window.EditorTabs.EditorTabsController({
      document,
      // The editor area + placeholder are created lazily on first enterIde, so
      // resolve them through getters every render.
      areaEl: () => this.ideShell?.editorAreaEl || null,
      placeholderEl: () =>
        this.ideShell?.editorAreaEl?.querySelector(".ide-editor-placeholder") ||
        null,
      mountFileBody: (hostEl, tab) => this.mountEditorFileTab(hostEl, tab),
      mountDiffBody: (hostEl, tab) => this.mountEditorDiffTab(hostEl, tab),
      // Settings body: build the settings content element and render it into
      // the tab body host. No teardown — settings state lives in settingsStore.
      mountSettingsBody: (hostEl) => this.mountEditorSettingsTab(hostEl),
      // Task Board body: a full-width board-variant Tasks view (backlog
      // 2026-07-05 — the kanban board gets the editor area, the sidebar stays
      // the quick-selection list).
      mountTasksBody: (hostEl) => this.mountEditorTasksTab(hostEl),
      onActiveBodyMeasure: () => this.refreshActiveEditorTab(),
      // Destroy the live CodeMirror view/handle when a tab body is torn down.
      onBodyTeardown: (key) => {
        const handle = this.editorTabHandles?.get(key);
        handle?.destroy?.();
        this.editorTabHandles?.delete(key);
      },
      // Open-at-line: scroll a freshly-mounted file tab to a search-hit line +
      // place the cursor there. The controller owns the reveal target; we own
      // the live CodeMirror handle, so it delegates here.
      onRevealLine: (key, target) => this.revealEditorTabLine(key, target),
      // Dirty-check for user-initiated file-tab close (Codex fix 3): ask the
      // live handle whether the file has unsaved changes.
      isDirtyImpl: (key) => {
        const handle = this.editorTabHandles?.get(key);
        return typeof handle?.isDirty === "function" ? handle.isDirty() : false;
      },
      // Persist descriptors only (never content). Debounced via settingsStore.
      // Also notify the SCM History view so file-scoped (6b) history follows the
      // active editor file when the active tab changes.
      onChange: (state) => {
        this.settingsStore?.set(
          window.EditorTabs.EDITOR_TABS_KEY,
          window.EditorTabs.serializeTabs(state),
        );
        this.scmView?.onActiveFileChanged?.();
      },
    });
  }

  // Absolute path of the active editor FILE tab, or null. Used by the SCM
  // History view's file scope (6b) to follow the active file. File tabs carry
  // their absolute path as a string `ref`; diff/settings tabs return null.
  getActiveEditorFilePath() {
    const tab = this.editorTabs?.model?.activeTab?.();
    if (!tab || tab.type !== window.EditorTabs?.TAB_FILE) return null;
    const ref = tab.ref;
    return typeof ref === "string" ? ref : ref?.relPath || null;
  }

  // --- IDE Source Control view (phase 5, slice 5) ---------------------------

  // Build the SCM sidebar view + register it as the second activity-bar view
  // (Explorer first). The view re-skins the git panel into a VS Code SCM tree;
  // it reuses the live GitManager's git OPERATIONS + the shared git-status-store
  // (decoration sync), and opens diffs as editor tabs via openDiffTab.
  initScmView() {
    if (!window.GitScmView?.GitScmViewController || !this.ideShell) return;
    this.scmView = new window.GitScmView.GitScmViewController({
      document,
      getGitManager: () => window.gitManager || null,
      getTerminalManager: () => this,
      getStatusStore: () => this.gitStatusStore || null,
    });
    this.ideShell.addView({
      id: window.IdeShell.VIEW_SCM,
      icon: "git-branch",
      title: "Source Control",
      mount: (container) => this.scmView.mount(container),
      unmount: () => this.scmView.unmount(),
      resize: () => this.scmView.resize(),
    });
  }

  // --- IDE Tasks view (phase 5, slice 6) ------------------------------------

  // Build the Tasks sidebar view + register it as the third activity-bar view
  // (Explorer 1st, Source Control 2nd, Tasks 3rd). The view re-skins the task
  // panel into a sidebar list/board; it reuses the live task OPERATIONS on this
  // TerminalManager (refreshTasks / handleTaskAction / selectTask /
  // toggleTaskViewMode / openTaskPanel + the shared taskState model). The
  // floating #task-panel keeps working (additive — the view subscribes via a
  // poll on mount and tears it down on unmount).
  initTasksView() {
    if (!window.TasksView?.TasksViewController || !this.ideShell) return;
    this.tasksView = new window.TasksView.TasksViewController({
      document,
      getTaskManager: () => this,
    });
    this.ideShell.addView({
      id: window.IdeShell.VIEW_TASKS,
      icon: "list-checks",
      title: "Tasks",
      mount: (container) => this.tasksView.mount(container),
      unmount: () => this.tasksView.unmount(),
      resize: () => this.tasksView.resize(),
    });
  }

  // --- IDE Search view (phase 5, slice 7) -----------------------------------

  // Build the Search sidebar view + register it as the 4th activity-bar view
  // (Explorer 1st, Source Control 2nd, Tasks 3rd, Search 4th). The view
  // dispatches a debounced, request-id'd query to the gated + bounded backend
  // POST /api/files/search; clicking a result opens the file at the line via
  // the editor-tabs open-at-line path.
  initSearchView() {
    if (!window.SearchView?.SearchViewController || !this.ideShell) return;
    this.searchView = new window.SearchView.SearchViewController({
      document,
      getTerminalManager: () => this,
    });
    this.ideShell.addView({
      id: window.IdeShell.VIEW_SEARCH,
      icon: "search",
      title: "Search",
      mount: (container) => this.searchView.mount(container),
      unmount: () => this.searchView.unmount(),
      resize: () => this.searchView.resize(),
    });
  }

  // Explorer file open: route to an editor TAB in IDE mode, else the modal.
  // The explorer passes the click intent: a single open action previews; a
  // double-click pins (VS Code semantics). Terminal-mode modal is unchanged.
  handleExplorerOpenFile(path, { pinned = false } = {}) {
    if (this.isIdeModeActive() && this.editorTabs) {
      this.editorTabs.openFile(path, { preview: !pinned });
      return;
    }
    void this.openFileInEditor(path);
  }

  // Is the IDE editor area live (rendered IDE mode)? Tabs only make sense then.
  isIdeModeActive() {
    return this.ideShell?.renderedMode?.() === "ide" && this.ideShell?.rendered;
  }

  // Mount a file editor into a tab body via FileEditor.mountInto (reuses the
  // gated load + the phase-3 gutter). Editing the file pins the preview tab
  // (VS Code "edit promotes to pinned"). The returned handle drives refresh.
  async mountEditorFileTab(hostEl, tab) {
    if (!this.fileEditor?.mountInto) return;
    const key = window.EditorTabs.tabKey(tab);
    const handle = await this.fileEditor.mountInto(hostEl, tab.ref, {
      onEdit: () => this.editorTabs?.model.pin(key),
      // Seed the initial debounce from the current editor.autosave setting
      // (applyEditorAutosave keeps every ALREADY-open tab's interval live —
      // this only covers the mount-time value for a freshly opened tab).
      autosaveMs: this.editorAutosaveMs ?? null,
    });
    if (!handle) {
      // Load failed (binary / 403 / 404): drop the tab so we don't leave an
      // empty body. Silent — matches the revalidation contract.
      this.editorTabs?.closeKey(key);
      return;
    }
    // Wrap save() with a minimal success toast (failures already surface their
    // own alert from mountInto's save). The Mod-s keymap inside the editor view
    // routes through this wrapped handle, so a successful Ctrl/Cmd+S flashes
    // "Saved ✓" — keeping feedback cheap without a status bar.
    const innerSave = handle.save;
    if (typeof innerSave === "function") {
      handle.save = async () => {
        const ok = await innerSave();
        if (ok) this.showToast?.("Saved ✓", "success");
        return ok;
      };
    }
    this.editorTabHandles?.set(key, handle);
  }

  // Open-at-line: scroll the live editor for a tab to a 1-based line + place the
  // cursor there. Reuses the tab's CodeMirror EditorView handle (handle.view).
  // Best-effort + total: a missing handle/view or out-of-range line is a no-op,
  // so a search hit on a file that since shrank never throws.
  async revealEditorTabLine(key, target) {
    if (!key || !target) return;
    const line = Number.isFinite(target.line) ? target.line : 1;
    const col = Number.isFinite(target.col) ? target.col : 1;
    const handle = this.editorTabHandles?.get(key);
    const view = handle?.view;
    if (!view?.state?.doc || typeof view.dispatch !== "function") return;
    try {
      const cm = await import("/vendor/codemirror.js");
      const doc = view.state.doc;
      const lineNo = Math.min(Math.max(1, line), doc.lines);
      const lineInfo = doc.line(lineNo);
      // Clamp the column to the line length; col is 1-based.
      const anchor = Math.min(
        lineInfo.from + Math.max(0, col - 1),
        lineInfo.to,
      );
      view.dispatch({
        selection: { anchor },
        effects: cm.EditorView.scrollIntoView(anchor, { y: "center" }),
      });
      try {
        view.focus();
      } catch {
        // best-effort focus
      }
    } catch {
      // best-effort — never break the open on a reveal failure
    }
  }

  // Mount a merge diff into a tab body, reusing the git panel's renderMergeDiff
  // machinery. The diff ref carries everything needed to re-fetch both sides.
  // Mount the settings UI into a settings editor tab body. Builds the content
  // element once (settingsManager.buildContent is idempotent) and appends it.
  // No handle registration needed — settings has no CodeMirror view to destroy.
  async mountEditorSettingsTab(hostEl) {
    if (!this.settingsManager) {
      this.settingsManager = new SettingsManager({
        settingsStore: this.settingsStore,
        runtime: this.settingsRuntime,
      });
    }
    const content = this.settingsManager.buildContent();
    hostEl.appendChild(content);
    await this.settingsManager.render();
  }

  // Mount the full-width Task Board into the editor-area tab body: a second
  // TasksViewController instance in the "board" variant. It shares the live
  // taskState + operations on this manager (its own poll subscription is torn
  // down via the editorTabHandles destroy hook when the tab closes).
  mountEditorTasksTab(hostEl) {
    if (!window.TasksView?.TasksViewController) return;
    const view = new window.TasksView.TasksViewController({
      document,
      getTaskManager: () => this,
      variant: "board",
    });
    view.mount(hostEl);
    this.editorTabHandles?.set("tasks:board", {
      destroy: () => view.dispose(),
      refresh: () => {},
    });
  }

  // Can the Task Board editor tab open right now? (IDE mode with live tabs.)
  canOpenTaskBoardTab() {
    return Boolean(this.isIdeModeActive() && this.editorTabs);
  }

  // Open (or focus) the singleton Task Board editor tab.
  openTaskBoardTab() {
    if (!this.canOpenTaskBoardTab()) return;
    this.editorTabs.openTasksBoard();
  }

  // Close the active editor tab (palette command). Goes through
  // requestCloseKey — the single user-initiated-close chokepoint — so a
  // dirty file tab still prompts before discarding.
  closeActiveEditorTabFromPalette() {
    if (!this.isIdeModeActive() || !this.editorTabs) return;
    const key = this.editorTabs.model.state.activeKey;
    if (!key) return;
    this.editorTabs.requestCloseKey(key);
  }

  // Activate the next/previous editor tab (direction +1/-1), wrapping around.
  // No-op with 0 or 1 tabs (nothing to step to).
  stepActiveEditorTab(direction) {
    if (!this.isIdeModeActive() || !this.editorTabs) return;
    const state = this.editorTabs.model.state;
    const tabs = Array.isArray(state?.tabs) ? state.tabs : [];
    if (tabs.length < 2) return;
    const keys = tabs.map((tab) => window.EditorTabs.tabKey(tab));
    const currentIndex = keys.indexOf(state.activeKey);
    if (currentIndex < 0) return;
    const nextIndex = (currentIndex + direction + keys.length) % keys.length;
    this.editorTabs.model.activate(keys[nextIndex]);
  }

  async mountEditorDiffTab(hostEl, tab) {
    const r = tab.ref || {};
    const key = window.EditorTabs.tabKey(tab);
    try {
      const [original, modified] = await this.fetchDiffTabSources(r);
      // Reuse the GitManager's CodeMirror merge-view machinery (split/inline per
      // the diff-layout preference) — rendered into the tab body, not #git-diff.
      if (window.gitManager?.renderMergeDiffInto) {
        const view = await window.gitManager.renderMergeDiffInto(
          hostEl,
          original,
          modified,
          r.relPath,
        );
        // Register a teardown handle so closing/clearing the tab destroys the
        // live CodeMirror EditorView/MergeView (symmetric with the file path);
        // otherwise diff views leak listeners + state. The handle's no-op
        // refresh keeps refreshActiveEditorTab() total across tab types.
        if (view?.destroy) {
          this.editorTabHandles?.set(key, {
            destroy: () => view.destroy(),
            refresh: () => {},
          });
        }
      }
    } catch {
      hostEl.replaceChildren();
      const err = document.createElement("p");
      err.className = "muted";
      err.textContent = "Failed to load diff.";
      hostEl.appendChild(err);
    }
  }

  // Resolve a diff tab's two document sides through the gated git/file endpoints.
  async fetchDiffTabSources(ref) {
    const cwd = ref.cwd || this.currentCwd || "";
    const relPath = ref.relPath;
    const mode = ref.mode || "working";
    const showAt = async (commit) => {
      const params = new URLSearchParams({ cwd, commit, path: relPath });
      const res = await fetch(`/api/git/show?${params.toString()}`);
      if (res.status === 404) return "";
      if (!res.ok) return "";
      const data = await res.json().catch(() => ({}));
      return typeof data.content === "string" ? data.content : "";
    };
    const worktree = async () => {
      const abs = `${cwd.replace(/\/$/, "")}/${relPath}`;
      const res = await fetch(
        `/api/files/content?path=${encodeURIComponent(abs)}`,
      );
      if (!res.ok) return "";
      const data = await res.json().catch(() => ({}));
      return typeof data.content === "string" ? data.content : "";
    };
    if (mode === "staged") {
      // Staged side: the gated /api/git/show route maps "INDEX" → git's :0
      // (server rejects a raw ":0" — its commit regex disallows the colon).
      return Promise.all([showAt("HEAD"), showAt("INDEX")]);
    }
    if (mode === "commit" && ref.commit) {
      return Promise.all([showAt(`${ref.commit}~1`), showAt(ref.commit)]);
    }
    if (mode === "conflict") {
      // Merge conflict (Track D slice D3): ours (index stage 2) vs theirs
      // (index stage 3) — the gated /api/git/show route maps the STAGE2/
      // STAGE3 sentinels to git's :2/:3. Never the raw working file, which
      // still carries the conflict markers.
      return Promise.all([showAt("STAGE2"), showAt("STAGE3")]);
    }
    // working tree (default): HEAD vs the on-disk file.
    return Promise.all([showAt("HEAD"), worktree()]);
  }

  // Open a diff as an editor tab (the SCM list in slice 5 calls this). cwd
  // defaults to the active git panel cwd so an explicit cwd is optional.
  openDiffTab({ relPath, mode = "working", cwd, commit, title } = {}) {
    if (!this.editorTabs || !relPath) return;
    this.editorTabs.openDiff({
      relPath,
      mode,
      cwd:
        cwd ||
        window.gitManager?.state?.cwd ||
        window.gitManager?.currentCwd ||
        this.currentCwd ||
        "",
      commit,
      title:
        title ||
        `${relPath} (${
          mode === "staged"
            ? "Staged"
            : mode === "commit"
              ? "Commit"
              : mode === "conflict"
                ? "Merge Conflict"
                : "Working Tree"
        })`,
    });
  }

  // Refresh (measure) the active editor-tab body after a resize / activation.
  refreshActiveEditorTab() {
    const tab = this.editorTabs?.model.activeTab?.();
    if (!tab) return;
    const key = window.EditorTabs.tabKey(tab);
    this.editorTabHandles?.get(key)?.refresh?.();
  }

  // Persist + revalidated restore (Codex xhigh). Reads the v3 descriptors and
  // re-opens each through the gated file/git endpoints; anything that fails
  // (deleted / moved / unauthorized) is SILENTLY dropped. Only runs in IDE mode
  // (the editor area must exist); terminal mode leaves the descriptors persisted.
  async restoreEditorTabs() {
    if (!this.editorTabs || !this.isIdeModeActive()) return;
    const raw = this.settingsStore?.get(
      window.EditorTabs.EDITOR_TABS_KEY,
      null,
    );
    const restored = window.EditorTabs.deserializeTabs(raw);
    if (!restored.tabs.length) return;
    const survived = await window.EditorTabs.filterRestoredTabs(
      restored,
      (tab) => this.canReopenTab(tab),
    );
    this.editorTabs.restoreState(survived);
  }

  // Probe whether a persisted tab can still be opened through the capability
  // layer. We attempt the SAME gated load(s) the body mount would do and DROP on
  // access-denied / server-error / malformed / network failure (the spec
  // requires silently dropping unauthorized or invalid tabs — not restoring them
  // as an empty diff). The probe never renders — it only validates access +
  // existence. A throw (network) drops; we never trust a cached/200-on-error.
  async canReopenTab(tab) {
    // Settings tabs: always restorable — no network probe needed (Codex fix 1,
    // type-scoped restore). filterRestoredTabs handles deduplication.
    if (tab.type === window.EditorTabs.TAB_SETTINGS) return true;
    try {
      if (tab.type === window.EditorTabs.TAB_DIFF) {
        return await this.canReopenDiffTab(tab);
      }
      // File tab: must resolve OK (a 404/403/5xx all drop it).
      const res = await fetch(
        `/api/files/content?path=${encodeURIComponent(tab.ref)}`,
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  // Diff-tab revalidation. A diff renders through one or two GATED endpoints
  // depending on its mode; every probe it needs must be "renderable" or the tab
  // is dropped. Renderable = HTTP 200 OR 404 (a 404 is a legitimate add/delete
  // side of a diff — e.g. a tracked-but-deleted working file, or a file that
  // doesn't exist on one of the two compared refs). NOT renderable = 401/403
  // (access denied → root no longer authorized), 400 (malformed ref), 5xx
  // (server error), or a network throw — all DROP. We require ALL probes to be
  // renderable, so an access-denied git side drops even if the working file is
  // still readable.
  async canReopenDiffTab(tab) {
    const r = tab.ref || {};
    const cwd = (r.cwd || this.currentCwd || "").replace(/\/$/, "");
    const mode = r.mode || "working";

    // Probe a gated endpoint; resolve true when its status is renderable.
    const probe = async (url) => {
      const res = await fetch(url);
      // 200 → fine; 404 → meaningful add/delete side; everything else drops.
      return res.ok || res.status === 404;
    };
    const showProbe = (commit) =>
      probe(
        `/api/git/show?${new URLSearchParams({ cwd, commit, path: r.relPath }).toString()}`,
      );
    const fileProbe = () =>
      probe(
        `/api/files/content?path=${encodeURIComponent(`${cwd}/${r.relPath}`)}`,
      );

    // Map mode → the exact (endpoint, ref) probes the diff actually renders.
    let probes;
    if (mode === "staged") {
      // HEAD vs the staged INDEX (the /api/git/show route maps "INDEX" → :0).
      probes = [showProbe("HEAD"), showProbe("INDEX")];
    } else if (mode === "commit" && r.commit) {
      // commit~1 vs commit.
      probes = [showProbe(`${r.commit}~1`), showProbe(r.commit)];
    } else if (mode === "conflict") {
      // Merge conflict: ours (STAGE2 → :2) vs theirs (STAGE3 → :3).
      probes = [showProbe("STAGE2"), showProbe("STAGE3")];
    } else {
      // working tree (default): HEAD vs the on-disk working file.
      probes = [showProbe("HEAD"), fileProbe()];
    }

    const results = await Promise.all(probes);
    // Conflict diffs are meaningful with a single existing stage (UD/DU/AU/UA
    // — one side deleted/absent renders ours-vs-empty; showAt() already
    // substitutes "" for a missing stage). Only a conflict with NO stage at
    // all (DD) has nothing to show. Every other mode needs both sides.
    if (mode === "conflict") return results.some(Boolean);
    return results.every(Boolean);
  }

  // Show the IDE toggle only on desktop; keep its pressed state in sync and let
  // the controller reconcile the rendered mode to the current viewport.
  syncIdeAffordance() {
    const btn = document.getElementById("ide-toggle-btn");
    const desktop = this.isWindowedSurfaces();
    if (btn) {
      btn.hidden = !desktop;
      const ide = this.ideShell?.renderedMode?.() === "ide";
      btn.classList.toggle("active", ide);
      btn.setAttribute("aria-pressed", ide ? "true" : "false");
    }
    // Re-apply so a viewport crossing 768px docks/undocks correctly.
    this.ideShell?.applyMode();
  }

  toggleIdeMode() {
    if (!this.ideShell || !this.isWindowedSurfaces()) return;
    this.ideShell.toggle();
    this.syncIdeAffordance();
  }

  // Run BEFORE the shell reparents #file-explorer into the sidebar. If the Files
  // surface-window currently HOSTS the explorer element, release it FIRST so the
  // reparent doesn't race stale surface-window state / no-op against a moved node.
  // Other floating windows are left as-is (they float above the shell — pop-out/
  // dock is slice 3).
  beforeEnterIdeMode() {
    this.releaseSurfaceWindowContent(
      "files",
      document.getElementById("file-explorer"),
    );
  }

  // Entering IDE mode (after reparent): the `body.ide-mode` class (set by the
  // controller) docks the terminal container to the bottom panel via CSS only —
  // no PTY touch. Close the terminal-mode settings SurfaceWindow if open so
  // there aren't two settings UIs simultaneously (Codex fix 7). "files" is
  // handled separately (reparented into the sidebar, not closed) — every
  // OTHER floating surface window (tasks/git/editor) is closed here too:
  // those windows are positioned relative to the whole viewport, so left
  // open they'd float on top of the freshly-painted IDE shell, visually
  // disconnected from it.
  onEnterIdeMode() {
    ["settings", "tasks", "git", "editor"].forEach((id) =>
      this.surfaceWindowManager?.close(id),
    );
    // The scrollback-search overlay is positioned relative to the active
    // terminal's tile, which the IDE reflow can detach/resize mid-session —
    // close it rather than let it float over stale geometry (bug A2).
    this.closeTerminalSearch();
    this.applyIdeDockHeight();
    this.ensureIdeExplorerLoaded();
  }

  // Leaving IDE mode: removing `body.ide-mode` (by the controller) restores the
  // full-bleed TileManager presentation exactly (we only toggled CSS + moved one
  // element). The explorer's prior state is restored via restoreExplorerPresentation.
  // We do NOT auto-spawn a SurfaceWindow for settings on exit (Codex fix 7).
  onExitIdeMode() {
    // Same rationale as onEnterIdeMode: the terminal reparents back to the
    // TileManager layout, so any open search overlay must be disposed rather
    // than left bound to a container it's about to leave.
    this.closeTerminalSearch();
  }

  // In IDE mode the Explorer lives permanently in the sidebar, so it must load the
  // active workspace's directory itself (the legacy Files surface is what loads it
  // in terminal mode). No-op once the active workspace's tree is loaded — so the
  // frequent afterRender/workspace-sync calls never re-open or reset a browsed
  // subdirectory. Only acts on first load or when the active workspace changed.
  ensureIdeExplorerLoaded() {
    if (!this.fileExplorer || !this.isIdeModeActive()) return;
    const { workspaceId, cwd } = this.getActiveWorkspaceContext();
    if (!workspaceId) return;
    const sameWorkspace = this.fileExplorer.currentWorkspaceId === workspaceId;
    const hasItems =
      this.fileExplorer.getWorkspaceItems(workspaceId).length > 0;
    if (sameWorkspace && hasItems) return;
    const targetPath = this.fileExplorer.openForWorkspace(workspaceId, cwd);
    if (targetPath) void this.fileExplorer.loadDir(targetPath, workspaceId);
  }

  // Snapshot the focus target before a mode switch. An active terminal wins (its
  // xterm is the natural focus); else, if the explorer holds focus, remember it.
  captureIdeFocusTarget() {
    const activeId = this.activeId || null;
    const active = this.terminals.get(activeId);
    if (active?.terminal) {
      return window.IdeShell.captureFocusTarget({ activeTerminalId: activeId });
    }
    const explorerEl = document.getElementById("file-explorer");
    const ae = document.activeElement;
    const focusInExplorer = Boolean(
      explorerEl && ae && explorerEl.contains(ae),
    );
    return window.IdeShell.captureFocusTarget({
      activeControl: focusInExplorer ? "explorer" : null,
    });
  }

  // Refocus the resolved target on the live DOM (the controller already checked
  // the terminal still exists). Best-effort — never throws into the switch.
  restoreIdeFocusTarget(target) {
    if (!target) return;
    if (target.kind === "terminal" && target.terminalId) {
      this.focusTerminal(target.terminalId, { ensureVisible: true });
      return;
    }
    if (target.kind === "control" && target.control === "explorer") {
      const explorerEl = document.getElementById("file-explorer");
      if (!explorerEl) return;
      // Focus the first focusable explorer control, else the container itself.
      const focusable = explorerEl.querySelector(
        'button, [href], input, [tabindex]:not([tabindex="-1"])',
      );
      (focusable || explorerEl).focus?.({ preventScroll: true });
    }
  }

  // Flat DOM read of the explorer's prior presentation (parent, open, surface
  // window host) for a lossless restore on IDE exit.
  readExplorerPresentation() {
    const explorerEl = document.getElementById("file-explorer");
    const parent = explorerEl?.parentElement || null;
    const inSurfaceWindow = Boolean(
      parent?.classList?.contains("surface-window-body"),
    );
    return {
      parentId: parent?.id || null,
      isOpen: Boolean(explorerEl && !explorerEl.classList.contains("hidden")),
      surfaceWindow: inSurfaceWindow ? "files" : null,
    };
  }

  // Restore the explorer to its captured prior presentation on IDE exit. If it
  // was OPEN before, re-present it (in a surface window when that's where it was);
  // if it was CLOSED, keep it closed in #app. Never force-hides an open explorer.
  restoreExplorerPresentation(state) {
    const explorerEl = document.getElementById("file-explorer");
    if (!explorerEl) return;
    const home = document.getElementById("app");
    if (home && explorerEl.parentElement !== home) home.appendChild(explorerEl);

    const wasOpen = Boolean(state?.isOpen);
    if (!wasOpen) {
      // Closed before IDE → keep closed. Rebind the view to the home skeleton.
      explorerEl.classList.add("hidden");
      const view = this.fileExplorer;
      if (view) {
        view.unmount?.();
        view.mount?.(explorerEl);
        view.isOpen = false;
      }
      return;
    }

    // Open before IDE → re-open via the normal path (this rebinds + re-presents,
    // re-hosting in the Files surface-window on desktop just like the user left it).
    explorerEl.classList.remove("hidden");
    const view = this.fileExplorer;
    if (view) {
      view.unmount?.();
      view.mount?.(explorerEl);
    }
    void this.openFileExplorer();
  }

  // --- IDE Explorer pop-out window (slice 3) --------------------------------

  // Open (or reuse) the floating Explorer SurfaceWindow and host the given
  // #file-explorer element in it. Returns the window body element so the IDE
  // shell controller can run its ViewHost rebind against it (the SAME element +
  // controller are reused — no recreation). Synchronous: by the time IDE mode is
  // active the surface-window manager + settings are already resolved.
  detachIdeExplorerWindow(explorerEl) {
    const manager = this.surfaceWindowManager;
    if (!manager || !explorerEl) return null;
    if (!manager.get(IDE_EXPLORER_WINDOW_ID)) {
      manager.register({
        id: IDE_EXPLORER_WINDOW_ID,
        title: "Explorer",
        icon: "▤",
        // Default bounds when no saved geometry exists; the manager prefers the
        // persisted windows.layout entry for this id when present.
        bounds: { x: 6, y: 6, width: 30, height: 80 },
        // Closing via the window's × docks the Explorer back to the sidebar.
        onClose: () => this.ideShell?.dockExplorer(),
      });
    }
    const win = manager.get(IDE_EXPLORER_WINDOW_ID);
    if (!win?.bodyEl) return null;
    if (explorerEl.parentElement !== win.bodyEl) {
      win.bodyEl.appendChild(explorerEl);
    }
    manager.open(IDE_EXPLORER_WINDOW_ID);
    return win.bodyEl;
  }

  // Close the floating Explorer window (used when docking back to the sidebar or
  // when leaving IDE mode). The controller reparents the element out separately.
  dockIdeExplorerWindow() {
    this.surfaceWindowManager?.close(IDE_EXPLORER_WINDOW_ID);
  }

  setDockHeight(pct) {
    this.dockState.heightPct =
      window.SurfaceWindows?.clampDockHeight?.(pct) ?? this.dockState.heightPct;
    this.applyDockState();
  }

  // Drag the IDE terminal-panel sash. Measures the IDE main column so the split
  // is scoped to grid-column 3 and never reaches the sidebar. Persists to its own
  // --ide-terminal-height var + dock.ide key, independent of the sessions dock.
  startIdeTerminalSashDrag(e) {
    e.preventDefault();
    const col = this.ideShell?.mainColumnEl;
    if (!col) return;
    const rect = col.getBoundingClientRect();
    const sash = this.ideShell?.terminalSashEl;
    sash?.classList.add("dragging");
    const apply = (clientY) => {
      const pct = ((rect.bottom - clientY) / Math.max(rect.height, 1)) * 100;
      this.ideDockHeightPct =
        window.SurfaceWindows?.clampDockHeight?.(pct) ?? this.ideDockHeightPct;
      this.applyIdeDockHeight();
      window.dispatchEvent(new Event("resize"));
    };
    const onMove = (ev) => apply(ev.clientY);
    const onEnd = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onEnd);
      document.removeEventListener("pointercancel", onEnd);
      sash?.classList.remove("dragging");
      this.settingsStore?.set("dock.ide", {
        heightPct: this.ideDockHeightPct,
      });
      // Per-move work above only sets the CSS var + fires a debounced
      // synthetic `resize` (window listener refits just the ACTIVE terminal,
      // 150ms later, and never calls refresh()). That leaves a gap where a
      // fast drag-and-release can settle on a stale/corrupted paint for any
      // terminal that isn't the active one. Explicitly run the full
      // fit -> resize(force) -> refresh sequence for every currently visible
      // terminal right now instead of relying on that debounce (bug A3b).
      for (const [id, t] of this.terminals) {
        if (!t?.element || t.element.offsetParent === null) continue;
        this.performReconnectLayoutSync(id, { forceResize: true });
      }
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onEnd);
    document.addEventListener("pointercancel", onEnd);
  }

  startDockSashDrag(e) {
    e.preventDefault();
    const area = document.getElementById("workspace-area");
    if (!area) return;
    const rect = area.getBoundingClientRect();
    this.dockSash?.classList.add("dragging");
    const onMove = (ev) => {
      const pct = ((rect.bottom - ev.clientY) / Math.max(rect.height, 1)) * 100;
      this.dockState.heightPct =
        window.SurfaceWindows?.clampDockHeight?.(pct) ??
        this.dockState.heightPct;
      this.applyDockState({ persist: false });
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      this.dockSash?.classList.remove("dragging");
      this.applyDockState();
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
  }

  async openFileInEditor(path) {
    if (!this.fileEditor) return;
    await this.fileEditor.open(path);
    // open() bails on binary files and fetch errors — only window a visible
    // editor.
    const modal = document.getElementById("file-editor-modal");
    if (!modal || modal.classList.contains("hidden")) return;
    if (this.isWindowedSurfaces()) {
      const win = await this.openSurfaceWindow("editor", {
        title: path,
        icon: "✎",
        contentEl: modal,
        bounds: { x: 12, y: 6, width: 76, height: 86 },
        minWidthPx: 480,
        minHeightPx: 320,
        onClose: () => this.fileEditor.close(),
      });
      win?.setTitle(path);
    } else {
      this.releaseSurfaceWindowContent("editor", modal);
    }
  }

  // Panels originally live in #app; sheets expect them there. Used when a
  // panel opens in sheet mode after having been mounted in a window.
  releaseSurfaceWindowContent(id, contentEl) {
    if (!contentEl) return;
    this.surfaceWindowManager?.close(id);
    if (contentEl.parentElement?.classList?.contains("surface-window-body")) {
      document.getElementById("app")?.appendChild(contentEl);
    }
  }

  async openFileExplorer() {
    if (!this.fileExplorer) return null;

    const { workspaceId, cwd } = this.getActiveWorkspaceContext();
    if (!workspaceId) return null;

    if (this.isWindowedSurfaces()) {
      // Windows coexist — no mutual exclusion with the git panel.
      await this.openSurfaceWindow("files", {
        title: "Files",
        icon: "▤",
        contentEl: document.getElementById("file-explorer"),
        bounds: { x: 64, y: 4, width: 34, height: 92 },
        onClose: () => this.closeFileExplorer(),
      });
    } else {
      this.releaseSurfaceWindowContent(
        "files",
        document.getElementById("file-explorer"),
      );
      if (
        window.gitManager &&
        !window.gitManager.panel?.classList.contains("hidden")
      ) {
        window.gitManager.hide();
      }
    }

    const targetPath = this.fileExplorer.openForWorkspace(workspaceId, cwd);
    this.rightSurface = "files";

    if (targetPath) {
      await this.fileExplorer.loadDir(targetPath, workspaceId);
    }

    this.syncSurfaceButtonState();
    return targetPath;
  }

  closeFileExplorer() {
    this.fileExplorer?.close();
    this.surfaceWindowManager?.close("files");
    this.getRightSurface();
    this.syncSurfaceButtonState();
  }

  async toggleFileExplorer() {
    if (this.getRightSurface() === "files") {
      this.closeFileExplorer();
      return;
    }
    await this.openFileExplorer();
  }

  async openGitPanel() {
    const { cwd } = this.getActiveWorkspaceContext();
    if (!cwd) return null;

    if (this.isWindowedSurfaces()) {
      if (window.gitManager?.panel) {
        await this.openSurfaceWindow("git", {
          title: "Git",
          icon: "⎇",
          contentEl: window.gitManager.panel,
          bounds: { x: 50, y: 0, width: 50, height: 100 },
          minWidthPx: 480,
          minHeightPx: 320,
          onClose: () => this.closeGitPanel(),
        });
      }
    } else {
      this.releaseSurfaceWindowContent("git", window.gitManager?.panel);
      if (this.fileExplorer?.isOpen) {
        this.fileExplorer.close();
      }
    }

    this.rightSurface = "git";
    const result = await window.gitManager?.show(cwd);
    this.syncSurfaceButtonState();
    return result;
  }

  closeGitPanel() {
    window.gitManager?.hide();
    this.surfaceWindowManager?.close("git");
    this.getRightSurface();
    this.syncSurfaceButtonState();
  }

  async toggleGitPanel() {
    if (this.getRightSurface() === "git") {
      this.closeGitPanel();
      return;
    }
    await this.openGitPanel();
  }

  async syncRightSurfaceForWorkspace() {
    if (this.isIdeModeActive()) this.ensureIdeExplorerLoaded();
    const surface = this.getRightSurface();
    const { workspaceId, cwd } = this.getActiveWorkspaceContext();
    if (!workspaceId) return;

    if (surface === "files") {
      const targetPath = this.fileExplorer?.openForWorkspace(workspaceId, cwd);
      if (targetPath) {
        await this.fileExplorer.loadDir(targetPath, workspaceId);
      }
      return;
    }

    if (surface === "git") {
      await window.gitManager?.show(cwd);
    }
  }

  setupKeyboardShortcuts() {
    document.addEventListener("keydown", (e) => {
      if (this.handledPaneShortcutEvents.has(e)) return;
      if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "p"
      ) {
        e.preventDefault();
        this.toggleCommandPalette();
        return;
      }
      // Ctrl+P — quick-open is the default no-prefix palette experience;
      // opens the SAME palette as Ctrl+Shift+P. preventDefault is essential
      // here (unlike the shift variant, plain Ctrl/Cmd+P is the browser's
      // print-dialog shortcut).
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        e.key.toLowerCase() === "p"
      ) {
        e.preventDefault();
        this.toggleCommandPalette();
        return;
      }
      if (this.isCommandPaletteOpen()) {
        return;
      }
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
      if (e.altKey && e.shiftKey && e.key === "ArrowRight") {
        e.preventDefault();
        this.switchToNext(1);
      }
      if (e.altKey && e.shiftKey && e.key === "ArrowLeft") {
        e.preventDefault();
        this.switchToNext(-1);
      }
      if (
        e.altKey &&
        e.shiftKey &&
        e.key === "ArrowDown" &&
        this.switchToAdjacentPane(1)
      ) {
        e.preventDefault();
        return;
      }
      if (
        e.altKey &&
        e.shiftKey &&
        e.key === "ArrowUp" &&
        this.switchToAdjacentPane(-1)
      ) {
        e.preventDefault();
        return;
      }
      if (e.ctrlKey && e.key === "f") {
        e.preventDefault();
        this.openTerminalSearch();
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
      // `?` is a literal character in task/commit/search inputs — only treat it
      // as the help shortcut when focus is not inside an editable field. F1 is a
      // function key (never typed as text) so it opens help anywhere.
      if (e.key === "F1" || (e.key === "?" && !isEditableTarget(e.target))) {
        e.preventDefault();
        this.openHelp();
      }
      // Ctrl+Alt+D - Toggle debug mode
      if (e.ctrlKey && e.altKey && e.key === "d") {
        e.preventDefault();
        this.toggleDebugMode();
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

  shouldBootstrapLinkedView(terminalInfo) {
    return Boolean(
      window.BootstrapRouting?.shouldBootstrapLinkedView?.({
        supportsLinkedView: Boolean(terminalInfo?.supportsLinkedView),
        hasForeignConnection: Boolean(terminalInfo?.hasForeignConnection),
      }),
    );
  }

  async bootstrapLinkedView(sourceTerminal) {
    const res = await fetch(
      `/api/terminals/${encodeURIComponent(sourceTerminal.id)}/linked-view`,
      { method: "POST" },
    );
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload.error || "Failed to create linked view");
    }

    await this.reconnectToTerminal(payload.id, payload.cwd, null, {
      showReconnectBanner: false,
      isReconnection: false,
      backendMode: payload.backendMode || null,
      supportsLinkedView: Boolean(payload.supportsLinkedView),
    });
  }

  async checkExistingTerminals() {
    try {
      const res = await fetch("/api/terminals", {
        headers: { "X-DeckTerm-Client-Id": this.clientInstanceId },
      });
      const serverTerminals = await res.json();
      const reconnectableTerminals = serverTerminals.filter(
        (terminal) =>
          terminal?.sessionStatus !== "ended" &&
          terminal?.status !== "inactive",
      );

      if (reconnectableTerminals.length > 0) {
        dbg(
          `[DeckTerm] Reconnecting to ${reconnectableTerminals.length} existing terminal(s)...`,
        );

        // Clean up stale sessions from registry
        this.sessionRegistry.cleanup(reconnectableTerminals.map((t) => t.id));

        const savedSessionsById = Object.fromEntries(
          reconnectableTerminals
            .map((t) => [t.id, this.sessionRegistry.get(t.id)])
            .filter(([, savedSession]) => Boolean(savedSession)),
        );
        const bootstrapActions =
          window.BootstrapRouting?.planBootstrapTerminals?.({
            serverTerminals: reconnectableTerminals,
            savedSessionsById,
          }) || [];

        for (const action of bootstrapActions) {
          const terminalInfo = reconnectableTerminals.find(
            (terminal) => terminal.id === action.terminalId,
          );
          if (!terminalInfo) continue;

          if (action.type === "linked-view") {
            await this.bootstrapLinkedView(terminalInfo);
            continue;
          }

          await this.reconnectToTerminal(
            terminalInfo.id,
            terminalInfo.cwd,
            action.savedSession,
            {
              backendMode: terminalInfo.backendMode || null,
              supportsLinkedView: Boolean(terminalInfo.supportsLinkedView),
            },
          );
        }
        return;
      }
    } catch (err) {
      console.error("Failed to check existing terminals:", err);
    }
    await this.createTerminal(false, { skipBootstrapWait: true });
  }

  async reconnectToTerminal(id, cwd, savedSession = null, options = {}) {
    const {
      showReconnectBanner = true,
      isReconnection = true,
      backendMode = null,
      supportsLinkedView = false,
    } = options;
    // Use saved workspace info if available, otherwise create new
    let workspaceId;
    let tabNum;
    const restoredCwd =
      typeof savedSession?.cwd === "string" && savedSession.cwd
        ? savedSession.cwd
        : cwd;

    if (savedSession?.workspaceId) {
      // Restore from saved session
      workspaceId = savedSession.workspaceId;
      tabNum = savedSession.tabNum || ++this.tabIndex;
      // Ensure workspaceIndex stays in sync
      const wsNum = parseInt(workspaceId.replace("ws-", ""), 10);
      if (wsNum > this.workspaceIndex) this.workspaceIndex = wsNum;
      if (tabNum > this.tabIndex) this.tabIndex = tabNum;
      dbg("[Reconnect] Restoring session:", id, savedSession);
    } else {
      // New workspace for this terminal
      this.workspaceIndex++;
      workspaceId = `ws-${this.workspaceIndex}`;
      this.tabIndex++;
      tabNum = this.tabIndex;
      dbg("[Reconnect] New workspace for:", id, workspaceId);
    }

    const workspaceAlreadyRestored =
      this.tileManager.getWorkspaceTiles(workspaceId).length > 0;
    const element = this.tileManager.createTile(
      id,
      workspaceId,
      false,
      (tid) => this.closeTerminal(tid),
      (tid) => this.detachTerminalToWorkspace(tid),
    );
    const overlay = this.createOverlay(element.parentElement);
    const dimensionOverlay = this.createDimensionOverlay(element.parentElement);

    const sizeWarning = document.createElement("div");
    sizeWarning.className = "size-warning";
    sizeWarning.textContent = "Terminal too small. Minimum size: 60x16";
    element.parentElement.appendChild(sizeWarning);

    // Build debug overlay with DOM methods (safe, no innerHTML)
    const debugOverlay = document.createElement("div");
    debugOverlay.className = "debug-overlay";
    const debugFields = ["container", "calculated", "actual", "delta"];
    const debugLabels = ["Container:", "Calculated:", "Actual:", "Delta:"];
    debugFields.forEach((field, i) => {
      const row = document.createElement("div");
      row.className = "debug-row";
      const label = document.createElement("span");
      label.className = "debug-label";
      label.textContent = debugLabels[i];
      const value = document.createElement("span");
      value.className = "debug-value";
      value.dataset.field = field;
      value.textContent = "0x0";
      row.appendChild(label);
      row.appendChild(value);
      debugOverlay.appendChild(row);
    });
    element.parentElement.appendChild(debugOverlay);

    const terminal = this.createXtermInstance(id);
    terminal.open(element);
    const activationCleanup = this.bindTerminalActivation(id, element);
    const webglAddon = this.setupTerminalRenderer(id, terminal);
    const osc7Disposable = this.attachOsc7Handler(id, terminal);

    const fitAddon = terminal._fitAddon;
    fitAddon.fit();
    this.normalizeTerminalGeometry({ terminal });

    dbg(`[reconnect] Attempting to reconnect terminal ${id}...`);
    if (showReconnectBanner) {
      terminal.write(
        "\x1b[33m[Reconnecting to existing terminal...]\x1b[0m\r\n",
      );
    }

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${location.host}/ws/terminals/${id}?clientId=${encodeURIComponent(this.clientInstanceId)}`;
    dbg(`[reconnect] WebSocket URL: ${wsUrl}`);

    const ws = new ReconnectingWebSocket(wsUrl, id, {
      onMessage: (data) => {
        // Log first 100 chars of received data for debugging
        if (data.length > 0 && data.length < 200) {
          dbg(`[reconnect] Received data for ${id}: ${data.length} bytes`);
        }
        terminal.write(data);
        this.queueTelemetryRefresh();
      },
      onStatusChange: (status, extra) => {
        dbg(`[reconnect] Status change for ${id}: ${status}`, extra);
        this.handleStatusChange(id, status, extra);
      },
      onLifecycle: (message) => {
        dbg(`[reconnect] Lifecycle for ${id}: ${message.phase}`, message);
        this.handleReconnectLifecycle(id, message);
      },
      onTerminalState: (message) => {
        this.applyTerminalRuntimeState(id, message);
      },
    });

    const inputState = this.createInputState();
    const onDataDisposable = terminal.onData((data) => {
      // Debug: direct DOM update
      const dbg = document.getElementById("modifier-debug");
      if (dbg)
        dbg.textContent = `onData1: "${data}" | mods: ${JSON.stringify(this.extraKeys?.modifiers)}`;

      const dedupedData = this.consumePendingFallbackEcho(inputState, data);
      if (!dedupedData) {
        if (dbg) dbg.textContent = "onData1: SKIP (fallback echo)";
        return;
      }

      inputState.lastOnDataAt = performance.now();
      inputState.lastOnDataValue = dedupedData;
      const finalData = this.applyExtraKeyModifiers(dedupedData);
      ws.send(JSON.stringify({ type: "input", data: finalData }));
    });

    const inputFallbackCleanup = this.attachMobileInputFallback(
      ws,
      element,
      inputState,
    );
    const pasteFallbackCleanup = this.attachClipboardPasteFallback(ws, element);
    dbg("[ExtraKeys] attachMobileInputFallback (reconnect)", {
      id,
      attached: !!inputFallbackCleanup,
    });

    this.terminals.set(id, {
      terminal,
      fitAddon,
      webglAddon,
      ws,
      element,
      overlay,
      dimensionOverlay,
      sizeWarning,
      debugOverlay,
      dimensionTimer: null,
      cwd: restoredCwd,
      running: false,
      busy: false,
      lastExitCode: null,
      agentName: null,
      agentState: null,
      ports: [],
      isWorktree: false,
      recentTools: [],
      backendMode,
      supportsLinkedView,
      tabNum,
      workspaceId,
      originalWorkspaceId: savedSession?.originalWorkspaceId || workspaceId,
      resizeObserver: null,
      resizeTimer: null,
      preferredCols: 0,
      lastSentCols: null,
      lastSentRows: null,
      fitFrame: 0,
      onDataDisposable,
      osc7Disposable,
      inputFallbackCleanup,
      pasteFallbackCleanup,
      activationCleanup,
      inputState,
      hasConnected: false, // Track if WebSocket has ever successfully connected
      isReconnection,
      awaitingReconnectReady: false,
      connectionStatus: "connecting",
    });

    dbg(`[reconnect] Terminal ${id} stored in Map with isReconnection=true`);

    // Register with session registry for future reconnection
    this.sessionRegistry.register(id, {
      workspaceId,
      cwd: restoredCwd,
      tabNum,
      originalWorkspaceId: savedSession?.originalWorkspaceId || workspaceId,
    });

    if (!this.getWorkspaceTab(workspaceId)) {
      this.addTab(id, restoredCwd, tabNum, workspaceId);
    } else {
      this.retargetWorkspaceTab(workspaceId);
      // Restored panes can share a workspace before telemetry has completed.
      // Refresh pane count/detach chrome immediately instead of depending on
      // a later catalog response to reveal the multi-pane state.
      this.updateTabGroups();
    }
    if (workspaceAlreadyRestored) {
      this.tileManager.relayout(workspaceId);
    }
    this.queueTelemetryRefresh(0);
    this.switchTo(id);
    this.attachResizeObserver(id);
    this.scheduleTerminalMetricStabilization(id);

    setTimeout(() => {
      this.fitTerminal(id);
      this.syncTerminalSize(id);
      this.disableMobileKeyboardFeatures(element);
    }, 200);
  }

  // Disable autocorrect, autocomplete, etc. on mobile - must use setAttribute for mobile browsers
  disableMobileKeyboardFeatures(element) {
    const textarea = element.querySelector(".xterm-helper-textarea");
    if (textarea) {
      textarea.setAttribute("autocomplete", "off");
      textarea.setAttribute("autocorrect", "off");
      textarea.setAttribute("autocapitalize", "off");
      textarea.setAttribute("spellcheck", "false");
      textarea.setAttribute("data-gramm", "false"); // Grammarly
      textarea.setAttribute("data-gramm_editor", "false");
      // For iOS
      textarea.setAttribute("inputmode", "text");
      dbg("[ExtraKeys] Mobile keyboard features disabled on textarea");
    }
  }

  createInputState() {
    return {
      lastOnDataAt: 0,
      lastOnDataValue: "",
      lastFallbackAt: 0,
      lastFallbackData: "",
      pendingFallbackEcho: "",
    };
  }

  rememberFallbackEcho(inputState, data) {
    if (!inputState || !data) return;

    inputState.lastFallbackAt = performance.now();
    inputState.lastFallbackData = data;
    inputState.pendingFallbackEcho =
      `${inputState.pendingFallbackEcho || ""}${data}`.slice(-256);
  }

  consumePendingFallbackEcho(inputState, data) {
    if (!inputState || !data) return data;

    let pending = inputState.pendingFallbackEcho || "";
    let remainingData = data;

    while (pending && remainingData) {
      if (pending.startsWith(remainingData)) {
        inputState.pendingFallbackEcho = pending.slice(remainingData.length);
        return "";
      }

      if (remainingData.startsWith(pending)) {
        remainingData = remainingData.slice(pending.length);
        pending = "";
        break;
      }

      let overlap = 0;
      const limit = Math.min(pending.length, remainingData.length);
      while (
        overlap < limit &&
        pending.charCodeAt(overlap) === remainingData.charCodeAt(overlap)
      ) {
        overlap += 1;
      }

      if (!overlap) break;

      pending = pending.slice(overlap);
      remainingData = remainingData.slice(overlap);
    }

    inputState.pendingFallbackEcho = pending;
    return remainingData;
  }

  applyExtraKeyModifiers(data, options = {}) {
    let finalData = data;
    const mods = this.extraKeys?.modifiers;

    // ALWAYS log for debugging mobile issues
    dbg("[ExtraKeys] applyExtraKeyModifiers called:", {
      data: JSON.stringify(data),
      hasExtraKeys: !!this.extraKeys,
      mods: mods ? JSON.stringify(mods) : "null",
    });

    // Always update debug overlay to show input was received
    this.extraKeys?.updateDebug(data, null);

    if (!this.extraKeys || !mods || !data) {
      dbg(
        "[ExtraKeys] applyExtraKeyModifiers: early return - no extraKeys or mods or data",
      );
      this.extraKeys?.updateDebug(data, "[NO MODS]");
      return finalData;
    }

    const hasModifier = mods.ctrl || mods.alt || mods.shift;
    if (!hasModifier) {
      dbg("[ExtraKeys] applyExtraKeyModifiers: no modifier active");
      this.extraKeys?.updateDebug(data, data + " [no mod]");
      return finalData;
    }

    dbg("[ExtraKeys] applyExtraKeyModifiers: APPLYING modifier!", {
      mods,
    });

    if (mods.ctrl) {
      // CTRL: convert each alphabetic char to control code
      finalData = "";
      for (const char of data) {
        const charCode = char.toUpperCase().charCodeAt(0);
        if (charCode >= 65 && charCode <= 90) {
          finalData += String.fromCharCode(charCode - 64);
        } else {
          finalData += char;
        }
      }
      if (options.log) {
        dbg("[ExtraKeys] Applied CTRL, finalData:", JSON.stringify(finalData));
      }
      // Don't reset - modifiers stay active until user toggles them off
    } else if (mods.alt) {
      // ALT: prefix entire string with ESC
      finalData = "\x1b" + data;
      if (options.log) dbg("[ExtraKeys] Applied ALT");
      // Don't reset - modifiers stay active until user toggles them off
    } else if (mods.shift) {
      // SHIFT: uppercase entire string
      finalData = data.toUpperCase();
      if (options.log) {
        dbg("[ExtraKeys] Applied SHIFT, finalData:", JSON.stringify(finalData));
      }
      // Don't reset - modifiers stay active until user toggles them off
    }

    // Update visible debug overlay with input/output
    this.extraKeys?.updateDebug(data, finalData);

    return finalData;
  }

  attachMobileInputFallback(ws, element, inputState = null) {
    if (!ws || !element) {
      dbg("[ExtraKeys] mobile input fallback skipped", {
        reason: !ws ? "no-ws" : "no-element",
      });
      return null;
    }
    const textarea = element.querySelector(".xterm-helper-textarea");
    if (!textarea) {
      dbg("[ExtraKeys] mobile input fallback skipped", {
        reason: "no-textarea",
        childCount: element.childElementCount,
      });
      return null;
    }

    if (DEBUG) {
      dbg("[ExtraKeys] mobile input fallback attached", {
        isMobile: platformDetector.isMobile,
        hasTouch: platformDetector.hasTouch,
        isCoarsePointer: platformDetector.isCoarsePointer,
        noHover: platformDetector.noHover,
        smallScreen: platformDetector.smallScreen,
      });
    }

    let lastValue = textarea.value || "";
    let lastCompositionCommitAt = 0;
    let lastCompositionCommitData = "";
    const shouldUseFallback = () =>
      inputFallbackHelpers.shouldUseMobileInputFallback({
        isMobile: platformDetector.isMobile,
        hasTouch: platformDetector.hasTouch,
        isVirtualKeyboardOpen: document.body.classList.contains(
          "virtual-keyboard-open",
        ),
      });

    const sendCommittedData = (source, inputType, data, e) => {
      if (!data) {
        return false;
      }

      // Track fallback-originated input so delayed xterm echoes can be skipped.
      this.rememberFallbackEcho(inputState, data);

      const finalData = this.applyExtraKeyModifiers(data);
      ws.send(JSON.stringify({ type: "input", data: finalData }));

      if (DEBUG) {
        dbg("[ExtraKeys] mobile input fallback:", {
          source,
          inputType,
          composed: e?.composed,
          data,
          finalData,
        });
      }

      textarea.value = "";
      lastValue = "";
      lastCompositionCommitAt = performance.now();
      lastCompositionCommitData = data;
      return true;
    };

    const commitTextareaValue = (source, e) => {
      // Debug: direct DOM update
      const dbg = document.getElementById("modifier-debug");
      if (dbg)
        dbg.textContent = `commit:${source} | touch:${platformDetector.hasTouch}`;

      // Only use the fallback for mobile-style text entry or an open virtual
      // keyboard; hybrid desktops should stay on xterm's native key handling.
      if (!shouldUseFallback()) {
        if (dbg) dbg.textContent = `!touch - skipping`;
        return;
      }
      const inputType = e?.inputType || source || "";
      let data = typeof e?.data === "string" ? e.data : "";
      const currentValue = textarea.value || "";

      if (!data) {
        if (currentValue.startsWith(lastValue)) {
          data = currentValue.slice(lastValue.length);
        } else if (lastValue.startsWith(currentValue)) {
          const diff = lastValue.length - currentValue.length;
          if (diff > 0) data = "\x7f".repeat(diff);
        } else {
          data = currentValue;
        }
      }

      if (!data) {
        lastValue = currentValue;
        return;
      }

      sendCommittedData(source, inputType, data, e);
    };
    const handler = (e) => {
      if (DEBUG) {
        dbg("[ExtraKeys] mobile input event", {
          hasTouch: platformDetector.hasTouch,
          inputType: e?.inputType,
          isComposing: e?.isComposing,
          composed: e?.composed,
          data: e?.data,
        });
      }
      // Hybrid touch desktops should ignore the fallback and let xterm own input.
      if (!shouldUseFallback()) {
        lastValue = textarea.value || "";
        return;
      }
      if (!e) {
        return;
      }
      // DON'T skip isComposing! Mobile keyboards use composition for ALL input.
      // We need to process each character immediately, not wait for composition end.

      const inputType = e.inputType || "";
      if (inputType === "insertText") {
        const recent = performance.now() - lastCompositionCommitAt < 50;
        const sameData =
          typeof e.data === "string" && e.data === lastCompositionCommitData;
        if (recent && sameData) {
          return;
        }
      }
      if (inputType === "insertText" && inputState) {
        const recent = performance.now() - (inputState.lastOnDataAt || 0) < 30;
        const sameData =
          typeof e.data === "string" && e.data === inputState.lastOnDataValue;
        if (recent && sameData) {
          return;
        }
      }
      commitTextareaValue("input", e);
    };

    const compositionHandler = (type) => (e) => {
      if (DEBUG) {
        dbg("[ExtraKeys] composition event", {
          type,
          data: e?.data,
          isComposing: e?.isComposing,
          inputType: e?.inputType,
          value: textarea.value,
        });
      }
      if (type === "end") {
        commitTextareaValue("compositionend", e);
      }
    };

    const beforeInputHandler = (e) => {
      if (DEBUG) {
        dbg("[ExtraKeys] beforeinput", {
          inputType: e?.inputType,
          data: e?.data,
          isComposing: e?.isComposing,
          value: textarea.value,
        });
      }

      if (!shouldUseFallback() || !e || e.isComposing) {
        return;
      }

      const inputType = e.inputType || "";
      if (inputType !== "insertText" && inputType !== "insertReplacementText") {
        return;
      }

      const data = typeof e.data === "string" ? e.data : "";
      if (!data) {
        return;
      }

      e.preventDefault();
      sendCommittedData("beforeinput", inputType, data, e);
    };

    const compositionStartHandler = compositionHandler("start");
    const compositionUpdateHandler = compositionHandler("update");
    const compositionEndHandler = compositionHandler("end");

    textarea.addEventListener("input", handler, true);
    textarea.addEventListener(
      "compositionstart",
      compositionStartHandler,
      true,
    );
    textarea.addEventListener(
      "compositionupdate",
      compositionUpdateHandler,
      true,
    );
    textarea.addEventListener("compositionend", compositionEndHandler, true);
    textarea.addEventListener("beforeinput", beforeInputHandler, true);

    return () => {
      textarea.removeEventListener("input", handler, true);
      textarea.removeEventListener(
        "compositionstart",
        compositionStartHandler,
        true,
      );
      textarea.removeEventListener(
        "compositionupdate",
        compositionUpdateHandler,
        true,
      );
      textarea.removeEventListener(
        "compositionend",
        compositionEndHandler,
        true,
      );
      textarea.removeEventListener("beforeinput", beforeInputHandler, true);
    };
  }

  attachClipboardPasteFallback(ws, element) {
    if (!ws || !element) return null;

    const textarea = element.querySelector(".xterm-helper-textarea");
    if (!textarea) return null;

    const pasteHandler = (event) => {
      if (!event.clipboardData) return;
      event.preventDefault();
      // stopImmediatePropagation is essential: xterm.js registers its own
      // `paste` listeners on the inner .xterm element + helper textarea, and
      // preventDefault alone does NOT stop them from firing. Without this we
      // paste twice (once here, once via xterm's onData). We attach on the
      // container in the capture phase (below) so this handler always runs
      // before xterm's descendant listeners, then halt the event here.
      event.stopImmediatePropagation();
      this.clipboardManager
        .handlePaste(ws, event.clipboardData)
        .catch((err) => {
          console.error("Clipboard paste fallback failed:", err);
        });
    };

    // Capture phase on the container (an ancestor of the .xterm element and
    // helper textarea) guarantees we intercept before xterm's own listeners.
    element.addEventListener("paste", pasteHandler, true);
    return () => {
      element.removeEventListener("paste", pasteHandler, true);
    };
  }

  createXtermInstance(id) {
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
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: this.fontSize,
      lineHeight: TERMINAL_LINE_HEIGHT,
      scrollback: 10000,
      cursorBlink: true,
      allowProposedApi: true,
      scrollOnUserInput: true,
      smoothScrollDuration: 0,
    });

    const fitAddon = new FitAddon.FitAddon();
    const webLinksAddon = new WebLinksAddon.WebLinksAddon();
    const searchAddon = new SearchAddon.SearchAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.loadAddon(searchAddon);
    terminal._fitAddon = fitAddon;
    terminal._searchAddon = searchAddon;

    // Unicode11: correct wide-char (CJK/emoji) column metrics. Always on,
    // independent of the terminal.renderer setting. Guarded so a missing
    // vendor script degrades gracefully instead of crashing terminal creation.
    if (typeof window.Unicode11Addon !== "undefined") {
      try {
        terminal.loadAddon(new window.Unicode11Addon.Unicode11Addon());
        terminal.unicode.activeVersion = "11";
      } catch (err) {
        console.warn("[terminal] Failed to load Unicode11 addon", err);
      }
    } else {
      console.warn(
        "[terminal] Unicode11Addon vendor script not loaded; using default unicode version",
      );
    }

    // OSC52 clipboard support (xterm.js 6.0+)
    if (terminal.parser?.registerOscHandler) {
      terminal.parser.registerOscHandler(52, (data) => {
        this.clipboardManager.handleOsc52(data);
        return true;
      });
    }

    // Intercept Ctrl+V for clipboard paste with large content warning
    terminal.attachCustomKeyEventHandler((event) => {
      if (
        event.type === "keydown" &&
        event.altKey &&
        event.shiftKey &&
        (event.key === "ArrowDown" || event.key === "ArrowUp")
      ) {
        const switched = this.switchToAdjacentPane(
          event.key === "ArrowDown" ? 1 : -1,
        );
        if (switched) {
          event.preventDefault();
          this.handledPaneShortcutEvents.add(event);
          return false;
        }
      }

      // Ctrl+Shift+F: scrollback search overlay
      if (
        event.ctrlKey &&
        event.shiftKey &&
        event.type === "keydown" &&
        (event.key === "F" || event.key === "f")
      ) {
        event.preventDefault();
        this.openTerminalSearch();
        return false;
      }
      // Ctrl+V or Cmd+V
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "v" &&
        event.type === "keydown"
      ) {
        this.activateTerminal(id);
        if (event.shiftKey) {
          // Ctrl+Shift+V (and similar "paste as plain text"): the browser
          // fires a native `paste` event that attachClipboardPasteFallback
          // already handles exactly once. Returning false only stops xterm
          // from emitting a literal ^V (0x16); we deliberately do NOT
          // preventDefault here — otherwise the native paste is cancelled
          // and nothing pastes. Intercepting here too would paste twice.
          return false;
        }
        event.preventDefault();
        const termData = this.terminals.get(id);
        if (termData?.ws) {
          this.clipboardManager.handlePaste(termData.ws);
        }
        return false; // Prevent default xterm handling
      }
      return true; // Allow other keys
    });

    // Auto-copy on selection (if enabled)
    terminal.onSelectionChange(() => {
      this.clipboardManager?.handleSelectionChange(terminal);
    });

    return terminal;
  }

  // GPU renderer wiring for the `terminal.renderer` setting (auto|default).
  // Called once per terminal, right after terminal.open(). Returns the loaded
  // WebglAddon instance (to be tracked as termData.webglAddon) or null when
  // the addon was not loaded — leaving xterm 5.3.0's default renderer active,
  // exactly as before this setting existed.
  //
  // "default": never loads the addon (byte-identical to pre-existing
  // behavior — the addon script is never even evaluated into behavior).
  // "auto" (also the fallback for unset/unknown values): loads the addon only
  // when a cached, once-per-page WebGL2 probe succeeded. Any failure while
  // constructing/loading the addon disposes it and falls back to default.
  setupTerminalRenderer(id, terminal) {
    const setting =
      this.settingsStore?.get("terminal.renderer", "auto") ?? "auto";
    const probeResult = probeWebgl2Support();
    const plan =
      window.TerminalRenderer?.decideRendererPlan?.(setting, probeResult) || {};
    if (!plan.loadWebgl) return null;

    if (typeof window.WebglAddon === "undefined") {
      console.warn(
        "[terminal-renderer] WebglAddon vendor script not loaded; using default renderer",
      );
      return null;
    }

    let webglAddon = null;
    try {
      webglAddon = new window.WebglAddon.WebglAddon();
      terminal.loadAddon(webglAddon);
      webglAddon.onContextLoss(() => {
        try {
          webglAddon.dispose();
        } catch (err) {
          if (DEBUG)
            dbg("[renderer] webgl dispose-on-context-loss error", { id, err });
        }
        const t = this.terminals.get(id);
        if (t) t.webglAddon = null;
        if (terminal._webglAddon === webglAddon) terminal._webglAddon = null;
        console.warn(
          `[terminal-renderer] WebGL context lost for terminal ${id}; fell back to default renderer`,
        );
      });
    } catch (err) {
      console.warn(
        "[terminal-renderer] Failed to load WebGL addon, using default renderer",
        err,
      );
      try {
        webglAddon?.dispose?.();
      } catch {
        // Already in a bad state — nothing more to clean up.
      }
      return null;
    }

    terminal._webglAddon = webglAddon;
    return webglAddon;
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

  // --- Scrollback search (Ctrl+Shift+F) -------------------------------------
  // One shared bar + controller, rebound to the active terminal's SearchAddon
  // on each open. State logic lives in web/search-overlay.js.

  ensureSearchBar() {
    if (this.searchBar) return this.searchBar;
    const bar = document.createElement("div");
    bar.className = "terminal-search-bar hidden";
    bar.innerHTML = `
      <input type="text" class="search-input" placeholder="Search scrollback" spellcheck="false" autocomplete="off" />
      <span class="search-count" aria-live="polite"></span>
      <button type="button" class="search-btn" data-search-act="prev" title="Previous match (Shift+Enter)">↑</button>
      <button type="button" class="search-btn" data-search-act="next" title="Next match (Enter)">↓</button>
      <button type="button" class="search-btn" data-search-act="close" title="Close (Esc)">✕</button>
    `;
    const input = bar.querySelector(".search-input");
    input.addEventListener("input", () => {
      this.searchController?.setQuery(input.value);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "F3") {
        e.preventDefault();
        if (e.shiftKey) this.searchController?.prev();
        else this.searchController?.next();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.closeTerminalSearch({ refocus: true });
      }
    });
    bar.addEventListener("click", (e) => {
      const act = e.target?.dataset?.searchAct;
      if (act === "prev") this.searchController?.prev();
      else if (act === "next") this.searchController?.next();
      else if (act === "close") this.closeTerminalSearch({ refocus: true });
    });
    this.searchBar = bar;
    return bar;
  }

  openTerminalSearch() {
    const active = this.getActiveTerminal();
    const addon = active?.terminal?._searchAddon;
    if (!addon) return;

    const bar = this.ensureSearchBar();
    const host = active.element?.parentElement || active.element;
    if (bar.parentElement !== host) host.appendChild(bar);

    this.searchResultsDisposable?.dispose?.();
    this.searchController = window.SearchOverlay.createSearchController({
      searchApi: {
        findNext: (q, opts) =>
          addon.findNext(q, {
            ...opts,
            decorations: TERMINAL_SEARCH_DECORATIONS,
          }),
        findPrevious: (q, opts) =>
          addon.findPrevious(q, {
            ...opts,
            decorations: TERMINAL_SEARCH_DECORATIONS,
          }),
        clearDecorations: () => addon.clearDecorations(),
      },
      onState: (state) => this.renderSearchState(state),
    });
    this.searchResultsDisposable = addon.onDidChangeResults?.((r) =>
      this.searchController?.handleResults(
        r || { resultIndex: -1, resultCount: 0 },
      ),
    );

    // Prefill: short single-line selection wins, then the last search.
    const selection = active.terminal.getSelection?.()?.trim() || "";
    const prefill =
      selection && selection.length <= 200 && !selection.includes("\n")
        ? selection
        : this.searchLastQuery || "";
    const input = bar.querySelector(".search-input");
    input.value = prefill;
    this.searchController.open(prefill ? { query: prefill } : undefined);
    input.focus();
    input.select();
  }

  closeTerminalSearch({ refocus = false } = {}) {
    if (!this.searchController) return;
    this.searchLastQuery =
      this.searchController.getState().query || this.searchLastQuery || "";
    this.searchController.close();
    this.searchController = null;
    this.searchResultsDisposable?.dispose?.();
    this.searchResultsDisposable = null;
    this.searchBar?.classList.add("hidden");
    if (refocus) this.getActiveTerminal()?.terminal?.focus();
  }

  renderSearchState(state) {
    const bar = this.ensureSearchBar();
    bar.classList.toggle("hidden", !state.open);
    const count = bar.querySelector(".search-count");
    if (!state.query || state.resultCount === null) {
      count.textContent = "";
    } else if (state.resultCount === 0) {
      count.textContent = "0/0";
    } else {
      count.textContent = `${state.resultIndex + 1}/${state.resultCount}`;
    }
  }

  createDimensionOverlay(container) {
    const overlay = document.createElement("div");
    overlay.className = "dimension-overlay";
    overlay.textContent = "80x24";
    container.appendChild(overlay);
    return overlay;
  }

  updateOverlay(id, status, extra = {}) {
    const t = this.terminals.get(id);
    if (!t?.overlay) return;

    const overlay = t.overlay;
    const icon = overlay.querySelector(".overlay-icon");
    const message = overlay.querySelector(".overlay-message");
    const actions = overlay.querySelector(".overlay-actions");

    // Any status change invalidates a running next-attempt countdown.
    clearInterval(t.reconnectCountdownTimer);
    t.reconnectCountdownTimer = null;

    const formatAttempt = window.ReconnectClassify.formatReconnectAttempt;
    const overlayConfigs = {
      connected: { hidden: true },
      reconnecting: {
        icon: "🔄",
        message: formatAttempt({
          attempt: extra.attempt,
          maxRetries: extra.maxRetries,
          secondsLeft: Math.round((extra.delay || 0) / 1000),
        }),
        actions: "",
      },
      failed: {
        icon: "❌",
        message: "Connection lost",
        actions: `
        <button class="btn" data-overlay-action="retry">Retry</button>
        <button class="btn" data-overlay-action="close">Close</button>
      `,
      },
      dead: {
        icon: "💀",
        message: "Terminal no longer exists",
        actions: `
        <button class="btn btn-primary" data-overlay-action="new-terminal">New Terminal</button>
        <button class="btn" data-overlay-action="close">Close</button>
      `,
      },
      setup_required: {
        icon: "🔒",
        message:
          "Terminal access is locked — server setup (bootstrap) or permission is required.",
        actions: `
        <button class="btn btn-primary" data-overlay-action="setup">Open Setup</button>
        <button class="btn" data-overlay-action="retry">Retry</button>
        <button class="btn" data-overlay-action="close">Close</button>
      `,
      },
      taken_over: {
        icon: "📱",
        message: "Session resumed on another device",
        actions: `
        <button class="btn" data-overlay-action="retry">Resume Here</button>
        <button class="btn" data-overlay-action="close">Close</button>
      `,
      },
      exited: {
        icon: "⏹️",
        message: `Process exited with code ${extra}`,
        actions: `
        <button class="btn btn-primary" data-overlay-action="new-terminal">New Terminal</button>
        <button class="btn" data-overlay-action="close">Close</button>
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
      actions.onclick = (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const button = target?.closest("[data-overlay-action]");
        if (!button) return;
        const action = button.dataset.overlayAction;
        if (action === "retry") {
          this.retryConnection(id);
          return;
        }
        if (action === "new-terminal") {
          this.closeTerminal(id);
          this.createTerminal();
          return;
        }
        if (action === "setup") {
          this.openSetupPanel?.();
          return;
        }
        if (action === "close") {
          this.closeTerminal(id);
        }
      };

      if (status === "reconnecting" && extra.delay > 1000) {
        const deadline = Date.now() + extra.delay;
        t.reconnectCountdownTimer = setInterval(() => {
          const secondsLeft = Math.round((deadline - Date.now()) / 1000);
          message.textContent = formatAttempt({
            attempt: extra.attempt,
            maxRetries: extra.maxRetries,
            secondsLeft,
          });
          if (secondsLeft <= 0) {
            clearInterval(t.reconnectCountdownTimer);
            t.reconnectCountdownTimer = null;
          }
        }, 1000);
      }
    }
  }

  handleStatusChange(id, status, extra) {
    const t = this.terminals.get(id);
    const waitingForReplay = Boolean(
      status === "connected" &&
        (t?.awaitingReconnectReady || t?.ws?.awaitingReconnectReady),
    );
    const effectiveStatus = waitingForReplay ? "reconnecting" : status;

    if (t) {
      t.connectionStatus = effectiveStatus;
      if (
        !["connecting", "reconnecting"].includes(
          this.normalizeConnectionStatus(effectiveStatus),
        )
      ) {
        t.awaitingReconnectReady = false;
      }
    }

    this.updateOverlay(id, effectiveStatus, extra);
    if (id === this.activeId) {
      this.updateConnectionStatus(
        t
          ? this.getTerminalConnectionStatus(t)
          : this.normalizeConnectionStatus(effectiveStatus),
      );
    }

    if (effectiveStatus === "connected") {
      // Mark terminal as successfully connected
      if (t) {
        t.hasConnected = true;
        dbg(`[reconnect] Terminal ${id} marked as hasConnected=true`);
      }

      this.performReconnectLayoutSync(id, {
        forceResize: true,
        scrollToPrompt: platformDetector.hasTouch,
      });
    } else if (waitingForReplay) {
      dbg(`[reconnect] Transport connected for ${id}, waiting for ready`);
    }

    const tab =
      this.getWorkspaceTab(t?.workspaceId) ||
      this.tabs.querySelector(`[data-id="${id}"]`);
    dbg(
      `[reconnect] Tab update for ${id}: status=${effectiveStatus}, tab found=${!!tab}, hasConnected=${t?.hasConnected}`,
    );
    if (tab) {
      this.applyWorkspaceConnectionState(tab, t?.workspaceId, [
        effectiveStatus,
      ]);
      dbg(`[reconnect] Workspace ${t?.workspaceId || id} status updated`);
    } else if (t) {
      console.warn(`[reconnect] Tab not found for ${id}!`);
    }
    this.updatePaneControls();
  }

  retryConnection(id) {
    this.terminals.get(id)?.ws?.retry();
  }

  performReconnectLayoutSync(
    id,
    { forceResize = false, scrollToPrompt = false } = {},
  ) {
    const t = this.terminals.get(id);
    if (!t?.fitAddon || !t?.terminal) return;

    requestAnimationFrame(() => {
      try {
        this.fitTerminalState(t);
        this.sendResize(id, t.terminal.cols, t.terminal.rows, {
          force: forceResize,
        });
        t.terminal.refresh(0, Math.max(0, t.terminal.rows - 1));
        if (scrollToPrompt) {
          t.terminal.scrollToBottom();
          const viewport = this.getTerminalViewport(t);
          if (viewport) viewport.scrollTop = viewport.scrollHeight;
        }
      } catch (err) {
        console.warn(`[reconnect] Layout sync failed for ${id}:`, err);
      }
    });
  }

  handleReconnectLifecycle(id, message) {
    const t = this.terminals.get(id);
    if (!t) return;

    if (message.phase === "replay-start") {
      t.awaitingReconnectReady = true;
      t.connectionStatus = "reconnecting";
      if (id === this.activeId) {
        this.updateConnectionStatus("reconnecting");
      }
      const tab = this.getWorkspaceTab(t.workspaceId);
      if (tab) this.applyWorkspaceConnectionState(tab, t.workspaceId);
      this.updatePaneControls();
      return;
    }

    if (message.phase === "replay-complete") {
      this.performReconnectLayoutSync(id, {
        forceResize: true,
        scrollToPrompt: platformDetector.hasTouch,
      });
      t.ws?.send(JSON.stringify({ type: "resume-ready" }));
      return;
    }

    if (message.phase === "ready") {
      t.awaitingReconnectReady = false;
      if (id === this.activeId) {
        this.focusTerminal(id, {
          syncSize: false,
          scrollToPrompt: platformDetector.hasTouch,
          ensureVisible: false,
        });
      }
    }
  }

  scheduleResize(id) {
    const t = this.terminals.get(id);
    if (!t) return;
    if (t.resizeTimer) clearTimeout(t.resizeTimer);
    t.resizeTimer = setTimeout(() => {
      this.syncTerminalSize(id);
    }, this.resizeDebounceMs);
  }

  showDimensionOverlay(id) {
    const t = this.terminals.get(id);
    if (!t?.dimensionOverlay || !t.terminal) return;

    const cols = t.terminal.cols;
    const rows = t.terminal.rows;

    t.dimensionOverlay.textContent = `${cols}x${rows}`;
    t.dimensionOverlay.classList.add("visible");

    // Clear existing timer
    if (t.dimensionTimer) clearTimeout(t.dimensionTimer);

    // Hide after 1 second
    t.dimensionTimer = setTimeout(() => {
      t.dimensionOverlay.classList.remove("visible");
    }, 1000);

    if (this.debugMode) {
      this.updateDebugOverlay(id);
    }
  }

  toggleDebugMode() {
    this.debugMode = !this.debugMode;
    for (const [id, t] of this.terminals) {
      if (t.debugOverlay) {
        t.debugOverlay.classList.toggle("visible", this.debugMode);
        if (this.debugMode) {
          this.updateDebugOverlay(id);
        }
      }
    }
    dbg(`[debug] Terminal debug mode: ${this.debugMode ? "ON" : "OFF"}`);
  }

  updateDebugOverlay(id) {
    const t = this.terminals.get(id);
    if (!t?.debugOverlay || !t.terminal || !t.element || !this.debugMode)
      return;

    const containerWidth = t.element.offsetWidth;
    const containerHeight = t.element.offsetHeight;

    // Calculate expected dimensions based on cell size
    const dims = t.terminal._core._renderService?.dimensions;
    const cellWidth = dims?.css?.cell?.width || 9;
    const cellHeight = dims?.css?.cell?.height || 18;

    const expectedCols = Math.floor((containerWidth - 16) / cellWidth); // 16px padding
    const expectedRows = Math.floor((containerHeight - 16) / cellHeight);

    const actualCols = t.terminal.cols;
    const actualRows = t.terminal.rows;

    const deltaCol = actualCols - expectedCols;
    const deltaRow = actualRows - expectedRows;

    const fields = t.debugOverlay.querySelectorAll("[data-field]");
    fields.forEach((field) => {
      const name = field.dataset.field;
      if (name === "container")
        field.textContent = `${containerWidth}x${containerHeight}px`;
      if (name === "calculated")
        field.textContent = `${expectedCols}x${expectedRows}`;
      if (name === "actual") field.textContent = `${actualCols}x${actualRows}`;
      if (name === "delta") {
        const sign1 = deltaCol >= 0 ? "+" : "";
        const sign2 = deltaRow >= 0 ? "+" : "";
        field.textContent = `${sign1}${deltaCol} / ${sign2}${deltaRow}`;
        field.classList.toggle("mismatch", deltaCol !== 0 || deltaRow !== 0);
      }
    });
  }

  syncTerminalSize(id) {
    const t = this.terminals.get(id);
    if (!t?.terminal) return;
    const fitCols = t.terminal.cols;
    const fitRows = t.terminal.rows;
    // Keep sizing anchored to the current container size to avoid stale oversizing.
    t.preferredCols = fitCols;
    this.sendResize(id, fitCols, fitRows);
  }

  attachResizeObserver(id) {
    const t = this.terminals.get(id);
    if (!t?.element || !t.fitAddon) return;

    if (t.resizeObserver) {
      t.resizeObserver.disconnect();
    }

    const observer = new ResizeObserver(() => {
      if (!t.element || t.element.offsetParent === null) return;
      if (t.fitFrame) return;
      t.fitFrame = requestAnimationFrame(() => {
        t.fitFrame = 0;
        try {
          const prevCols = t.terminal?.cols;
          const prevRows = t.terminal?.rows;
          this.fitTerminalState(t);
          // fitTerminalState only recomputes cols/rows and tells the PTY —
          // it does NOT repaint the buffer. Every other resize path in this
          // file (performReconnectLayoutSync, scheduleTerminalMetricStabilization,
          // toggleFullscreen) follows fit with an explicit refresh; this was the
          // one ResizeObserver-driven path that skipped it, which let a resize
          // mid-drag (IDE sash, dock sash) leave stale/corrupted glyph rows
          // until something else happened to repaint (bug A3a).
          t.terminal.refresh(0, Math.max(0, t.terminal.rows - 1));

          // Match compact chrome behavior to the SAME mobile decision as the
          // toolbar/action-bar chrome swap (getActiveChromeMode / chrome-mobile),
          // not just the width-based smallScreen check. A landscape phone (e.g.
          // 844x390) gets mobile chrome via isMobile even though it isn't
          // smallScreen by width alone — it must not be held to the desktop
          // 60x16 threshold with the warning left un-suppressed.
          const cols = t.terminal.cols;
          const rows = t.terminal.rows;
          const usesCompactLayout = this.getActiveChromeMode() === "mobile";
          const minCols = usesCompactLayout ? 40 : 60;
          const minRows = usesCompactLayout ? 12 : 16;
          const isTooSmall = cols < minCols || rows < minRows;

          // Hide the warning for compact layouts where the bottom action bar
          // is expected, for the bottom dock where a short terminal strip is
          // the whole point, and for the IDE mode bottom panel — its fixed
          // activity-bar + sidebar chrome routinely squeezes the main column
          // below 60 cols at ordinary desktop widths even though the
          // resulting terminal is perfectly usable (same class of
          // "intentionally short/narrow docked panel" as sessionsDocked).
          const sessionsDocked =
            document.body.classList.contains("sessions-docked");
          const ideDocked = document.body.classList.contains("ide-mode");
          if (t.sizeWarning) {
            const showWarning =
              isTooSmall && !usesCompactLayout && !sessionsDocked && !ideDocked;
            t.sizeWarning.classList.toggle("visible", showWarning);
            if (showWarning) {
              // Keep the warning copy honest — render the ACTUAL thresholds
              // used above instead of a hardcoded string that can drift.
              t.sizeWarning.textContent = `Terminal too small. Minimum size: ${minCols}x${minRows}`;
            }
          }

          // Always send resize - terminal will work even if small
          this.scheduleResize(id);

          // Only flash the ColsxRows overlay when the GRID actually changed —
          // sub-cell container jitter (toolbar reflow, badge updates, 1px
          // sash noise) used to storm every visible terminal with overlays.
          if (t.terminal.cols !== prevCols || t.terminal.rows !== prevRows) {
            this.showDimensionOverlay(id);
          }
        } catch (err) {
          if (DEBUG) dbg("resizeObserver error", { id, err });
        }
      });
    });

    observer.observe(t.element);
    t.resizeObserver = observer;
  }

  // Create a new terminal in a new workspace (split=false) or current workspace (split=true)
  async createTerminal(split = false, options = {}) {
    const { skipBootstrapWait = false, cwd: cwdOverride } = options;
    if (!skipBootstrapWait) {
      await this.waitForBootstrap();
    }
    await this.waitForFontMetrics();

    const cwd = cwdOverride || this.getCurrentDirectoryValue() || undefined;
    const { cols, rows } = this.estimateInitialTerminalSize(split);

    try {
      const res = await fetch("/api/terminals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, cols, rows }),
      });

      if (!res.ok) {
        // Surface the backend's real reason (e.g. SQLITE_BUSY-driven 500,
        // max-terminals limit, bad cwd) instead of a generic, doubled message.
        let reason = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          reason = body.message || body.error || reason;
        } catch (_) {
          /* non-JSON body — keep the status code */
        }
        throw new Error(reason);
      }

      const terminalInfo = await res.json();
      const { id } = terminalInfo;
      const resolvedCwd = terminalInfo.cwd || cwd;

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

      const element = this.tileManager.createTile(
        id,
        workspaceId,
        split,
        (tid) => this.closeTerminal(tid),
        (tid) => this.detachTerminalToWorkspace(tid),
      );
      const overlay = this.createOverlay(element.parentElement);
      const dimensionOverlay = this.createDimensionOverlay(
        element.parentElement,
      );

      const sizeWarning = document.createElement("div");
      sizeWarning.className = "size-warning";
      sizeWarning.textContent = "Terminal too small. Minimum size: 60x16";
      element.parentElement.appendChild(sizeWarning);

      // Build debug overlay with DOM methods (safe, no innerHTML)
      const debugOverlay = document.createElement("div");
      debugOverlay.className = "debug-overlay";
      const debugFields = ["container", "calculated", "actual", "delta"];
      const debugLabels = ["Container:", "Calculated:", "Actual:", "Delta:"];
      debugFields.forEach((field, i) => {
        const row = document.createElement("div");
        row.className = "debug-row";
        const label = document.createElement("span");
        label.className = "debug-label";
        label.textContent = debugLabels[i];
        const value = document.createElement("span");
        value.className = "debug-value";
        value.dataset.field = field;
        value.textContent = "0x0";
        row.appendChild(label);
        row.appendChild(value);
        debugOverlay.appendChild(row);
      });
      element.parentElement.appendChild(debugOverlay);

      const terminal = this.createXtermInstance(id);
      terminal.open(element);
      const activationCleanup = this.bindTerminalActivation(id, element);
      const webglAddon = this.setupTerminalRenderer(id, terminal);
      const osc7Disposable = this.attachOsc7Handler(id, terminal);

      const fitAddon = terminal._fitAddon;
      fitAddon.fit();
      this.normalizeTerminalGeometry({ terminal });

      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new ReconnectingWebSocket(
        `${protocol}//${location.host}/ws/terminals/${id}?clientId=${encodeURIComponent(this.clientInstanceId)}`,
        id,
        {
          onMessage: (data) => {
            terminal.write(data);
            this.queueTelemetryRefresh();
          },
          onStatusChange: (status, extra) =>
            this.handleStatusChange(id, status, extra),
          onLifecycle: (message) => this.handleReconnectLifecycle(id, message),
          onTerminalState: (message) =>
            this.applyTerminalRuntimeState(id, message),
        },
      );

      const inputState = this.createInputState();
      const onDataDisposable = terminal.onData((data) => {
        // Debug: direct DOM update to see if onData fires at all
        const debugEl = document.getElementById("modifier-debug");
        if (debugEl) {
          debugEl.textContent = `onData: "${data}" | mods: ${JSON.stringify(this.extraKeys?.modifiers)}`;
        }

        const dedupedData = this.consumePendingFallbackEcho(inputState, data);
        if (!dedupedData) {
          if (debugEl) {
            debugEl.textContent = "onData: SKIP (fallback echo)";
          }
          return;
        }

        const mods = this.extraKeys?.modifiers;
        dbg("[ExtraKeys] onData:", JSON.stringify(dedupedData), "mods:", mods);
        inputState.lastOnDataAt = performance.now();
        inputState.lastOnDataValue = dedupedData;
        const finalData = this.applyExtraKeyModifiers(dedupedData, {
          log: true,
        });
        ws.send(JSON.stringify({ type: "input", data: finalData }));
      });

      const inputFallbackCleanup = this.attachMobileInputFallback(
        ws,
        element,
        inputState,
      );
      const pasteFallbackCleanup = this.attachClipboardPasteFallback(
        ws,
        element,
      );
      dbg("[ExtraKeys] attachMobileInputFallback (create)", {
        id,
        attached: !!inputFallbackCleanup,
      });

      this.tabIndex++;
      const tabNum = this.tabIndex;
      this.terminals.set(id, {
        terminal,
        fitAddon,
        webglAddon,
        ws,
        element,
        overlay,
        dimensionOverlay,
        sizeWarning,
        debugOverlay,
        dimensionTimer: null,
        cwd: resolvedCwd,
        running: false,
        busy: false,
        lastExitCode: null,
        agentName: null,
        agentState: null,
        ports: [],
        isWorktree: false,
        recentTools: [],
        backendMode: terminalInfo.backendMode || null,
        supportsLinkedView: Boolean(terminalInfo.supportsLinkedView),
        tabNum,
        workspaceId,
        originalWorkspaceId: workspaceId,
        resizeObserver: null,
        resizeTimer: null,
        preferredCols: 0,
        lastSentCols: null,
        lastSentRows: null,
        fitFrame: 0,
        onDataDisposable,
        osc7Disposable,
        inputFallbackCleanup,
        pasteFallbackCleanup,
        activationCleanup,
        inputState,
        awaitingReconnectReady: false,
        connectionStatus: "connecting",
      });

      // Register with session registry for reconnection persistence
      this.sessionRegistry.register(id, {
        workspaceId,
        cwd: resolvedCwd,
        tabNum,
        originalWorkspaceId: workspaceId,
      });

      // Only add tab for new workspaces, not splits
      if (!split) {
        this.addTab(id, resolvedCwd, tabNum, workspaceId);
      } else {
        // Update tab badge count for split workspaces
        this.updateTabGroups();
      }
      this.queueTelemetryRefresh(0);
      this.switchTo(id);
      this.attachResizeObserver(id);
      this.scheduleTerminalMetricStabilization(id);

      // Disable mobile keyboard autocorrect etc.
      setTimeout(() => this.disableMobileKeyboardFeatures(element), 100);
    } catch (err) {
      console.error("Failed to create terminal:", err);
      alert("Failed to create terminal: " + err.message);
    }
  }

  async createLinkedView() {
    if (!this.activeId) return;
    const active = this.getActiveTerminal();
    if (!this.canCreateLinkedView(active)) return;

    try {
      const res = await fetch(
        `/api/terminals/${encodeURIComponent(this.activeId)}/linked-view`,
        { method: "POST" },
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || "Failed to create linked view");
      }

      await this.reconnectToTerminal(payload.id, payload.cwd, null, {
        showReconnectBanner: false,
        isReconnection: false,
        backendMode: payload.backendMode || null,
        supportsLinkedView: Boolean(payload.supportsLinkedView),
      });
    } catch (err) {
      console.error("Failed to create linked view:", err);
      alert(`Failed to create linked view: ${err.message}`);
    }
  }

  addTab(id, cwd, tabNum, workspaceId) {
    const existingTab = this.getWorkspaceTab(workspaceId);
    if (existingTab) {
      this.retargetWorkspaceTab(workspaceId, id);
      this.renderWorkspaceTab(existingTab, cwd);
      return existingTab;
    }
    const tab = document.createElement("div");
    tab.className = "tab";
    tab.dataset.id = id;
    tab.dataset.workspaceId = workspaceId;
    tab.dataset.index = tabNum % 9 || 9;
    tab.tabIndex = 0;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", "false");

    const label = this.formatCwdLabel(cwd);
    tab.innerHTML = `
      <span class="tab-dot"></span>
      <span class="tab-index">${tabNum}</span>
      <span class="tab-count"></span>
      <span class="tab-copy">
        <span class="tab-label">${label}</span>
        <span class="tab-meta" hidden></span>
        <span class="tab-signal-badge" hidden aria-hidden="true"></span>
      </span>
      <button class="tab-close" title="Close workspace" aria-label="Close workspace">&times;</button>
    `;

    tab.querySelector(".tab-close").addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeWorkspace(workspaceId);
    });

    tab.addEventListener("click", (e) => {
      if (e.target.closest(".tab-close")) return;
      const targetId = this.resolveWorkspaceTerminalId(workspaceId, id);
      if (targetId) this.switchTo(targetId);
    });
    tab.addEventListener("keydown", (e) => {
      if (e.target.closest(".tab-close")) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const targetId = this.resolveWorkspaceTerminalId(workspaceId, id);
        if (targetId) this.switchTo(targetId);
      }
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const tabs = Array.from(this.tabs.querySelectorAll(".tab"));
        const currentIndex = tabs.indexOf(tab);
        if (currentIndex === -1 || tabs.length <= 1) return;
        const direction = e.key === "ArrowRight" ? 1 : -1;
        const nextIndex =
          (currentIndex + direction + tabs.length) % tabs.length;
        tabs[nextIndex]?.focus();
      }
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
    return tab;
  }

  clearDropTargets() {
    this.tabs
      .querySelectorAll(".tab")
      .forEach((t) => t.classList.remove("drop-target", "dragging"));
  }

  updateTabGroups() {
    this.tabs.querySelectorAll(".tab").forEach((tab) => {
      this.renderWorkspaceTab(tab);
    });
    this.updatePaneControls();
    this.refreshCommandPalette();
    this.scheduleDesktopToolbarDensitySync();
  }

  getWorkspaceTab(workspaceId) {
    if (!workspaceId) return null;
    return (
      Array.from(this.tabs.querySelectorAll(".tab")).find(
        (tab) => tab.dataset.workspaceId === workspaceId,
      ) || null
    );
  }

  retargetWorkspaceTab(workspaceId, preferredId = null) {
    const tab = this.getWorkspaceTab(workspaceId);
    if (!tab) return null;
    const preferredTerminal = preferredId
      ? this.terminals.get(preferredId)
      : null;
    const terminalId =
      preferredTerminal?.workspaceId === workspaceId
        ? preferredId
        : this.resolveWorkspaceTerminalId(workspaceId);
    if (terminalId && this.terminals.has(terminalId)) {
      tab.dataset.id = terminalId;
    }
    return tab;
  }

  updatePaneControls() {
    this.tileManager.tiles.forEach((tile, id) => {
      const terminal = this.terminals.get(id);
      const paneCount = terminal
        ? this.getWorkspaceTerminals(terminal.workspaceId).length
        : 0;
      const canDetach = paneCount > 1;
      const connectionStatus = this.getTerminalConnectionStatus(terminal);
      const connectionLabel = this.getConnectionStatusLabel(connectionStatus);
      const activity = this.getPaneActivityState(terminal);
      const cwd = terminal?.cwd || "Terminal";
      const folderLabel = this.formatCwdLabel(cwd);
      const hasAttention =
        connectionStatus !== "connected" || activity.key !== "idle";

      tile.element.classList.toggle("workspace-multi-pane", canDetach);
      tile.element.classList.toggle("pane-has-attention", hasAttention);
      tile.element.dataset.connectionStatus = connectionStatus;
      tile.element.dataset.activity = activity.key;
      tile.element.title = `${cwd}\n${connectionLabel} • ${activity.accessibleLabel}`;
      tile.element.setAttribute(
        "aria-label",
        `Terminal pane: ${cwd}. ${connectionLabel}. ${activity.accessibleLabel}.`,
      );

      if (tile.paneStatus) {
        tile.paneStatus.dataset.connectionStatus = connectionStatus;
        tile.paneStatus.dataset.activity = activity.key;
      }
      if (tile.paneStatusFolder) {
        tile.paneStatusFolder.textContent = folderLabel;
      }
      if (tile.paneStatusConnection) {
        tile.paneStatusConnection.textContent =
          connectionStatus === "connected" ? "" : connectionLabel;
      }
      if (tile.paneStatusActivity) {
        tile.paneStatusActivity.textContent = activity.label;
      }

      if (tile.detachButton) {
        const label = terminal?.cwd
          ? `Move ${this.formatCwdLabel(terminal.cwd)} pane to a new tab`
          : "Move pane to a new tab";
        tile.detachButton.title = label;
        tile.detachButton.setAttribute("aria-label", label);
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
    if (!this.activeId) return;
    const terminal = this.terminals.get(this.activeId);
    if (this.getWorkspaceTerminals(terminal?.workspaceId).length > 1) {
      this.detachTerminalToWorkspace(this.activeId);
      return;
    }
    this.tileManager.removeFromGroup(this.activeId);
    this.updateTabGroups();
  }

  detachTerminalToWorkspace(id = this.activeId) {
    const terminal = this.terminals.get(id);
    if (!terminal?.workspaceId) return false;

    const sourceWorkspaceId = terminal.workspaceId;
    const sourceTerminals = this.getWorkspaceTerminals(sourceWorkspaceId);
    if (sourceTerminals.length <= 1) return false;

    this.workspaceIndex += 1;
    const workspaceId = `ws-${this.workspaceIndex}`;
    this.tabIndex += 1;
    const tabNum = this.tabIndex;
    const sourceSurvivor = sourceTerminals.find((item) => item.id !== id);

    terminal.workspaceId = workspaceId;
    terminal.originalWorkspaceId = workspaceId;
    terminal.tabNum = tabNum;
    this.tileManager.moveTileToWorkspace(id, workspaceId);
    this.sessionRegistry.update(id, {
      workspaceId,
      originalWorkspaceId: workspaceId,
      tabNum,
    });

    if (sourceSurvivor) {
      this.workspaceLastActive.set(sourceWorkspaceId, sourceSurvivor.id);
      this.retargetWorkspaceTab(sourceWorkspaceId, sourceSurvivor.id);
    }
    this.workspaceLastActive.set(workspaceId, id);
    this.addTab(id, terminal.cwd, tabNum, workspaceId);
    this.tileManager.relayout(sourceWorkspaceId);
    this.tileManager.relayout(workspaceId);
    this.updateTabGroups();
    this.switchTo(id);
    return true;
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
    this.workspaceLastActive.delete(workspaceId);
    this.updateTabGroups();
  }

  // Merge one workspace into another (for drag-drop merging)
  mergeWorkspacesUI(fromWorkspaceId, toWorkspaceId) {
    // Update all terminals from the source workspace to the target workspace
    this.terminals.forEach((t, id) => {
      if (t.workspaceId === fromWorkspaceId) {
        t.workspaceId = toWorkspaceId;
        this.sessionRegistry.update(id, {
          workspaceId: toWorkspaceId,
          originalWorkspaceId: t.originalWorkspaceId || fromWorkspaceId,
        });
      }
    });
    const rememberedFrom = this.workspaceLastActive.get(fromWorkspaceId);
    if (rememberedFrom) {
      this.workspaceLastActive.set(toWorkspaceId, rememberedFrom);
      this.workspaceLastActive.delete(fromWorkspaceId);
    }

    // Merge tiles in tile manager
    this.tileManager.mergeWorkspaces(fromWorkspaceId, toWorkspaceId);

    // Remove the old tab
    this.tabs
      .querySelector(`[data-workspace-id="${fromWorkspaceId}"]`)
      ?.remove();
    this.retargetWorkspaceTab(toWorkspaceId);

    // Update tab display
    this.updateTabGroups();

    // `switchTo` owns workspace visibility and active-tab state. Calling
    // showWorkspace first can make activation look like a no-op when the
    // active terminal came from the removed source tab.
    const targetId = this.resolveWorkspaceTerminalId(
      toWorkspaceId,
      this.activeId,
    );
    if (targetId) this.switchTo(targetId);
  }

  resolveWorkspaceTerminalId(workspaceId, fallbackId = null) {
    if (!workspaceId) return fallbackId;
    const remembered = this.workspaceLastActive.get(workspaceId);
    if (
      remembered &&
      this.terminals.has(remembered) &&
      this.terminals.get(remembered)?.workspaceId === workspaceId
    ) {
      return remembered;
    }

    for (const [id, terminal] of this.terminals) {
      if (terminal.workspaceId === workspaceId) {
        return id;
      }
    }

    return fallbackId;
  }

  getActiveWorkspacePaneIds() {
    const workspaceId = this.terminals.get(this.activeId)?.workspaceId;
    if (!workspaceId) return [];
    return this.tileManager
      .getWorkspaceTiles(workspaceId)
      .map((tile) => tile.terminalId)
      .filter((id) => this.terminals.has(id));
  }

  switchToAdjacentPane(direction) {
    const paneIds = this.getActiveWorkspacePaneIds();
    if (paneIds.length < 2) return false;

    const currentIndex = paneIds.indexOf(this.activeId);
    const step = direction < 0 ? -1 : 1;
    const nextIndex =
      currentIndex === -1
        ? 0
        : (currentIndex + step + paneIds.length) % paneIds.length;
    const targetId = paneIds[nextIndex];
    if (!targetId) return false;

    this.switchTo(targetId);
    return true;
  }

  activateTerminal(id) {
    if (!this.terminals.has(id)) return false;
    const t = this.terminals.get(id);
    const changed =
      this.activeId !== id ||
      this.tileManager.activeTileId !== id ||
      this.tileManager.activeWorkspaceId !== t?.workspaceId;
    if (!changed) return false;

    // The search bar/controller are bound to the previous terminal's addon.
    this.closeTerminalSearch();

    this.activeId = id;
    if (t?.workspaceId) {
      this.workspaceLastActive.set(t.workspaceId, id);
    }
    if (t?.workspaceId) {
      this.tileManager.showWorkspace(t.workspaceId);
    }
    this.tileManager.setActive(id);
    if (t?.workspaceId && t.cwd) {
      this.setDirectoryValue(t.cwd, { force: true });
      this.updateWorkspaceLabel(t.workspaceId, t.cwd);
      this.rememberWorkspaceById(t.workspaceId, t.cwd);
    }
    if (DEBUG) {
      dbg("activateTerminal", {
        terminalId: id,
        workspaceId: t?.workspaceId || null,
        cols: t?.terminal?.cols,
        rows: t?.terminal?.rows,
      });
    }

    // Highlight tab by workspaceId (works for multi-terminal workspaces)
    const activeWorkspaceId = t?.workspaceId;
    this.tabs.querySelectorAll(".tab").forEach((tab) => {
      const isActive = tab.dataset.workspaceId === activeWorkspaceId;
      tab.classList.toggle("active", isActive);
      tab.setAttribute("aria-selected", isActive ? "true" : "false");
    });

    this.updateConnectionStatus(this.getTerminalConnectionStatus(t));
    this.updateLinkedViewButton();
    this.refreshCommandPalette();
    void this.syncRightSurfaceForWorkspace();
    return true;
  }

  switchTo(id) {
    if (!this.terminals.has(id)) return;
    this.activateTerminal(id);
    this.focusTerminal(id, {
      syncSize: true,
      scrollToPrompt: platformDetector.hasTouch,
    });
  }

  switchToIndex(index) {
    const tab = this.tabs.querySelector(`[data-index="${index}"]`);
    if (!tab) return;
    const workspaceId = tab.dataset.workspaceId;
    const targetId = this.resolveWorkspaceTerminalId(
      workspaceId,
      tab.dataset.id,
    );
    if (targetId) this.switchTo(targetId);
  }

  switchToNext(direction) {
    const tabs = Array.from(
      this.tabs.querySelectorAll(".tab[data-workspace-id]"),
    );
    if (tabs.length < 2) return;
    const activeWorkspaceId = this.terminals.get(this.activeId)?.workspaceId;
    const currentIndex = Math.max(
      0,
      tabs.findIndex(
        (tab) => tab.dataset.workspaceId === activeWorkspaceId,
      ),
    );
    const newIndex = (currentIndex + direction + tabs.length) % tabs.length;
    const targetTab = tabs[newIndex];
    const targetId = this.resolveWorkspaceTerminalId(
      targetTab.dataset.workspaceId,
      targetTab.dataset.id,
    );
    if (targetId) this.switchTo(targetId);
  }

  async closeTerminal(id) {
    const t = this.terminals.get(id);
    if (!t) return;
    const closingWorkspaceId = t.workspaceId;
    const wasActive = id === this.activeId;

    if (wasActive) this.closeTerminalSearch();

    t.ws?.close();
    t.inputFallbackCleanup?.();
    t.pasteFallbackCleanup?.();
    t.activationCleanup?.();
    if (t.resizeObserver) t.resizeObserver.disconnect();
    if (t.resizeTimer) clearTimeout(t.resizeTimer);
    if (t.dimensionTimer) clearTimeout(t.dimensionTimer);
    if (t.reconnectCountdownTimer) clearInterval(t.reconnectCountdownTimer);
    if (t.fitFrame) cancelAnimationFrame(t.fitFrame);
    t.onDataDisposable?.dispose?.();
    t.osc7Disposable?.dispose?.();
    // The webgl addon must be disposed BEFORE terminal.dispose() — disposing
    // it after the terminal is gone throws in some xterm versions.
    if (t.webglAddon) {
      try {
        t.webglAddon.dispose();
      } catch (err) {
        if (DEBUG) dbg("webglAddon.dispose error", { id, err });
      }
      t.webglAddon = null;
    }
    try {
      t.terminal?.dispose?.();
    } catch (err) {
      if (DEBUG) dbg("terminal.dispose error", { id, err });
    }
    this.tileManager.removeTile(id);
    this.terminals.delete(id);
    this.sessionRegistry.remove(id);

    const workspaceFallback = this.resolveWorkspaceTerminalId(
      closingWorkspaceId,
    );
    if (workspaceFallback) {
      this.workspaceLastActive.set(closingWorkspaceId, workspaceFallback);
      this.retargetWorkspaceTab(closingWorkspaceId, workspaceFallback);
      this.tileManager.relayout(closingWorkspaceId);
    } else {
      this.workspaceLastActive.delete(closingWorkspaceId);
      this.getWorkspaceTab(closingWorkspaceId)?.remove();
    }
    this.updateTabGroups();

    if (wasActive) {
      const nextId = workspaceFallback || this.terminals.keys().next().value;
      if (nextId) this.switchTo(nextId);
      else {
        this.activeId = null;
        this.tileManager.activeTileId = null;
        this.tileManager.activeWorkspaceId = null;
        this.updateConnectionStatus("disconnected");
      }
    }
    this.updateLinkedViewButton();

    try {
      await fetch(`/api/terminals/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    } catch {}
  }

  sendResize(id, colsOverride = null, rowsOverride = null, options = {}) {
    const t = this.terminals.get(id);
    if (!t?.ws) return;
    const { force = false } = options;
    const cols = colsOverride ?? t.terminal.cols;
    const rows = rowsOverride ?? t.terminal.rows;
    if (!force && t.lastSentCols === cols && t.lastSentRows === rows) {
      return;
    }
    t.lastSentCols = cols;
    t.lastSentRows = rows;
    t.ws.send(JSON.stringify({ type: "resize", cols, rows }));
  }

  updateConnectionStatus(status) {
    if (!this.connectionStatus) return;
    const normalized = this.normalizeConnectionStatus(status);
    this.connectionStatus.className = "status-dot " + normalized;
    this.connectionStatus.title = this.getConnectionStatusLabel(normalized);
  }

  changeFontSize(delta) {
    const next = this.fontSize + delta;
    // Persist + clamp through the runtime (coerceValue clamps to the schema
    // min/max); the terminal.fontSize side effect (applyFontSize) does the work.
    if (this.settingsRuntime) {
      this.settingsRuntime.apply("terminal.fontSize", next);
    } else {
      this.applyFontSize(next);
      this.settingsStore?.set("terminal.fontSize", this.fontSize);
    }
  }

  // Side effect for terminal.fontSize. `value` is already coerced/clamped by the
  // runtime; clamp defensively too (Codex #4 — clamp host-affecting numbers at
  // the application site) before applying it to every terminal.
  applyFontSize(value) {
    const n = Number(value);
    this.fontSize = Number.isFinite(n) ? Math.max(8, Math.min(32, n)) : 14;
    for (const [, t] of this.terminals) {
      t.terminal.options.fontSize = this.fontSize;
      t.preferredCols = 0;
      this.fitTerminalState(t);
    }
    if (this.activeId) this.syncTerminalSize(this.activeId);
    this.syncFontSizeStepper();
  }

  handleViewportResize() {
    if (!window.visualViewport) return;

    const viewport = window.visualViewport;
    const windowHeight = window.innerHeight;
    const viewportHeight = viewport.height;
    const keyboardHeight = windowHeight - viewportHeight - viewport.offsetTop;

    const extraKeys = document.getElementById("extra-keys");
    const mobileActionBar = document.getElementById("mobile-action-bar");
    const toolbarHeight = this.toolbar?.offsetHeight || 0;
    const extraKeysHeight = extraKeys?.offsetHeight || 0;
    const mobileActionBarHeight =
      mobileActionBar && getComputedStyle(mobileActionBar).display !== "none"
        ? mobileActionBar.offsetHeight || 0
        : 0;
    const isKeyboardOpen = keyboardHeight > 100;

    if (isKeyboardOpen) {
      // Show extra keys above virtual keyboard
      this.extraKeys?.showForKeyboard();
      extraKeys.style.position = "fixed";
      extraKeys.style.bottom = `${keyboardHeight}px`;
      extraKeys.style.left = "0";
      extraKeys.style.right = "0";
      extraKeys.style.zIndex = "1000";
      this.container.style.height = `calc(${viewportHeight}px - ${toolbarHeight}px - ${extraKeysHeight}px - ${mobileActionBarHeight}px)`;
      document.body.classList.add("virtual-keyboard-open");
    } else {
      // Hide extra keys when keyboard closes (mobile only)
      this.extraKeys?.hideForKeyboard();
      extraKeys.style.cssText = "";
      this.container.style.height = "";
      document.body.classList.remove("virtual-keyboard-open");
    }

    const active = this.terminals.get(this.activeId);
    if (active) {
      if (this.viewportFocusTimer) clearTimeout(this.viewportFocusTimer);
      this.viewportFocusTimer = setTimeout(
        () => {
          this.focusTerminal(this.activeId, {
            syncSize: true,
            scrollToPrompt: isKeyboardOpen || platformDetector.hasTouch,
          });
          this.disableMobileKeyboardFeatures(active.element);
        },
        isKeyboardOpen ? 50 : 0,
      );
    }
  }

  scrollActiveTerminalToPrompt() {
    const active = this.terminals.get(this.activeId);
    try {
      active?.terminal?.scrollToBottom?.();
    } catch {
      /* best-effort */
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
      await this.clipboardManager.handlePaste(active.ws);
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
        this.fitTerminalState(active);
        this.syncTerminalSize(this.activeId);
      }, 100);
  }

  async openDirPicker() {
    document.getElementById("dir-modal")?.classList.remove("hidden");
    await this.loadDir(this.getCurrentDirectoryValue() || "/");
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
      this.selectedDir = data.path;
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
      parentEl.addEventListener("click", () => this.loadDir(parent));
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
      this.setDirectoryValue(dir, { force: true });
      void this.commitWorkingDirectory(dir);
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
  syncInteractionModeClasses();
  platformDetector.onChange(() => syncInteractionModeClasses());

  document
    .getElementById("debug-panel-close")
    ?.addEventListener("click", () => {
      document.getElementById("debug-panel")?.classList.remove("visible");
    });

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
          "copy-plus": "⧉+",
          "more-horizontal": "⋯",
          "chevron-up": "↑",
          "chevron-down": "↓",
          "chevron-left": "←",
          "chevron-right": "→",
          x: "×",
          copy: "📋",
          "clipboard-paste": "📥",
          "sliders-horizontal": "⚙",
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
  window.gitManager = new GitManager();
});
