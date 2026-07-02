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
import { readFileSync, existsSync } from "node:fs";
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
  getUserById,
  getUserSettings,
  hasScopedGrant,
  initializeFoundationState,
  isBootstrapComplete,
  listTerminalEventsAfter,
  listTerminalSessionsForActor,
  markTerminalSessionEnded,
  recordTerminalSession,
  setUserSettings,
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
type WsData = TerminalWsData;

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
const TMUX_SOCKET_PATH = getTmuxSocketPath({
  namespace: TMUX_SESSION_NAMESPACE,
  stateDir: DECKTERM_STATE_DIR,
});
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
const SETTINGS_MAX_KEYS = 200;
const SETTINGS_MAX_KEY_LENGTH = 128;
const SETTINGS_MAX_VALUE_BYTES = 16 * 1024;
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

// Clipboard image configuration
const CLIPBOARD_IMAGES_DIR = "/tmp/deckterm-clipboard";
const CLIPBOARD_IMAGE_MAX_SIZE = 10 * 1024 * 1024; // 10MB
const CLIPBOARD_IMAGE_TTL_MS = 60 * 60 * 1000; // 1 hour

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
  | { ok: true }
  | {
      ok: false;
      status: 403;
      message: string;
      reason: string;
      capability: ScopedGrantCapability;
      resourceType: string;
      resourceId: string;
    }
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
      capability,
      resourceType,
      resourceId: resourceId || "*",
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
      capability,
      resourceType,
      resourceId: resourceId || "*",
    };
  }

  return { ok: true };
}

function foundationGateJson(error: {
  message: string;
  reason: string;
  capability?: string;
  resourceType?: string;
  resourceId?: string;
}) {
  const structured = {
    reason: error.reason,
    capability: error.capability,
    resourceType: error.resourceType,
    resourceId: error.resourceId,
  };
  if (error.reason === "bootstrap_required") {
    return {
      error: error.message,
      message:
        "DeckTerm foundation state exists, but no admin has completed bootstrap yet.",
      ...structured,
    };
  }
  return {
    error: error.message,
    message:
      "The current user is missing the required DeckTerm capability grant.",
    ...structured,
  };
}

// Onboarding apply/remediate rewrite the server's .env — gate them to
// owner/admin actors and audit every attempt (allow and deny), mirroring
// requireFoundationCapability's trust model (legacy bypass + edge-trusted
// tunnel mode keep single-tenant installs working unchanged).
async function requireOnboardingAdmin(
  c: any,
  action: "onboarding.apply" | "onboarding.remediate",
  data: Record<string, unknown> = {},
): Promise<{ ok: true } | { ok: false; status: 401 | 403; body: any }> {
  const resourceId =
    (data.remediationId as string | undefined) ||
    (data.profile as string | undefined) ||
    null;

  let ownerId: string;
  try {
    ({ ownerId } = getCurrentUser(c));
  } catch (err) {
    if (err instanceof UnauthorizedRequestError) {
      const state = await getFoundationState();
      writeAuditEvent(state.db, {
        actorUserId: null,
        action,
        resourceType: "onboarding",
        resourceId,
        decision: "deny",
        reason: "unauthenticated",
        data,
      });
      return { ok: false, status: 401, body: { error: err.message } };
    }
    throw err;
  }

  if (isFoundationLegacyBypassEnabled()) {
    const state = await getFoundationState();
    writeAuditEvent(state.db, {
      actorUserId: ownerId,
      action,
      resourceType: "onboarding",
      resourceId,
      decision: "allow",
      reason: "legacy_bypass",
      data,
    });
    return { ok: true };
  }

  if (isEdgeProtectedTunnelMode(process.env)) {
    const state = await getFoundationState();
    writeAuditEvent(state.db, {
      actorUserId: ownerId,
      action,
      resourceType: "onboarding",
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
      actorUserId: ownerId,
      action,
      resourceType: "onboarding",
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
      body: foundationGateJson({
        message: "DeckTerm bootstrap required",
        reason: "bootstrap_required",
        resourceType: "onboarding",
        resourceId: resourceId || "*",
      }),
    };
  }

  const user = getUserById(state.db, ownerId);
  if (!user || (user.role !== "owner" && user.role !== "admin")) {
    writeAuditEvent(state.db, {
      actorUserId: ownerId,
      action,
      resourceType: "onboarding",
      resourceId,
      decision: "deny",
      reason: "missing_role",
      data,
    });
    return {
      ok: false,
      status: 403,
      body: foundationGateJson({
        message: "DeckTerm admin role required",
        reason: "missing_role",
        resourceType: "onboarding",
        resourceId: resourceId || "*",
      }),
    };
  }

  writeAuditEvent(state.db, {
    actorUserId: ownerId,
    action,
    resourceType: "onboarding",
    resourceId,
    decision: "allow",
    reason: "role_admin",
    data,
  });
  return { ok: true };
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

// Resolve a requested terminal cwd to a usable start directory.
//   - Path outside the allowed roots            → null  (caller denies: 403).
//   - Path within roots and existing            → its real path.
//   - Path within roots but missing (ENOENT)    → nearest EXISTING ancestor
//     that is still within roots (so a stale/deleted saved cwd — e.g. a
//     files.defaultCwd whose directory was later removed — falls back to a
//     valid root instead of hard-failing terminal creation).
// Security is preserved: the first existing ancestor is realpath-resolved and
// checked against the roots, so a missing path whose nearest real ancestor is
// out of bounds (e.g. /tmp/gone → /tmp) still returns null. Unlike
// resolveAllowedPath this never returns a non-existent path — the result is
// always a directory the PTY can actually start in.
async function resolveTerminalStartDir(
  inputPath: string,
): Promise<string | null> {
  if (!inputPath) return null;
  const fs = await import("fs/promises");
  const roots = await getAllowedRealRoots();
  let candidate = resolve(inputPath);
  while (true) {
    try {
      const realPath = await fs.realpath(candidate);
      return isWithinAllowedRoots(realPath, roots) ? realPath : null;
    } catch (err: unknown) {
      if ((err as { code?: string }).code !== "ENOENT") return null;
      const parent = dirname(candidate);
      if (parent === candidate) return null; // reached filesystem root
      candidate = parent;
    }
  }
}

// ── Scoped content search (POST /api/files/search) bounds + impl ─────────────
const SEARCH_MAX_QUERY_LEN = 1024; // reject queries longer than this (400)
const SEARCH_DEFAULT_MAX_RESULTS = 500; // default cap on returned matches
const SEARCH_MAX_RESULTS = 500; // hard ceiling; client maxResults clamped to this
const SEARCH_MAX_PER_FILE = 50; // stop collecting from a single file past this
const SEARCH_MAX_LINE_LEN = 500; // truncate each returned match line to this many chars
const SEARCH_TIMEOUT_MS = 5000; // hard-kill grep after this
const SEARCH_MAX_STDOUT_BYTES = 2 * 1024 * 1024; // stop reading stdout past 2 MB

// Secret-shaped basenames excluded from search by DEFAULT. These grep
// --exclude globs are a FIRST-PASS PERF filter only — grep --exclude is
// case-SENSITIVE, so the authoritative policy is the server-side
// isSecretSearchMatch() check below (which lower-cases and broadens). There is
// no client flag to disable this; a privileged bypass (if ever introduced)
// would stay a server-side boolean that is OFF with no client input.
const SEARCH_SECRET_EXCLUDES = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.pkcs12",
  "*.keystore",
  "*.jks",
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
  "*.ppk",
  ".netrc",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  ".htpasswd",
  "*token*",
  "*secret*",
  "*credential*",
  "*password*",
  "*.kdbx",
];

// Directories never recursed into (noise + perf).
const SEARCH_EXCLUDE_DIRS = [
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "out",
  "target",
  "coverage",
  ".cache",
];

// ── Authoritative server-side secret policy (case-insensitive) ───────────────
// The grep --exclude globs above are a perf first-pass; THIS is the policy of
// record. Every grep match is re-checked here (lower-cased) before being
// surfaced. Predicates over a normalized (lower-cased) basename.
const SECRET_BASENAME_PREDICATES: Array<(name: string) => boolean> = [
  (n) => n === ".env" || n.startsWith(".env"), // .env and .env.*  (.env*)
  (n) => n.endsWith(".pem"),
  (n) => n.endsWith(".key"),
  (n) => n.endsWith(".p12"),
  (n) => n.endsWith(".pfx"),
  (n) => n.endsWith(".pkcs12"),
  (n) => n.endsWith(".keystore"),
  (n) => n.endsWith(".jks"),
  (n) => n.endsWith(".gpg"), // gpg-encrypted file (the .gpg DIR is covered too)
  (n) => n.endsWith(".asc"), // PGP armored key/signature
  (n) => n.endsWith(".p8"), // PKCS#8 / Apple auth key
  (n) => n === ".pgpass",
  (n) => n === ".boto",
  (n) => n.startsWith("id_rsa"),
  (n) => n.startsWith("id_dsa"),
  (n) => n.startsWith("id_ecdsa"),
  (n) => n.startsWith("id_ed25519"),
  (n) => n.endsWith(".ppk"),
  (n) => n === ".netrc",
  (n) => n === ".git-credentials",
  (n) => n === ".npmrc",
  (n) => n === ".pypirc",
  (n) => n === ".htpasswd",
  (n) => n.includes("token"),
  (n) => n.includes("secret"),
  (n) => n.includes("credential"),
  (n) => n.includes("password"),
  (n) => n.endsWith(".kdbx"),
];

// Secret directory segments (lower-cased path-segment test). ".config/gcloud"
// is a two-segment marker handled separately.
const SECRET_DIR_SEGMENTS = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".gpg",
  ".kube", // kube configs carry bearer tokens
  ".docker", // config.json carries registry creds
  "secrets",
  ".secrets",
]);

// Returns true if the given absolute path is secret-shaped and must be dropped
// from search results, regardless of grep's case-sensitive --exclude pass.
function isSecretSearchMatch(absPath: string): boolean {
  const lower = absPath.toLowerCase();
  const base = basename(lower);
  for (const pred of SECRET_BASENAME_PREDICATES) {
    if (pred(base)) return true;
  }
  const segments = lower.split("/").filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    if (SECRET_DIR_SEGMENTS.has(segments[i])) return true;
    if (segments[i] === ".config" && segments[i + 1] === "gcloud") return true;
  }
  return false;
}

// ── grep binary resolved ONCE from a trusted absolute location ───────────────
// Bun.spawn resolves a bare "grep" via PATH while cwd is the user's search
// root; a writable/relative PATH entry could run a planted grep. Resolve from a
// fixed absolute path at module load and pass a sanitized PATH to the spawn.
const SEARCH_SAFE_PATH = "/usr/bin:/bin";
const GREP_BINARY: string = (() => {
  for (const candidate of ["/usr/bin/grep", "/bin/grep"]) {
    if (existsSync(candidate)) return candidate;
  }
  console.warn(
    "[search] neither /usr/bin/grep nor /bin/grep found; falling back to PATH-resolved 'grep'",
  );
  return "grep";
})();

interface ScopedSearchMatch {
  path: string;
  line: number;
  text: string;
}

// Per-actor in-flight grep process. A new search for the same actor aborts the
// prior one (server side of the client's request-id staleness model — keeps
// per-actor grep concurrency at 1).
const inFlightSearches = new Map<string, ReturnType<typeof Bun.spawn>>();

function parseGrepLine(line: string): ScopedSearchMatch | null {
  // With grep -Z/--null the filename is NUL-delimited: `path\0lineno:text`.
  // Parsing the path on \0 (rather than ':') makes paths containing colons or
  // newlines safe — a filename can no longer forge result framing, and a
  // colon-bearing path parses correctly. (record framing is on \0; we split
  // records on \0 before reaching here only for the filename portion.)
  const nul = line.indexOf("\0");
  if (nul < 0) return null;
  const path = line.slice(0, nul);
  if (!path) return null;
  const rest = line.slice(nul + 1);
  const colon = rest.indexOf(":");
  if (colon < 0) return null;
  const lineNoRaw = rest.slice(0, colon);
  if (!/^\d+$/.test(lineNoRaw)) return null;
  const lineNo = parseInt(lineNoRaw, 10);
  if (!Number.isFinite(lineNo) || lineNo <= 0) return null;
  let text = rest.slice(colon + 1);
  if (text.length > SEARCH_MAX_LINE_LEN) {
    text = text.slice(0, SEARCH_MAX_LINE_LEN);
  }
  return { path, line: lineNo, text };
}

async function runScopedSearch(opts: {
  ownerId: string;
  root: string;
  query: string;
  regex: boolean;
  maxResults: number;
}): Promise<{ matches: ScopedSearchMatch[]; truncated: boolean }> {
  const { ownerId, root, query, regex, maxResults } = opts;

  // Abort any prior in-flight grep for this actor (per-actor concurrency = 1).
  const prior = inFlightSearches.get(ownerId);
  if (prior) {
    try {
      prior.kill();
    } catch {
      // best-effort
    }
  }

  const excludeArgs: string[] = [];
  for (const glob of SEARCH_SECRET_EXCLUDES)
    excludeArgs.push(`--exclude=${glob}`);
  for (const dir of SEARCH_EXCLUDE_DIRS)
    excludeArgs.push(`--exclude-dir=${dir}`);

  // -r (lowercase) → recurse but do NOT follow symlinks found during recursion.
  // -I skip binary files, -n line numbers, -Z/--null NUL-delimit the filename
  // (newline-in-filename framing safety), -F literal / -E regex, -e <query> so
  // a leading-dash query can't be argv-flag-smuggled. GREP_BINARY is an
  // absolute path resolved at module load so a planted ./grep can't be run.
  const args = [
    GREP_BINARY,
    "-rnIZ",
    regex ? "-E" : "-F",
    ...excludeArgs,
    "-e",
    query,
    root,
  ];

  const proc = Bun.spawn(args, {
    cwd: root,
    stdout: "pipe",
    stderr: "ignore",
    // Sanitized PATH (not the possibly-poisoned process.env.PATH); the binary
    // itself is absolute, this just hardens any grep-internal subprocess.
    env: { ...process.env, PATH: SEARCH_SAFE_PATH, LC_ALL: "C" },
  });
  inFlightSearches.set(ownerId, proc);

  let truncated = false;
  const timeout = setTimeout(() => {
    truncated = true;
    try {
      proc.kill();
    } catch {
      // best-effort
    }
  }, SEARCH_TIMEOUT_MS);

  const matches: ScopedSearchMatch[] = [];
  const perFile = new Map<string, number>();
  let buffer = "";
  let bytesRead = 0;

  const consumeLine = (line: string) => {
    if (matches.length >= maxResults) {
      truncated = true;
      return;
    }
    const parsed = parseGrepLine(line);
    if (!parsed) return;
    // Authoritative secret policy (case-insensitive) — grep --exclude is only a
    // perf first-pass; this drops case/name variants it misses.
    if (isSecretSearchMatch(parsed.path)) return;
    const seen = perFile.get(parsed.path) || 0;
    if (seen >= SEARCH_MAX_PER_FILE) {
      truncated = true;
      return;
    }
    perFile.set(parsed.path, seen + 1);
    matches.push(parsed);
  };

  try {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      bytesRead += chunk.byteLength;
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line) consumeLine(line);
        if (matches.length >= maxResults) break;
      }
      if (matches.length >= maxResults) {
        truncated = true;
        try {
          proc.kill();
        } catch {
          // best-effort
        }
        break;
      }
      if (bytesRead > SEARCH_MAX_STDOUT_BYTES) {
        truncated = true;
        try {
          proc.kill();
        } catch {
          // best-effort
        }
        break;
      }
    }
    // Trailing line (no terminating newline) within bounds.
    if (buffer && matches.length < maxResults) consumeLine(buffer);
  } catch {
    // Stream torn down by kill() (timeout / abort / cap) — keep what we have.
  } finally {
    clearTimeout(timeout);
    await proc.exited.catch(() => undefined);
    if (inFlightSearches.get(ownerId) === proc) {
      inFlightSearches.delete(ownerId);
    }
  }

  // ── Authoritative server-side post-filter (the SERVER is the authority on
  // every returned match, not grep's flags) ─────────────────────────────────
  // For each match path: (1) realpath it and require the canonical result to be
  // inside an allowed root (closes TOCTOU/symlink-swap where a path leaked
  // outside the roots — its realpath then falls outside and is dropped), and
  // (2) re-apply the secret policy. Drop silently. realpath is cached per
  // unique path so we pay it once per file, not per match line.
  const realpathCache = new Map<string, string | null>();
  const filtered: ScopedSearchMatch[] = [];
  for (const m of matches) {
    if (isSecretSearchMatch(m.path)) continue;
    let canonical = realpathCache.get(m.path);
    if (canonical === undefined) {
      canonical = await resolveAllowedPath(m.path);
      realpathCache.set(m.path, canonical);
    }
    if (!canonical) continue; // outside allowed roots → dropped
    // Re-check the secret policy against the canonical path too (a symlinked
    // name could disguise a secret target).
    if (isSecretSearchMatch(canonical)) continue;
    filtered.push(m);
  }

  return { matches: filtered, truncated };
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
      body: {
        error: "Forbidden path (no matching registered root)",
        reason: "no_matching_root",
        path: resolvedPath,
      },
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

  // Holds the JWT payload in a mutable container rather than a captured
  // `let` binding: TS control-flow analysis does not track reassignment of
  // an outer `let` from inside a nested closure, so a direct `let` here
  // still type-checks as `null` after the closure runs.
  const accessPayloadHolder: { value: CloudflareAccessPayload | null } = {
    value: null,
  };
  if (jwt && CF_ACCESS_TEAM_NAME) {
    try {
      const { cloudflareAccess: verifyJWT } =
        await import("@hono/cloudflare-access");
      const mockContext = {
        req: { header: (name: string) => req.headers.get(name) },
        set: (key: string, value: CloudflareAccessPayload) => {
          if (key === "accessPayload") {
            accessPayloadHolder.value = value;
          }
        },
      };
      const middleware = verifyJWT(CF_ACCESS_TEAM_NAME);
      await middleware(mockContext as never, async () => {});
      if (
        !isCloudflareAudienceAllowed(
          accessPayloadHolder.value?.aud,
          CF_ACCESS_AUD,
        )
      ) {
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
    accessPayload: accessPayloadHolder.value,
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

  // Cloudflare Access JWT authentication. /api/health is exempt: the deploy
  // pipeline health-gates the candidate and verifies the promoted release
  // over 127.0.0.1 where no JWT exists, and the origin binds loopback, so the
  // exemption exposes nothing publicly (edge traffic still passes the CF
  // Access policy). See backend/health-allowlist.test.ts.
  if (CF_ACCESS_REQUIRED && CF_ACCESS_TEAM_NAME) {
    const cfAccessMiddleware = cloudflareAccess(CF_ACCESS_TEAM_NAME);
    app.use("/*", async (c, next) => {
      if (c.req.path === "/api/health") {
        await next();
        return;
      }
      return cfAccessMiddleware(c, next);
    });
    app.use("/*", async (c, next) => {
      if (c.req.path === "/api/health") {
        await next();
        return;
      }
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
    const gate = await requireOnboardingAdmin(c, "onboarding.apply", {
      profile: body.profile,
      publicOrigin: body.publicOrigin,
    });
    if (!gate.ok) {
      return c.json(gate.body, gate.status as never);
    }
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
    const gate = await requireOnboardingAdmin(c, "onboarding.remediate", {
      remediationId,
      profile: body.profile,
      publicOrigin: body.publicOrigin,
    });
    if (!gate.ok) {
      return c.json(gate.body, gate.status as never);
    }
    const result = await applyOnboardingRemediation(remediationId, {
      profile: body.profile,
      publicOrigin: body.publicOrigin,
      cfAccessTeamName: body.cfAccessTeamName,
      cfAccessAud: body.cfAccessAud,
    });
    return c.json(result);
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
    // Falls back to an allowed root when the requested cwd is within roots but
    // deleted; only a genuinely out-of-roots path returns null (→ 403).
    const resolvedCwd = await resolveTerminalStartDir(requestedCwd);
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

  // POST /api/files/search — bounded recursive content search (grep) scoped to
  // an allowed root. The single most security-critical slice-7 surface; do NOT
  // weaken the gating/bounds below without a security review.
  //
  // Threat model + DECISIONS (slice 7):
  //  - cwd is realpath-resolved + allowed-root-gated (resolveAllowedPath); the
  //    REALPATH is the grep start dir so a symlinked root can't escape.
  //  - grep -r (lowercase) does NOT follow symlinks found during recursion, so a
  //    symlink placed inside the root pointing outside is never traversed.
  //  - SERVER-AUTHORITATIVE post-filter: every returned match path is
  //    realpath-resolved + allowed-root-gated again (closes TOCTOU/symlink-swap
  //    surfacing a file outside the roots) and re-checked against the secret
  //    policy in server code (grep --exclude is only a perf first-pass).
  //  - secret-shaped files are excluded by default via a case-insensitive
  //    server-side policy (isSecretSearchMatch), no client flag to disable.
  //  - grep is invoked by ABSOLUTE path (resolved at module load) with a
  //    sanitized PATH so a planted ./grep on the search root can't run.
  //  - output is NUL-delimited (-Z) so a newline-in-filename can't forge result
  //    framing; the path is parsed on \0, the line number on the first colon.
  //  - literal-by-default (-F); regex is opt-in (-E).
  //  - query never reaches a shell (argv-style Bun.spawn) and is passed via -e so
  //    a leading dash can't be argv-flag-smuggled.
  //  - the raw query text and cwd are NEVER audited (they can contain secrets);
  //    only queryLength/regex/matchCount/truncated are logged on allow.
  app.post("/api/files/search", async (c) => {
    const { ownerId } = getCurrentUser(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      cwd?: unknown;
      query?: unknown;
      regex?: unknown;
      maxResults?: unknown;
      requestId?: unknown;
    };

    // Normalize requestId: accept only a finite number or a short string
    // (echoed back for client staleness matching); default to 0 otherwise so a
    // hostile/oversized value can't bloat the response.
    let requestId: number | string = 0;
    if (typeof body.requestId === "number" && Number.isFinite(body.requestId)) {
      requestId = body.requestId;
    } else if (
      typeof body.requestId === "string" &&
      body.requestId.length <= 64
    ) {
      requestId = body.requestId;
    }

    const regex = Boolean(body.regex);
    const rawQuery = typeof body.query === "string" ? body.query : "";
    const requestedCwd = typeof body.cwd === "string" ? body.cwd : "";

    // ── Validation / bounds ──────────────────────────────────────────────────
    // Bound cwd before any work — it is unbounded user input and is written to
    // the deny audit row, so cap it to avoid response/audit bloat on hostile
    // requests.
    const SEARCH_MAX_CWD_LEN = 4096;
    if (requestedCwd.length > SEARCH_MAX_CWD_LEN) {
      return c.json({ error: "cwd too long", requestId }, 400);
    }

    const query = rawQuery.trim();
    if (!query) {
      return c.json({ error: "Empty query", requestId }, 400);
    }
    if (rawQuery.length > SEARCH_MAX_QUERY_LEN) {
      return c.json({ error: "Query too long", requestId }, 400);
    }

    let maxResults = SEARCH_DEFAULT_MAX_RESULTS;
    if (
      typeof body.maxResults === "number" &&
      Number.isFinite(body.maxResults)
    ) {
      maxResults = Math.max(
        1,
        Math.min(SEARCH_MAX_RESULTS, Math.floor(body.maxResults)),
      );
    }

    // ── Gating: realpath-resolve cwd to an allowed root ──────────────────────
    const resolvedRoot = await resolveAllowedPath(requestedCwd);
    if (!resolvedRoot) {
      const state = await getFoundationState();
      writeAuditEvent(state.db, {
        actorUserId: ownerId,
        action: "files.search",
        resourceType: "root",
        decision: "deny",
        reason: "forbidden_root",
        data: { cwd: requestedCwd },
      });
      return c.json({ error: "Forbidden search root", requestId }, 403);
    }

    const fileAccess = await requireFileAccess(c, resolvedRoot);
    if (!fileAccess.ok) {
      // Attribute the denial to THIS endpoint in the audit trail (in addition
      // to whatever requireFileAccess logs internally). Never log the raw query
      // or cwd here — reason only, empty data.
      const state = await getFoundationState();
      writeAuditEvent(state.db, {
        actorUserId: ownerId,
        action: "files.search",
        resourceType: "root",
        decision: "deny",
        reason: "file_access_denied",
        data: {},
      });
      return c.json(
        { ...fileAccess.body, requestId },
        { status: fileAccess.status as any },
      );
    }

    // ── Run the bounded grep (argv-style, no shell) ──────────────────────────
    const { matches, truncated } = await runScopedSearch({
      ownerId,
      root: resolvedRoot,
      query,
      regex,
      maxResults,
    });

    const state = await getFoundationState();
    const rootId = resolveFoundationRootIdForPath(state, resolvedRoot);
    writeAuditEvent(state.db, {
      actorUserId: ownerId,
      action: "files.search",
      resourceType: "root",
      resourceId: rootId || resolvedRoot,
      decision: "allow",
      // DECISION: never log the raw query (it can contain secrets being hunted).
      data: {
        queryLength: query.length,
        regex,
        matchCount: matches.length,
        truncated,
      },
    });

    return c.json({ matches, truncated, requestId });
  });

  // File download
  app.get("/api/files/download", async (c) => {
    const requestedPath = c.req.query("path");
    if (!requestedPath) {
      return c.json({ error: "Path required" }, 400);
    }
    const filePath = await resolveAllowedPath(requestedPath);
    if (!filePath) {
      return c.json(
        { error: "Forbidden path", reason: "no_matching_root" },
        403,
      );
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

  // File content for the in-browser editor: GET returns text + mtime, PUT
  // saves atomically (tmp + rename) with an optimistic-concurrency check on
  // expectedMtimeMs so two editors can't silently clobber each other.
  const EDITOR_MAX_FILE_BYTES = 2 * 1024 * 1024;

  app.get("/api/files/content", async (c) => {
    const requestedPath = c.req.query("path");
    if (!requestedPath) {
      return c.json({ error: "Path required" }, 400);
    }
    const filePath = await resolveAllowedPath(requestedPath);
    if (!filePath) {
      return c.json(
        { error: "Forbidden path", reason: "no_matching_root" },
        403,
      );
    }
    const fileAccess = await requireFileAccess(c, filePath);
    if (!fileAccess.ok) {
      return c.json(fileAccess.body, { status: fileAccess.status as any });
    }

    const fs = await import("fs/promises");
    try {
      const fileStat = await fs.stat(filePath);
      if (!fileStat.isFile()) {
        return c.json({ error: "Not a file" }, 400);
      }
      if (fileStat.size > EDITOR_MAX_FILE_BYTES) {
        return c.json(
          { error: "File too large to edit", maxBytes: EDITOR_MAX_FILE_BYTES },
          413,
        );
      }
      const data = await fs.readFile(filePath);
      if (data.includes(0)) {
        return c.json({ error: "Binary file cannot be edited" }, 415);
      }
      return c.json({
        path: filePath,
        content: data.toString("utf8"),
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size,
      });
    } catch {
      return c.json({ error: "Cannot read file" }, 400);
    }
  });

  app.put("/api/files/content", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const requestedPath = typeof body.path === "string" ? body.path : "";
    const content = typeof body.content === "string" ? body.content : null;
    if (!requestedPath || content === null) {
      return c.json({ error: "path and content required" }, 400);
    }
    if (Buffer.byteLength(content, "utf8") > EDITOR_MAX_FILE_BYTES) {
      return c.json(
        { error: "Content too large", maxBytes: EDITOR_MAX_FILE_BYTES },
        413,
      );
    }
    const filePath = await resolveAllowedPath(requestedPath, {
      allowMissing: true,
    });
    if (!filePath) {
      return c.json(
        { error: "Forbidden path", reason: "no_matching_root" },
        403,
      );
    }
    const fileAccess = await requireFileAccess(c, filePath);
    if (!fileAccess.ok) {
      return c.json(fileAccess.body, { status: fileAccess.status as any });
    }

    const fs = await import("fs/promises");
    try {
      const expectedMtimeMs = Number(body.expectedMtimeMs);
      if (Number.isFinite(expectedMtimeMs)) {
        try {
          const current = await fs.stat(filePath);
          if (current.mtimeMs !== expectedMtimeMs) {
            return c.json(
              {
                error: "File changed on disk since it was opened",
                reason: "mtime_conflict",
                mtimeMs: current.mtimeMs,
              },
              409,
            );
          }
        } catch {
          // File vanished — treat as conflict so the user re-decides.
          return c.json(
            { error: "File no longer exists", reason: "mtime_conflict" },
            409,
          );
        }
      }

      const tmpPath = `${filePath}.deckterm-save-${process.pid}-${Date.now()}`;
      await fs.writeFile(tmpPath, content, "utf8");
      await fs.rename(tmpPath, filePath);
      const saved = await fs.stat(filePath);

      const state = await getFoundationState();
      writeAuditEvent(state.db, {
        actorUserId: getCurrentUser(c).ownerId,
        action: "file.write",
        resourceType: "root",
        decision: "allow",
        reason: "editor_save",
        data: { path: filePath, bytes: saved.size },
      });

      return c.json({ ok: true, path: filePath, mtimeMs: saved.mtimeMs });
    } catch (err) {
      return c.json({ error: "Cannot write file", message: String(err) }, 500);
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
      return c.json(
        { error: "Forbidden path", reason: "no_matching_root" },
        403,
      );
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
        return c.json(
          { error: "Forbidden path", reason: "no_matching_root" },
          403,
        );
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
      return c.json(
        { error: "Forbidden path", reason: "no_matching_root" },
        403,
      );
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
      return c.json(
        { error: "Forbidden path", reason: "no_matching_root" },
        403,
      );
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
      return c.json(
        { error: "Forbidden path", reason: "no_matching_root" },
        403,
      );
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

  // Shared runner for git child processes. GIT_TERMINAL_PROMPT=0 makes
  // credential prompts (e.g. push to an auth-requiring remote) fail fast
  // instead of hanging the request until the timeout.
  async function runGit(
    cwd: string,
    args: string[],
    timeoutMs = 10000,
  ): Promise<{ ok: boolean; output: string; stderr: string; code: number }> {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const timeoutId = setTimeout(() => proc.kill(), timeoutMs);
    const [output, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timeoutId);
    return { ok: code === 0, output, stderr, code };
  }

  // GET /api/settings — actor-scoped UI settings (windows layout, dock, prefs)
  app.get("/api/settings", async (c) => {
    const actor = getCurrentActor(c);
    const state = await getFoundationState();
    return c.json({ settings: getUserSettings(state.db, actor.id) });
  });

  // PUT /api/settings { settings: { key: value | null } } — merge semantics,
  // null deletes a key. Values are opaque JSON owned by the frontend.
  app.put("/api/settings", async (c) => {
    const actor = getCurrentActor(c);
    const body = await c.req.json().catch(() => null);
    const entries = (body as { settings?: unknown } | null)?.settings;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      return c.json({ error: "settings object required" }, 400);
    }
    const record = entries as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length > SETTINGS_MAX_KEYS) {
      return c.json({ error: "too many settings keys" }, 400);
    }
    for (const key of keys) {
      if (!key || key.length > SETTINGS_MAX_KEY_LENGTH) {
        return c.json({ error: "invalid settings key" }, 400);
      }
      const value = record[key];
      if (
        value !== null &&
        JSON.stringify(value).length > SETTINGS_MAX_VALUE_BYTES
      ) {
        return c.json({ error: `settings value too large: ${key}` }, 400);
      }
    }
    const state = await getFoundationState();
    setUserSettings(state.db, actor.id, record);
    return c.json({ settings: getUserSettings(state.db, actor.id) });
  });

  // Does the resolved actor already hold a filesystem capability (i.e. is
  // allowed to browse the registered roots)? Read-only: never writes an audit
  // row (this is consulted on every settings-window open, and a deny here is
  // an expected, benign state — not a host-access attempt). Mirrors the
  // allow conditions of requireFoundationCapability("root.use", …) without the
  // deny side effects.
  async function actorHoldsFilesystemCapability(c: any): Promise<boolean> {
    if (isFoundationLegacyBypassEnabled()) return true;
    if (isEdgeProtectedTunnelMode(process.env)) return true;
    const state = await getFoundationState();
    if (!isBootstrapComplete(state)) return false;
    const { ownerId } = getCurrentUser(c);
    // Match the same shape requireFileAccess would check: root.use on any
    // registered root (admins hold the "*"/"*" wildcard; per-root grants are
    // matched by their rootId). hasScopedGrant treats "*" as a wildcard on
    // both sides, so checking the first root's id also catches wildcard grants.
    const firstRootId = state.roots[0]?.id;
    return hasScopedGrant(state.db, {
      userId: ownerId,
      capability: "root.use",
      resourceType: "root",
      resourceId: firstRootId || "*",
    });
  }

  // GET /api/settings/env-info — read-only, non-secret server config.
  //
  // Returns a HARDCODED allowlist of {key, value, description} rows. It NEVER
  // echoes arbitrary process.env, and never includes secret-shaped vars
  // (CF_ACCESS_*, *_TOKEN, *_SECRET, *_KEY). Path-valued config is COARSENED by
  // default (label + count) because raw host paths reveal topology, usernames,
  // and confinement boundaries — exact paths are revealed only to an actor that
  // already holds the filesystem capability (the same gate that lets them
  // browse those roots). Same actor gate as GET/PUT /api/settings; deliberately
  // NOT behind requireFileAccess so any authenticated actor can read the
  // non-path basics.
  app.get("/api/settings/env-info", async (c) => {
    // Resolve the actor (throws -> 401 for unauthenticated) just like
    // GET/PUT /api/settings.
    getCurrentActor(c);

    const env: Array<{ key: string; value: string; description: string }> = [];

    // --- Default (non-path) rows: shown to any authenticated actor. ---
    env.push({
      key: "PORT",
      value: String(process.env.PORT || "4174"),
      description: "HTTP port the server listens on.",
    });
    env.push({
      key: "DECKTERM_RUNTIME_ENV",
      value: String(
        process.env.DECKTERM_RUNTIME_ENV ||
          process.env.NODE_ENV ||
          "production",
      ),
      description: "Runtime environment (development or production).",
    });
    env.push({
      key: "TMUX_BACKEND",
      value: getBackendMode() === "tmux" ? "enabled" : "disabled",
      description:
        "Terminal backend: tmux (persists across reconnects) or raw PTY.",
    });
    env.push({
      key: "MAX_TERMINALS_PER_USER",
      value: String(MAX_TERMINALS_PER_USER),
      description: "Maximum concurrent terminals allowed per user.",
    });
    env.push({
      key: "DECKTERM_PUBLISH_MODE",
      value: String(process.env.DECKTERM_PUBLISH_MODE || "default"),
      description: "How the server is published (e.g. cloudflare-tunnel).",
    });

    // --- Path-valued rows: coarsened by default, exact only with capability. ---
    const canSeePaths = await actorHoldsFilesystemCapability(c);
    const rootCount = ALLOWED_FILESYSTEM_ROOTS.length;

    if (canSeePaths) {
      env.push({
        key: "ALLOWED_FILE_ROOTS",
        value: ALLOWED_FILESYSTEM_ROOTS.join(", "),
        description:
          "Filesystem roots terminals and file/git access are scoped to.",
      });
      env.push({
        key: "DECKTERM_STATE_DIR",
        value: DECKTERM_STATE_DIR,
        description: "Directory holding foundation state, sockets, and DB.",
      });
    } else {
      env.push({
        key: "ALLOWED_FILE_ROOTS",
        value: `${rootCount} allowed root${rootCount === 1 ? "" : "s"} configured`,
        description:
          "Number of filesystem roots access is scoped to (exact paths hidden).",
      });
      env.push({
        key: "DECKTERM_STATE_DIR",
        value: "configured",
        description: "Server state directory (exact path hidden).",
      });
    }

    return c.json({ env });
  });

  // GET /api/git/status?cwd=/path/to/repo
  app.get("/api/git/status", async (c) => {
    const cwd = c.req.query("cwd") || process.env.HOME;
    if (!cwd || !(await validateGitCwd(c, cwd))) {
      return c.json(
        { error: "Forbidden path", reason: "no_matching_root" },
        403,
      );
    }

    try {
      const proc = Bun.spawn(["git", "status", "--porcelain", "-uall", "-b"], {
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
      const headerLine = lines[0]?.replace("## ", "") || "";
      // "main...origin/main [ahead 1, behind 2]" | "main" | "No commits yet on main"
      const trackMatch = headerLine.match(
        /^(.+?)(?:\.\.\.(\S+))?(?:\s+\[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\])?$/,
      );
      const branch = trackMatch?.[1] || "unknown";
      const upstream = trackMatch?.[2] || null;
      const ahead = Number(trackMatch?.[3] || 0);
      const behind = Number(trackMatch?.[4] || 0);
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

      // Absolute repo toplevel — lets callers (e.g. the explorer decorations)
      // map porcelain paths (repo-relative) to absolute paths. Best-effort:
      // null if the lookup fails, never breaks the status response.
      let root: string | null = null;
      try {
        const rootProc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
          cwd,
          stdout: "pipe",
          stderr: "ignore",
        });
        const rootTimeout = setTimeout(() => rootProc.kill(), 10000);
        const [rootOut, rootExit] = await Promise.all([
          new Response(rootProc.stdout).text(),
          rootProc.exited,
        ]);
        clearTimeout(rootTimeout);
        if (rootExit === 0) root = rootOut.trim() || null;
      } catch {
        root = null;
      }

      return c.json({ branch, upstream, ahead, behind, files, cwd, root });
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
      return c.json(
        { error: "Forbidden path", reason: "no_matching_root" },
        403,
      );
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

      // Untracked file fallback (working-tree, single-path, empty diff output):
      // plain `git diff -- <path>` produces no output for untracked files. Check
      // if the path is untracked (status "??") and, if so, re-run with
      // --no-index against /dev/null so the whole file appears as an addition.
      // NOTE: `git diff --no-index` exits with code 1 when files differ — treat
      // exit code 1 + non-empty stdout as SUCCESS (not an error). Only 400 on
      // exit code > 1.
      if (!commit && !stagedEnabled && path && output.trim() === "") {
        const statusProc = Bun.spawn(
          ["git", "status", "--porcelain", "--", path],
          { cwd, stdout: "pipe", stderr: "pipe" },
        );
        const statusTimeoutId = setTimeout(() => statusProc.kill(), 10000);
        const [statusOut, , statusExit] = await Promise.all([
          new Response(statusProc.stdout).text(),
          new Response(statusProc.stderr).text(),
          statusProc.exited,
        ]);
        clearTimeout(statusTimeoutId);

        if (statusExit === 0 && statusOut.trimStart().startsWith("??")) {
          // Resolve the absolute path for --no-index (git diff --no-index
          // expects real filesystem paths, not relative-to-cwd)
          const absPath = path.startsWith("/") ? path : `${cwd}/${path}`;
          const noIndexProc = Bun.spawn(
            [
              "git",
              "diff",
              "--no-index",
              "--color=never",
              "--",
              "/dev/null",
              absPath,
            ],
            { cwd, stdout: "pipe", stderr: "pipe" },
          );
          const noIndexTimeoutId = setTimeout(() => noIndexProc.kill(), 10000);
          const [noIndexOut, noIndexErr, noIndexExit] = await Promise.all([
            new Response(noIndexProc.stdout).text(),
            new Response(noIndexProc.stderr).text(),
            noIndexProc.exited,
          ]);
          clearTimeout(noIndexTimeoutId);

          // exit 1 + non-empty stdout = files differ (expected for untracked)
          if (
            noIndexExit === 0 ||
            (noIndexExit === 1 && noIndexOut.length > 0)
          ) {
            return c.json({
              diff: noIndexOut,
              cwd,
              path,
              staged: 0,
              commit: null,
            });
          }
          if (noIndexExit > 1) {
            return c.json(
              {
                error: "Git diff failed",
                message: noIndexErr.trim() || "git diff --no-index failed",
              },
              400,
            );
          }
        }
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
      return c.json(
        { error: "Forbidden path", reason: "no_matching_root" },
        403,
      );
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
      return c.json(
        { error: "Forbidden path", reason: "no_matching_root" },
        403,
      );
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
    const { cwd, message, amend } = body;

    if (!cwd || !(await validateGitCwd(c, cwd))) {
      return c.json(
        { error: "Forbidden path", reason: "no_matching_root" },
        403,
      );
    }

    if (!message?.trim()) {
      return c.json({ error: "Message required" }, 400);
    }

    try {
      const args = amend
        ? ["commit", "--amend", "-m", message]
        : ["commit", "-m", message];
      const result = await runGit(cwd, args);

      if (!result.ok) {
        // git reports the common failure ("nothing to commit") on stdout, not
        // stderr — fall back to stdout so the panel shows a real reason instead
        // of an empty "Commit failed:" line.
        const reason =
          result.stderr.trim() || result.output.trim() || "git commit failed";
        return c.json({ error: "Commit failed", message: reason }, 400);
      }

      return c.json({ ok: true, output: result.output });
    } catch (err) {
      return c.json({ error: "Git commit failed", message: String(err) }, 400);
    }
  });

  // GET /api/git/branches?cwd=...
  app.get("/api/git/branches", async (c) => {
    const cwd = c.req.query("cwd") || process.env.HOME;
    if (!cwd || !(await validateGitCwd(c, cwd))) {
      return c.json(
        { error: "Forbidden path", reason: "no_matching_root" },
        403,
      );
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

  // GET /api/git/log?cwd=...&limit=50&path= (path = per-file history)
  app.get("/api/git/log", async (c) => {
    const cwd = c.req.query("cwd") || process.env.HOME;
    const limit = parseInt(c.req.query("limit") || "50");
    const path = c.req.query("path");

    if (!cwd || !(await validateGitCwd(c, cwd))) {
      return c.json(
        { error: "Forbidden path", reason: "no_matching_root" },
        403,
      );
    }

    if (path && (path.startsWith("/") || path.includes(".."))) {
      return c.json({ error: "Invalid path" }, 400);
    }

    try {
      const args = [
        "git",
        "log",
        `--max-count=${Math.min(limit, 200)}`,
        "--format=%h|%H|%s|%an|%aI",
        "--graph",
        "--",
      ];
      if (path) args.push(path);
      const proc = Bun.spawn(args, {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

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

  // GET /api/git/commit-files?cwd=...&commit=<sha> — the files changed in a
  // single commit (vs its first parent; --root lets the initial commit list its
  // files). Powers the SCM History repo-scope "expand a commit to its files"
  // view, where each file opens a single-file commit diff. Returns
  // { files: [{ status, path }], cwd, commit }.
  app.get("/api/git/commit-files", async (c) => {
    const cwd = c.req.query("cwd") || process.env.HOME;
    const commit = c.req.query("commit");
    if (!cwd || !(await validateGitCwd(c, cwd))) {
      return c.json(
        { error: "Forbidden path", reason: "no_matching_root" },
        403,
      );
    }
    // Same ref validation as /api/git/show: hex/HEAD/refname + optional ~N/^N,
    // never a leading dash (argv-flag smuggling), passed argv-style (no shell).
    if (
      !commit ||
      commit.startsWith("-") ||
      !/^([a-f0-9]{4,40}|HEAD|[\w\-\/.]+)(~\d+|\^\d+)?$/i.test(commit)
    ) {
      return c.json({ error: "Invalid commit reference" }, 400);
    }
    const res = await runGit(cwd, [
      "diff-tree",
      "--no-commit-id",
      "--name-status",
      "-r",
      "--root",
      commit,
    ]);
    if (!res.ok) {
      return c.json(
        { error: "Git diff-tree failed", message: res.stderr.trim() },
        400,
      );
    }
    // Lines are "<STATUS>\t<path>" (renames/copies: "R100\t<old>\t<new>").
    const files = res.output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("\t");
        const status = (parts[0] || "").charAt(0);
        // For renames/copies the destination path is the LAST tab field.
        const path = parts[parts.length - 1] || "";
        return path ? { status, path } : null;
      })
      .filter(Boolean);
    return c.json({ files, cwd, commit });
  });

  // POST /api/git/checkout { cwd, branch }
  app.post("/api/git/checkout", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { cwd, branch } = body;

    if (!cwd || !(await validateGitCwd(c, cwd))) {
      return c.json(
        { error: "Forbidden path", reason: "no_matching_root" },
        403,
      );
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

  // POST /api/git/branch { cwd, action: "create"|"delete", name, checkout?, force? }
  app.post("/api/git/branch", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { cwd, action, name, checkout, force } = body;
    if (!cwd || !(await validateGitCwd(c, cwd))) {
      return c.json(
        { error: "Forbidden path", reason: "no_matching_root" },
        403,
      );
    }
    if (!["create", "delete"].includes(action)) {
      return c.json({ error: "Invalid branch action" }, 400);
    }
    if (!name || typeof name !== "string" || !/^(?!-)[\w\-\/\.]+$/.test(name)) {
      return c.json({ error: "Invalid branch name" }, 400);
    }
    const args =
      action === "create"
        ? checkout
          ? ["checkout", "-b", name]
          : ["branch", name]
        : ["branch", force ? "-D" : "-d", name];
    const result = await runGit(cwd, args);
    if (!result.ok) {
      const reason =
        result.stderr.trim() || result.output.trim() || "git branch failed";
      return c.json({ error: "Git branch failed", message: reason }, 400);
    }
    return c.json({ ok: true, name, action });
  });

  // GET /api/git/stash?cwd= — list stashes
  app.get("/api/git/stash", async (c) => {
    const cwd = c.req.query("cwd") || process.env.HOME;
    if (!cwd || !(await validateGitCwd(c, cwd))) {
      return c.json(
        { error: "Forbidden path", reason: "no_matching_root" },
        403,
      );
    }
    const result = await runGit(cwd, ["stash", "list", "--format=%gd%x09%s"]);
    if (!result.ok) {
      return c.json(
        { error: "Git stash failed", message: result.stderr.trim() },
        400,
      );
    }
    const stashes = result.output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line, i) => {
        const [ref, ...rest] = line.split("\t");
        return { index: i, ref, message: rest.join("\t") };
      });
    return c.json({ stashes, cwd });
  });

  // POST /api/git/stash { cwd, action: "push"|"pop"|"apply"|"drop", message?, index? }
  app.post("/api/git/stash", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { cwd, action, message, index } = body;
    if (!cwd || !(await validateGitCwd(c, cwd))) {
      return c.json(
        { error: "Forbidden path", reason: "no_matching_root" },
        403,
      );
    }
    if (!["push", "pop", "apply", "drop"].includes(action)) {
      return c.json({ error: "Invalid stash action" }, 400);
    }
    if (index !== undefined && (!Number.isInteger(index) || index < 0)) {
      return c.json({ error: "Invalid stash index" }, 400);
    }
    const args = ["stash", action as string];
    if (action === "push") {
      args.push("--include-untracked");
      if (typeof message === "string" && message.trim()) {
        args.push("-m", message.trim());
      }
    } else if (index !== undefined) {
      args.push(`stash@{${index}}`);
    }
    const result = await runGit(cwd, args);
    if (!result.ok) {
      const reason =
        result.stderr.trim() || result.output.trim() || "git stash failed";
      return c.json({ error: "Git stash failed", message: reason }, 400);
    }
    return c.json({ ok: true, output: result.output });
  });

  // POST /api/git/discard { cwd, paths: string[], confirm: true }
  // Destructive: confirm is required by contract; untracked files are removed
  // via `git clean` (restore can't touch them), tracked via `git restore`.
  app.post("/api/git/discard", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { cwd, paths, confirm } = body;
    if (!cwd || !(await validateGitCwd(c, cwd))) {
      return c.json(
        { error: "Forbidden path", reason: "no_matching_root" },
        403,
      );
    }
    if (
      !Array.isArray(paths) ||
      paths.length === 0 ||
      paths.some((p) => typeof p !== "string")
    ) {
      return c.json({ error: "Paths required" }, 400);
    }
    if (confirm !== true) {
      return c.json(
        { error: "Confirmation required", reason: "confirm_required" },
        400,
      );
    }
    const status = await runGit(cwd, ["status", "--porcelain", "--", ...paths]);
    if (!status.ok) {
      return c.json(
        { error: "Git status failed", message: status.stderr.trim() },
        400,
      );
    }
    const untracked: string[] = [];
    const tracked: string[] = [];
    for (const line of status.output.split("\n")) {
      if (line.length < 3) continue;
      const path = line.substring(3).trim();
      (line.startsWith("??") ? untracked : tracked).push(path);
    }
    if (tracked.length > 0) {
      const res = await runGit(cwd, [
        "restore",
        "--worktree",
        "--",
        ...tracked,
      ]);
      if (!res.ok) {
        return c.json(
          { error: "Git restore failed", message: res.stderr.trim() },
          400,
        );
      }
    }
    if (untracked.length > 0) {
      const res = await runGit(cwd, ["clean", "-f", "--", ...untracked]);
      if (!res.ok) {
        return c.json(
          { error: "Git clean failed", message: res.stderr.trim() },
          400,
        );
      }
    }
    return c.json({ ok: true, discarded: { tracked, untracked } });
  });

  // POST /api/git/push { cwd, remote?, branch?, setUpstream? }
  // POST /api/git/pull { cwd, remote?, branch? }
  // POST /api/git/fetch { cwd, remote? }
  // Network ops get a longer timeout; GIT_TERMINAL_PROMPT=0 (runGit) makes
  // credential prompts fail fast instead of hanging the request. No --force
  // and no --rebase by design — conflicts belong in the terminal.
  // Leading dash is rejected so a ref can never be parsed as a git flag
  // (argv smuggling, e.g. remote="--force").
  const GIT_REF_RE = /^(?!-)[\w\-\/\.]+$/;
  for (const op of ["push", "pull", "fetch"] as const) {
    app.post(`/api/git/${op}`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const { cwd, remote, branch, setUpstream } = body;
      if (!cwd || !(await validateGitCwd(c, cwd))) {
        return c.json(
          { error: "Forbidden path", reason: "no_matching_root" },
          403,
        );
      }
      if (
        remote !== undefined &&
        (typeof remote !== "string" || !GIT_REF_RE.test(remote))
      ) {
        return c.json({ error: "Invalid remote" }, 400);
      }
      if (
        branch !== undefined &&
        (typeof branch !== "string" || !GIT_REF_RE.test(branch))
      ) {
        return c.json({ error: "Invalid branch" }, 400);
      }
      const args: string[] = [op];
      if (op === "push" && setUpstream) args.push("-u");
      if (remote) args.push(remote);
      if (op !== "fetch" && branch) args.push(branch);
      const result = await runGit(cwd, args, 30000);
      if (!result.ok) {
        const reason =
          result.stderr.trim() || result.output.trim() || `git ${op} failed`;
        return c.json({ error: `Git ${op} failed`, message: reason }, 400);
      }
      return c.json({ ok: true, output: result.output + result.stderr });
    });
  }

  // GET /api/git/show?cwd=...&commit=...&path=...
  app.get("/api/git/show", async (c) => {
    const cwd = c.req.query("cwd") || process.env.HOME;
    const commit = c.req.query("commit");
    const path = c.req.query("path");

    if (!cwd || !(await validateGitCwd(c, cwd))) {
      return c.json(
        { error: "Forbidden path", reason: "no_matching_root" },
        403,
      );
    }

    // Allow hex hashes (4-40 chars), HEAD, INDEX, and branch/tag names, each
    // with an optional ~N / ^N revision suffix (so a commit diff's "before"
    // side `<sha>~1` resolves; git refnames can't contain ~/^ so this is safe,
    // and the ref is passed argv-style to `git show <ref>:<path>` — no shell).
    // Reject leading-dash refs so an option-shaped ref (e.g. "--stat", "-C")
    // can't be smuggled as a git argv flag even though the ref is spawned
    // argv-style. `[\w\-\/.]+` permits an interior dash but never a leading one.
    if (
      !commit ||
      commit.startsWith("-") ||
      !/^([a-f0-9]{4,40}|HEAD|[\w\-\/.]+)(~\d+|\^\d+)?$/i.test(commit)
    ) {
      return c.json({ error: "Invalid commit reference" }, 400);
    }

    if (!path) {
      return c.json({ error: "Path required" }, 400);
    }

    // "INDEX" maps to git's :0 (staged content) — used by the diff editor for
    // working-tree/staged comparisons.
    const ref = commit === "INDEX" ? ":0" : commit;

    try {
      const proc = Bun.spawn(["git", "show", `${ref}:${path}`, "--"], {
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
