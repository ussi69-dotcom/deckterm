import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import type { ServerWebSocket, Subprocess } from "bun";
import { Database } from "bun:sqlite";
import {
  cloudflareAccess,
  type CloudflareAccessPayload,
} from "@hono/cloudflare-access";
import { mkdir, readdir, unlink, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  classifyAgentOutputPhase,
  createGitWorktreeDetector,
  getTerminalTelemetry,
  inferTmuxRuntimeState,
  parseShellIntegrationChunk,
  resolveAgentOutputState,
} from "./telemetry";
import { isCloudflareAudienceAllowed } from "./cloudflare-access-guards";
import {
  applyOnboardingProfile,
  runOnboardingDoctor,
  applyOnboardingRemediation,
} from "./onboarding-doctor";
import { supportsLinkedView as supportsTerminalLinkedView } from "./terminal-capabilities";
import { RawTerminalBackend } from "./services/raw-terminal-backend";
import { TmuxTerminalBackend } from "./services/tmux-terminal-backend";
import type { TerminalBackend } from "./services/terminal-backend";
import {
  TaskRunnerError,
  buildJudgeCommand,
  buildWorkerCommand,
  createTaskRunner,
} from "./task-runner";
import { syncTmuxSessionClients } from "./tmux-client-size";
import {
  buildTmuxSessionName,
  getTmuxSocketPath,
  getTmuxSessionPrefix,
  parseTmuxSessionName,
  resolveTmuxSessionNamespace,
} from "./tmux-session-names";
import {
  bootstrapFirstAdmin,
  appendTerminalEvent,
  getTerminalSession,
  hasScopedGrant,
  initializeFoundationState,
  isBootstrapComplete,
  listTerminalEventsAfter,
  listTerminalSessionsForActor,
  markTerminalSessionEnded,
  recordTerminalSession,
  writeAuditEvent,
  type FoundationState,
  type RecordedTerminalSession,
  type ScopedGrantCapability,
} from "./services/foundation-state";
import {
  authorizeTerminalAttach,
  authorizeTerminalSessionAccess,
  authorizeTerminalWrite,
  getRouteCapability,
  isLegacyBootstrapBypassAllowed,
} from "./services/foundation-authorization";
import {
  resolveActorFromAccessPayload,
  isEdgeProtectedTunnelMode,
  type DeckTermActor,
} from "./services/foundation-actors";

// =============================================================================
// GLOBAL ERROR HANDLERS - Prevent 502 from uncaught exceptions
// =============================================================================

process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
  // Don't exit - try to keep serving
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[FATAL] Unhandled rejection at:", promise, "reason:", reason);
  // Don't exit - try to keep serving
});

// Bun.Terminal API types (Bun 1.3.5+) - not yet in bun-types
interface BunTerminalOptions {
  cols: number;
  rows: number;
  data: (terminal: BunTerminalInstance, data: string | Uint8Array) => void;
}

interface BunTerminalInstance {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

// Type-safe wrapper for Bun.Terminal (API not yet in bun-types)
const BunTerminal = (
  Bun as unknown as {
    Terminal: new (opts: BunTerminalOptions) => BunTerminalInstance;
  }
).Terminal;

type Terminal = {
  id: string;
  proc: Subprocess;
  terminal: BunTerminalInstance;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  lastActivityAt: number; // Last user input timestamp for idle detection
  lastDetachedAt?: number; // Last client socket disconnection timestamp for detached reaper
  ownerId: string; // User sub from JWT
  ownerEmail: string; // User email for display
  sessionName?: string; // tmux session name (when TMUX_BACKEND=1)
  scrollback: string[]; // ring buffer of recent terminal output chunks
  scrollbackBytes: number; // current bytes in ring buffer
  hadSocketConnection: boolean; // tracks whether a websocket was ever connected
  running: boolean;
  lastExitCode: number | null;
  agentName: "codex" | "claude" | null;
  agentState: "thinking" | "responding" | null;
  agentHasUserPrompt: boolean;
  agentRespondingTimer: ReturnType<typeof setTimeout> | null;
  shellIntegrationCarry: string;
  lastTmuxCapture: string;
  tmuxPipePath: string | null;
  tmuxPipeOffset: number;
};

type TerminalWsData = {
  type: "terminal";
  terminalId: string;
  ownerId: string;
  actorUserId: string;
  mode: "read" | "write";
  protocol: "legacy" | "v2";
  clientId: string | null;
  lastEventId: number | null;
};
type OpenCodeWsData = { type: "opencode_proxy"; upstream: WebSocket };
type WsData = TerminalWsData | OpenCodeWsData;

// Configuration
const DEBUG = process.env.OPENCODE_WEB_DEBUG === "1";
const MAX_TERMINALS = parseInt(
  process.env.OPENCODE_WEB_MAX_TERMINALS || "10",
  10,
);
const MAX_TERMINALS_PER_USER = parseInt(
  process.env.MAX_TERMINALS_PER_USER || "10",
  10,
);
const RATE_LIMIT_WINDOW_MS = Math.max(
  1_000,
  parseInt(
    process.env.OPENCODE_WEB_TERMINAL_RATE_LIMIT_WINDOW_MS || "60000",
    10,
  ) || 60_000,
);
const RATE_LIMIT_MAX_REQUESTS = Math.max(
  1,
  parseInt(
    process.env.OPENCODE_WEB_TERMINAL_RATE_LIMIT_MAX_REQUESTS || "40",
    10,
  ) || 40,
);
const TERMINAL_IDLE_TIMEOUT_MS = parseInt(
  process.env.TERMINAL_IDLE_TIMEOUT_MS || String(2 * 60 * 60 * 1000),
  10,
); // 2 hours default
const AGENT_RESPONDING_IDLE_MS = parseInt(
  process.env.AGENT_RESPONDING_IDLE_MS || "700",
  10,
);
const CLAUDE_AGENT_RESPONDING_IDLE_MS = parseInt(
  process.env.CLAUDE_AGENT_RESPONDING_IDLE_MS ||
    String(Math.max(AGENT_RESPONDING_IDLE_MS, 3000)),
  10,
);

const CF_ACCESS_REQUIRED = process.env.CF_ACCESS_REQUIRED === "1";
const CF_ACCESS_TEAM_NAME = process.env.CF_ACCESS_TEAM_NAME || "";
const CF_ACCESS_AUD = process.env.CF_ACCESS_AUD || "";
// Resolves the state directory from the current environment. Prefer this over
// the frozen DECKTERM_STATE_DIR const for runtime services wired in
// createWebApp(): the const is captured at module import, so a test that sets
// DECKTERM_STATE_DIR after server.ts is first imported would otherwise write
// task workspaces into the live ~/.deckterm (leaking api-task-* dirs into the
// real UI). In production the env is stable at startup, so this matches the
// const exactly.
function resolveStateDir(): string {
  return (
    process.env.DECKTERM_STATE_DIR ||
    join(process.env.HOME || "/home/deploy", ".deckterm")
  );
}
const DECKTERM_STATE_DIR = resolveStateDir();
// Identifies which build is actually running, so a deploy can verify that prod
// is serving the release it just promoted (not a rolled-back / stale process).
// Sourced from env, then a RELEASE_ID marker written next to the app at deploy
// time, falling back to "dev" for local checkouts.
const DECKTERM_RELEASE = ((): string => {
  const fromEnv = process.env.DECKTERM_RELEASE?.trim();
  if (fromEnv) return fromEnv;
  try {
    const marker = resolve(import.meta.dir, "../RELEASE_ID");
    const text = readFileSync(marker, "utf8").trim();
    if (text) return text;
  } catch {
    // no marker (local dev or pre-marker release) - fall through
  }
  return "dev";
})();
const DECKTERM_TASK_MAX_ROUNDS = parseInt(
  process.env.DECKTERM_TASK_MAX_ROUNDS || "5",
  10,
);
const DECKTERM_TASK_PROVIDERS = (
  process.env.DECKTERM_TASK_PROVIDERS || "codex,claude"
)
  .split(",")
  .map((provider) => provider.trim())
  .filter(
    (provider): provider is "codex" | "claude" =>
      provider === "codex" || provider === "claude",
  );

// tmux backend for session persistence (survives server restart)
const TMUX_BACKEND = process.env.TMUX_BACKEND === "1";
const TMUX_SESSION_NAMESPACE = resolveTmuxSessionNamespace({
  namespace: process.env.TMUX_SESSION_NAMESPACE,
  port: process.env.PORT,
});
const TMUX_SESSION_PREFIX = getTmuxSessionPrefix(TMUX_SESSION_NAMESPACE);
const TMUX_SOCKET_PATH = getTmuxSocketPath(TMUX_SESSION_NAMESPACE);
const TMUX_PIPE_DIR = "/tmp/deckterm-tmux-pipes";
const terminalBackend: TerminalBackend = TMUX_BACKEND
  ? new TmuxTerminalBackend({
      namespace: TMUX_SESSION_NAMESPACE,
      socketPath: TMUX_SOCKET_PATH,
      pipeDir: TMUX_PIPE_DIR,
      shellCommandResolver: resolveShellCommand,
      env: process.env,
    })
  : new RawTerminalBackend({
      shellCommandResolver: resolveShellCommand,
      env: process.env,
    });
const tmuxTerminalBackend =
  terminalBackend.mode === "tmux"
    ? (terminalBackend as TmuxTerminalBackend)
    : null;
const SCROLLBACK_MAX_LINES = parseInt(
  process.env.SCROLLBACK_MAX_LINES || "2000",
  10,
);
const SCROLLBACK_MAX_BYTES = parseInt(
  process.env.SCROLLBACK_MAX_BYTES || String(1024 * 1024),
  10,
); // 1MB default
const TRUSTED_ORIGINS = (process.env.TRUSTED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const DEFAULT_ALLOWED_ROOT = process.env.HOME || "/home/deploy";
const ALLOWED_FILESYSTEM_ROOTS = (
  process.env.ALLOWED_FILE_ROOTS || DEFAULT_ALLOWED_ROOT
)
  .split(",")
  .map((root) => root.trim())
  .filter(Boolean);

// OpenCode configuration
const OPENCODE_UPSTREAM =
  process.env.OPENCODE_UPSTREAM || "http://127.0.0.1:4096";
const OPENCODE_URL = process.env.OPENCODE_URL || "";

// Clipboard image configuration
const CLIPBOARD_IMAGES_DIR = "/tmp/deckterm-clipboard";
const CLIPBOARD_IMAGE_MAX_SIZE = 10 * 1024 * 1024; // 10MB
const CLIPBOARD_IMAGE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Hop-by-hop headers to strip from proxied requests/responses
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
];

// Terminal sessions (PTY processes)
const terminals = new Map<string, Terminal>();

// Listeners notified when any terminal exits. The task runner uses this to
// advance tasks stuck on worker-running/judge-running once their agent
// terminal ends (status otherwise only changes on explicit user actions).
const terminalExitListeners: Array<
  (ownerId: string, terminalId: string) => void
> = [];
function onTerminalExit(
  listener: (ownerId: string, terminalId: string) => void,
) {
  terminalExitListeners.push(listener);
}
function notifyTerminalExit(ownerId: string, terminalId: string) {
  for (const listener of terminalExitListeners) {
    try {
      listener(ownerId, terminalId);
    } catch (err) {
      debug("Terminal exit listener failed:", err);
    }
  }
}
const terminalSockets = new Map<string, Set<ServerWebSocket<WsData>>>();
type TerminalReconnectState = {
  pendingReady: boolean;
  replaying: boolean;
  replayMode: "tmux" | "raw" | null;
};
const socketReconnectState = new WeakMap<
  ServerWebSocket<WsData>,
  TerminalReconnectState
>();
const utf8Decoder = new TextDecoder();
let bashIntegrationRcPathPromise: Promise<string> | null = null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function hasVisibleUserInput(data: string | Uint8Array) {
  const text = typeof data === "string" ? data : utf8Decoder.decode(data);
  if (!text) return false;
  const withoutEscapeSequences = text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1bP[\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "");
  return (
    /[^\x00-\x1f\x7f]/.test(withoutEscapeSequences) ||
    /[\r\n]/.test(withoutEscapeSequences)
  );
}

function sendReconnectLifecycle(
  ws: ServerWebSocket<WsData>,
  phase: "replay-start" | "replay-complete" | "ready",
  extra: Record<string, unknown> = {},
) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: "reconnect_lifecycle", phase, ...extra }));
}

function appendTerminalRuntimeEvent(
  terminalId: string,
  kind: "output" | "state" | "exit" | "lifecycle",
  payload: {
    data?: string | Uint8Array | null;
    dataJson?: Record<string, unknown> | null;
  } = {},
): void {
  void getFoundationState()
    .then((state) => {
      if (!getTerminalSession(state.db, terminalId)) return;
      appendTerminalEvent(state.db, {
        terminalId,
        kind,
        data: payload.data ?? null,
        dataJson: payload.dataJson ?? null,
      });
    })
    .catch((err) =>
      debug(`[events] Failed to append ${kind} event for ${terminalId}:`, err),
    );
}

function broadcastTerminalState(term: Terminal) {
  const sockets = terminalSockets.get(term.id);
  const statePayload = {
    type: "terminal_state" as const,
    running: term.running,
    lastExitCode: term.lastExitCode,
    agentName: term.agentName,
    agentState: term.agentState,
  };
  appendTerminalRuntimeEvent(term.id, "state", { dataJson: statePayload });
  if (!sockets || sockets.size === 0) return;
  const payload = JSON.stringify(statePayload);
  for (const ws of sockets) {
    try {
      ws.send(payload);
    } catch {
      // WebSocket closed
    }
  }
}

function applyParsedShellIntegrationState(
  term: Terminal,
  parsed: ReturnType<typeof parseShellIntegrationChunk>,
  { emitOutput = true }: { emitOutput?: boolean } = {},
) {
  term.shellIntegrationCarry = parsed.state.carry;
  let stateChanged = false;
  if (term.running !== parsed.state.running) {
    term.running = parsed.state.running;
    stateChanged = true;
  }
  if (term.lastExitCode !== parsed.state.lastExitCode) {
    term.lastExitCode = parsed.state.lastExitCode;
    stateChanged = true;
  }
  if (term.agentName !== parsed.state.agentName) {
    if (term.agentName && term.agentName !== parsed.state.agentName) {
      clearAgentRespondingTimer(term);
    }
    term.agentName = parsed.state.agentName;
    if (parsed.state.agentName) {
      term.agentHasUserPrompt = false;
    }
    stateChanged = true;
  }
  if (term.agentState !== parsed.state.agentState) {
    term.agentState = parsed.state.agentState;
    stateChanged = true;
  }
  if (parsed.output && term.agentName) {
    const classifiedState = classifyAgentOutputPhase(
      term.agentName,
      parsed.output,
    );
    const nextAgentState = resolveAgentOutputState({
      currentState: term.agentState,
      classifiedState,
      hasUserPrompted: term.agentHasUserPrompt,
    });
    if (nextAgentState === "responding") {
      scheduleAgentThinkingFallback(term);
    } else if (nextAgentState === "thinking") {
      clearAgentRespondingTimer(term);
    }
    if (nextAgentState && term.agentState !== nextAgentState) {
      term.agentState = nextAgentState;
      stateChanged = true;
    }
  }
  if (stateChanged) {
    broadcastTerminalState(term);
  }

  if (emitOutput && parsed.output) {
    appendScrollback(term.id, parsed.output);
    broadcastTerminalOutput(term.id, parsed.output);
  }
}

function processShellIntegrationChunk(
  term: Terminal,
  chunk: string,
  options: { emitOutput?: boolean } = {},
) {
  const parsed = parseShellIntegrationChunk(chunk, {
    carry: term.shellIntegrationCarry || "",
    running: term.running || false,
    lastExitCode:
      typeof term.lastExitCode === "number" ? term.lastExitCode : null,
    agentName: term.agentName || null,
    agentState: term.agentState || null,
  });
  applyParsedShellIntegrationState(term, parsed, options);
}

function clearAgentRespondingTimer(term: Terminal) {
  if (!term.agentRespondingTimer) return;
  clearTimeout(term.agentRespondingTimer);
  term.agentRespondingTimer = null;
}

function scheduleAgentThinkingFallback(term: Terminal) {
  clearAgentRespondingTimer(term);
  const idleMs =
    term.agentName === "claude"
      ? CLAUDE_AGENT_RESPONDING_IDLE_MS
      : AGENT_RESPONDING_IDLE_MS;
  term.agentRespondingTimer = setTimeout(() => {
    const current = terminals.get(term.id);
    if (!current || current !== term) return;
    term.agentRespondingTimer = null;
    if (!term.agentName || term.agentState !== "responding") {
      return;
    }
    term.agentState = "thinking";
    broadcastTerminalState(term);
  }, idleMs);
}

async function finalizeReconnectReady(
  ws: ServerWebSocket<WsData>,
  terminalId: string,
  term: Terminal,
) {
  if (TMUX_BACKEND) {
    if (term.sessionName) {
      try {
        await syncTmuxSessionSize(term.sessionName, term.cols, term.rows);
        await sendTmuxPaneCapture(ws, term.sessionName, terminalId, {
          waitMs: 120,
          reason: "refresh",
        });
      } catch (err) {
        debug(`[reconnect] tmux refresh capture failed for ${terminalId}`, err);
      }
    }
    sendReconnectLifecycle(ws, "ready");
    return;
  }

  try {
    const originalCols = term.cols;
    const originalRows = term.rows;
    term.terminal.resize(Math.max(1, originalCols - 1), originalRows);
    await sleep(120);
    term.terminal.resize(originalCols, originalRows);
  } catch (err) {
    debug(`[reconnect] redraw resize failed for ${terminalId}`, err);
  } finally {
    sendReconnectLifecycle(ws, "ready");
  }
}

const openCodeCircuit = {
  failures: 0,
  lastFailure: 0,
  isOpen: false,
  threshold: 5,
  resetTimeout: 30_000,
  recordFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.threshold) {
      this.isOpen = true;
      debug("OpenCode circuit OPEN - too many failures");
    }
  },
  recordSuccess() {
    this.failures = 0;
    this.isOpen = false;
  },
  canRequest(): boolean {
    if (!this.isOpen) return true;
    if (Date.now() - this.lastFailure > this.resetTimeout) {
      this.isOpen = false;
      this.failures = 0;
      debug("OpenCode circuit HALF-OPEN - testing");
      return true;
    }
    return false;
  },
};

// Rate limiting state (simple in-memory)
const rateLimitState = {
  timestamps: [] as number[],
  clean() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(
      (t) => now - t < RATE_LIMIT_WINDOW_MS,
    );
  },
  canCreate(): boolean {
    this.clean();
    return this.timestamps.length < RATE_LIMIT_MAX_REQUESTS;
  },
  record() {
    this.timestamps.push(Date.now());
  },
};

// =============================================================================
// CLIPBOARD IMAGE HELPERS
// =============================================================================

// Ensure clipboard directory exists
async function ensureClipboardDir() {
  try {
    await mkdir(CLIPBOARD_IMAGES_DIR, { recursive: true });
  } catch {
    // Directory exists
  }
}

// Cleanup old clipboard images (called periodically)
async function cleanupClipboardImages() {
  try {
    const files = await readdir(CLIPBOARD_IMAGES_DIR);
    const now = Date.now();

    for (const file of files) {
      const filePath = join(CLIPBOARD_IMAGES_DIR, file);
      try {
        const fileStat = await stat(filePath);
        if (now - fileStat.mtimeMs > CLIPBOARD_IMAGE_TTL_MS) {
          await unlink(filePath);
          console.log(`[Clipboard] Cleaned up old image: ${file}`);
        }
      } catch {
        // File may have been deleted
      }
    }
  } catch {
    // Directory may not exist yet
  }
}

// Run cleanup every 15 minutes
setInterval(cleanupClipboardImages, 15 * 60 * 1000);
// Ensure directory exists on startup
ensureClipboardDir();

export async function reconcileSessionsOnStartup(
  db: Database,
): Promise<number> {
  if (!TMUX_BACKEND) return 0;
  let fixed = 0;
  try {
    const activeSessions = db
      .query("SELECT id FROM terminal_sessions WHERE status = 'active'")
      .all() as { id: string }[];
    for (const session of activeSessions) {
      const sessionName = buildTmuxSessionName({
        namespace: TMUX_SESSION_NAMESPACE,
        terminalId: session.id,
      });
      if (!(await tmuxSessionExists(sessionName))) {
        markTerminalSessionEnded(db, session.id);
        fixed++;
        console.log(
          `[reconciliation] Closed zombie session ${session.id} (DB was active, but tmux session was missing)`,
        );
      }
    }
  } catch (err) {
    console.error(
      "[reconciliation] Error during startup session reconciliation:",
      err,
    );
  }
  return fixed;
}

// Recover existing tmux sessions on startup (for TMUX_BACKEND)
async function recoverTmuxSessions(): Promise<number> {
  if (!TMUX_BACKEND) return 0;

  try {
    const sessions =
      await tmuxTerminalBackend!.listSessions(TMUX_SESSION_PREFIX);
    if (sessions.length === 0) return 0;

    let recovered = 0;
    const state = await getFoundationState();

    for (const sessionName of sessions) {
      const parsed = parseTmuxSessionName(sessionName, TMUX_SESSION_PREFIX);
      if (!parsed) continue;

      const { terminalId: id } = parsed;
      const recordedSession = getTerminalSession(state.db, id);
      if (!recordedSession) {
        console.warn(
          `[tmux] Orphan session found: ${sessionName}, skipping recovery`,
        );
        continue;
      }
      if (recordedSession.status !== "active") {
        console.warn(
          `[tmux] Inactive database session found for ${sessionName} (${recordedSession.status}), skipping recovery`,
        );
        continue;
      }

      const ownerId = recordedSession.actorUserId || "unknown";
      const ownerEmail = resolveRecoveredOwnerEmail(
        state,
        recordedSession.actorUserId,
      );

      const { cwd, cols, rows, panePid, paneCurrentCommand } =
        await getTmuxSessionInfo(sessionName);
      const paneCapture = await captureTmuxPane(sessionName);
      const processTree = panePid > 0 ? await getProcessTreeArgs(panePid) : [];
      const recoveredRuntimeState = inferTmuxRuntimeState({
        paneCurrentCommand,
        processTree,
        capture: paneCapture,
        previousCapture: "",
        previousState: {
          running: false,
          lastExitCode: null,
          agentName: null,
          agentState: null,
        },
        hasUserPrompted: true,
      });
      const recoveredTerminal = await createManagedTerminal({
        id,
        cwd: recordedSession.cwd || cwd,
        cols,
        rows,
        ownerId,
        ownerEmail,
        sessionName,
        initialRuntimeState: recoveredRuntimeState,
        initialLastExitCode: recoveredRuntimeState.lastExitCode,
        initialScrollback: paneCapture,
      });
      recoveredTerminal.hadSocketConnection = true;

      recovered++;
      console.log(
        `[tmux] Recovered session: ${sessionName} -> terminal ${id} (root: ${recordedSession.rootId || "unknown"})`,
      );
    }

    return recovered;
  } catch (err) {
    // tmux not running or no sessions - that's fine
    console.log("[tmux] No existing sessions to recover");
    return 0;
  }
}

function resolveRecoveredOwnerEmail(
  state: FoundationState,
  actorUserId: string | null,
): string {
  if (!actorUserId) return "recovered";
  const row = state.db
    .query("SELECT email FROM users WHERE id = ?")
    .get(actorUserId) as { email: string | null } | null;
  return row?.email || actorUserId;
}

async function tmuxSessionExists(sessionName: string): Promise<boolean> {
  if (!TMUX_BACKEND || !tmuxTerminalBackend) return false;
  return tmuxTerminalBackend.sessionExists(sessionName);
}

async function restoreRecordedTmuxSession(
  state: FoundationState,
  recordedSession: RecordedTerminalSession,
): Promise<Terminal | null> {
  if (!TMUX_BACKEND || recordedSession.status !== "active") return null;

  const existing = terminals.get(recordedSession.id);
  if (existing) return existing;

  const sessionName = buildTmuxSessionName({
    namespace: TMUX_SESSION_NAMESPACE,
    terminalId: recordedSession.id,
  });
  if (!(await tmuxSessionExists(sessionName))) {
    markTerminalSessionEnded(state.db, recordedSession.id);
    return null;
  }

  const ownerId = recordedSession.actorUserId || "unknown";
  const ownerEmail = resolveRecoveredOwnerEmail(
    state,
    recordedSession.actorUserId,
  );
  const { cwd, cols, rows, panePid, paneCurrentCommand } =
    await getTmuxSessionInfo(sessionName);
  const paneCapture = await captureTmuxPane(sessionName);
  const processTree = panePid > 0 ? await getProcessTreeArgs(panePid) : [];
  const recoveredRuntimeState = inferTmuxRuntimeState({
    paneCurrentCommand,
    processTree,
    capture: paneCapture,
    previousCapture: "",
    previousState: {
      running: false,
      lastExitCode: null,
      agentName: null,
      agentState: null,
    },
    hasUserPrompted: true,
  });

  const restoredTerminal = await createManagedTerminal({
    id: recordedSession.id,
    cwd: recordedSession.cwd || cwd,
    cols,
    rows,
    ownerId,
    ownerEmail,
    sessionName,
    initialRuntimeState: recoveredRuntimeState,
    initialLastExitCode: recoveredRuntimeState.lastExitCode,
    initialScrollback: paneCapture,
  });
  restoredTerminal.hadSocketConnection = true;
  return restoredTerminal;
}

// Debug logger
function debug(...args: unknown[]) {
  if (DEBUG) console.log("[web-terminal]", ...args);
}

let allowedRealRootsCache: string[] | null = null;
let foundationStatePromise: Promise<FoundationState> | null = null;

function isFoundationLegacyBypassEnabled(): boolean {
  return isLegacyBootstrapBypassAllowed(process.env);
}

async function getFoundationState(): Promise<FoundationState> {
  if (!foundationStatePromise) {
    foundationStatePromise = initializeFoundationState({
      stateDir: DECKTERM_STATE_DIR,
      allowedFileRoots: ALLOWED_FILESYSTEM_ROOTS,
      env: process.env,
    });
  }
  return foundationStatePromise;
}

async function requireFoundationCapability({
  actorUserId,
  capability,
  resourceType,
  resourceId = "*",
  data = {},
}: {
  actorUserId: string;
  capability: ScopedGrantCapability;
  resourceType: string;
  resourceId?: string | null;
  data?: Record<string, unknown>;
}): Promise<
  { ok: true } | { ok: false; status: 403; message: string; reason: string }
> {
  if (isFoundationLegacyBypassEnabled()) {
    return { ok: true };
  }

  // Edge-trusted cloudflare-tunnel mode: the Cloudflare Access edge already
  // authenticated the human (the app binds loopback, so it is only reachable
  // through the tunnel). Allow host-access without a per-actor grant, but audit
  // the real identity for accountability. Root mapping still happens upstream,
  // so this does not widen filesystem scope.
  if (isEdgeProtectedTunnelMode(process.env)) {
    const state = await getFoundationState();
    writeAuditEvent(state.db, {
      actorUserId,
      action: capability,
      resourceType,
      resourceId,
      decision: "allow",
      reason: "edge_trusted_tunnel",
      data,
    });
    return { ok: true };
  }

  const state = await getFoundationState();
  if (!isBootstrapComplete(state)) {
    writeAuditEvent(state.db, {
      actorUserId,
      action: capability,
      resourceType,
      resourceId,
      decision: "deny",
      reason: "bootstrap_required",
      data: {
        ...data,
        bootstrapMode: state.bootstrap.mode,
        bootstrapTokenPath: state.bootstrap.tokenPath,
      },
    });

    return {
      ok: false,
      status: 403,
      message: "DeckTerm bootstrap required",
      reason: "bootstrap_required",
    };
  }

  if (
    !hasScopedGrant(state.db, {
      userId: actorUserId,
      capability,
      resourceType,
      resourceId: resourceId || "*",
    })
  ) {
    writeAuditEvent(state.db, {
      actorUserId,
      action: capability,
      resourceType,
      resourceId,
      decision: "deny",
      reason: "missing_capability",
      data,
    });

    return {
      ok: false,
      status: 403,
      message: "DeckTerm capability denied",
      reason: "missing_capability",
    };
  }

  return { ok: true };
}

function foundationGateJson(error: { message: string; reason: string }) {
  if (error.reason === "bootstrap_required") {
    return {
      error: error.message,
      message:
        "DeckTerm foundation state exists, but no admin has completed bootstrap yet.",
    };
  }
  return {
    error: error.message,
    message:
      "The current user is missing the required DeckTerm capability grant.",
  };
}

function ensureTerminalSessionRecorded(state: FoundationState, term: Terminal) {
  if (getTerminalSession(state.db, term.id)) return;
  recordTerminalSession(state.db, {
    id: term.id,
    actorUserId: term.ownerId,
    rootId: resolveFoundationRootIdForPath(state, term.cwd),
    cwd: term.cwd,
    status: "active",
  });
}

async function requireTerminalSessionAccess({
  actorUserId,
  term,
  capability,
}: {
  actorUserId: string;
  term: Terminal;
  capability: "terminal.attach" | "terminal.manage";
}): Promise<
  { ok: true } | { ok: false; status: 403; reason: string; message: string }
> {
  if (isFoundationLegacyBypassEnabled()) {
    return term.ownerId === actorUserId
      ? { ok: true }
      : {
          ok: false,
          status: 403,
          reason: "legacy_owner_mismatch",
          message: "DeckTerm capability denied",
        };
  }
  const state = await getFoundationState();
  if (!isBootstrapComplete(state)) {
    writeAuditEvent(state.db, {
      actorUserId,
      action: capability,
      resourceType: "terminal",
      resourceId: term.id,
      decision: "deny",
      reason: "bootstrap_required",
    });
    return {
      ok: false,
      status: 403,
      reason: "bootstrap_required",
      message: "DeckTerm bootstrap required",
    };
  }

  ensureTerminalSessionRecorded(state, term);
  const decision = authorizeTerminalSessionAccess(state.db, {
    actorUserId,
    terminalId: term.id,
    capability,
  });
  writeAuditEvent(state.db, {
    actorUserId,
    action: capability,
    resourceType: "terminal",
    resourceId: term.id,
    decision: decision.allow ? "allow" : "deny",
    reason: decision.reason,
  });
  if (!decision.allow) {
    return {
      ok: false,
      status: 403,
      reason: decision.reason,
      message: "DeckTerm capability denied",
    };
  }
  return { ok: true };
}

async function getAllowedRealRoots(): Promise<string[]> {
  if (allowedRealRootsCache) return allowedRealRootsCache;
  const fs = await import("fs/promises");
  const roots: string[] = [];
  for (const root of ALLOWED_FILESYSTEM_ROOTS) {
    try {
      roots.push(await fs.realpath(root));
    } catch {
      debug("Skipping non-existent allowed root:", root);
    }
  }
  if (roots.length === 0) {
    roots.push(DEFAULT_ALLOWED_ROOT);
  }
  allowedRealRootsCache = roots;
  return roots;
}

function isWithinAllowedRoots(pathValue: string, roots: string[]): boolean {
  return roots.some(
    (root) => pathValue === root || pathValue.startsWith(`${root}/`),
  );
}

async function resolveAllowedPath(
  inputPath: string,
  opts: { allowMissing?: boolean } = {},
): Promise<string | null> {
  if (!inputPath) return null;
  const fs = await import("fs/promises");
  const candidatePath = resolve(inputPath);
  const roots = await getAllowedRealRoots();
  try {
    const realPath = await fs.realpath(candidatePath);
    return isWithinAllowedRoots(realPath, roots) ? realPath : null;
  } catch (err: unknown) {
    const error = err as { code?: string };
    if (!opts.allowMissing || error.code !== "ENOENT") {
      return null;
    }
    try {
      const realParent = await fs.realpath(dirname(candidatePath));
      if (!isWithinAllowedRoots(realParent, roots)) {
        return null;
      }
      const rel = relative(realParent, candidatePath);
      if (!rel || rel.startsWith("..")) {
        return null;
      }
      return candidatePath;
    } catch {
      return null;
    }
  }
}

function resolveFoundationRootIdForPath(
  state: FoundationState,
  pathValue: string,
): string | null {
  const matchingRoots = state.roots
    .filter(
      (root) =>
        pathValue === root.path || pathValue.startsWith(`${root.path}/`),
    )
    .sort((a, b) => b.path.length - a.path.length);
  return matchingRoots[0]?.id || null;
}

async function requireFileAccess(
  c: any,
  resolvedPath: string,
): Promise<{ ok: true } | { ok: false; status: number; body: any }> {
  if (isFoundationLegacyBypassEnabled()) {
    return { ok: true };
  }

  const { ownerId } = getCurrentUser(c);
  const state = await getFoundationState();
  const rootId = resolveFoundationRootIdForPath(state, resolvedPath);

  if (!rootId) {
    writeAuditEvent(state.db, {
      actorUserId: ownerId,
      action: "file.access",
      resourceType: "root",
      decision: "deny",
      reason: "no_matching_root",
      data: { path: resolvedPath },
    });
    return {
      ok: false,
      status: 403,
      body: { error: "Forbidden path (no matching registered root)" },
    };
  }

  const rootAuth = await requireFoundationCapability({
    actorUserId: ownerId,
    capability: "root.use",
    resourceType: "root",
    resourceId: rootId,
    data: { cwd: resolvedPath },
  });

  if (!rootAuth.ok) {
    return {
      ok: false,
      status: rootAuth.status,
      body: foundationGateJson(rootAuth),
    };
  }

  // Audit-lite telemetry for legacy path-only resolution. Every current file/git
  // call is path-only (no rootId param yet), so this is a queryable migration
  // signal rather than per-request console spam.
  writeAuditEvent(state.db, {
    actorUserId: ownerId,
    action: "file.access",
    resourceType: "root",
    resourceId: rootId,
    decision: "allow",
    reason: "legacy_path_resolution",
    data: { path: resolvedPath },
  });
  debug(
    `[deprecation] Legacy path-only resolution for ${resolvedPath} -> root ${rootId}`,
  );

  return { ok: true };
}

async function getDefaultBrowseRoot(): Promise<string> {
  const roots = await getAllowedRealRoots();
  return roots[0] || resolve(DEFAULT_ALLOWED_ROOT || "/");
}

const detectGitWorktree = createGitWorktreeDetector({
  resolveAllowedPath,
});

async function authenticateWebSocketRequest(req: Request): Promise<{
  ok: boolean;
  status?: number;
  message?: string;
  ownerId: string;
  ownerEmail: string;
  actor?: DeckTermActor;
}> {
  const jwt = req.headers.get("cf-access-jwt-assertion");
  if (CF_ACCESS_REQUIRED && !jwt) {
    return {
      ok: false,
      status: 401,
      message: "Unauthorized",
      ownerId: "",
      ownerEmail: "",
    };
  }

  let accessPayload: CloudflareAccessPayload | null = null;
  if (jwt && CF_ACCESS_TEAM_NAME) {
    try {
      const { cloudflareAccess: verifyJWT } =
        await import("@hono/cloudflare-access");
      const mockContext = {
        req: { header: (name: string) => req.headers.get(name) },
        set: (key: string, value: CloudflareAccessPayload) => {
          if (key === "accessPayload") {
            accessPayload = value;
          }
        },
      };
      const middleware = verifyJWT(CF_ACCESS_TEAM_NAME);
      await middleware(mockContext as never, async () => {});
      if (!isCloudflareAudienceAllowed(accessPayload?.aud, CF_ACCESS_AUD)) {
        return {
          ok: false,
          status: 401,
          message: "Unauthorized",
          ownerId: "",
          ownerEmail: "",
        };
      }
    } catch (err) {
      debug("WebSocket JWT verification failed:", err);
      return {
        ok: false,
        status: 401,
        message: "Unauthorized",
        ownerId: "",
        ownerEmail: "",
      };
    }
  }

  const actorResult = resolveActorFromAccessPayload({
    accessPayload,
    tunnelUserEmail: req.headers.get("cf-access-authenticated-user-email"),
    env: process.env,
  });
  if (!actorResult.ok) {
    return {
      ok: false,
      status: actorResult.status,
      message: "Unauthorized",
      ownerId: "",
      ownerEmail: "",
    };
  }

  return {
    ok: true,
    ownerId: actorResult.actor.id,
    ownerEmail: actorResult.actor.email,
    actor: actorResult.actor,
  };
}

function appendScrollback(terminalId: string, data: string) {
  if (!data) return;
  const term = terminals.get(terminalId);
  if (!term) return;

  appendTerminalRuntimeEvent(terminalId, "output", { data });

  const chunks = data.split(/(?<=\n)/g);
  for (const chunk of chunks) {
    if (!chunk) continue;
    term.scrollback.push(chunk);
    term.scrollbackBytes += Buffer.byteLength(chunk);
  }

  while (
    term.scrollback.length > SCROLLBACK_MAX_LINES ||
    term.scrollbackBytes > SCROLLBACK_MAX_BYTES
  ) {
    const removed = term.scrollback.shift();
    if (!removed) break;
    term.scrollbackBytes -= Buffer.byteLength(removed);
  }
}

function getScrollbackSnapshot(term: Terminal): string {
  return term.scrollback.join("");
}

class UnauthorizedRequestError extends Error {
  status = 401 as const;
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedRequestError";
  }
}

function getCurrentActor(c: {
  get: (key: string) => CloudflareAccessPayload | undefined;
  req?: { header: (name: string) => string | undefined };
}): DeckTermActor {
  const actorResult = resolveActorFromAccessPayload({
    accessPayload: c.get("accessPayload") || null,
    tunnelUserEmail:
      c.req?.header("cf-access-authenticated-user-email") ?? null,
    env: process.env,
  });
  if (!actorResult.ok) {
    throw new UnauthorizedRequestError();
  }
  return actorResult.actor;
}

function getCurrentUser(c: {
  get: (key: string) => CloudflareAccessPayload | undefined;
}): {
  ownerId: string;
  ownerEmail: string;
  ownerSource: DeckTermActor["source"];
} {
  const actor = getCurrentActor(c);
  return {
    ownerId: actor.id,
    ownerEmail: actor.email,
    ownerSource: actor.source,
  };
}

async function getFoundationStatus(c: {
  get: (key: string) => CloudflareAccessPayload | undefined;
}) {
  const actor = getCurrentActor(c);
  const state = await getFoundationState();
  return {
    runtime: {
      environment:
        process.env.DECKTERM_RUNTIME_ENV ||
        process.env.NODE_ENV ||
        "production",
      backendMode: getBackendMode(),
      port: process.env.PORT || "4174",
    },
    auth: {
      actor,
      cloudflareAccessRequired: CF_ACCESS_REQUIRED,
      cloudflareAccessTeamConfigured: Boolean(CF_ACCESS_TEAM_NAME),
      cloudflareAccessAudienceConfigured: Boolean(CF_ACCESS_AUD),
    },
    bootstrap: {
      bootstrapped: state.bootstrap.bootstrapped,
      mode: state.bootstrap.mode,
      expectedEmail: state.bootstrap.expectedEmail,
    },
    roots: state.roots.map((root) => ({
      id: root.id,
      name: root.name,
      path: root.path,
      status: root.status,
      warning: root.warning,
    })),
  };
}

function getBackendMode(): "tmux" | "raw" {
  return terminalBackend.mode;
}

function getTerminalSocketStats(
  term: Terminal,
  requestingClientId?: string | null,
) {
  const sockets = terminalSockets.get(term.id);
  let activeConnectionCount = 0;
  let hasForeignConnection = false;

  if (sockets) {
    for (const socket of sockets) {
      if (socket.readyState !== 1) continue;
      activeConnectionCount++;
      const socketClientId =
        socket.data.type === "terminal" ? socket.data.clientId : null;
      if (
        socketClientId &&
        requestingClientId &&
        socketClientId === requestingClientId
      ) {
        continue;
      }
      if (activeConnectionCount > 0) {
        hasForeignConnection = true;
      }
    }
  }

  return { activeConnectionCount, hasForeignConnection };
}

function supportsLinkedView(term: Terminal): boolean {
  return supportsTerminalLinkedView({
    tmuxBackend: TMUX_BACKEND,
    sessionName: term.sessionName,
  });
}

function serializeTerminal(term: Terminal, requestingClientId?: string | null) {
  const socketStats = getTerminalSocketStats(term, requestingClientId);
  return {
    id: term.id,
    cols: term.cols,
    rows: term.rows,
    cwd: term.cwd,
    createdAt: term.createdAt,
    running: term.running,
    lastExitCode: term.lastExitCode,
    agentName: term.agentName,
    agentState: term.agentState,
    backendMode: getBackendMode(),
    supportsLinkedView: supportsLinkedView(term),
    sharedSessionKey: term.sessionName || null,
    activeConnectionCount: socketStats.activeConnectionCount,
    hasForeignConnection: socketStats.hasForeignConnection,
    active: true,
    status: "active" as const,
    sessionStatus: "active" as const,
  };
}

function parseSessionTimestamp(timestamp: string): number {
  const millis = Date.parse(timestamp);
  return Number.isFinite(millis) ? millis : 0;
}

function getRecordedSessionCatalogStatus(
  session: RecordedTerminalSession,
): "detached" | "inactive" {
  return session.status === "active" ? "detached" : "inactive";
}

function serializeRecordedTerminalSession(session: RecordedTerminalSession) {
  const status = getRecordedSessionCatalogStatus(session);
  const sharedSessionKey =
    TMUX_BACKEND && session.status === "active"
      ? buildTmuxSessionName({
          namespace: TMUX_SESSION_NAMESPACE,
          terminalId: session.id,
        })
      : null;

  return {
    id: session.id,
    cols: 120,
    rows: 30,
    cwd: session.cwd,
    createdAt: parseSessionTimestamp(session.createdAt),
    updatedAt: session.updatedAt,
    endedAt: session.endedAt,
    running: false,
    lastExitCode: session.status === "ended" ? 0 : null,
    agentName: null,
    agentState: null,
    backendMode: getBackendMode(),
    supportsLinkedView: Boolean(TMUX_BACKEND && sharedSessionKey),
    sharedSessionKey,
    activeConnectionCount: 0,
    hasForeignConnection: false,
    active: false,
    status,
    sessionStatus: session.status,
  };
}

function getTerminalCreationError(ownerId: string) {
  if (!rateLimitState.canCreate()) {
    return {
      status: 429 as const,
      body: { error: "Rate limit exceeded. Try again later." },
    };
  }

  const userTerminals = Array.from(terminals.values()).filter(
    (t) => t.ownerId === ownerId,
  );
  if (userTerminals.length >= MAX_TERMINALS_PER_USER) {
    return {
      status: 429 as const,
      body: {
        error: `Maximum terminals per user (${MAX_TERMINALS_PER_USER}) reached.`,
      },
    };
  }

  if (terminals.size >= MAX_TERMINALS) {
    return {
      status: 429 as const,
      body: { error: `Maximum terminals (${MAX_TERMINALS}) reached.` },
    };
  }

  return null;
}

function getTerminalSockets(id: string): Set<ServerWebSocket<WsData>> {
  const existing = terminalSockets.get(id);
  if (existing) return existing;
  const sockets = new Set<ServerWebSocket<WsData>>();
  terminalSockets.set(id, sockets);
  return sockets;
}

function getForeignSessionSockets(
  sessionName: string | undefined,
  requestingClientId: string | null,
): Array<ServerWebSocket<WsData>> {
  if (!sessionName || !requestingClientId) return [];

  const foreignSockets: Array<ServerWebSocket<WsData>> = [];
  for (const term of terminals.values()) {
    if (term.sessionName !== sessionName) continue;
    const sockets = terminalSockets.get(term.id);
    if (!sockets) continue;
    for (const socket of sockets) {
      if (socket.readyState !== 1 || socket.data.type !== "terminal") continue;
      if (
        !socket.data.clientId ||
        socket.data.clientId === requestingClientId
      ) {
        continue;
      }
      foreignSockets.push(socket);
    }
  }

  return foreignSockets;
}

function handoffTmuxSession(
  sessionName: string | undefined,
  requestingClientId: string | null,
): void {
  const foreignSockets = getForeignSessionSockets(
    sessionName,
    requestingClientId,
  );
  if (foreignSockets.length === 0) return;

  for (const socket of foreignSockets) {
    try {
      socket.send(
        JSON.stringify({
          type: "session_handoff",
          sessionName,
        }),
      );
    } catch {
      // ignore
    }

    setTimeout(() => {
      try {
        socket.close();
      } catch {
        // ignore
      }
    }, 25);
  }
}

function broadcastTerminalOutput(id: string, data: string) {
  const sockets = terminalSockets.get(id);
  if (!sockets || sockets.size === 0) return;
  debug(`PTY ${id} data (${data.length} bytes)`);
  for (const ws of sockets) {
    const reconnectState = socketReconnectState.get(ws);
    if (reconnectState?.pendingReady || reconnectState?.replaying) {
      continue;
    }
    try {
      if (ws.data.type === "terminal" && ws.data.protocol === "v2") {
        ws.send(
          JSON.stringify({
            type: "terminal_event",
            kind: "output",
            data,
          }),
        );
      } else {
        ws.send(data);
      }
    } catch {
      // WebSocket closed
    }
  }
}

async function ensureBashIntegrationRc(): Promise<string> {
  if (bashIntegrationRcPathPromise) return bashIntegrationRcPathPromise;

  bashIntegrationRcPathPromise = (async () => {
    const rcPath = "/tmp/deckterm-bash-integration.rc";
    const rcContents = [
      "if [ -f /etc/profile ]; then",
      "  . /etc/profile",
      "fi",
      'if [ -f "$HOME/.bash_profile" ]; then',
      '  . "$HOME/.bash_profile"',
      'elif [ -f "$HOME/.bash_login" ]; then',
      '  . "$HOME/.bash_login"',
      'elif [ -f "$HOME/.profile" ]; then',
      '  . "$HOME/.profile"',
      "fi",
      "if [ -f /etc/bash.bashrc ]; then",
      "  . /etc/bash.bashrc",
      "fi",
      'if [ -f "$HOME/.bashrc" ]; then',
      '  . "$HOME/.bashrc"',
      "fi",
      "__deckterm_running_start() {",
      "  printf '\\033]9;9;deckterm;running;start\\a'",
      "}",
      "__deckterm_emit_marker() {",
      "  printf '\\033]9;9;deckterm;%s\\a' \"$1\"",
      "}",
      "__deckterm_running_done() {",
      "  local exit_code=$?",
      '  if [ "${__deckterm_prompt_seen:-0}" -eq 0 ]; then',
      "    __deckterm_prompt_seen=1",
      "    return",
      "  fi",
      "  printf '\\033]9;9;deckterm;running;done;%s\\a' \"$exit_code\"",
      "}",
      "__deckterm_run_agent() {",
      '  local agent_name="$1"',
      "  shift",
      '  __deckterm_emit_marker "agent;${agent_name};start"',
      '  command "$agent_name" "$@"',
      "  local exit_code=$?",
      '  __deckterm_emit_marker "agent;${agent_name};done;${exit_code}"',
      '  return "$exit_code"',
      "}",
      "if command -v codex >/dev/null 2>&1; then",
      '  codex() { __deckterm_run_agent codex "$@"; }',
      "fi",
      "if command -v claude >/dev/null 2>&1; then",
      '  claude() { __deckterm_run_agent claude "$@"; }',
      "fi",
      'case ";${PROMPT_COMMAND};" in',
      '  *";__deckterm_running_done;"*) ;;',
      '  "")',
      '    PROMPT_COMMAND="__deckterm_running_done"',
      "    ;;",
      "  *)",
      '    PROMPT_COMMAND="__deckterm_running_done; ${PROMPT_COMMAND}"',
      "    ;;",
      "esac",
      "PS0=$'\\033]9;9;deckterm;running;start\\a'",
      "",
    ].join("\n");
    await Bun.write(rcPath, rcContents);
    return rcPath;
  })();

  return bashIntegrationRcPathPromise;
}

async function resolveShellCommand(): Promise<string[]> {
  const shell = process.env.SHELL || "/bin/bash";
  const isBashShell = basename(shell) === "bash";
  const bashRcPath = isBashShell ? await ensureBashIntegrationRc() : null;
  return bashRcPath && isBashShell
    ? [shell, "--rcfile", bashRcPath, "-i"]
    : [shell, "-il"];
}

function createTerminalHandle(id: string, cols: number, rows: number) {
  return new BunTerminal({
    cols,
    rows,
    data(term, data) {
      const strData =
        typeof data === "string" ? data : utf8Decoder.decode(data);
      const terminalState = terminals.get(id);
      if (terminalState) {
        processShellIntegrationChunk(terminalState, strData);
      }
    },
  });
}

function closeTerminalSockets(id: string, message?: string) {
  const sockets = terminalSockets.get(id);
  if (!sockets) return;
  for (const ws of sockets) {
    try {
      if (message) ws.send(message);
      ws.close();
    } catch {
      // ignore
    }
  }
}

function removeTerminalState(id: string) {
  const terminal = terminals.get(id);
  if (terminal) {
    clearAgentRespondingTimer(terminal);
  }
  terminals.delete(id);
  terminalSockets.delete(id);
}

function hasOtherTerminalForSession(
  sessionName: string,
  excludedTerminalId?: string,
): boolean {
  for (const term of terminals.values()) {
    if (term.sessionName !== sessionName) continue;
    if (excludedTerminalId && term.id === excludedTerminalId) continue;
    return true;
  }
  return false;
}

async function killTmuxSessionIfLast(
  sessionName: string | undefined,
  excludedTerminalId?: string,
) {
  if (!TMUX_BACKEND || !tmuxTerminalBackend || !sessionName) return false;
  if (hasOtherTerminalForSession(sessionName, excludedTerminalId)) {
    debug(
      `[tmux] Preserving shared session ${sessionName} for other attached DeckTerm views`,
    );
    return false;
  }

  debug(`[tmux] Killing session ${sessionName}`);
  try {
    await tmuxTerminalBackend.kill(sessionName);
  } catch (err) {
    debug(`[tmux] kill-session failed for ${sessionName}`, err);
    return false;
  }
  return true;
}

async function getTmuxSessionInfo(sessionName: string): Promise<{
  cwd: string;
  cols: number;
  rows: number;
  panePid: number;
  paneCurrentCommand: string;
}> {
  if (!tmuxTerminalBackend) {
    return {
      cwd: process.env.HOME || "/home/deploy",
      cols: 120,
      rows: 30,
      panePid: 0,
      paneCurrentCommand: "",
    };
  }
  return tmuxTerminalBackend.getSessionInfo(sessionName);
}

async function captureTmuxPane(sessionName: string): Promise<string> {
  return tmuxTerminalBackend ? tmuxTerminalBackend.capture(sessionName) : "";
}

async function readTmuxPipeDelta(term: Terminal): Promise<string> {
  if (!tmuxTerminalBackend || !term.tmuxPipePath) return "";
  const delta = await tmuxTerminalBackend.readPipeDelta(
    term.tmuxPipePath,
    term.tmuxPipeOffset,
  );
  term.tmuxPipeOffset = delta.offset;
  return delta.chunk;
}

async function syncTmuxSessionSize(
  sessionName: string,
  cols: number,
  rows: number,
  options: { waitForClient?: boolean } = {},
): Promise<void> {
  if (!tmuxTerminalBackend) return;
  await tmuxTerminalBackend.resize(sessionName, cols, rows, options);
}

async function sendTmuxPaneCapture(
  ws: ServerWebSocket<WsData>,
  sessionName: string,
  terminalId: string,
  {
    clearFirst = true,
    waitMs = 0,
    reason = "capture",
  }: {
    clearFirst?: boolean;
    waitMs?: number;
    reason?: string;
  } = {},
): Promise<boolean> {
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  if (ws.readyState !== 1) return false;

  const output = await captureTmuxPane(sessionName);
  if (!output || ws.readyState !== 1) return false;

  ws.send(`${clearFirst ? "\x1b[2J\x1b[H" : ""}${output}`);
  debug(
    `[reconnect] Sent ${output.length} bytes from tmux ${reason} for ${terminalId}`,
  );
  return true;
}

function replayScrollbackFallback(
  ws: ServerWebSocket<WsData>,
  term: Terminal,
  terminalId: string,
): boolean {
  const buffered = getScrollbackSnapshot(term);
  if (buffered && ws.readyState === 1) {
    ws.send(buffered);
    debug(
      `[reconnect] Replayed ${buffered.length} bytes from in-memory scrollback for ${terminalId}`,
    );
    return true;
  }
  return false;
}

async function completeTmuxReconnectReplay(
  ws: ServerWebSocket<WsData>,
  terminalId: string,
  term: Terminal,
  reason: "client-ready" | "timeout" = "client-ready",
): Promise<void> {
  const reconnectState = socketReconnectState.get(ws);
  if (!reconnectState || reconnectState.replaying || ws.readyState !== 1) {
    return;
  }

  reconnectState.replaying = true;
  reconnectState.pendingReady = true;
  try {
    // Attempt delta replay if lastEventId is provided
    if (ws.data.type === "terminal" && ws.data.lastEventId !== null) {
      const state = await getFoundationState();
      const events = listTerminalEventsAfter(
        state.db,
        terminalId,
        ws.data.lastEventId,
      );
      if (events.length > 0) {
        for (const ev of events) {
          if (ev.kind === "output" && ev.data) {
            if (ws.data.protocol === "v2") {
              ws.send(
                JSON.stringify({
                  type: "terminal_event",
                  kind: "output",
                  data: ev.data,
                }),
              );
            } else {
              ws.send(ev.data);
            }
          } else if (ev.kind === "state" && ev.dataJson) {
            ws.send(JSON.stringify({ type: "terminal_state", ...ev.dataJson }));
          }
        }
        debug(
          `[reconnect] Delta-replayed ${events.length} events after ${ws.data.lastEventId} for ${terminalId}`,
        );
        sendReconnectLifecycle(ws, "replay-complete", {
          requiresRedraw: false,
        });
        return;
      }
    }

    if (term.sessionName) {
      await syncTmuxSessionSize(term.sessionName, term.cols, term.rows, {
        waitForClient: reason === "client-ready",
      });
      const replayed = await sendTmuxPaneCapture(
        ws,
        term.sessionName,
        terminalId,
        {
          waitMs: reason === "client-ready" ? 80 : 120,
          reason,
        },
      );
      if (!replayed) {
        replayScrollbackFallback(ws, term, terminalId);
      }
    } else {
      replayScrollbackFallback(ws, term, terminalId);
    }

    sendReconnectLifecycle(ws, "replay-complete", {
      requiresRedraw: false,
    });
  } catch (err) {
    debug(
      `[reconnect] tmux replay failed for ${terminalId}, falling back to in-memory buffer`,
      err,
    );
    replayScrollbackFallback(ws, term, terminalId);
    sendReconnectLifecycle(ws, "replay-complete", {
      requiresRedraw: false,
    });
  } finally {
    reconnectState.replaying = false;
    reconnectState.pendingReady = false;
    sendReconnectLifecycle(ws, "ready");
    socketReconnectState.delete(ws);
  }
}

async function getProcessTreeArgs(rootPid: number): Promise<string[]> {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];

  const proc = Bun.spawn(["ps", "-eo", "pid=,ppid=,args="], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;

  const childrenByParent = new Map<number, number[]>();
  const argsByPid = new Map<number, string>();

  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1] || "", 10);
    const ppid = Number.parseInt(match[2] || "", 10);
    const args = (match[3] || "").trim();
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !args) continue;
    argsByPid.set(pid, args);
    const siblings = childrenByParent.get(ppid) || [];
    siblings.push(pid);
    childrenByParent.set(ppid, siblings);
  }

  const processTree: string[] = [];
  const stack = [rootPid];
  const visited = new Set<number>();

  while (stack.length > 0) {
    const pid = stack.pop();
    if (!pid || visited.has(pid)) continue;
    visited.add(pid);
    const args = argsByPid.get(pid);
    if (args) processTree.push(args);
    const children = childrenByParent.get(pid) || [];
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push(children[index]);
    }
  }

  return processTree;
}

async function syncTmuxRuntimeState(term: Terminal): Promise<void> {
  if (!TMUX_BACKEND || !term.sessionName) return;

  const pipeDelta = await readTmuxPipeDelta(term);
  if (pipeDelta) {
    processShellIntegrationChunk(term, pipeDelta, { emitOutput: false });
  }

  const { cwd, panePid, paneCurrentCommand } = await getTmuxSessionInfo(
    term.sessionName,
  );
  if (cwd) {
    term.cwd = cwd;
  }

  const [capture, processTree] = await Promise.all([
    captureTmuxPane(term.sessionName).catch(() => ""),
    panePid > 0
      ? getProcessTreeArgs(panePid).catch(() => [])
      : Promise.resolve([]),
  ]);
  const nextRuntimeState = inferTmuxRuntimeState({
    paneCurrentCommand,
    processTree,
    capture,
    previousCapture: term.lastTmuxCapture,
    previousState: {
      running: term.running,
      lastExitCode: term.lastExitCode,
      agentName: term.agentName,
      agentState: term.agentState,
    },
    hasUserPrompted: term.agentHasUserPrompt,
  });

  if (term.agentName && term.agentName !== nextRuntimeState.agentName) {
    clearAgentRespondingTimer(term);
  }

  term.running = nextRuntimeState.running;
  term.lastExitCode = nextRuntimeState.lastExitCode;
  term.agentName = nextRuntimeState.agentName;
  term.agentState = nextRuntimeState.agentState;
  if (!nextRuntimeState.agentName) {
    term.agentHasUserPrompt = false;
  }
  term.lastTmuxCapture = capture;

  if (term.agentState === "responding") {
    scheduleAgentThinkingFallback(term);
  } else {
    clearAgentRespondingTimer(term);
  }
}

async function createManagedTerminal({
  id = crypto.randomUUID(),
  cwd,
  cols,
  rows,
  ownerId,
  ownerEmail,
  sessionName,
  createTmuxSession = false,
  initialRuntimeState,
  initialLastExitCode = null,
  initialScrollback = "",
}: {
  id?: string;
  cwd: string;
  cols: number;
  rows: number;
  ownerId: string;
  ownerEmail: string;
  sessionName?: string;
  createTmuxSession?: boolean;
  initialRuntimeState?: {
    running: boolean;
    agentName: "codex" | "claude" | null;
    agentState: "thinking" | "responding" | null;
  };
  initialLastExitCode?: number | null;
  initialScrollback?: string;
}): Promise<Terminal> {
  const terminal = createTerminalHandle(id, cols, rows);
  let activeSessionName = sessionName;

  const closeAndRemoveTerminal = (
    exitCode: number,
    signalCode?: number | null,
  ) => {
    debug(
      `Terminal ${id}${activeSessionName ? ` (tmux: ${activeSessionName})` : ""} exited: code=${exitCode}, signal=${signalCode}`,
    );
    closeTerminalSockets(id, JSON.stringify({ type: "exit", code: exitCode }));
    getFoundationState()
      .then((state) => markTerminalSessionEnded(state.db, id))
      .catch((err) => debug("Failed to mark terminal session ended:", err));
    notifyTerminalExit(ownerId, id);
    removeTerminalState(id);
    terminal.close();
  };

  let tmuxPipePath: string | null = null;
  let tmuxPipeOffset = 0;

  if (createTmuxSession || !TMUX_BACKEND) {
    const backendSession = await terminalBackend.createSession(
      id,
      cwd,
      cols,
      rows,
      ownerId,
      ownerEmail,
    );
    if (TMUX_BACKEND) {
      activeSessionName = backendSession.sessionName;
    }
    tmuxPipePath = backendSession.pipePath || null;
    tmuxPipeOffset = backendSession.pipeOffset || 0;
  }

  const attachSessionName = activeSessionName || id;
  const attachResult = await terminalBackend.attach(attachSessionName, {
    cwd,
    cols,
    rows,
    terminal,
    waitForClient: TMUX_BACKEND,
    onExit(
      _proc: Subprocess,
      exitCode: number | null,
      signalCode?: number | null,
    ) {
      closeAndRemoveTerminal(exitCode ?? 0, signalCode);
    },
  });
  const proc = attachResult.proc as Subprocess;
  tmuxPipePath = attachResult.pipePath ?? tmuxPipePath;
  tmuxPipeOffset = attachResult.pipeOffset ?? tmuxPipeOffset;

  const now = Date.now();
  const managedTerminal: Terminal = {
    id,
    proc,
    terminal,
    cwd,
    cols,
    rows,
    createdAt: now,
    lastActivityAt: now,
    lastDetachedAt: now, // starts as detached/unattached
    ownerId,
    ownerEmail,
    sessionName,
    scrollback: [],
    scrollbackBytes: 0,
    hadSocketConnection: false,
    running: initialRuntimeState?.running || false,
    lastExitCode:
      typeof initialLastExitCode === "number" ? initialLastExitCode : null,
    agentName: initialRuntimeState?.agentName || null,
    agentState: initialRuntimeState?.agentState || null,
    agentHasUserPrompt: Boolean(initialRuntimeState?.agentName),
    agentRespondingTimer: null,
    shellIntegrationCarry: "",
    lastTmuxCapture: initialScrollback,
    tmuxPipePath,
    tmuxPipeOffset,
  };

  terminals.set(id, managedTerminal);
  getTerminalSockets(id);
  if (initialScrollback) {
    appendScrollback(id, initialScrollback);
  }
  if (managedTerminal.agentState === "responding") {
    scheduleAgentThinkingFallback(managedTerminal);
  }
  debug(`Terminal ${id} created with PID ${proc.pid}`);

  return managedTerminal;
}

async function createOwnedTerminal({
  cwd,
  cols = 120,
  rows = 30,
  ownerId,
  ownerEmail,
}: {
  cwd: string;
  cols?: number;
  rows?: number;
  ownerId: string;
  ownerEmail: string;
}): Promise<Terminal> {
  const fs = await import("fs/promises");
  let resolvedCwd = cwd || process.env.HOME || "/";
  try {
    const pathStat = await fs.stat(resolvedCwd);
    if (!pathStat.isDirectory()) {
      resolvedCwd = process.env.HOME || "/";
    }
  } catch {
    resolvedCwd = process.env.HOME || "/";
  }

  const id = crypto.randomUUID();
  const sessionName = TMUX_BACKEND
    ? buildTmuxSessionName({
        namespace: TMUX_SESSION_NAMESPACE,
        terminalId: id,
      })
    : undefined;

  return createManagedTerminal({
    id,
    cwd: resolvedCwd,
    cols,
    rows,
    ownerId,
    ownerEmail,
    sessionName,
    createTmuxSession: Boolean(sessionName),
  });
}

export function createWebApp() {
  const app = new Hono();
  // Resolve at call time (not the frozen const) so task workspaces follow the
  // current DECKTERM_STATE_DIR — keeps tests that set a temp state dir after
  // import from leaking api-task-* dirs into the live ~/.deckterm.
  const taskRunner = createTaskRunner({
    stateDir: resolveStateDir(),
    resolveAllowedPath,
    maxRounds: DECKTERM_TASK_MAX_ROUNDS,
    allowedProviders: DECKTERM_TASK_PROVIDERS,
  });

  // Advance worker/judge tasks when their agent terminal exits.
  onTerminalExit((ownerId, terminalId) => {
    taskRunner
      .handleTerminalExit(ownerId, terminalId)
      .catch((err) => debug("Task terminal-exit sync failed:", err));
  });

  app.onError((err, c) => {
    if (err instanceof UnauthorizedRequestError) {
      return c.text(err.message, err.status);
    }
    console.error("[Hono] Route error:", err);
    const response: { error: string; message?: string } = {
      error: "Internal server error",
    };
    if (DEBUG) {
      response.message = err instanceof Error ? err.message : String(err);
    }
    return c.json(response, 500);
  });

  const hasTrustedOrigins = TRUSTED_ORIGINS.length > 0;
  app.use(
    "/*",
    cors({
      origin: hasTrustedOrigins
        ? (origin) =>
            origin && TRUSTED_ORIGINS.includes(origin) ? origin : null
        : "*",
      credentials: hasTrustedOrigins,
    }),
  );

  // Cloudflare Access JWT authentication
  if (CF_ACCESS_REQUIRED && CF_ACCESS_TEAM_NAME) {
    app.use("/*", cloudflareAccess(CF_ACCESS_TEAM_NAME));
    app.use("/*", async (c, next) => {
      const accessPayload = c.get("accessPayload");
      if (!isCloudflareAudienceAllowed(accessPayload?.aud, CF_ACCESS_AUD)) {
        return c.text("Unauthorized", 401);
      }
      await next();
    });
  }

  // No-cache headers - bypass CF cache
  app.use("/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    c.header("Pragma", "no-cache");
    c.header("Expires", "0");
    c.header("CDN-Cache-Control", "no-store");
    c.header("Cloudflare-CDN-Cache-Control", "no-store");
  });

  // Health endpoint
  app.get("/api/health", (c) => {
    return c.json({
      status: "ok",
      release: DECKTERM_RELEASE,
      terminals: terminals.size,
      maxTerminals: MAX_TERMINALS,
      uptime: process.uptime(),
    });
  });

  app.post("/api/bootstrap", async (c) => {
    const { ownerId, ownerEmail, ownerSource } = getCurrentUser(c);
    const body = await c.req.json().catch(() => ({}));
    const state = await getFoundationState();
    const result = await bootstrapFirstAdmin({
      state,
      stateDir: DECKTERM_STATE_DIR,
      actorUserId: ownerId,
      actorEmail: ownerEmail,
      token: typeof body.token === "string" ? body.token : null,
      authIdentity:
        ownerSource === "cloudflare_access"
          ? { provider: "cloudflare_access", providerSubject: ownerId }
          : null,
      env: process.env,
    });
    if (!result.ok) {
      writeAuditEvent(state.db, {
        actorUserId: ownerId,
        action: "bootstrap.admin.create",
        resourceType: "server",
        resourceId: "*",
        decision: "deny",
        reason: result.error,
      });
      return c.json({ error: result.error }, result.status);
    }
    return c.json({ ok: true, user: result.user });
  });

  app.get("/api/foundation/status", async (c) => {
    return c.json(await getFoundationStatus(c));
  });

  // Server stats endpoint (CPU, RAM, Disk)
  app.get("/api/stats", async (c) => {
    const os = await import("os");
    const fs = await import("fs/promises");

    const cpus = os.cpus();
    const cpuUsage =
      cpus.reduce((acc, cpu) => {
        const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
        const idle = cpu.times.idle;
        return acc + ((total - idle) / total) * 100;
      }, 0) / cpus.length;

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    let availableMem = freeMem;
    try {
      const meminfo = await fs.readFile("/proc/meminfo", "utf8");
      const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m);
      if (match) {
        availableMem = parseInt(match[1], 10) * 1024;
      }
    } catch {
      // /proc/meminfo not available, fall back to freeMem
    }

    const memUsage = ((totalMem - availableMem) / totalMem) * 100;

    let diskUsage = 0;
    try {
      const stat = await fs.statfs("/");
      diskUsage = ((stat.blocks - stat.bfree) / stat.blocks) * 100;
    } catch {
      // statfs not available
    }

    return c.json({
      cpu: { usage: Math.round(cpuUsage) },
      memory: {
        percent: Math.round(memUsage),
        availableBytes: Math.round(availableMem),
        freeBytes: Math.round(freeMem),
        totalBytes: Math.round(totalMem),
      },
      disk: { percent: Math.round(diskUsage) },
    });
  });

  app.get("/api/onboarding/doctor", async (c) => {
    const cfVisitor = c.req.header("cf-visitor") || "";
    const cfVisitorScheme =
      cfVisitor.match(/"scheme"\s*:\s*"([^"]+)"/)?.[1] || "";
    const host = c.req.header("x-forwarded-host") || c.req.header("host") || "";
    const forwardedProto = c.req.header("x-forwarded-proto") || cfVisitorScheme;
    const report = await runOnboardingDoctor({
      profile: c.req.query("profile"),
      publicOrigin: c.req.query("publicOrigin"),
      requestContext: {
        viaCloudflare: Boolean(
          c.req.header("cf-ray") ||
          c.req.header("cf-connecting-ip") ||
          c.req.header("cf-visitor"),
        ),
        cfAccessJwtPresent: Boolean(c.req.header("cf-access-jwt-assertion")),
        publicOrigin:
          c.req.query("publicOrigin") ||
          (host && forwardedProto ? `${forwardedProto}://${host}` : ""),
        host,
        forwardedProto,
      },
    });
    return c.json({
      ...report,
      foundation: await getFoundationStatus(c),
    });
  });

  app.post("/api/onboarding/apply", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(
      await applyOnboardingProfile({
        profile: body.profile,
        publicOrigin: body.publicOrigin,
        allowedFileRoots: body.allowedFileRoots,
        cfAccessTeamName: body.cfAccessTeamName,
        cfAccessAud: body.cfAccessAud,
      }),
    );
  });

  app.post("/api/onboarding/remediate", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const remediationId = String(body.remediationId || "").trim();
    if (!remediationId) {
      return c.json({ error: "remediationId is required" }, 400);
    }
    const result = await applyOnboardingRemediation(remediationId, {
      profile: body.profile,
      publicOrigin: body.publicOrigin,
      cfAccessTeamName: body.cfAccessTeamName,
      cfAccessAud: body.cfAccessAud,
    });
    return c.json(result);
  });

  // OpenCode health check
  app.get("/api/apps/opencode/health", async (c) => {
    try {
      const res = await fetch(`${OPENCODE_UPSTREAM}/api/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return c.json({
        status: res.ok ? "running" : "error",
        upstream: OPENCODE_UPSTREAM,
        url: OPENCODE_URL,
      });
    } catch {
      return c.json({
        status: "not_running",
        upstream: OPENCODE_UPSTREAM,
        url: OPENCODE_URL,
      });
    }
  });

  app.all("/apps/opencode/*", async (c) => {
    if (!openCodeCircuit.canRequest()) {
      return c.json(
        {
          error: "OpenCode temporarily unavailable",
          message: "Circuit breaker open - too many failures",
          retryAfter: Math.ceil(openCodeCircuit.resetTimeout / 1000),
        },
        503,
      );
    }

    const path = c.req.path.replace("/apps/opencode", "") || "/";
    const url = `${OPENCODE_UPSTREAM}${path}${c.req.url.includes("?") ? "?" + c.req.url.split("?")[1] : ""}`;

    const headers = new Headers();
    for (const [key, value] of c.req.raw.headers) {
      if (!HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) {
        headers.set(key, value);
      }
    }

    try {
      const response = await fetch(url, {
        method: c.req.method,
        headers,
        body:
          c.req.method !== "GET" && c.req.method !== "HEAD"
            ? await c.req.raw.arrayBuffer()
            : undefined,
        signal: AbortSignal.timeout(30_000),
      });

      openCodeCircuit.recordSuccess();

      const contentType = response.headers.get("content-type") || "";

      if (contentType.includes("text/event-stream")) {
        return new Response(response.body, {
          status: response.status,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      const responseHeaders = new Headers();
      for (const [key, value] of response.headers) {
        if (!HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) {
          responseHeaders.set(key, value);
        }
      }

      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      });
    } catch (err) {
      openCodeCircuit.recordFailure();
      const isTimeout = err instanceof Error && err.name === "TimeoutError";
      return c.json(
        {
          error: "OpenCode unavailable",
          message: isTimeout ? "Request timeout" : String(err),
        },
        502,
      );
    }
  });

  function taskErrorResponse(c: any, err: unknown) {
    if (err instanceof TaskRunnerError) {
      return c.json({ error: err.message }, err.status as never);
    }
    return c.json({ error: "Task runner failed", message: String(err) }, 500);
  }

  app.get("/api/tasks", async (c) => {
    const { ownerId } = getCurrentUser(c);
    return c.json(await taskRunner.listTasks(ownerId));
  });

  app.post("/api/tasks", async (c) => {
    const { ownerId } = getCurrentUser(c);
    const body = await c.req.json().catch(() => ({}));

    // C2: route the task's project root through the same actor/root/grant
    // resolution as terminal/file/git so it is gated and audited consistently
    // (taskRunner only does a path-allowlist check, without bootstrap/grant).
    const requestedRoot = String(body.projectRoot || "").trim();
    if (requestedRoot) {
      const resolvedRoot = await resolveAllowedPath(requestedRoot);
      if (!resolvedRoot) {
        const state = await getFoundationState();
        writeAuditEvent(state.db, {
          actorUserId: ownerId,
          action: "task.create",
          resourceType: "root",
          decision: "deny",
          reason: "forbidden_root",
          data: { projectRoot: requestedRoot },
        });
        return c.json({ error: "Forbidden project root" }, 403);
      }
      const access = await requireFileAccess(c, resolvedRoot);
      if (!access.ok) {
        return c.json(access.body, { status: access.status as any });
      }
    }

    try {
      const task = await taskRunner.createTask(body, { ownerId });
      return c.json(task);
    } catch (err) {
      return taskErrorResponse(c, err);
    }
  });

  app.get("/api/tasks/:id", async (c) => {
    const { ownerId } = getCurrentUser(c);
    try {
      return c.json(await taskRunner.getTask(c.req.param("id"), { ownerId }));
    } catch (err) {
      return taskErrorResponse(c, err);
    }
  });

  app.patch("/api/tasks/:id", async (c) => {
    const { ownerId } = getCurrentUser(c);
    const body = await c.req.json().catch(() => ({}));
    try {
      return c.json(
        await taskRunner.updateTask(c.req.param("id"), { ownerId }, body),
      );
    } catch (err) {
      return taskErrorResponse(c, err);
    }
  });

  app.post("/api/tasks/:id/start", async (c) => {
    const { ownerId, ownerEmail } = getCurrentUser(c);
    try {
      const task = await taskRunner.getTask(c.req.param("id"), { ownerId });
      const creationError = getTerminalCreationError(ownerId);
      if (creationError) {
        return c.json(creationError.body, creationError.status);
      }
      rateLimitState.record();
      const terminal = await createOwnedTerminal({
        cwd: task.workingDirectory,
        cols: 120,
        rows: 30,
        ownerId,
        ownerEmail,
      });
      terminal.terminal.write(`${buildWorkerCommand(task)}\n`);
      const updated = await taskRunner.markWorkerStarted(
        task.id,
        {
          ownerId,
        },
        terminal.id,
      );
      return c.json({ task: updated, terminal: serializeTerminal(terminal) });
    } catch (err) {
      return taskErrorResponse(c, err);
    }
  });

  app.post("/api/tasks/:id/run-checks", async (c) => {
    const { ownerId } = getCurrentUser(c);
    try {
      return c.json(await taskRunner.runChecks(c.req.param("id"), { ownerId }));
    } catch (err) {
      return taskErrorResponse(c, err);
    }
  });

  app.post("/api/tasks/:id/judge", async (c) => {
    const { ownerId, ownerEmail } = getCurrentUser(c);
    try {
      const task = await taskRunner.getTask(c.req.param("id"), { ownerId });
      const prompt = await taskRunner.buildJudgePrompt(task.id, { ownerId });
      await writeFile(task.controlFiles.judgePromptFile, prompt);
      const creationError = getTerminalCreationError(ownerId);
      if (creationError) {
        return c.json(creationError.body, creationError.status);
      }
      rateLimitState.record();
      const terminal = await createOwnedTerminal({
        cwd: task.workingDirectory,
        cols: 120,
        rows: 30,
        ownerId,
        ownerEmail,
      });
      terminal.terminal.write(`${buildJudgeCommand(task)}\n`);
      const updated = await taskRunner.markJudgeStarted(
        task.id,
        {
          ownerId,
        },
        terminal.id,
      );
      return c.json({
        task: updated,
        terminal: serializeTerminal(terminal),
        prompt,
      });
    } catch (err) {
      return taskErrorResponse(c, err);
    }
  });

  app.post("/api/tasks/:id/pause", async (c) => {
    const { ownerId } = getCurrentUser(c);
    try {
      return c.json(
        await taskRunner.updateTask(
          c.req.param("id"),
          { ownerId },
          { status: "paused" },
        ),
      );
    } catch (err) {
      return taskErrorResponse(c, err);
    }
  });

  app.post("/api/tasks/:id/reset", async (c) => {
    const { ownerId } = getCurrentUser(c);
    try {
      return c.json(
        await taskRunner.updateTask(
          c.req.param("id"),
          { ownerId },
          { status: "ready" },
        ),
      );
    } catch (err) {
      return taskErrorResponse(c, err);
    }
  });

  app.delete("/api/tasks/:id", async (c) => {
    const { ownerId } = getCurrentUser(c);
    try {
      return c.json(
        await taskRunner.deleteTask(c.req.param("id"), { ownerId }),
      );
    } catch (err) {
      return taskErrorResponse(c, err);
    }
  });

  // Create new terminal running shell
  app.post("/api/terminals", async (c) => {
    const { ownerId, ownerEmail } = getCurrentUser(c);
    const body = await c.req.json().catch(() => ({}));
    const routeCapability = getRouteCapability(c.req.method, c.req.url);
    if (!routeCapability) {
      return c.json({ error: "Missing route capability" }, 500);
    }
    const foundationAuth = await requireFoundationCapability({
      actorUserId: ownerId,
      capability: routeCapability.capability,
      resourceType: routeCapability.resourceType,
      resourceId: routeCapability.resourceId,
      data: { cwd: body.cwd || process.env.HOME || "/" },
    });
    if (!foundationAuth.ok) {
      return c.json(foundationGateJson(foundationAuth), foundationAuth.status);
    }

    const requestedCwd = body.cwd || process.env.HOME || "/";
    const resolvedCwd = await resolveAllowedPath(requestedCwd);
    if (!resolvedCwd) {
      const state = await getFoundationState();
      writeAuditEvent(state.db, {
        actorUserId: ownerId,
        action: "terminal.create",
        resourceType: "root",
        decision: "deny",
        reason: "forbidden_root",
        data: { cwd: requestedCwd },
      });
      return c.json({ error: "Forbidden terminal root" }, 403);
    }

    const rootAuth = await requireFoundationCapability({
      actorUserId: ownerId,
      capability: "root.use",
      resourceType: "root",
      resourceId: resolvedCwd,
      data: { cwd: resolvedCwd },
    });
    if (!rootAuth.ok) {
      return c.json(foundationGateJson(rootAuth), rootAuth.status);
    }

    const creationError = getTerminalCreationError(ownerId);
    if (creationError) {
      return c.json(creationError.body, creationError.status);
    }

    rateLimitState.record();
    const terminal = await createOwnedTerminal({
      cwd: resolvedCwd,
      cols: body.cols || 120,
      rows: body.rows || 30,
      ownerId,
      ownerEmail,
    });

    const state = await getFoundationState();
    const rootId = resolveFoundationRootIdForPath(state, resolvedCwd);
    recordTerminalSession(state.db, {
      id: terminal.id,
      actorUserId: ownerId,
      rootId,
      cwd: resolvedCwd,
      status: "active",
    });
    writeAuditEvent(state.db, {
      actorUserId: ownerId,
      action: "terminal.create",
      resourceType: "terminal",
      resourceId: terminal.id,
      decision: "allow",
      data: { cwd: resolvedCwd },
    });

    return c.json(serializeTerminal(terminal));
  });

  app.post("/api/terminals/:id/linked-view", async (c) => {
    const { ownerId, ownerEmail } = getCurrentUser(c);
    const sourceId = c.req.param("id");
    const sourceTerm = terminals.get(sourceId);

    if (!sourceTerm) {
      return c.json({ error: "Terminal not found" }, 404);
    }
    const sourceAccess = await requireTerminalSessionAccess({
      actorUserId: ownerId,
      term: sourceTerm,
      capability: "terminal.attach",
    });
    if (!sourceAccess.ok) {
      return c.json(foundationGateJson(sourceAccess), sourceAccess.status);
    }
    if (!TMUX_BACKEND) {
      return c.json({ error: "Linked view requires tmux backend" }, 400);
    }
    if (!sourceTerm.sessionName) {
      return c.json(
        { error: "Linked view unavailable for this terminal" },
        409,
      );
    }

    const creationError = getTerminalCreationError(ownerId);
    if (creationError) {
      return c.json(creationError.body, creationError.status);
    }

    rateLimitState.record();

    const tmuxInfo = await getTmuxSessionInfo(sourceTerm.sessionName).catch(
      () => null,
    );
    const terminal = await createManagedTerminal({
      cwd: tmuxInfo?.cwd || sourceTerm.cwd,
      cols: tmuxInfo?.cols || sourceTerm.cols,
      rows: tmuxInfo?.rows || sourceTerm.rows,
      ownerId,
      ownerEmail,
      sessionName: sourceTerm.sessionName,
    });
    const state = await getFoundationState();
    recordTerminalSession(state.db, {
      id: terminal.id,
      actorUserId: ownerId,
      rootId: resolveFoundationRootIdForPath(state, terminal.cwd),
      cwd: terminal.cwd,
      status: "active",
    });

    return c.json(serializeTerminal(terminal));
  });

  // List terminals
  app.get("/api/terminals", async (c) => {
    const { ownerId } = getCurrentUser(c);
    const requestingClientId =
      c.req.header("x-deckterm-client-id")?.trim() || null;
    const backendMode = getBackendMode();
    const state = await getFoundationState();
    const recordedSessions = listTerminalSessionsForActor(state.db, ownerId);
    const seenIds = new Set<string>();

    const list = await Promise.all(
      recordedSessions.map(async (recordedSession) => {
        const restoredTerm =
          terminals.get(recordedSession.id) ||
          (recordedSession.status === "active"
            ? await restoreRecordedTmuxSession(state, recordedSession)
            : null);

        if (restoredTerm) {
          seenIds.add(restoredTerm.id);
          if (TMUX_BACKEND && restoredTerm.sessionName) {
            await syncTmuxRuntimeState(restoredTerm).catch((err) => {
              debug(`[tmux] runtime sync failed for ${restoredTerm.id}:`, err);
            });
          }

          return {
            ...serializeTerminal(restoredTerm, requestingClientId),
            ...(await getTerminalTelemetry(restoredTerm, backendMode, {
              detectWorktree: detectGitWorktree,
            })),
          };
        }

        seenIds.add(recordedSession.id);
        const effectiveSession =
          recordedSession.status === "active"
            ? !TMUX_BACKEND
              ? (markTerminalSessionEnded(state.db, recordedSession.id),
                getTerminalSession(state.db, recordedSession.id) ||
                  recordedSession)
              : getTerminalSession(state.db, recordedSession.id) ||
                recordedSession
            : recordedSession;
        const serialized = serializeRecordedTerminalSession(effectiveSession);
        return {
          ...serialized,
          ...(await getTerminalTelemetry(
            {
              cwd: effectiveSession.cwd,
              createdAt: parseSessionTimestamp(effectiveSession.createdAt),
              lastActivityAt: parseSessionTimestamp(
                effectiveSession.updatedAt || effectiveSession.createdAt,
              ),
              scrollback: [],
              running: false,
              lastExitCode: serialized.lastExitCode,
              agentName: null,
              agentState: null,
            },
            backendMode,
            { detectWorktree: detectGitWorktree },
          )),
          active: serialized.active,
          status: serialized.status,
          sessionStatus: serialized.sessionStatus,
        };
      }),
    );

    const memoryOnly = await Promise.all(
      Array.from(terminals.values())
        .filter((t) => t.ownerId === ownerId && !seenIds.has(t.id))
        .map(async (t) => {
          ensureTerminalSessionRecorded(state, t);
          if (TMUX_BACKEND && t.sessionName) {
            await syncTmuxRuntimeState(t).catch((err) => {
              debug(`[tmux] runtime sync failed for ${t.id}:`, err);
            });
          }
          return {
            ...serializeTerminal(t, requestingClientId),
            ...(await getTerminalTelemetry(t, backendMode, {
              detectWorktree: detectGitWorktree,
            })),
          };
        }),
    );

    return c.json([...list, ...memoryOnly]);
  });

  // Delete terminal
  app.delete("/api/terminals/:id", async (c) => {
    const { ownerId } = getCurrentUser(c);
    const id = c.req.param("id");
    const term = terminals.get(id);
    if (!term) {
      return c.json({ error: "Terminal not found" }, 404);
    }
    const access = await requireTerminalSessionAccess({
      actorUserId: ownerId,
      term,
      capability: "terminal.manage",
    });
    if (!access.ok) {
      return c.json(foundationGateJson(access), access.status);
    }

    const state = await getFoundationState();
    markTerminalSessionEnded(state.db, id);
    closeTerminalSockets(id);
    removeTerminalState(id);
    await killTmuxSessionIfLast(term.sessionName);

    term.proc.kill();
    term.terminal.close();
    return c.json({ ok: true });
  });

  // Resize terminal - now with proper PTY resize support via Bun.Terminal
  app.post("/api/terminals/:id/resize", async (c) => {
    const { ownerId } = getCurrentUser(c);
    const id = c.req.param("id");
    const term = terminals.get(id);
    if (!term) {
      return c.json({ error: "Terminal not found" }, 404);
    }
    const access = await requireTerminalSessionAccess({
      actorUserId: ownerId,
      term,
      capability: "terminal.manage",
    });
    if (!access.ok) {
      return c.json(foundationGateJson(access), access.status);
    }

    const body = await c.req.json();
    const cols = body.cols || 120;
    const rows = body.rows || 30;
    term.cols = cols;
    term.rows = rows;

    // Actually resize the PTY - this sends SIGWINCH to the process
    try {
      term.terminal.resize(cols, rows);

      // Also resize tmux pane if using tmux backend
      if (TMUX_BACKEND && term.sessionName) {
        await syncTmuxSessionSize(term.sessionName, cols, rows);
        debug(`Terminal ${id} tmux session resized to ${cols}x${rows}`);
      }

      debug(`Terminal ${id} resized to ${cols}x${rows}`);
    } catch (err) {
      debug(`Terminal ${id} resize error:`, err);
    }

    return c.json({ ok: true, cols, rows });
  });

  // Browse directories (for directory picker)
  app.get("/api/browse", async (c) => {
    const requestedPath = c.req.query("path") || process.env.HOME || "/";
    const includeFiles = c.req.query("files") === "true";
    const fs = await import("fs/promises");
    const pathModule = await import("path");
    const fallbackPath = await getDefaultBrowseRoot();
    let path = (await resolveAllowedPath(requestedPath)) || fallbackPath;

    const fileAccess = await requireFileAccess(c, path);
    if (!fileAccess.ok) {
      return c.json(fileAccess.body, { status: fileAccess.status as any });
    }

    let fellBack = path === fallbackPath && requestedPath !== fallbackPath;

    const readDirectory = async (targetPath: string) => {
      const entries = await fs.readdir(targetPath, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort();

      const result: {
        path: string;
        dirs: string[];
        files?: { name: string; size: number }[];
        fallback?: boolean;
      } = { path: targetPath, dirs };

      if (includeFiles) {
        const fileEntries = entries.filter(
          (e) => e.isFile() && !e.name.startsWith("."),
        );
        const files = await Promise.all(
          fileEntries.map(async (e) => {
            try {
              const stat = await fs.stat(pathModule.join(targetPath, e.name));
              return { name: e.name, size: stat.size };
            } catch {
              return { name: e.name, size: 0 };
            }
          }),
        );
        result.files = files.sort((a, b) => a.name.localeCompare(b.name));
      }

      if (fellBack) {
        result.fallback = true;
      }

      return result;
    };

    try {
      return c.json(await readDirectory(path));
    } catch (err: unknown) {
      const error = err as { code?: string };
      if (error.code === "ENOENT" && path !== fallbackPath) {
        path = fallbackPath;
        fellBack = true;
        return c.json(await readDirectory(path));
      }
      return c.json({ error: "Cannot read directory" }, 400);
    }
  });

  // File download
  app.get("/api/files/download", async (c) => {
    const requestedPath = c.req.query("path");
    if (!requestedPath) {
      return c.json({ error: "Path required" }, 400);
    }
    const filePath = await resolveAllowedPath(requestedPath);
    if (!filePath) {
      return c.json({ error: "Forbidden path" }, 403);
    }
    const fileAccess = await requireFileAccess(c, filePath);
    if (!fileAccess.ok) {
      return c.json(fileAccess.body, { status: fileAccess.status as any });
    }

    const fs = await import("fs/promises");

    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        return c.json({ error: "Not a file" }, 400);
      }

      const data = await fs.readFile(filePath);
      const filename = basename(filePath);

      return new Response(data, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Length": String(stat.size),
        },
      });
    } catch {
      return c.json({ error: "Cannot read file" }, 400);
    }
  });

  // File upload
  app.post("/api/files/upload", async (c) => {
    const requestedPath = c.req.query("path");
    if (!requestedPath) {
      return c.json({ error: "Path required" }, 400);
    }
    const targetPath = await resolveAllowedPath(requestedPath);
    if (!targetPath) {
      return c.json({ error: "Forbidden path" }, 403);
    }
    const fileAccess = await requireFileAccess(c, targetPath);
    if (!fileAccess.ok) {
      return c.json(fileAccess.body, { status: fileAccess.status as any });
    }

    const fs = await import("fs/promises");

    try {
      // Check if target is a directory
      const stat = await fs.stat(targetPath);
      if (!stat.isDirectory()) {
        return c.json({ error: "Target must be a directory" }, 400);
      }

      // Parse multipart form data
      const formData = await c.req.formData();
      const file = formData.get("file") as File | null;

      if (!file) {
        return c.json({ error: "No file provided" }, 400);
      }

      const fileName = basename(file.name);
      const destPath = await resolveAllowedPath(join(targetPath, fileName), {
        allowMissing: true,
      });
      if (!destPath) {
        return c.json({ error: "Forbidden path" }, 403);
      }
      const buffer = await file.arrayBuffer();
      await fs.writeFile(destPath, Buffer.from(buffer));

      debug(`File uploaded: ${destPath}`);

      return c.json({ ok: true, path: destPath });
    } catch (err) {
      debug(`Upload error:`, err);
      return c.json({ error: "Failed to upload file" }, 500);
    }
  });

  // Create directory
  app.post("/api/files/mkdir", async (c) => {
    const requestedPath = c.req.query("path");
    if (!requestedPath) {
      return c.json({ error: "Path required" }, 400);
    }
    const dirPath = await resolveAllowedPath(requestedPath, {
      allowMissing: true,
    });
    if (!dirPath) {
      return c.json({ error: "Forbidden path" }, 403);
    }
    const fileAccess = await requireFileAccess(c, dirPath);
    if (!fileAccess.ok) {
      return c.json(fileAccess.body, { status: fileAccess.status as any });
    }

    const fs = await import("fs/promises");

    try {
      await fs.mkdir(dirPath, { recursive: false });
      return c.json({ ok: true, path: dirPath });
    } catch (err: unknown) {
      const error = err as { code?: string };
      if (error.code === "EEXIST") {
        return c.json({ error: "Directory already exists" }, 400);
      }
      return c.json({ error: "Failed to create directory" }, 500);
    }
  });

  // Delete file or directory
  app.delete("/api/files", async (c) => {
    const requestedPath = c.req.query("path");
    if (!requestedPath) {
      return c.json({ error: "Path required" }, 400);
    }
    const filePath = await resolveAllowedPath(requestedPath);
    if (!filePath) {
      return c.json({ error: "Forbidden path" }, 403);
    }
    const fileAccess = await requireFileAccess(c, filePath);
    if (!fileAccess.ok) {
      return c.json(fileAccess.body, { status: fileAccess.status as any });
    }

    // Security: don't allow deleting filesystem roots
    const protectedRoots = await getAllowedRealRoots();
    if (filePath === "/" || protectedRoots.includes(filePath)) {
      return c.json({ error: "Cannot delete root or home directory" }, 403);
    }

    const fs = await import("fs/promises");

    try {
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) {
        await fs.rm(filePath, { recursive: true });
      } else {
        await fs.unlink(filePath);
      }
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "Failed to delete" }, 500);
    }
  });

  // Rename file or directory
  app.post("/api/files/rename", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { from: fromInput, to: toInput } = body;

    if (!fromInput || !toInput) {
      return c.json({ error: "from and to paths required" }, 400);
    }
    const from = await resolveAllowedPath(fromInput);
    const to = await resolveAllowedPath(toInput, { allowMissing: true });
    if (!from || !to) {
      return c.json({ error: "Forbidden path" }, 403);
    }
    const fromAccess = await requireFileAccess(c, from);
    if (!fromAccess.ok) {
      return c.json(fromAccess.body, { status: fromAccess.status as any });
    }
    const toAccess = await requireFileAccess(c, to);
    if (!toAccess.ok) {
      return c.json(toAccess.body, { status: toAccess.status as any });
    }

    const fs = await import("fs/promises");

    try {
      await fs.rename(from, to);
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "Failed to rename" }, 500);
    }
  });

  // =============================================================================
  // GIT API - Secure git operations with realpath validation
  // =============================================================================

  async function validateGitCwd(c: any, cwd: string): Promise<boolean> {
    const resolved = await resolveAllowedPath(cwd);
    if (!resolved) return false;
    const fileAccess = await requireFileAccess(c, resolved);
    return fileAccess.ok;
  }

  // GET /api/git/status?cwd=/path/to/repo
  app.get("/api/git/status", async (c) => {
    const cwd = c.req.query("cwd") || process.env.HOME;
    if (!cwd || !(await validateGitCwd(c, cwd))) {
      return c.json({ error: "Forbidden path" }, 403);
    }

    try {
      const proc = Bun.spawn(["git", "status", "--porcelain", "-b"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      const timeoutId = setTimeout(() => proc.kill(), 10000);
      const [output, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      clearTimeout(timeoutId);

      if (exitCode !== 0) {
        return c.json(
          {
            error: "Not a git repository",
            message: stderr.trim() || "git status failed",
          },
          400,
        );
      }

      const lines = output.trim().split("\n");
      const branch = lines[0]?.replace("## ", "").split("...")[0] || "unknown";
      const files = lines
        .slice(1)
        .filter((line) => line.length >= 3)
        .map((line) => {
          const rawStatus = line.substring(0, 2);
          const stagedStatus = rawStatus[0] === " " ? "" : rawStatus[0];
          const unstagedStatus = rawStatus[1] === " " ? "" : rawStatus[1];
          const rawPath = line.substring(3).trim();
          const renameSep = " -> ";
          const renameIdx = rawPath.indexOf(renameSep);
          const isRenamed =
            stagedStatus === "R" || unstagedStatus === "R" || renameIdx !== -1;

          let path = rawPath;
          let oldPath: string | undefined;
          if (renameIdx !== -1) {
            oldPath = rawPath.substring(0, renameIdx).trim();
            path = rawPath.substring(renameIdx + renameSep.length).trim();
          }

          return {
            // Backward-compat field
            status: rawStatus.trim(),
            path,
            stagedStatus,
            unstagedStatus,
            isRenamed,
            ...(oldPath ? { oldPath } : {}),
            section:
              stagedStatus && stagedStatus !== "?" ? "staged" : "changes",
          };
        });

      return c.json({ branch, files, cwd });
    } catch (err) {
      return c.json(
        { error: "Not a git repository", message: String(err) },
        400,
      );
    }
  });

  // GET /api/git/diff?cwd=...&path=... (optional path for single file)
  app.get("/api/git/diff", async (c) => {
    const cwd = c.req.query("cwd") || process.env.HOME;
    const path = c.req.query("path");
    const staged = c.req.query("staged");
    const commit = c.req.query("commit");
    if (!cwd || !(await validateGitCwd(c, cwd))) {
      return c.json({ error: "Forbidden path" }, 403);
    }

    if (
      typeof staged === "string" &&
      !["1", "0", "true", "false"].includes(staged.toLowerCase())
    ) {
      return c.json(
        { error: "Invalid query: staged must be one of 1,0,true,false" },
        400,
      );
    }

    const stagedEnabled = staged === "1" || staged?.toLowerCase?.() === "true";
    if (stagedEnabled && commit) {
      return c.json(
        { error: "Invalid query: staged and commit cannot be combined" },
        400,
      );
    }

    try {
      let args: string[];
      if (commit) {
        args = ["git", "show", "--format=", "--color=never", commit];
      } else if (stagedEnabled) {
        args = ["git", "diff", "--staged", "--color=never"];
      } else {
        args = ["git", "diff", "--color=never"];
      }

      if (path) {
        args.push("--", path);
      }

      const proc = Bun.spawn(args, {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      const timeoutId = setTimeout(() => proc.kill(), 10000);
      const [output, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      clearTimeout(timeoutId);

      if (exitCode !== 0) {
        return c.json(
          { error: "Git diff failed", message: stderr.trim() || "git failed" },
          400,
        );
      }

      return c.json({
        diff: output,
        cwd,
        path,
        staged: stagedEnabled ? 1 : 0,
        commit: commit || null,
      });
    } catch (err) {
      return c.json({ error: "Git diff failed", message: String(err) }, 400);
    }
  });

  // POST /api/git/stage { cwd, paths: string[] }
  app.post("/api/git/stage", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { cwd, paths } = body;

    if (!cwd || !(await validateGitCwd(c, cwd))) {
      return c.json({ error: "Forbidden path" }, 403);
    }

    if (!paths || !Array.isArray(paths) || paths.length === 0) {
      return c.json({ error: "Paths required" }, 400);
    }

    try {
      const proc = Bun.spawn(["git", "add", "--", ...paths], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      const timeoutId = setTimeout(() => proc.kill(), 10000);
      await proc.exited;
      clearTimeout(timeoutId);

      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: "Git add failed", message: String(err) }, 400);
    }
  });

  // POST /api/git/unstage { cwd, paths: string[] }
  app.post("/api/git/unstage", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { cwd, paths } = body;

    if (!cwd || !(await validateGitCwd(c, cwd))) {
      return c.json({ error: "Forbidden path" }, 403);
    }

    if (!paths || !Array.isArray(paths) || paths.length === 0) {
      return c.json({ error: "Paths required" }, 400);
    }

    try {
      const proc = Bun.spawn(["git", "restore", "--staged", "--", ...paths], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      const timeoutId = setTimeout(() => proc.kill(), 10000);
      await proc.exited;
      clearTimeout(timeoutId);

      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: "Git restore failed", message: String(err) }, 400);
    }
  });

  // POST /api/git/commit { cwd, message }
  app.post("/api/git/commit", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { cwd, message } = body;

    if (!cwd || !(await validateGitCwd(c, cwd))) {
      return c.json({ error: "Forbidden path" }, 403);
    }

    if (!message?.trim()) {
      return c.json({ error: "Message required" }, 400);
    }

    try {
      const proc = Bun.spawn(["git", "commit", "-m", message], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      const timeoutId = setTimeout(() => proc.kill(), 10000);
      const [output, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      clearTimeout(timeoutId);

      if (code !== 0) {
        // git reports the common failure ("nothing to commit") on stdout, not
        // stderr — fall back to stdout so the panel shows a real reason instead
        // of an empty "Commit failed:" line.
        const reason = stderr.trim() || output.trim() || "git commit failed";
        return c.json({ error: "Commit failed", message: reason }, 400);
      }

      return c.json({ ok: true, output });
    } catch (err) {
      return c.json({ error: "Git commit failed", message: String(err) }, 400);
    }
  });

  // GET /api/git/branches?cwd=...
  app.get("/api/git/branches", async (c) => {
    const cwd = c.req.query("cwd") || process.env.HOME;
    if (!cwd || !(await validateGitCwd(c, cwd))) {
      return c.json({ error: "Forbidden path" }, 403);
    }

    try {
      const proc = Bun.spawn(
        ["git", "branch", "-a", "--format=%(refname:short)"],
        {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      const timeoutId = setTimeout(() => proc.kill(), 10000);
      const output = await new Response(proc.stdout).text();
      clearTimeout(timeoutId);

      const branches = output.trim().split("\n").filter(Boolean);
      return c.json({ branches, cwd });
    } catch (err) {
      return c.json({ error: "Git branch failed", message: String(err) }, 400);
    }
  });

  // GET /api/git/log?cwd=...&limit=50
  app.get("/api/git/log", async (c) => {
    const cwd = c.req.query("cwd") || process.env.HOME;
    const limit = parseInt(c.req.query("limit") || "50");

    if (!cwd || !(await validateGitCwd(c, cwd))) {
      return c.json({ error: "Forbidden path" }, 403);
    }

    try {
      const proc = Bun.spawn(
        [
          "git",
          "log",
          `--max-count=${Math.min(limit, 200)}`,
          "--format=%h|%H|%s|%an|%aI",
          "--graph",
          "--",
        ],
        {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      const timeoutId = setTimeout(() => proc.kill(), 10000);
      const output = await new Response(proc.stdout).text();
      clearTimeout(timeoutId);

      const commits = output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          // Parse graph prefix (*, |, etc) and commit data
          const graphMatch = line.match(/^([*|\\ \/]+)\s*(.*)$/);
          const graph = graphMatch ? graphMatch[1] : "";
          const data = graphMatch ? graphMatch[2] : line;

          const parts = data.split("|");
          if (parts.length >= 5) {
            return {
              hash: parts[0],
              fullHash: parts[1],
              message: parts[2],
              author: parts[3],
              date: parts[4],
              graph: graph.trim(),
            };
          }
          return null;
        })
        .filter(Boolean);

      return c.json({ commits, cwd });
    } catch (err) {
      return c.json({ error: "Git log failed", message: String(err) }, 400);
    }
  });

  // POST /api/git/checkout { cwd, branch }
  app.post("/api/git/checkout", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { cwd, branch } = body;

    if (!cwd || !(await validateGitCwd(c, cwd))) {
      return c.json({ error: "Forbidden path" }, 403);
    }

    if (
      !branch ||
      typeof branch !== "string" ||
      !/^[\w\-\/\.]+$/.test(branch)
    ) {
      return c.json({ error: "Invalid branch name" }, 400);
    }

    try {
      const proc = Bun.spawn(["git", "checkout", branch, "--"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      const timeoutId = setTimeout(() => proc.kill(), 10000);
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      clearTimeout(timeoutId);

      if (exitCode !== 0) {
        return c.json({ error: "Checkout failed", message: stderr }, 400);
      }

      return c.json({ success: true, branch });
    } catch (err) {
      return c.json(
        { error: "Git checkout failed", message: String(err) },
        400,
      );
    }
  });

  // GET /api/git/show?cwd=...&commit=...&path=...
  app.get("/api/git/show", async (c) => {
    const cwd = c.req.query("cwd") || process.env.HOME;
    const commit = c.req.query("commit");
    const path = c.req.query("path");

    if (!cwd || !(await validateGitCwd(c, cwd))) {
      return c.json({ error: "Forbidden path" }, 403);
    }

    // Allow hex hashes (4-40 chars), HEAD, HEAD~N, HEAD^N, and branch/tag names
    if (
      !commit ||
      !/^([a-f0-9]{4,40}|HEAD(~\d+|\^\d+)?|[\w\-\/\.]+)$/i.test(commit)
    ) {
      return c.json({ error: "Invalid commit reference" }, 400);
    }

    if (!path) {
      return c.json({ error: "Path required" }, 400);
    }

    try {
      const proc = Bun.spawn(["git", "show", `${commit}:${path}`, "--"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      const timeoutId = setTimeout(() => proc.kill(), 10000);
      const content = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      clearTimeout(timeoutId);

      if (exitCode !== 0) {
        return c.json({ error: "File not found at commit" }, 404);
      }

      return c.json({ content, commit, path });
    } catch (err) {
      return c.json({ error: "Git show failed", message: String(err) }, 400);
    }
  });

  // =============================================================================
  // CLIPBOARD IMAGE UPLOAD
  // =============================================================================

  // Whitelist of allowed image types for security
  const ALLOWED_IMAGE_TYPES = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
  ];

  app.post("/api/clipboard/image", async (c) => {
    try {
      const contentType = c.req.header("content-type") || "";

      // Validate content type against whitelist
      const isAllowedType = ALLOWED_IMAGE_TYPES.some((t) =>
        contentType.includes(t),
      );
      if (!contentType.includes("multipart/form-data") && !isAllowedType) {
        return c.json(
          { error: "Invalid image type. Allowed: PNG, JPEG, GIF, WEBP" },
          400,
        );
      }

      let imageData: Uint8Array;
      let extension = "png";

      if (contentType.includes("multipart/form-data")) {
        const formData = await c.req.formData();
        const file = formData.get("image") as File | null;

        if (!file) {
          return c.json({ error: "No image file provided" }, 400);
        }

        if (file.size > CLIPBOARD_IMAGE_MAX_SIZE) {
          return c.json({ error: "Image too large (max 10MB)" }, 400);
        }

        imageData = new Uint8Array(await file.arrayBuffer());

        // Determine extension from mime type
        if (file.type.includes("jpeg") || file.type.includes("jpg")) {
          extension = "jpg";
        } else if (file.type.includes("gif")) {
          extension = "gif";
        } else if (file.type.includes("webp")) {
          extension = "webp";
        }
      } else {
        // Raw image data in body
        const body = await c.req.arrayBuffer();

        if (body.byteLength === 0) {
          return c.json({ error: "Empty image data" }, 400);
        }

        if (body.byteLength > CLIPBOARD_IMAGE_MAX_SIZE) {
          return c.json({ error: "Image too large (max 10MB)" }, 400);
        }

        imageData = new Uint8Array(body);

        if (contentType.includes("jpeg") || contentType.includes("jpg")) {
          extension = "jpg";
        } else if (contentType.includes("gif")) {
          extension = "gif";
        } else if (contentType.includes("webp")) {
          extension = "webp";
        }
      }

      const timestamp = Date.now();
      const random = Math.random().toString(36).slice(2, 8);
      const filename = `clipboard-${timestamp}-${random}.${extension}`;
      const filePath = join(CLIPBOARD_IMAGES_DIR, filename);

      await Bun.write(filePath, imageData);

      console.log(
        `[Clipboard] Image saved: ${filePath} (${imageData.length} bytes)`,
      );

      return c.json({
        success: true,
        path: filePath,
        filename,
        size: imageData.length,
      });
    } catch (e) {
      console.error("[Clipboard] Image upload error:", e);
      return c.json({ error: "Upload failed" }, 500);
    }
  });

  // Serve static files
  app.use(
    "/*",
    serveStatic({
      root: "./web",
      rewriteRequestPath: (path) => (path === "/" ? "/index.html" : path),
    }),
  );

  return app;
}

export async function startWebServer(host: string, port: number) {
  if (CF_ACCESS_REQUIRED && !CF_ACCESS_TEAM_NAME) {
    throw new Error(
      "CF_ACCESS_REQUIRED=1 but CF_ACCESS_TEAM_NAME is empty. Server-side JWT validation cannot run; refusing to start in a silently-unprotected state. Set CF_ACCESS_TEAM_NAME or unset CF_ACCESS_REQUIRED.",
    );
  }
  if (CF_ACCESS_REQUIRED && !CF_ACCESS_AUD) {
    throw new Error(
      "CF_ACCESS_REQUIRED=1 but CF_ACCESS_AUD is empty. Server-side audience pinning cannot run; refusing to start in a silently-unprotected state. Set CF_ACCESS_AUD or unset CF_ACCESS_REQUIRED.",
    );
  }

  // Recover existing tmux sessions before starting server
  if (TMUX_BACKEND) {
    console.log(
      "[tmux] TMUX_BACKEND enabled - checking for existing sessions...",
    );
    const state = await getFoundationState();
    const reconciled = await reconcileSessionsOnStartup(state.db);
    if (reconciled > 0) {
      console.log(
        `[reconciliation] Reconciled ${reconciled} zombie session(s) on startup`,
      );
    }
    const recovered = await recoverTmuxSessions();
    if (recovered > 0) {
      console.log(`[tmux] Recovered ${recovered} session(s)`);
    }
  }

  const app = createWebApp();

  const server = Bun.serve<WsData>({
    port,
    hostname: host,

    async fetch(req, server) {
      const url = new URL(req.url);

      // OpenCode WebSocket proxy
      if (url.pathname.startsWith("/apps/opencode/ws")) {
        const auth = await authenticateWebSocketRequest(req);
        if (!auth.ok) {
          return new Response(auth.message || "Unauthorized", {
            status: auth.status || 401,
          });
        }

        const wsUrl =
          OPENCODE_UPSTREAM.replace("http", "ws") +
          url.pathname.replace("/apps/opencode", "") +
          url.search;

        try {
          const upstream = new WebSocket(wsUrl);

          const success = server.upgrade(req, {
            data: { type: "opencode_proxy", upstream },
          });

          if (success) {
            return undefined;
          }
        } catch (err) {
          debug("OpenCode WebSocket proxy error:", err);
        }

        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      if (url.pathname.startsWith("/ws/terminals/")) {
        const id = url.pathname.split("/").pop();
        if (!id) {
          return new Response("Terminal ID required", { status: 400 });
        }

        const auth = await authenticateWebSocketRequest(req);
        if (!auth.ok) {
          return new Response(auth.message || "Unauthorized", {
            status: auth.status || 401,
          });
        }
        const ownerId = auth.ownerId;
        const routeCapability = getRouteCapability(req.method, url.pathname);
        if (!routeCapability) {
          return new Response("Missing route capability", { status: 500 });
        }

        const state = await getFoundationState();
        if (!isFoundationLegacyBypassEnabled() && !isBootstrapComplete(state)) {
          writeAuditEvent(state.db, {
            actorUserId: ownerId,
            action: routeCapability.capability,
            resourceType: routeCapability.resourceType,
            resourceId: id,
            decision: "deny",
            reason: "bootstrap_required",
          });
          return new Response("DeckTerm bootstrap required", { status: 403 });
        }

        let term = terminals.get(id);

        if (!term) {
          const recordedSession = getTerminalSession(state.db, id);
          term = recordedSession
            ? ((await restoreRecordedTmuxSession(state, recordedSession)) ??
              undefined)
            : undefined;
        }

        if (!term) {
          return new Response("Terminal not found", { status: 404 });
        }

        if (!getTerminalSession(state.db, id)) {
          recordTerminalSession(state.db, {
            id,
            actorUserId: term.ownerId,
            rootId: resolveFoundationRootIdForPath(state, term.cwd),
            cwd: term.cwd,
            status: "active",
          });
        }

        const attachDecision = authorizeTerminalAttach(state.db, {
          actorUserId: ownerId,
          terminalId: id,
        });
        if (!attachDecision.allow) {
          writeAuditEvent(state.db, {
            actorUserId: ownerId,
            action: routeCapability.capability,
            resourceType: routeCapability.resourceType,
            resourceId: id,
            decision: "deny",
            reason: attachDecision.reason,
          });
          return new Response("Forbidden", { status: 403 });
        }
        writeAuditEvent(state.db, {
          actorUserId: ownerId,
          action: routeCapability.capability,
          resourceType: routeCapability.resourceType,
          resourceId: id,
          decision: "allow",
          reason: attachDecision.reason,
        });

        const clientId = url.searchParams.get("clientId")?.trim() || null;
        const requestedMode = url.searchParams.get("mode")?.trim();
        const isV2 = url.searchParams.get("protocol")?.trim() === "v2";
        const lastEventIdStr = url.searchParams.get("lastEventId")?.trim();
        const lastEventId = lastEventIdStr
          ? parseInt(lastEventIdStr, 10)
          : null;

        let mode: "read" | "write" = "read";
        if (requestedMode === "write") {
          const writeDecision = authorizeTerminalWrite(state.db, {
            actorUserId: ownerId,
            terminalId: id,
          });
          if (writeDecision.allow) {
            mode = "write";
          }
        } else if (requestedMode === "read") {
          mode = "read";
        } else {
          // No explicit mode requested, decide based on permissions
          const writeDecision = authorizeTerminalWrite(state.db, {
            actorUserId: ownerId,
            terminalId: id,
          });
          mode = writeDecision.allow ? "write" : "read";
        }

        const success = server.upgrade(req, {
          data: {
            type: "terminal" as const,
            terminalId: id,
            ownerId: term.ownerId,
            actorUserId: ownerId,
            mode,
            protocol: isV2 ? "v2" : "legacy",
            clientId,
            lastEventId: Number.isFinite(lastEventId) ? lastEventId : null,
          },
        });
        if (success) return undefined;

        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      // Regular HTTP requests go to Hono
      return app.fetch(req, server);
    },

    websocket: {
      open(ws: ServerWebSocket<WsData>) {
        const data = ws.data;

        if (data.type === "opencode_proxy") {
          const upstream = data.upstream;

          upstream.onmessage = (event) => {
            try {
              ws.send(event.data);
            } catch (err) {
              debug("OpenCode proxy upstream->client error:", err);
            }
          };

          upstream.onerror = (err) => {
            debug("OpenCode proxy upstream error:", err);
            ws.close();
          };

          upstream.onclose = () => {
            ws.close();
          };

          debug("OpenCode WebSocket proxy connected");
          return;
        }

        const { terminalId } = data;
        const term = terminals.get(terminalId);
        const sockets = terminalSockets.get(terminalId);

        if (!term || !sockets) {
          ws.close();
          return;
        }

        if (TMUX_BACKEND && term.sessionName) {
          handoffTmuxSession(term.sessionName, data.clientId);
        }

        sockets.add(ws);
        term.lastDetachedAt = undefined;
        const socketsCount = sockets.size;
        const isReconnect = term.hadSocketConnection;
        term.hadSocketConnection = true;
        socketReconnectState.set(ws, {
          pendingReady: isReconnect,
          replaying: false,
          replayMode: isReconnect
            ? TMUX_BACKEND && term.sessionName
              ? "tmux"
              : "raw"
            : null,
        });

        console.log(
          `[ws] WebSocket connected for ${terminalId} (${term.cols}x${term.rows}), sockets: ${socketsCount}, reconnect: ${isReconnect}`,
        );

        if (isReconnect) {
          sendReconnectLifecycle(ws, "replay-start");
          setTimeout(() => {
            if (socketReconnectState.get(ws)?.pendingReady) {
              void completeTmuxReconnectReplay(ws, terminalId, term, "timeout");
            }
          }, 750);
        }
      },

      message(ws: ServerWebSocket<WsData>, message) {
        try {
          const data = ws.data;

          if (data.type === "opencode_proxy") {
            try {
              data.upstream.send(message);
            } catch (err) {
              debug("OpenCode proxy client->upstream error:", err);
            }
            return;
          }

          const { terminalId } = data;

          if (data.type === "terminal" && data.mode === "read") {
            // Discard any non-ping/non-resume message for read-only mode
            if (typeof message === "string") {
              try {
                const parsed = JSON.parse(message);
                if (parsed.type !== "ping" && parsed.type !== "resume-ready") {
                  debug(
                    `[ws-security] Blocked message type "${parsed.type}" for read-only actor ${data.actorUserId} on terminal ${terminalId}`,
                  );
                  return;
                }
              } catch {
                // Raw input message
                debug(
                  `[ws-security] Blocked raw input message for read-only actor ${data.actorUserId} on terminal ${terminalId}`,
                );
                return;
              }
            } else {
              // Binary / raw buffer input message
              debug(
                `[ws-security] Blocked binary/raw input message for read-only actor ${data.actorUserId} on terminal ${terminalId}`,
              );
              return;
            }
          }

          const term = terminals.get(terminalId);

          if (!term) {
            debug(`Terminal ${terminalId} not found for message`);
            return;
          }

          if (typeof message === "string") {
            debug(`WS message for ${terminalId}`);
            try {
              const parsed = JSON.parse(message);
              if (parsed.type === "ping") {
                ws.send(JSON.stringify({ type: "pong" }));
                return;
              }
              if (parsed.type === "resize") {
                debug(`Resize ${terminalId}: ${parsed.cols}x${parsed.rows}`);
                term.cols = parsed.cols;
                term.rows = parsed.rows;
                try {
                  term.terminal.resize(parsed.cols, parsed.rows);
                  if (TMUX_BACKEND && term.sessionName) {
                    void syncTmuxSessionSize(
                      term.sessionName,
                      parsed.cols,
                      parsed.rows,
                    ).catch((err) => {
                      debug(
                        `[reconnect] tmux async resize failed for ${terminalId}:`,
                        err,
                      );
                    });
                  }
                } catch (err) {
                  debug(`Resize error for ${terminalId}:`, err);
                }
                return;
              }
              if (parsed.type === "input") {
                debug(`Input ${terminalId}`);
                term.lastActivityAt = Date.now();
                if (term.agentName && hasVisibleUserInput(parsed.data)) {
                  term.agentHasUserPrompt = true;
                  clearAgentRespondingTimer(term);
                  if (term.agentState !== "thinking") {
                    term.agentState = "thinking";
                    broadcastTerminalState(term);
                  }
                }
                try {
                  term.terminal.write(parsed.data);
                } catch (err) {
                  debug(`Write error for ${terminalId}:`, err);
                }
                return;
              }
              if (parsed.type === "resume-ready") {
                const reconnectState = socketReconnectState.get(ws);
                if (!reconnectState?.pendingReady) return;
                void completeTmuxReconnectReplay(
                  ws,
                  terminalId,
                  term,
                  "client-ready",
                );
                return;
              }
            } catch {
              debug(`Raw input ${terminalId}`);
              term.lastActivityAt = Date.now();
              try {
                term.terminal.write(message);
              } catch (err) {
                debug(`Write error for ${terminalId}:`, err);
              }
            }
          } else {
            const buf = message as unknown as Uint8Array;
            debug(`Binary input ${terminalId}: ${buf.byteLength} bytes`);
            term.lastActivityAt = Date.now();
            try {
              term.terminal.write(new TextDecoder().decode(buf));
            } catch (err) {
              debug(`Binary write error for ${terminalId}:`, err);
            }
          }
        } catch (err) {
          console.error("[WebSocket] Message handler error:", err);
        }
      },

      close(ws: ServerWebSocket<WsData>) {
        const data = ws.data;
        socketReconnectState.delete(ws);

        if (data.type === "opencode_proxy") {
          try {
            data.upstream.close();
          } catch (err) {
            debug("OpenCode proxy upstream close error:", err);
          }
          return;
        }

        const { terminalId } = data;
        const sockets = terminalSockets.get(terminalId);
        if (sockets) {
          sockets.delete(ws);
          if (sockets.size === 0) {
            const term = terminals.get(terminalId);
            if (term) {
              term.lastDetachedAt = Date.now();
            }
          }
        }
      },
    },
  });

  console.log(`🚀 DeckTerm running at http://${host}:${port}`);

  const DECKTERM_ORPHAN_TTL_HOURS = parseInt(
    process.env.DECKTERM_ORPHAN_TTL_HOURS || "8",
    10,
  );
  const DECKTERM_ORPHAN_TTL_MS = DECKTERM_ORPHAN_TTL_HOURS * 60 * 60 * 1000;

  const cleanupIdleTerminals = async () => {
    const now = Date.now();

    for (const [id, term] of terminals) {
      const sockets = terminalSockets.get(id);
      const activeSocketsCount = sockets ? sockets.size : 0;

      // Only clean up idle active/attached terminals. Detached terminals are reaped after 8 hours!
      if (activeSocketsCount > 0) {
        const idleTime = now - term.lastActivityAt;

        if (idleTime > TERMINAL_IDLE_TIMEOUT_MS) {
          console.log(
            `[cleanup] Closing idle active terminal ${id} (idle: ${Math.round(idleTime / 1000 / 60)}min, owner: ${term.ownerEmail})`,
          );
          if (sockets) {
            for (const ws of sockets) {
              try {
                ws.send(JSON.stringify({ type: "idle_timeout" }));
                ws.close();
              } catch {}
            }
          }

          closeTerminalSockets(id);
          removeTerminalState(id);
          try {
            await killTmuxSessionIfLast(term.sessionName);
          } catch (err) {
            if (term.sessionName) {
              debug(`[cleanup] tmux kill-session error for ${id}:`, err);
            }
          }

          try {
            term.proc.kill();
            term.terminal.close();
          } catch (err) {
            debug(`Cleanup error for ${id}:`, err);
          }
        }
      }
    }
  };

  const reapDetachedSessions = async () => {
    const now = Date.now();
    const state = await getFoundationState();

    for (const [id, term] of terminals) {
      const sockets = terminalSockets.get(id);
      const activeSocketsCount = sockets ? sockets.size : 0;

      // Only reap detached sessions (0 active connections)
      if (activeSocketsCount === 0 && term.lastDetachedAt) {
        const detachedTime = now - term.lastDetachedAt;
        const idleTime = now - term.lastActivityAt;
        // Detached and inactive for DECKTERM_ORPHAN_TTL_MS
        const timeSinceLastActivityOrDetach = Math.max(detachedTime, idleTime);

        if (timeSinceLastActivityOrDetach > DECKTERM_ORPHAN_TTL_MS) {
          console.log(
            `[reaper] Reaping expired detached terminal ${id} (detached/inactive: ${Math.round(timeSinceLastActivityOrDetach / 1000 / 60)}min, owner: ${term.ownerEmail})`,
          );

          try {
            await markTerminalSessionEnded(state.db, id);
          } catch (err) {
            debug(`[reaper] Failed to mark session ${id} ended in DB:`, err);
          }

          removeTerminalState(id);

          try {
            await killTmuxSessionIfLast(term.sessionName);
          } catch (err) {
            if (term.sessionName) {
              debug(`[reaper] tmux kill-session error for ${id}:`, err);
            }
          }

          try {
            term.proc.kill();
            term.terminal.close();
          } catch (err) {
            debug(`[reaper] Cleanup error for ${id}:`, err);
          }
        }
      }
    }
  };

  setInterval(cleanupIdleTerminals, 5 * 60 * 1000);
  setInterval(reapDetachedSessions, 15 * 60 * 1000);

  process.on("SIGINT", () => {
    for (const term of terminals.values()) {
      try {
        term.proc.kill();
      } catch {}
    }
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    for (const term of terminals.values()) {
      try {
        term.proc.kill();
      } catch {}
    }
    process.exit(0);
  });

  return server;
}
