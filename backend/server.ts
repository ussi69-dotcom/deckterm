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
import {
  readFileSync,
  existsSync,
  lstatSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
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
  getLastSuccessfulRunAt,
  RETENTION_JOB_PRUNE,
  RETENTION_JOB_WAL_CHECKPOINT,
  runRetentionPrune,
  runWalCheckpoint,
} from "./services/retention";
import { createTerminalRateLimiter } from "./services/terminal-rate-limiter";
import { listHarnessSummaries } from "./services/agent-harnesses";
import { writeTaskFileAtomic } from "./task-file-io";
import {
  buildPointerLine,
  readTaskMessages,
  renderInboxFile,
  appendTaskMessageEvent,
  sanitizeMessageBody,
  taskInboxDir,
  taskMessagesPath,
  type TaskMessageEvent,
} from "./task-messages";
import {
  bootstrapFirstAdmin,
  appendTerminalEvent,
  createInvitedUser,
  disableOrphanGrantPrincipal,
  getFoundationUserById,
  getScopedGrantById,
  getTerminalSession,
  getUserById,
  getUserSettings,
  grantScopedCapability,
  hasScopedGrant,
  IdentityConflictError,
  initializeFoundationState,
  isBootstrapComplete,
  listFoundationUsers,
  listScopedGrants,
  listTerminalEventsAfter,
  listTerminalSessionsForActor,
  listWildcardGrantPrincipals,
  markTerminalSessionEnded,
  markUserReviewed,
  recordTerminalSession,
  resolveUserForActor,
  revokeScopedCapability,
  setUserDisabled,
  setUserRole,
  setUserSettings,
  writeAuditEvent,
  type FoundationState,
  type FoundationUser,
  type FoundationUserRole,
  type RecordedTerminalSession,
  type ScopedGrantCapability,
} from "./services/foundation-state";
import {
  authorizeTerminalAttach,
  authorizeTerminalSessionAccess,
  authorizeTerminalWrite,
  getRouteCapability,
  isLegacyBootstrapBypassAllowed,
  isOsIsolationEnabled,
  isTrustedActorSourceForIsolation,
  resolveExecutionContext,
  roleImpliesCapability,
  type ExecutionContext,
} from "./services/foundation-authorization";
import {
  createOsMapping,
  deleteOsMapping,
  getOsMapping,
  listOsMappings,
  provisionProjectRoot,
  reactivateOsMapping,
  recordIsolationDeny,
  revokeRootUseGrant,
  suspendOsMapping,
} from "./services/foundation-state";
import {
  gatherOsAccountFacts,
  evaluateOsAccountEligibility,
  resolveEligibilityPolicy,
} from "./services/os-mapping-eligibility";
import { brokerCheck, brokerKill, brokerExec } from "./services/broker-client";
import {
  getFsExecutor,
  matchGrantedRoot,
  matchGrantedRootCandidates,
  canonicalizeLexical,
  FsExecError,
  acquireBrokerSlot,
  releaseBrokerSlot,
  type FsExecutorContext,
} from "./services/fs-executor";
import {
  BrokeredTmuxBackendCache,
  type BrokeredTmuxBackend,
} from "./services/brokered-tmux-backend";
import type { BrokeredExecContext } from "./services/terminal-backend";
import {
  resolveActorFromAccessPayload,
  isEdgeProtectedTunnelMode,
  hasExplicitLegacyDevActorMode,
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
  // S11: display-only ring of recent tool-used marker events (untrusted,
  // forgeable in-band data — never feeds transitions or authz).
  recentTools: Array<{ name: string; summary: string; at: number }>;
  toolRate: { windowStart: number; count: number };
  shellIntegrationCarry: string;
  lastTmuxCapture: string;
  tmuxPipePath: string | null;
  tmuxPipeOffset: number;
  // B2 OS isolation: when brokered, the mapped identity + the per-uid backend
  // that created this terminal, so attach/resize/kill/pipe-read all route back
  // to the same broker path instead of the legacy service-account backend.
  exec?: BrokeredExecContext;
  backend?: TerminalBackend;
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
export type WsData = TerminalWsData;

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
// Cap on ended sessions in GET /api/terminals (recent-history rows in the
// sessions drawer). Ended rows past the cap stay in the DB for their B6
// retention TTL — this only bounds the listing and its per-row telemetry.
const TERMINAL_LIST_ENDED_LIMIT = (() => {
  const parsed = parseInt(
    process.env.DECKTERM_TERMINAL_LIST_ENDED_LIMIT || "10",
    10,
  );
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10;
})();
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
// B7: the terminal-create budget is per-owner (one user must not exhaust
// everyone's budget) with a global backstop against aggregate abuse. Defaults
// preserve the pre-B7 observable limit for a single-user install.
const RATE_LIMIT_PER_USER_MAX = Math.max(
  1,
  parseInt(
    process.env.TERMINAL_RATE_LIMIT_PER_USER_MAX ||
      String(RATE_LIMIT_MAX_REQUESTS),
    10,
  ) || RATE_LIMIT_MAX_REQUESTS,
);
const RATE_LIMIT_GLOBAL_MAX = Math.max(
  RATE_LIMIT_PER_USER_MAX,
  parseInt(
    process.env.TERMINAL_RATE_LIMIT_GLOBAL_MAX ||
      String(4 * RATE_LIMIT_PER_USER_MAX),
    10,
  ) || 4 * RATE_LIMIT_PER_USER_MAX,
);
const TERMINAL_IDLE_TIMEOUT_MS = parseInt(
  process.env.TERMINAL_IDLE_TIMEOUT_MS || String(2 * 60 * 60 * 1000),
  10,
); // 2 hours default
const DECKTERM_ORPHAN_TTL_MS_DEFAULT =
  parseInt(process.env.DECKTERM_ORPHAN_TTL_HOURS || "8", 10) * 60 * 60 * 1000;
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

// B2 OS isolation (design §5): per-uid brokered tmux backends. Constructed
// lazily-populated but always present so the resolver result can select a
// backend; empty + untouched unless DECKTERM_OS_ISOLATION=1 selects a brokered
// context, so legacy mode is byte-unchanged.
const DECKTERM_CAPTURE_ROOT =
  process.env.DECKTERM_CAPTURE_ROOT || "/var/lib/deckterm/capture";
const brokeredTmuxCache = new BrokeredTmuxBackendCache({
  namespace: TMUX_SESSION_NAMESPACE,
  captureRoot: DECKTERM_CAPTURE_ROOT,
});

/**
 * Select the terminal backend for a resolved brokered execution context. In
 * tmux mode a per-uid `BrokeredTmuxBackend`; in raw mode the shared raw backend
 * (which brokers per-call via the `exec` attach option). Never called for a
 * legacy context (invariant §7.1).
 */
function backendForExec(exec: BrokeredExecContext): TerminalBackend {
  return TMUX_BACKEND ? brokeredTmuxCache.get(exec) : terminalBackend;
}
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

// Bridge for shell-integration `agent-done` edges (an agent finished while
// its terminal keeps running) — the primary verdict trigger for the task
// runner's judge loop (D1); terminal exit stays the fallback. A single
// mutable slot, NOT a grow-only listener list: createWebApp() can run more
// than once per process (tests), and stacked bridges would fan one edge out
// to multiple runner instances whose per-task mutexes don't cover each other
// (Codex S6 review). The most recently created app wins.
type AgentDoneBridge = (
  ownerId: string,
  terminalId: string,
  agentName: string,
) => void;
let agentDoneBridge: AgentDoneBridge | null = null;
function setAgentDoneBridge(bridge: AgentDoneBridge) {
  agentDoneBridge = bridge;
}
function notifyAgentDone(
  ownerId: string,
  terminalId: string,
  agentName: string,
) {
  if (!agentDoneBridge) return;
  try {
    agentDoneBridge(ownerId, terminalId, agentName);
  } catch (err) {
    debug("Agent done bridge failed:", err);
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

// S11: record a tool-used marker event into the terminal's display-only ring.
// Untrusted in-band data: capped ring (last 50), per-terminal flood limit
// (fixed 1s window, max 20 — excess events dropped). Never drives task
// transitions, authz, or persisted state (deliberately NOT in
// broadcastTerminalState, whose payload lands in B6-retained state events).
const RECENT_TOOLS_MAX = 50;
const TOOL_EVENTS_PER_WINDOW = 20;
const TOOL_EVENT_WINDOW_MS = 1000;
function recordToolEvent(
  term: Terminal,
  event: { name: string; summary: string },
) {
  const now = Date.now();
  if (now - term.toolRate.windowStart >= TOOL_EVENT_WINDOW_MS) {
    term.toolRate.windowStart = now;
    term.toolRate.count = 0;
  }
  if (term.toolRate.count >= TOOL_EVENTS_PER_WINDOW) return;
  term.toolRate.count += 1;
  term.recentTools.push({ name: event.name, summary: event.summary, at: now });
  if (term.recentTools.length > RECENT_TOOLS_MAX) {
    term.recentTools.splice(0, term.recentTools.length - RECENT_TOOLS_MAX);
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

  // Surface agent-done edges (agent finished, terminal still alive) to
  // subscribers — the task runner validates terminal id + provider + verdict
  // file before acting, so this stays a plain notification.
  for (const event of parsed.events) {
    if (event.type === "agent-done") {
      notifyAgentDone(term.ownerId, term.id, event.agentName);
    } else if (event.type === "tool-used") {
      recordToolEvent(term, event);
    }
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

// Rate limiting state (B7: per-owner buckets + global backstop). ownerId
// always comes from the server-side resolved actor — never from client
// input — and unauthenticated requests are rejected before any limiter
// check (D-B7-1).
const rateLimitState = createTerminalRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  perUserMax: RATE_LIMIT_PER_USER_MAX,
  globalMax: RATE_LIMIT_GLOBAL_MAX,
});

// B7 (D-B7-2): per-owner session policy seam. Env defaults only for now —
// C3 adds the admin-managed per-user policy store + UX on this seam. The
// `policy.` settings prefix is reserved (rejected in PUT /api/settings) so
// nothing can squat on it via actor-scoped self-service before C3.
function resolveSessionPolicy(_ownerId: string): {
  idleTimeoutMs: number;
  detachedTtlMs: number;
} {
  return {
    idleTimeoutMs: TERMINAL_IDLE_TIMEOUT_MS,
    detachedTtlMs: DECKTERM_ORPHAN_TTL_MS_DEFAULT,
  };
}

// =============================================================================
// CLIPBOARD IMAGE HELPERS
// =============================================================================

// Ensure clipboard directory exists
async function ensureClipboardDir() {
  try {
    // Service-owned, 0700 (B4 / Codex #14): no other account can plant a symlink
    // or read a pasted image in a shared world-accessible /tmp dir.
    await mkdir(CLIPBOARD_IMAGES_DIR, { recursive: true, mode: 0o700 });
  } catch {
    // Directory exists
  }
  // mkdir's mode only applies on creation — a PRE-EXISTING path could be a
  // symlink or an attacker-owned dir (Codex integrated #2). Verify + reharden;
  // refuse to use an unsafe path so the write below never targets it.
  const st = lstatSync(CLIPBOARD_IMAGES_DIR);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error("clipboard dir is not a real directory");
  }
  const myUid = process.getuid?.() ?? -1;
  if (st.uid !== myUid) {
    throw new Error("clipboard dir is not owned by the service account");
  }
  if ((st.mode & 0o777) !== 0o700) {
    chmodSync(CLIPBOARD_IMAGES_DIR, 0o700);
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
// Ensure directory exists on startup (best-effort; the upload route re-validates
// and fails the request if the dir is unsafe, rather than crashing the server).
ensureClipboardDir().catch(() => {});

export async function reconcileSessionsOnStartup(
  db: Database,
): Promise<number> {
  if (!TMUX_BACKEND) return 0;
  let fixed = 0;
  try {
    const activeSessions = db
      .query(
        "SELECT id, actor_user_id, exec_kind, os_uid FROM terminal_sessions WHERE status = 'active'",
      )
      .all() as {
      id: string;
      actor_user_id: string | null;
      exec_kind: "legacy" | "brokered" | null;
      os_uid: number | null;
    }[];
    // B2 (§4.4.3, Codex #8 + integrated-review #3/#6): under isolation, END
    // EVERY pre-existing active session rather than adopt any of them. Brokered
    // sessions live on a per-uid broker socket the shared tmux backend can't
    // see, and a legacy row would otherwise be resurrected on the service
    // account. Recovering brokered sessions across a restart is deferred (needs
    // per-uid backend rebuild + broker-side liveness); ending them is the safe
    // B2 behavior — the session is simply recreated. This closes both the
    // "uid-only mapping match" and "misrouted brokered recovery" gaps at once.
    if (isOsIsolationEnabled(process.env)) {
      const orphanUids = new Set<number>();
      for (const session of activeSessions) {
        markTerminalSessionEnded(db, session.id);
        fixed++;
        if (session.exec_kind === "brokered" && session.os_uid != null) {
          orphanUids.add(session.os_uid);
        }
        writeAuditEvent(db, {
          actorUserId: session.actor_user_id,
          action: "session.reconcile_denied",
          resourceType: "terminal",
          resourceId: session.id,
          decision: "deny",
          reason: "isolation_reconcile_end_all",
          data: { execKind: session.exec_kind, osUid: session.os_uid },
        });
      }
      // Stop each orphaned per-uid tmux-server scope (integrated-review
      // residual #3): brokered tmux servers survive a service restart
      // (KillMode=process), so ending the DB rows alone would leave shells
      // running until a later suspend/delete. Reap them now.
      for (const uid of orphanUids) {
        try {
          await brokerKill({ tmuxServerUid: uid });
        } catch (err) {
          debug(`[reconciliation] brokerKill tmux-server ${uid} failed`, err);
        }
      }
      if (fixed > 0) {
        console.log(
          `[reconciliation] Ended ${fixed} pre-existing session(s) under OS isolation (reaped ${orphanUids.size} broker server scope(s))`,
        );
      }
      return fixed;
    }
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
  // B2: legacy recovery walks the SHARED tmux socket as the service account —
  // never do that under isolation (reconcile already ended pre-existing rows;
  // brokered recovery is a per-uid concern deferred past B2).
  if (isOsIsolationEnabled(process.env)) return 0;

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

/**
 * Canonical ownership (plan §2, invariant §9.9): terminal create, attach, WS
 * upgrade, and live-count checks store/compare the resolved `users.id`, not
 * the raw actor id. For every grandfathered row these are identical by
 * construction (S1), so this is a no-op for existing single-tenant installs;
 * for invited (`user_<hex>`) users it collapses attach/create/ownership onto
 * one id space. Only unresolved actors (no user row at all) fall back to the
 * raw actor id, exactly like today. Throws IdentityConflictError (never
 * caught here) when resolution hits a self-heal collision — callers must
 * fail closed (403, audit reason "identity_conflict") rather than swallow it.
 */
function resolveCanonicalOwnerId(
  state: FoundationState,
  actor: DeckTermActor,
): { ownerId: string; user: FoundationUser | null } {
  const resolved = resolveUserForActor(state.db, actor, process.env);
  return {
    ownerId: resolved?.user.id ?? actor.id,
    user: resolved?.user ?? null,
  };
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
  actor,
  capability,
  resourceType,
  resourceId = "*",
  data = {},
}: {
  actor: DeckTermActor;
  capability: ScopedGrantCapability;
  resourceType: string;
  resourceId?: string | null;
  data?: Record<string, unknown>;
}): Promise<
  | { ok: true; ownerId: string }
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
  // Legacy bypass stays first and unchanged (CI/test/dev only): it never
  // touches the DB, so no canonical resolution happens here either — the
  // raw actor id is what pre-existing legacy-mode installs have always used.
  if (isFoundationLegacyBypassEnabled()) {
    return { ok: true, ownerId: actor.id };
  }

  const state = await getFoundationState();

  // Resolve the canonical user once (plan §2, invariant §9.9): drives the
  // disabled check and the role bundle below, and — on every allow path —
  // is the id downstream seams (terminal create/attach, session recording,
  // live-terminal counts) store and compare. IdentityConflictError means a
  // self-heal collision: fail closed rather than ever merge identity rows
  // (invariant §9.1).
  let canonical: { ownerId: string; user: FoundationUser | null };
  try {
    canonical = resolveCanonicalOwnerId(state, actor);
  } catch (err) {
    if (err instanceof IdentityConflictError) {
      writeAuditEvent(state.db, {
        actorUserId: actor.id,
        action: capability,
        resourceType,
        resourceId,
        decision: "deny",
        reason: "identity_conflict",
        data,
      });
      return {
        ok: false,
        status: 403,
        message: "DeckTerm identity resolution conflict",
        reason: "identity_conflict",
        capability,
        resourceType,
        resourceId: resourceId || "*",
      };
    }
    throw err;
  }
  const actorUserId = canonical.ownerId;
  const user = canonical.user;

  // Precedence (plan §3, invariant §9.2): disabled wins over every grant,
  // role, and edge/tunnel allowance for known users — checked before the
  // edge-tunnel allow just below. An unknown actor (`user === null`) can't
  // be disabled, so this is a no-op for actors without a user row.
  if (user?.disabled) {
    writeAuditEvent(state.db, {
      actorUserId,
      action: capability,
      resourceType,
      resourceId,
      decision: "deny",
      reason: "user_disabled",
      data,
    });
    return {
      ok: false,
      status: 403,
      message: "DeckTerm account disabled",
      reason: "user_disabled",
      capability,
      resourceType,
      resourceId: resourceId || "*",
    };
  }

  // Edge-trusted cloudflare-tunnel mode: the Cloudflare Access edge already
  // authenticated the human (the app binds loopback, so it is only reachable
  // through the tunnel). Allow host-access without a per-actor grant, but audit
  // the real identity for accountability. Root mapping still happens upstream,
  // so this does not widen filesystem scope.
  if (isEdgeProtectedTunnelMode(process.env)) {
    writeAuditEvent(state.db, {
      actorUserId,
      action: capability,
      resourceType,
      resourceId,
      decision: "allow",
      reason: "edge_trusted_tunnel",
      data,
    });
    return { ok: true, ownerId: actorUserId };
  }

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

  // Role bundle, evaluated at check time — not materialized (invariant
  // §9.3): owner/admin imply the five capabilities on any resource; member
  // gets no wildcards, scoped grants only.
  if (user && roleImpliesCapability(user.role, capability)) {
    writeAuditEvent(state.db, {
      actorUserId,
      action: capability,
      resourceType,
      resourceId,
      decision: "allow",
      reason: "role_bundle",
      data,
    });
    return { ok: true, ownerId: actorUserId };
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

  return { ok: true, ownerId: actorUserId };
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

// B3-S3 admin surfaces (/api/users*, /api/grants*): new privileged routes,
// strict from birth (invariant §9.5) — unlike requireFoundationCapability /
// requireOnboardingAdmin, this gate has NO legacy-bypass and NO edge-tunnel
// allow path. Order: 401 unauthenticated -> 403 bootstrap_required -> resolve
// canonical user (403 identity_conflict on a self-heal collision, 403
// missing_role when no user row exists) -> 403 user_disabled (checked before
// the role check, matching the disabled-wins precedence everywhere else) ->
// 403 missing_role (role not in `roles`) -> allow. Every attempt is audited;
// `action` doubles as the audit_events.action value (e.g. "users.create",
// "grants.revoke") and its "grants." prefix selects the audit resourceType.
async function requireRole(
  c: any,
  roles: FoundationUserRole[],
  action: string,
  data: Record<string, unknown> = {},
): Promise<
  | { ok: true; user: FoundationUser; ownerId: string }
  | { ok: false; status: 401 | 403; body: any }
> {
  const resourceType = action.startsWith("grants.") ? "grant" : "user";
  const resourceId = (data.targetId as string | undefined) || null;

  let actor: DeckTermActor;
  try {
    actor = getCurrentActor(c);
  } catch (err) {
    if (err instanceof UnauthorizedRequestError) {
      const state = await getFoundationState();
      writeAuditEvent(state.db, {
        actorUserId: null,
        action,
        resourceType,
        resourceId,
        decision: "deny",
        reason: "unauthenticated",
        data,
      });
      return { ok: false, status: 401, body: { error: err.message } };
    }
    throw err;
  }

  const state = await getFoundationState();

  if (!isBootstrapComplete(state)) {
    writeAuditEvent(state.db, {
      actorUserId: actor.id,
      action,
      resourceType,
      resourceId,
      decision: "deny",
      reason: "bootstrap_required",
      data,
    });
    return {
      ok: false,
      status: 403,
      body: foundationGateJson({
        message: "DeckTerm bootstrap required",
        reason: "bootstrap_required",
        resourceType,
        resourceId: resourceId || "*",
      }),
    };
  }

  let canonical: { ownerId: string; user: FoundationUser | null };
  try {
    canonical = resolveCanonicalOwnerId(state, actor);
  } catch (err) {
    if (err instanceof IdentityConflictError) {
      writeAuditEvent(state.db, {
        actorUserId: actor.id,
        action,
        resourceType,
        resourceId,
        decision: "deny",
        reason: "identity_conflict",
        data,
      });
      return {
        ok: false,
        status: 403,
        body: foundationGateJson({
          message: "DeckTerm identity resolution conflict",
          reason: "identity_conflict",
          resourceType,
          resourceId: resourceId || "*",
        }),
      };
    }
    throw err;
  }

  const { ownerId, user } = canonical;

  if (!user) {
    writeAuditEvent(state.db, {
      actorUserId: ownerId,
      action,
      resourceType,
      resourceId,
      decision: "deny",
      reason: "missing_role",
      data,
    });
    return {
      ok: false,
      status: 403,
      body: foundationGateJson({
        message: "DeckTerm role required",
        reason: "missing_role",
        resourceType,
        resourceId: resourceId || "*",
      }),
    };
  }

  // Disabled wins (invariant §9.2), checked before the role check — mirrors
  // requireFoundationCapability's precedence.
  if (user.disabled) {
    writeAuditEvent(state.db, {
      actorUserId: ownerId,
      action,
      resourceType,
      resourceId,
      decision: "deny",
      reason: "user_disabled",
      data,
    });
    return {
      ok: false,
      status: 403,
      body: foundationGateJson({
        message: "DeckTerm account disabled",
        reason: "user_disabled",
        resourceType,
        resourceId: resourceId || "*",
      }),
    };
  }

  if (!roles.includes(user.role)) {
    writeAuditEvent(state.db, {
      actorUserId: ownerId,
      action,
      resourceType,
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
        resourceType,
        resourceId: resourceId || "*",
      }),
    };
  }

  writeAuditEvent(state.db, {
    actorUserId: ownerId,
    action,
    resourceType,
    resourceId,
    decision: "allow",
    reason: `role_${user.role}`,
    data,
  });
  return { ok: true, user, ownerId };
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
  actor,
  term,
  capability,
}: {
  actor: DeckTermActor;
  term: Terminal;
  capability: "terminal.attach" | "terminal.manage";
}): Promise<
  | { ok: true; ownerId: string }
  | { ok: false; status: 403; reason: string; message: string }
> {
  if (isFoundationLegacyBypassEnabled()) {
    return term.ownerId === actor.id
      ? { ok: true, ownerId: actor.id }
      : {
          ok: false,
          status: 403,
          reason: "legacy_owner_mismatch",
          message: "DeckTerm capability denied",
        };
  }
  const state = await getFoundationState();

  // Canonical ownerId (plan §2, invariant §9.9): the attach/write/manage
  // authorization call below compares against this resolved id, the same
  // id terminal creation stores as ownerId. IdentityConflictError means a
  // self-heal collision: fail closed (invariant §9.1).
  let ownerId: string;
  try {
    ({ ownerId } = resolveCanonicalOwnerId(state, actor));
  } catch (err) {
    if (err instanceof IdentityConflictError) {
      writeAuditEvent(state.db, {
        actorUserId: actor.id,
        action: capability,
        resourceType: "terminal",
        resourceId: term.id,
        decision: "deny",
        reason: "identity_conflict",
      });
      return {
        ok: false,
        status: 403,
        reason: "identity_conflict",
        message: "DeckTerm identity resolution conflict",
      };
    }
    throw err;
  }

  if (!isBootstrapComplete(state)) {
    writeAuditEvent(state.db, {
      actorUserId: ownerId,
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
    actorUserId: ownerId,
    terminalId: term.id,
    capability,
  });
  writeAuditEvent(state.db, {
    actorUserId: ownerId,
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
  return { ok: true, ownerId };
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
  // B2 (§4.3, inv 17): in isolation mode every filesystem surface denies
  // `os_isolation_pending` — a mapped user's fs op must never run as the
  // service account (B4 brokers these). Checked BEFORE the legacy bypass so it
  // cannot be bypassed, though the startup gate already forbids
  // isolation × legacy-bypass coexisting.
  const isolationDeny = await denyIfOsIsolationPending(c, "files");
  if (isolationDeny) return isolationDeny;

  if (isFoundationLegacyBypassEnabled()) {
    return { ok: true };
  }

  const actor = getCurrentActor(c);
  const ownerId = actor.id;
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
    actor,
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

/**
 * B4 (§5.1/§5.3): resolve the execution context for a non-PTY fs/git/search
 * surface. Legacy ⇒ `{kind:"legacy"}` (byte-identical service-account path).
 * Isolation ⇒ brokered exec identity, or a 403 deny (mirrors
 * `resolvePtyExecutionContext`: a drift/ineligibility deny already suspended the
 * mapping in the resolver, so we run that user's revocation kill path here — Codex
 * #6 — and audit every deny).
 */
async function resolveExecFsContext(
  c: any,
  surface: string,
): Promise<
  | { ok: true; ctx: FsExecutorContext }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  const state = await getFoundationState();
  const actor = getCurrentActor(c);
  const ec = resolveExecutionContext(state.db, { actor, env: process.env });
  if (ec.kind === "legacy") return { ok: true, ctx: { kind: "legacy" } };
  if (ec.kind === "brokered") {
    return {
      ok: true,
      ctx: {
        kind: "brokered",
        uid: ec.uid,
        gid: ec.gid,
        osUsername: ec.osUsername,
      },
    };
  }
  if (ec.suspendedUserId) {
    await killUserSessions(ec.suspendedUserId, `os_mapping:${ec.reason}`);
  }
  writeAuditEvent(state.db, {
    actorUserId: actor.id,
    action: "surface.access",
    resourceType: "surface",
    resourceId: surface,
    decision: "deny",
    reason: ec.reason,
    data: { surface, osIsolation: true, actorSource: actor.source },
  });
  return {
    ok: false,
    status: 403,
    body: { error: "OS isolation denied", reason: ec.reason, surface },
  };
}

/**
 * B4 (§5.2): resolve a client path to `{root, relPath, rootId}` under the given
 * execution context, enforcing the `root.use` capability. Legacy reuses today's
 * `resolveAllowedPath` (realpath + env allowlist) + `requireFileAccess` so
 * behavior is byte-identical; brokered uses the lexical segment-boundary policy
 * (`matchGrantedRoot`, Codex #9) — no realpath, no fs touch — then the same
 * capability check. The returned `root`+`relPath` feed `getFsExecutor(ctx)`.
 */
async function resolveScopedFsPath(
  c: any,
  ctx: FsExecutorContext,
  clientPath: string,
  opts: { allowMissing?: boolean } = {},
): Promise<
  | { ok: true; root: string; relPath: string; rootId: string }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  const state = await getFoundationState();

  if (ctx.kind === "legacy") {
    const abs = await resolveAllowedPath(clientPath, opts);
    if (!abs) {
      return {
        ok: false,
        status: 403,
        body: { error: "Forbidden path", reason: "no_matching_root" },
      };
    }
    const access = await requireFileAccess(c, abs);
    if (!access.ok)
      return { ok: false, status: access.status, body: access.body };
    const rootId = resolveFoundationRootIdForPath(state, abs);
    // Legacy bypass short-circuits requireFileAccess without a rootId; fall back
    // to the whole path as its own root so the executor still targets `abs`.
    if (!rootId) return { ok: true, root: abs, relPath: "", rootId: "" };
    const rootPath = state.roots.find((r) => r.id === rootId)?.path ?? abs;
    const rel =
      abs === rootPath ? "" : abs.slice(rootPath.length).replace(/^\/+/, "");
    return { ok: true, root: rootPath, relPath: rel, rootId };
  }

  // brokered — lexical, segment-boundary containment against granted roots. Try
  // ALL containing roots longest-first until one passes root.use, so an ungranted
  // NESTED root cannot shadow a granted parent (Codex integrated #4). Only the
  // final "none authorized" outcome is a deny.
  const candidates = matchGrantedRootCandidates(
    state.roots.map((r) => r.path),
    clientPath,
  );
  if (candidates.length === 0) {
    return {
      ok: false,
      status: 403,
      body: { error: "Forbidden path", reason: "no_matching_root" },
    };
  }
  const actor = getCurrentActor(c);
  let lastDeny: { status: number; body: Record<string, unknown> } | null = null;
  for (const scoped of candidates) {
    const rootRow = state.roots.find(
      (r) => canonicalizeLexical(r.path) === scoped.root,
    );
    const rootId = rootRow?.id ?? "";
    const rootAuth = await requireFoundationCapability({
      actor,
      capability: "root.use",
      resourceType: "root",
      resourceId: rootId,
      data: { cwd: scoped.root, osIsolation: true },
    });
    if (rootAuth.ok) {
      return { ok: true, root: scoped.root, relPath: scoped.relPath, rootId };
    }
    lastDeny = { status: rootAuth.status, body: foundationGateJson(rootAuth) };
  }
  return {
    ok: false,
    status: lastDeny?.status ?? 403,
    body: lastDeny?.body ?? {
      error: "Forbidden path",
      reason: "no_matching_root",
    },
  };
}

/** B4 (Codex integrated #6): the default root for a brokered actor — their first
 *  granted root (the S6 home-root provisioning makes this their own $HOME), NOT
 *  the service account's HOME. Returns null if the actor holds no granted root. */
async function brokeredDefaultRoot(c: any): Promise<string | null> {
  const state = await getFoundationState();
  const actor = getCurrentActor(c);
  // Longest-first is arbitrary here; any granted root is a valid default. Prefer
  // a non-nested (shortest) root so the default is the broadest the actor holds.
  const roots = [...state.roots].sort((a, b) => a.path.length - b.path.length);
  for (const r of roots) {
    const auth = await requireFoundationCapability({
      actor,
      capability: "root.use",
      resourceType: "root",
      resourceId: r.id,
      data: { osIsolation: true },
    });
    if (auth.ok) return r.path;
  }
  return null;
}

/**
 * B2/B4 integration: resolve a PTY start dir for a BROKERED actor without
 * realpath. `resolveTerminalStartDir` realpaths the cwd as the service account,
 * which cannot traverse a mapped user's 0700 home — so under isolation the
 * start dir must be resolved LEXICALLY against the actor's registered roots
 * (same policy as `resolveScopedFsPath`'s brokered branch), and the broker's
 * post-drop chdir enforces the real traversal as the mapped uid. Returns a
 * canonical absolute path contained in some registered root, or null (forbidden
 * / no default root). The caller still enforces `terminal.create` + `root.use`
 * on the resolved root, so this is containment-and-canonicalization only.
 */
async function resolveBrokeredStartDir(
  c: any,
  inputCwd: string | null,
): Promise<string | null> {
  if (!inputCwd) {
    // No explicit cwd ⇒ the actor's own default (home) root, never the service
    // account's HOME (B4 Codex #6).
    return brokeredDefaultRoot(c);
  }
  // Lexical canonicalization rejects any residual `..` segment / NUL and
  // requires an absolute path — never node's `resolve`, which would collapse
  // `/home/alice/../bob` into an escape.
  const canonical = canonicalizeLexical(inputCwd);
  if (!canonical) return null;
  const state = await getFoundationState();
  const candidates = matchGrantedRootCandidates(
    state.roots.map((r) => r.path),
    canonical,
  );
  if (candidates.length === 0) return null;
  // NOTE (Codex integrated #3): lexical matching proves the STRING is under a
  // granted root, not that the resolved directory is. A symlink the mapped user
  // owns inside their root can point elsewhere and the broker's post-drop chdir
  // follows it — as the mapped uid, bound by DAC. This is intentional and
  // consistent with the B4 containment scope (security-model.md): the hard
  // guarantee is CROSS-UID isolation; intra-uid root confinement is best-effort
  // (mount-namespace/chroot is 1.1 container work), and the user already has a
  // shell they can `cd` from. fs/git/search ops ARE symlink-confined (fs-helper
  // openat2 RESOLVE_NO_SYMLINKS); only the PTY start dir is DAC-bound.
  return canonical;
}

/**
 * Early actor-validity gate for the terminal-create path (Codex integrated
 * #1/#2). Enforces identity-conflict, disabled-wins, and — under isolation —
 * actor-source trust BEFORE cwd/root resolution, so a disabled or untrusted
 * actor is denied with the correct reason and audit attribution instead of
 * being masked by a later `forbidden_root`/`no_matching_root` path deny. Legacy
 * bypass short-circuits to the raw actor id with no DB gating (byte-identical to
 * pre-isolation behavior). The subsequent capability checks still enforce the
 * grant + bootstrap; this only fixes the precedence of the resource-independent
 * denials.
 */
function preflightTerminalActor(
  state: FoundationState,
  actor: DeckTermActor,
):
  | { ok: true; ownerId: string }
  | {
      ok: false;
      reason: "identity_conflict" | "user_disabled" | "actor_source_untrusted";
      message: string;
      auditOwnerId: string;
    } {
  if (isFoundationLegacyBypassEnabled()) {
    return { ok: true, ownerId: actor.id };
  }
  let canonical: { ownerId: string; user: FoundationUser | null };
  try {
    canonical = resolveCanonicalOwnerId(state, actor);
  } catch (err) {
    if (err instanceof IdentityConflictError) {
      return {
        ok: false,
        reason: "identity_conflict",
        message: "DeckTerm identity resolution conflict",
        auditOwnerId: actor.id,
      };
    }
    throw err;
  }
  if (canonical.user?.disabled) {
    return {
      ok: false,
      reason: "user_disabled",
      message: "DeckTerm account disabled",
      auditOwnerId: canonical.ownerId,
    };
  }
  if (
    isOsIsolationEnabled(process.env) &&
    !isTrustedActorSourceForIsolation(actor.source)
  ) {
    return {
      ok: false,
      reason: "actor_source_untrusted",
      message: "OS isolation denied",
      auditOwnerId: canonical.ownerId,
    };
  }
  return { ok: true, ownerId: canonical.ownerId };
}

/** Map an `FsExecError` from the executor to the HTTP response shape B4 routes
 *  return. Broker/transient failures are 503; a busy cap is 429; the rest map to
 *  the closest 4xx. Kept centralized so every fs route is consistent. */
function fsErrorResponse(c: any, err: unknown, fallbackMsg: string): Response {
  if (err instanceof FsExecError) {
    const map: Record<string, number> = {
      not_found: 404,
      too_large: 413,
      not_regular: 400,
      not_owner: 403,
      escape_denied: 403,
      exists: 409,
      permission: 403,
      bad_request: 400,
      isolation_busy: 429,
      broker_unavailable: 503,
      io_error: 400,
    };
    const status = map[err.code] ?? 400;
    return c.json({ error: fallbackMsg, reason: err.code }, status as any);
  }
  return c.json({ error: fallbackMsg }, 400);
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

  // B6 D-B6-1: output bytes are no longer persisted to terminal_events (the
  // per-chunk INSERT was the root cause of unbounded DB growth); the capped
  // in-memory scrollback below + tmux capture-pane are the replay sources.

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
  // B3-S3: exposes the resolved canonical role/disabled state for the admin
  // UI's gate (plan §7 Codex #15). Status is informational, so an
  // IdentityConflictError (self-heal collision) reports null rather than
  // failing the whole endpoint — the conflict itself is fail-closed on every
  // capability-checking path, this is just "do we know who you are yet."
  let user: { id: string; role: FoundationUserRole; disabled: boolean } | null =
    null;
  try {
    const canonical = resolveCanonicalOwnerId(state, actor);
    if (canonical.user) {
      user = {
        id: canonical.user.id,
        role: canonical.user.role,
        disabled: canonical.user.disabled,
      };
    }
  } catch (err) {
    if (!(err instanceof IdentityConflictError)) throw err;
  }
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
      user,
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
    recentTools: term.recentTools,
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
  const rateVerdict = rateLimitState.canCreate(ownerId);
  if (rateVerdict === "global_limit") {
    return {
      status: 429 as const,
      body: { error: "Server is busy creating terminals. Try again later." },
    };
  }
  if (rateVerdict === "user_limit") {
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
  // Brokered terminals kill through their per-uid backend (design §5); legacy
  // uses the shared tmux backend.
  backendOverride?: TerminalBackend,
) {
  const backend = backendOverride ?? tmuxTerminalBackend;
  if (!TMUX_BACKEND || !backend || !sessionName) return false;
  if (hasOtherTerminalForSession(sessionName, excludedTerminalId)) {
    debug(
      `[tmux] Preserving shared session ${sessionName} for other attached DeckTerm views`,
    );
    return false;
  }

  debug(`[tmux] Killing session ${sessionName}`);
  try {
    await backend.kill(sessionName);
  } catch (err) {
    debug(`[tmux] kill-session failed for ${sessionName}`, err);
    return false;
  }
  return true;
}

// -----------------------------------------------------------------------
// B3-S3 revocation kill primitive (plan §5, invariant §9.7).
// -----------------------------------------------------------------------

/**
 * Fix 4 (invariant §9.7): runs the canonical single-terminal kill sequence
 * (the same steps as `DELETE /api/terminals/:id` above) with EACH step in
 * its own try/catch. A failing step (e.g. a process that already exited, or
 * an already-closed socket) must never skip the steps after it — every
 * subsequent cleanup step still runs regardless of an earlier failure, and
 * the audit write failing must not abort the kill steps that already ran.
 * Shared by `killOwnedTerminalsFor`'s sweep loop and the post-registration
 * single-terminal kill on a disable race (Fix 2, POST /api/terminals).
 */
async function killSingleTerminal(
  state: FoundationState,
  term: Terminal,
  reason: string,
): Promise<void> {
  try {
    markTerminalSessionEnded(state.db, term.id);
  } catch (err) {
    debug(`[revocation] markTerminalSessionEnded failed for ${term.id}`, err);
  }
  try {
    closeTerminalSockets(term.id, reason);
  } catch (err) {
    debug(`[revocation] closeTerminalSockets failed for ${term.id}`, err);
  }
  try {
    removeTerminalState(term.id);
  } catch (err) {
    debug(`[revocation] removeTerminalState failed for ${term.id}`, err);
  }
  try {
    await killTmuxSessionIfLast(term.sessionName, undefined, term.backend);
  } catch (err) {
    debug(`[revocation] killTmuxSessionIfLast failed for ${term.id}`, err);
  }
  try {
    term.proc.kill();
  } catch (err) {
    debug(`[revocation] proc.kill failed for ${term.id}`, err);
  }
  try {
    term.terminal.close();
  } catch (err) {
    debug(`[revocation] terminal.close failed for ${term.id}`, err);
  }
  try {
    writeAuditEvent(state.db, {
      actorUserId: term.ownerId,
      action: "terminal.revoked",
      resourceType: "terminal",
      resourceId: term.id,
      decision: "allow",
      reason,
    });
  } catch (err) {
    debug(`[revocation] audit write failed for ${term.id}`, err);
  }
}

/** Kills every live terminal owned by `userId`, running the same sequence as
 * the canonical `DELETE /api/terminals/:id` handler above (server.ts
 * `app.delete("/api/terminals/:id", ...)`. */
async function killOwnedTerminalsFor(
  state: FoundationState,
  userId: string,
  reason: string,
): Promise<void> {
  const owned = [...terminals.values()].filter(
    (term) => term.ownerId === userId,
  );
  for (const term of owned) {
    await killSingleTerminal(state, term, reason);
  }
}

/** Closes every live socket authenticated as `userId`, regardless of who owns
 * the terminal it is attached to — the general sweep used by full
 * revocation. `closeUserForeignAttachments` below is the conservative subset
 * that skips the user's own owned terminals. */
function closeAllSocketsFor(
  state: FoundationState,
  userId: string,
  reason: string,
): void {
  for (const [terminalId, sockets] of terminalSockets.entries()) {
    for (const ws of sockets) {
      if (ws.data.actorUserId !== userId) continue;
      // Enforcement (close) before audit (Fix 4): the audit write is
      // best-effort and must never abort the sweep — a failed audit row for
      // one socket must not skip closing the rest.
      try {
        ws.close();
      } catch {
        // ignore
      }
      try {
        writeAuditEvent(state.db, {
          actorUserId: userId,
          action: "terminal.revoked",
          resourceType: "terminal",
          resourceId: terminalId,
          decision: "allow",
          reason,
        });
      } catch (err) {
        debug(`[revocation] audit write failed for ${terminalId}`, err);
      }
    }
  }
}

/**
 * The full revocation kill primitive (plan §5) — used when a user is
 * disabled. Enumerates owned terminals and runs the canonical DELETE
 * sequence on each, then sweeps every `terminalSockets` set closing any
 * socket authenticated as this user (a disabled user attached to someone
 * else's terminal). Runs the whole thing a **second time** (Codex #8,
 * invariant §9.7): the disabling mutation already committed before this
 * runs, but a terminal create/attach that raced the mutation could still be
 * in flight — the pre-side-effect `disabled` re-check on create/attach/WS
 * upgrade (S2) closes that race for new attempts, and this second sweep
 * catches anything that slipped through between the mutation commit and the
 * first sweep. Synchronous, in-process — well under the 5s target.
 */
async function killUserSessions(userId: string, reason: string): Promise<void> {
  const state = await getFoundationState();
  await killOwnedTerminalsFor(state, userId, reason);
  closeAllSocketsFor(state, userId, reason);
  await killOwnedTerminalsFor(state, userId, reason);
  closeAllSocketsFor(state, userId, reason);
}

/**
 * The conservative revocation subset (plan §5, Codex #6) — used for
 * `DELETE /api/grants/:id` and admin->member demotion. Only closes this
 * user's attachments to terminals owned by SOMEONE ELSE (those attachments
 * were authorized by the grant/role bundle that just changed); terminals the
 * user owns survive, since the owner short-circuit still authorizes them
 * regardless of role/grants.
 */
async function closeUserForeignAttachments(
  userId: string,
  reason: string,
): Promise<void> {
  const state = await getFoundationState();
  for (const [terminalId, sockets] of terminalSockets.entries()) {
    const term = terminals.get(terminalId);
    if (term && term.ownerId === userId) continue;
    for (const ws of sockets) {
      if (ws.data.actorUserId !== userId) continue;
      // Enforcement (close) before audit (Fix 4): the audit write is
      // best-effort and must never abort the sweep.
      try {
        ws.close();
      } catch {
        // ignore
      }
      try {
        writeAuditEvent(state.db, {
          actorUserId: userId,
          action: "terminal.revoked",
          resourceType: "terminal",
          resourceId: terminalId,
          decision: "allow",
          reason,
        });
      } catch (err) {
        debug(`[revocation] audit write failed for ${terminalId}`, err);
      }
    }
  }
}

/**
 * Fix 2+3(b) (invariant §9.2/§9.7): re-validates a just-opened terminal
 * WebSocket AFTER registration (the `open()` websocket handler adds it to
 * `terminalSockets` before this runs). The pre-upgrade authorization check
 * and the socket actually opening are not atomic — a disable, grant
 * revocation, or role demotion can land in the interleave between them.
 * Extracted as a standalone helper (rather than inlined in `open()`) so it
 * is unit-testable without a real WebSocket connection. Skipped entirely
 * under legacy bypass (invariant §9.10 — those envs have no DB gating at
 * all, zero behavior change).
 */
export async function validateLiveSocket(
  state: FoundationState,
  wsData: WsData,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (isFoundationLegacyBypassEnabled()) return { ok: true };

  const user = getFoundationUserById(state.db, wsData.actorUserId);
  if (user?.disabled) {
    return { ok: false, reason: "user_disabled_postcheck" };
  }

  // Foreign attacher (not the terminal's owner): re-run the same
  // authorization decision the pre-upgrade gate used. If the grant or role
  // bundle that authorized this attach was revoked/demoted in the
  // interleave window, this denies and the caller closes the socket.
  if (wsData.actorUserId !== wsData.ownerId) {
    const decision = authorizeTerminalSessionAccess(state.db, {
      actorUserId: wsData.actorUserId,
      terminalId: wsData.terminalId,
      capability: "terminal.attach",
    });
    if (!decision.allow) {
      return { ok: false, reason: "grant_revoked_postcheck" };
    }
  }

  return { ok: true };
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
  if (!term.tmuxPipePath) return "";
  // Brokered terminals read their fd-safe spool via the per-uid backend; legacy
  // uses the shared tmux backend.
  const backend =
    (term.backend as BrokeredTmuxBackend | undefined) ?? tmuxTerminalBackend;
  if (!backend) return "";
  const delta = await backend.readPipeDelta(
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
    // Best-effort metadata delta replay (B6 D-B6-1): `output` events are no
    // longer persisted, so `lastEventId` only replays low-volume `state`
    // events and must NEVER suppress the capture/scrollback replay below —
    // screen content always comes from capture, not the event log.
    if (ws.data.type === "terminal" && ws.data.lastEventId !== null) {
      const state = await getFoundationState();
      const events = listTerminalEventsAfter(
        state.db,
        terminalId,
        ws.data.lastEventId,
        { kinds: ["state"] },
      );
      for (const ev of events) {
        if (ev.kind === "state" && ev.dataJson) {
          ws.send(JSON.stringify({ type: "terminal_state", ...ev.dataJson }));
        }
      }
      if (events.length > 0) {
        debug(
          `[reconnect] Delta-replayed ${events.length} state events after ${ws.data.lastEventId} for ${terminalId}`,
        );
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
  exec,
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
  /** B2: when set, spawn the PTY through the broker as this mapped uid. */
  exec?: BrokeredExecContext;
}): Promise<Terminal> {
  const terminal = createTerminalHandle(id, cols, rows);
  let activeSessionName = sessionName;
  // Brokered context selects a per-uid backend; legacy uses the shared one
  // (invariant §7.1 — absent exec ⇒ byte-identical legacy path).
  const backend: TerminalBackend = exec
    ? backendForExec(exec)
    : terminalBackend;

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
    const backendSession = await backend.createSession(
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
  const attachResult = await backend.attach(attachSessionName, {
    cwd,
    cols,
    rows,
    terminal,
    waitForClient: TMUX_BACKEND,
    exec,
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
    recentTools: [],
    toolRate: { windowStart: 0, count: 0 },
    shellIntegrationCarry: "",
    lastTmuxCapture: initialScrollback,
    tmuxPipePath,
    tmuxPipeOffset,
    exec,
    backend: exec ? backend : undefined,
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
  exec,
}: {
  cwd: string;
  cols?: number;
  rows?: number;
  ownerId: string;
  ownerEmail: string;
  /** B2: brokered execution context (mapped uid) when isolation is active. */
  exec?: BrokeredExecContext;
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
    exec,
  });
}

/**
 * B2 (§4.3, invariant §7.17): surfaces not yet brokered (files/git/search/
 * tasks) must NOT run as the service account in isolation mode — B4 lifts this
 * per-surface later. Returns a 403 `os_isolation_pending` deny for EVERY actor
 * when isolation is on, else null (byte-identical legacy path). Every deny is
 * recorded in the persisted aggregation counter; a full audit row is written on
 * the first hit and periodically thereafter so evidence survives without
 * unbounded rows under probing (Codex #11 / inv 14).
 */
async function denyIfOsIsolationPending(
  c: Parameters<typeof getCurrentActor>[0],
  surface: string,
  requestId?: string | null,
): Promise<{ ok: false; status: 403; body: Record<string, unknown> } | null> {
  // Flag check FIRST so legacy mode never even resolves the actor — keeps the
  // legacy path byte-identical (no new getCurrentActor call, no DB touch).
  if (!isOsIsolationEnabled(process.env)) return null;
  const actor = getCurrentActor(c);
  const state = await getFoundationState();
  const count = recordIsolationDeny(state.db, {
    actorUserId: actor.id,
    actorSource: actor.source,
    surface,
    reason: "os_isolation_pending",
    requestId: requestId ?? null,
  });
  // First occurrence + every 100th thereafter get a full audit row.
  if (count === 1 || count % 100 === 0) {
    writeAuditEvent(state.db, {
      actorUserId: actor.id,
      action: "surface.access",
      resourceType: "surface",
      resourceId: surface,
      decision: "deny",
      reason: "os_isolation_pending",
      data: { surface, actorSource: actor.source, count },
    });
  }
  return {
    ok: false,
    status: 403,
    body: {
      error: "OS isolation pending",
      reason: "os_isolation_pending",
      surface,
    },
  };
}

/**
 * B4-S6: a PERMANENT isolation deny for surfaces that will not be brokered in
 * 1.0 (task runner: workspaces/worktrees live under the service-owned state dir,
 * which mapped users cannot write and B2 eligibility forbids accounts that can).
 * Distinct from `os_isolation_pending` (which meant "brokered later"). Every deny
 * is audited via the persisted aggregation counter so evidence survives probing.
 */
async function denyIfOsIsolationUnsupported(
  c: Parameters<typeof getCurrentActor>[0],
  surface: string,
  requestId?: string | null,
): Promise<{ ok: false; status: 403; body: Record<string, unknown> } | null> {
  if (!isOsIsolationEnabled(process.env)) return null;
  const actor = getCurrentActor(c);
  const state = await getFoundationState();
  const count = recordIsolationDeny(state.db, {
    actorUserId: actor.id,
    actorSource: actor.source,
    surface,
    reason: "os_isolation_unsupported",
    requestId: requestId ?? null,
  });
  if (count === 1 || count % 100 === 0) {
    writeAuditEvent(state.db, {
      actorUserId: actor.id,
      action: "surface.access",
      resourceType: "surface",
      resourceId: surface,
      decision: "deny",
      reason: "os_isolation_unsupported",
      data: { surface, actorSource: actor.source, count },
    });
  }
  return {
    ok: false,
    status: 403,
    body: {
      error: "Surface unavailable under OS isolation",
      reason: "os_isolation_unsupported",
      surface,
    },
  };
}

/** Loopback bind targets (B2 §4.4.1): the tunnel fail-closed guard treats these
 *  as safe because only local processes can reach them. */
function isLoopbackHost(host: string): boolean {
  const h = (host || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h === "::1" ||
    h === "0:0:0:0:0:0:0:1" ||
    /^127\./.test(h)
  );
}

/**
 * B2 (§4.3): resolve the execution context for a PTY surface and, on deny,
 * produce the 403 body + audit + revocation. Returns either the brokered exec
 * context to spawn with (undefined ⇒ legacy), or a `deny` with the JSON to
 * return. A drift/ineligibility deny already suspended the mapping in the
 * resolver; we run that user's revocation kill path here (Codex #6).
 */
async function resolvePtyExecutionContext(
  state: FoundationState,
  actor: DeckTermActor,
  ownerId: string,
  cwd: string,
): Promise<
  | { ok: true; exec?: BrokeredExecContext }
  | { ok: false; status: 403; body: Record<string, unknown> }
> {
  const ctx: ExecutionContext = resolveExecutionContext(state.db, {
    actor,
    env: process.env,
  });
  if (ctx.kind === "legacy") return { ok: true };
  if (ctx.kind === "brokered") {
    return {
      ok: true,
      exec: { uid: ctx.uid, gid: ctx.gid, osUsername: ctx.osUsername },
    };
  }
  // deny — the mapping may have just been suspended; tear down live sessions.
  if (ctx.suspendedUserId) {
    await killUserSessions(ctx.suspendedUserId, `os_mapping:${ctx.reason}`);
  }
  writeAuditEvent(state.db, {
    actorUserId: ownerId,
    action: "terminal.create",
    resourceType: "terminal",
    decision: "deny",
    reason: ctx.reason,
    data: { cwd, osIsolation: true, actorSource: actor.source },
  });
  return {
    ok: false,
    status: 403,
    body: { error: "OS isolation denied", reason: ctx.reason },
  };
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

  // Audit trail for automatic task transitions (security invariant 3: the
  // verdict-processing result is auditable). Best-effort — an audit failure
  // must not break the transition itself.
  const auditTaskTransition = (
    ownerId: string,
    action: string,
    terminalId: string,
    task: {
      id: string;
      status: string;
      processedVerdictAtRound: number | null;
    },
  ) => {
    getFoundationState()
      .then((state) => {
        writeAuditEvent(state.db, {
          actorUserId: ownerId,
          action,
          resourceType: "task",
          resourceId: task.id,
          decision: "allow",
          data: {
            terminalId,
            status: task.status,
            processedVerdictAtRound: task.processedVerdictAtRound,
          },
        });
      })
      .catch((err) => debug("Task transition audit failed:", err));
  };

  // Advance worker/judge tasks when their agent terminal exits.
  onTerminalExit((ownerId, terminalId) => {
    taskRunner
      .handleTerminalExit(ownerId, terminalId)
      .then((task) => {
        if (task) {
          auditTaskTransition(ownerId, "task.terminal-exit", terminalId, task);
        }
      })
      .catch((err) => debug("Task terminal-exit sync failed:", err));
  });

  // Primary judge-verdict trigger: the judge agent finished while its
  // terminal keeps running (persistent shell). The runner enforces the
  // provider-matched judge-terminal edge + per-round verdict identity.
  setAgentDoneBridge((ownerId, terminalId, agentName) => {
    taskRunner
      .handleJudgeCompletion(ownerId, terminalId, agentName)
      .then((task) => {
        if (task) {
          auditTaskTransition(
            ownerId,
            "task.judge-completion",
            terminalId,
            task,
          );
        }
      })
      .catch((err) => debug("Task judge-completion sync failed:", err));
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

  // ---------------------------------------------------------------------
  // B3-S3 admin API: user provisioning, roles, revocation (plan §4).
  // requireRole gates every route below — no legacy-bypass, no edge-tunnel
  // allow path (invariant §9.5). Every attempt is audited by the gate; route
  // bodies additionally audit business-validation denials and the mutation
  // outcome under the same `action` name.
  // ---------------------------------------------------------------------

  app.get("/api/users", async (c) => {
    const gate = await requireRole(c, ["owner", "admin"], "users.list");
    if (!gate.ok) return c.json(gate.body, gate.status as never);

    const state = await getFoundationState();
    const terminalCounts = new Map<string, number>();
    for (const term of terminals.values()) {
      terminalCounts.set(
        term.ownerId,
        (terminalCounts.get(term.ownerId) || 0) + 1,
      );
    }
    const users = listFoundationUsers(state.db).map((user) => ({
      ...user,
      liveTerminalCount: terminalCounts.get(user.id) || 0,
    }));
    return c.json({ users });
  });

  app.post("/api/users", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const requestedRole =
      body.role === "admin"
        ? "admin"
        : body.role === "member"
          ? "member"
          : null;
    // Creating an 'admin' requires owner (plan §4/invariant §9.4); an invalid
    // role falls back to the looser owner|admin gate so business validation
    // (not the gate) reports "invalid_role" for a garbage role value.
    const gate = await requireRole(
      c,
      requestedRole === "admin" ? ["owner"] : ["owner", "admin"],
      "users.create",
      { role: body.role },
    );
    if (!gate.ok) return c.json(gate.body, gate.status as never);

    const state = await getFoundationState();
    const provider =
      typeof body.provider === "string" ? body.provider.trim() : "";
    const subject = typeof body.subject === "string" ? body.subject.trim() : "";
    const issuer = typeof body.issuer === "string" ? body.issuer.trim() : "";
    const email =
      typeof body.email === "string" && body.email.trim()
        ? body.email.trim()
        : null;
    const displayName =
      typeof body.displayName === "string" && body.displayName.trim()
        ? body.displayName.trim()
        : null;

    const deny = (reason: string, status: 400 | 409 = 400) => {
      writeAuditEvent(state.db, {
        actorUserId: gate.ownerId,
        action: "users.create",
        resourceType: "user",
        resourceId: null,
        decision: "deny",
        reason,
        data: { provider, issuer, subject, role: body.role },
      });
      return c.json({ error: reason, reason }, status);
    };

    // Provider 'oidc' is rejected until C1 wires real OIDC identity
    // resolution; any other non-cloudflare_access provider is rejected the
    // same way (Codex #11).
    if (provider !== "cloudflare_access") {
      return deny("provider_not_supported");
    }
    if (!subject) {
      return deny("subject_required");
    }
    const configuredIssuer = process.env.CF_ACCESS_TEAM_NAME?.trim() || "";
    if (!configuredIssuer) {
      return deny("issuer_not_configured");
    }
    if (!issuer || issuer !== configuredIssuer) {
      return deny("issuer_mismatch");
    }
    if (!requestedRole) {
      return deny("invalid_role");
    }

    try {
      const created = state.db.transaction(() => {
        const { user } = createInvitedUser(state.db, {
          provider,
          issuer,
          subject,
          email,
          displayName,
          role: requestedRole,
        });
        writeAuditEvent(state.db, {
          actorUserId: gate.ownerId,
          action: "users.create",
          resourceType: "user",
          resourceId: user.id,
          decision: "allow",
          reason: "ok",
          data: { provider, issuer, subject, role: requestedRole },
        });
        return user;
      })();
      return c.json({ user: created });
    } catch (err) {
      if (err instanceof IdentityConflictError) {
        return deny("identity_exists", 409);
      }
      throw err;
    }
  });

  app.patch("/api/users/:id", async (c) => {
    const targetId = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const gate = await requireRole(c, ["owner", "admin"], "users.update", {
      targetId,
      role: body.role,
      disabled: body.disabled,
    });
    if (!gate.ok) return c.json(gate.body, gate.status as never);

    const state = await getFoundationState();
    const deny = (reason: string, status: 400 | 403 | 404 = 400) => {
      writeAuditEvent(state.db, {
        actorUserId: gate.ownerId,
        action: "users.update",
        resourceType: "user",
        resourceId: targetId,
        decision: "deny",
        reason,
        data: { role: body.role, disabled: body.disabled },
      });
      return c.json({ error: reason, reason }, status);
    };

    const target = getFoundationUserById(state.db, targetId);
    if (!target) return deny("user_not_found", 404);

    const wantsRole = typeof body.role === "string" ? body.role : null;
    const wantsDisabled =
      typeof body.disabled === "boolean" ? body.disabled : null;
    if (wantsRole === null && wantsDisabled === null) {
      return deny("no_changes");
    }
    if (
      wantsRole !== null &&
      !["owner", "admin", "member"].includes(wantsRole)
    ) {
      return deny("invalid_role");
    }
    if (wantsRole === "owner") {
      // Owner cannot be created/assigned via the API (invariant §9.4) — not
      // even by the owner themselves.
      return deny("invalid_role");
    }

    // Owner immutable via API — for BOTH role and disabled changes, checked
    // before the admin-surface check below (invariant §9.4).
    if (target.role === "owner") {
      return deny("owner_immutable", 403);
    }

    const touchesAdminSurface =
      target.role === "admin" || wantsRole === "admin";
    if (touchesAdminSurface && gate.user.role !== "owner") {
      return deny("owner_required", 403);
    }

    const wasAdmin = target.role === "admin";

    const updated = state.db.transaction(() => {
      let next = target;
      if (wantsRole !== null && wantsRole !== target.role) {
        next = setUserRole(state.db, {
          userId: targetId,
          role: wantsRole as FoundationUserRole,
        });
        if (wantsRole === "admin") {
          // Fix 7: this route is already owner-gated for any target that
          // touches the admin surface (touchesAdminSurface check above), so
          // a promotion here is always an owner-approved decision — it must
          // not leave the target in the unreviewed-admin state the §1.6
          // startup gate rejects. Mark reviewed in the same transaction as
          // the role change.
          markUserReviewed(state.db, { userId: targetId });
          next = getFoundationUserById(state.db, targetId) ?? next;
        }
      }
      if (wantsDisabled !== null && wantsDisabled !== target.disabled) {
        next = setUserDisabled(state.db, {
          userId: targetId,
          disabled: wantsDisabled,
        });
      }
      writeAuditEvent(state.db, {
        actorUserId: gate.ownerId,
        action: "users.update",
        resourceType: "user",
        resourceId: targetId,
        decision: "allow",
        reason: "ok",
        data: { role: wantsRole, disabled: wantsDisabled },
      });
      return next;
    })();

    // The kill primitive runs AFTER the transaction commits (plan §5.1):
    // state before kill.
    if (wantsDisabled === true) {
      await killUserSessions(targetId, "user_disabled");
    } else if (wasAdmin && wantsRole === "member") {
      await closeUserForeignAttachments(targetId, "role_demoted");
    }

    return c.json({ user: updated });
  });

  app.post("/api/users/:id/review", async (c) => {
    const targetId = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const decision = typeof body.decision === "string" ? body.decision : "";
    const gate = await requireRole(c, ["owner"], "users.review", {
      targetId,
      decision,
    });
    if (!gate.ok) return c.json(gate.body, gate.status as never);

    const state = await getFoundationState();
    const deny = (reason: string, status: 400 | 403 | 404 = 400) => {
      writeAuditEvent(state.db, {
        actorUserId: gate.ownerId,
        action: "users.review",
        resourceType: "user",
        resourceId: targetId,
        decision: "deny",
        reason,
        data: { decision },
      });
      return c.json({ error: reason, reason }, status);
    };

    const target = getFoundationUserById(state.db, targetId);
    if (!target) return deny("user_not_found", 404);
    if (target.role === "owner") {
      return deny("owner_immutable", 403);
    }

    const VALID_DECISIONS = [
      "keep_admin",
      "make_member",
      "disable",
      "revoke_wildcards",
    ] as const;
    if (!(VALID_DECISIONS as readonly string[]).includes(decision)) {
      return deny("invalid_decision");
    }

    // All four decisions delete the target's wildcard grant rows in the same
    // transaction (plan §4 Codex #12/#13) — 'keep_admin' relies on the
    // implicit role bundle from here on, not materialized wildcards.
    const updated = state.db.transaction(() => {
      state.db
        .query(
          `DELETE FROM scoped_grants
           WHERE user_id = ? AND (resource_type = '*' OR resource_id = '*')`,
        )
        .run(targetId);

      if (decision === "make_member") {
        setUserRole(state.db, { userId: targetId, role: "member" });
      } else if (decision === "disable") {
        setUserDisabled(state.db, { userId: targetId, disabled: true });
      }

      markUserReviewed(state.db, { userId: targetId });

      writeAuditEvent(state.db, {
        actorUserId: gate.ownerId,
        action: "users.review",
        resourceType: "user",
        resourceId: targetId,
        decision: "allow",
        reason: decision,
        data: { decision },
      });

      return getFoundationUserById(state.db, targetId);
    })();

    if (decision === "disable") {
      await killUserSessions(targetId, "user_disabled");
    } else if (decision === "make_member") {
      await closeUserForeignAttachments(targetId, "role_demoted");
    }

    return c.json({ user: updated });
  });

  app.post("/api/grants/review", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const principalId =
      typeof body.principalId === "string" ? body.principalId.trim() : "";
    const decision = typeof body.decision === "string" ? body.decision : "";
    const gate = await requireRole(c, ["owner"], "grants.review", {
      targetId: principalId,
      decision,
    });
    if (!gate.ok) return c.json(gate.body, gate.status as never);

    const state = await getFoundationState();
    const deny = (reason: string, status: 400 | 403 | 404 = 400) => {
      writeAuditEvent(state.db, {
        actorUserId: gate.ownerId,
        action: "grants.review",
        resourceType: "grant",
        resourceId: principalId || null,
        decision: "deny",
        reason,
        data: { principalId, decision },
      });
      return c.json({ error: reason, reason }, status);
    };

    if (!principalId) return deny("principal_id_required");
    if (!["revoke_wildcards", "disable"].includes(decision)) {
      return deny("invalid_decision");
    }

    // Orphan principals only: a scoped_grants.user_id with wildcard rows but
    // no users row. If a users row exists, /api/users/:id/review is the
    // correct path (Codex #3/#13).
    const existingUser = getFoundationUserById(state.db, principalId);
    if (existingUser) {
      return deny("not_orphan");
    }

    // Fix 6: principalId must actually appear in listWildcardGrantPrincipals
    // with hasUserRow === false — i.e. it must genuinely hold an orphaned
    // wildcard grant row. Without this, the "not_orphan" check above is the
    // ONLY gate, and it only rejects ids that already have a users row —
    // any other arbitrary id (a typo, a guessed id, anything) would sail
    // through to `disableOrphanGrantPrincipal`, which creates an
    // identity-less users row for it. This closes that path.
    const isOrphanWildcardPrincipal = listWildcardGrantPrincipals(
      state.db,
    ).some(
      (principal) => principal.userId === principalId && !principal.hasUserRow,
    );
    if (!isOrphanWildcardPrincipal) {
      return deny("not_wildcard_principal");
    }

    const updated = state.db.transaction(() => {
      state.db
        .query(
          `DELETE FROM scoped_grants
           WHERE user_id = ? AND (resource_type = '*' OR resource_id = '*')`,
        )
        .run(principalId);

      let user: FoundationUser | null = null;
      if (decision === "disable") {
        user = disableOrphanGrantPrincipal(state.db, { userId: principalId });
      }

      writeAuditEvent(state.db, {
        actorUserId: gate.ownerId,
        action: "grants.review",
        resourceType: "grant",
        resourceId: principalId,
        decision: "allow",
        reason: decision,
        data: { principalId, decision },
      });

      return user;
    })();

    if (decision === "disable") {
      await killUserSessions(principalId, "user_disabled");
    } else {
      await closeUserForeignAttachments(principalId, "grant_revoked");
    }

    return c.json({ user: updated });
  });

  app.get("/api/grants", async (c) => {
    const userId = c.req.query("userId") || undefined;
    const gate = await requireRole(c, ["owner", "admin"], "grants.list", {
      targetId: userId,
    });
    if (!gate.ok) return c.json(gate.body, gate.status as never);

    const state = await getFoundationState();
    const grants = listScopedGrants(state.db, userId ? { userId } : undefined);
    return c.json({ grants });
  });

  app.post("/api/grants", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    const capability =
      typeof body.capability === "string" ? body.capability : "";
    const resourceType =
      typeof body.resourceType === "string" ? body.resourceType.trim() : "";
    const resourceId =
      typeof body.resourceId === "string" ? body.resourceId.trim() : "";

    const gate = await requireRole(c, ["owner", "admin"], "grants.create", {
      targetId: userId,
      capability,
      resourceType,
      resourceId,
    });
    if (!gate.ok) return c.json(gate.body, gate.status as never);

    const state = await getFoundationState();
    const deny = (reason: string, status: 400 | 403 | 404 = 400) => {
      writeAuditEvent(state.db, {
        actorUserId: gate.ownerId,
        action: "grants.create",
        resourceType: "grant",
        resourceId: null,
        decision: "deny",
        reason,
        data: { userId, capability, resourceType, resourceId },
      });
      return c.json({ error: reason, reason }, status);
    };

    // Invariant §9.3: no API path may create a wildcard grant row for ANY
    // target, not even the owner — implicit role bundles are the only
    // wildcard mechanism from B3 on. Missing fields are rejected the same
    // way (they can never resolve to a valid scoped grant).
    if (
      !resourceType ||
      !resourceId ||
      resourceType === "*" ||
      resourceId === "*"
    ) {
      return deny("wildcard_forbidden");
    }

    const target = getFoundationUserById(state.db, userId);
    if (!target) return deny("user_not_found", 404);
    if (
      (target.role === "admin" || target.role === "owner") &&
      gate.user.role !== "owner"
    ) {
      return deny("owner_required", 403);
    }

    const VALID_CAPS: ScopedGrantCapability[] = [
      "terminal.create",
      "terminal.attach",
      "terminal.write",
      "terminal.manage",
      "root.use",
    ];
    if (!VALID_CAPS.includes(capability as ScopedGrantCapability)) {
      return deny("invalid_capability");
    }

    const grantId = state.db.transaction(() => {
      const id = grantScopedCapability(state.db, {
        userId,
        capability: capability as ScopedGrantCapability,
        resourceType,
        resourceId,
      });
      writeAuditEvent(state.db, {
        actorUserId: gate.ownerId,
        action: "grants.create",
        resourceType: "grant",
        resourceId: id,
        decision: "allow",
        reason: "ok",
        data: { userId, capability, resourceType, resourceId },
      });
      return id;
    })();

    return c.json({ grantId });
  });

  app.delete("/api/grants/:id", async (c) => {
    const grantId = c.req.param("id");
    const gate = await requireRole(c, ["owner", "admin"], "grants.revoke", {
      targetId: grantId,
    });
    if (!gate.ok) return c.json(gate.body, gate.status as never);

    const state = await getFoundationState();
    const deny = (reason: string, status: 400 | 403 | 404 = 400) => {
      writeAuditEvent(state.db, {
        actorUserId: gate.ownerId,
        action: "grants.revoke",
        resourceType: "grant",
        resourceId: grantId,
        decision: "deny",
        reason,
        data: {},
      });
      return c.json({ error: reason, reason }, status);
    };

    const grant = getScopedGrantById(state.db, grantId);
    if (!grant) return deny("grant_not_found", 404);

    const target = getFoundationUserById(state.db, grant.userId);
    if (
      target &&
      (target.role === "admin" || target.role === "owner") &&
      gate.user.role !== "owner"
    ) {
      return deny("owner_required", 403);
    }

    const revoked = state.db.transaction(() => {
      const ok = revokeScopedCapability(state.db, grantId);
      writeAuditEvent(state.db, {
        actorUserId: gate.ownerId,
        action: "grants.revoke",
        resourceType: "grant",
        resourceId: grantId,
        decision: "allow",
        reason: "ok",
        data: { userId: grant.userId },
      });
      return ok;
    })();

    // Conservative revocation subset (plan §5, Codex #6): close the target's
    // foreign-terminal attachments; owned terminals survive.
    await closeUserForeignAttachments(grant.userId, "grant_revoked");

    return c.json({ ok: revoked });
  });

  // ---------------------------------------------------------------------
  // B2 (§4.3): OS-mapping owner API. Owner-only via requireRole (no legacy /
  // edge-tunnel bypass). The client never supplies uid/gid — they are resolved
  // server-side from the username via getent, validated by the same eligibility
  // policy the broker independently re-checks (invariant §7.2/§7.5). Every call
  // is audited by the gate; bodies audit business denials + the outcome.
  // ---------------------------------------------------------------------

  function osMappingProtectedPaths(): string[] {
    const stateDir =
      process.env.DECKTERM_STATE_DIR ||
      `${process.env.HOME || "/home/deploy"}/.deckterm`;
    return [
      stateDir,
      "/usr/local/lib/deckterm/deckterm-broker",
      "/etc/deckterm",
      "/etc/deckterm/broker.json",
      "/etc/sudoers.d/deckterm-broker",
    ];
  }

  app.get("/api/os-mappings", async (c) => {
    const gate = await requireRole(c, ["owner"], "os_mapping.list");
    if (!gate.ok) return c.json(gate.body, gate.status as never);
    const state = await getFoundationState();
    const policy = resolveEligibilityPolicy(process.env);
    const protectedPaths = osMappingProtectedPaths();
    const mappings = listOsMappings(state.db).map((m) => {
      // Live eligibility re-probe per row so the owner sees drift/ineligibility
      // before it bites at use time.
      const facts = gatherOsAccountFacts(m.osUsername, protectedPaths);
      const eligibility = evaluateOsAccountEligibility(facts, policy);
      const drift =
        !facts.exists || facts.uid !== m.osUid || facts.gid !== m.osGid;
      return {
        ...m,
        probe: {
          exists: facts.exists,
          uid: facts.uid,
          gid: facts.gid,
          drift,
          eligible: eligibility.ok,
          reason: eligibility.ok ? null : eligibility.reason,
        },
      };
    });
    return c.json({ mappings });
  });

  app.post("/api/os-mappings", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    const osUsername =
      typeof body.osUsername === "string" ? body.osUsername.trim() : "";
    const gate = await requireRole(c, ["owner"], "os_mapping.create", {
      targetId: userId,
      osUsername,
    });
    if (!gate.ok) return c.json(gate.body, gate.status as never);

    const state = await getFoundationState();
    const deny = (reason: string, status: 400 | 404 | 409 = 400) => {
      writeAuditEvent(state.db, {
        actorUserId: gate.ownerId,
        action: "os_mapping.create",
        resourceType: "user",
        resourceId: userId || null,
        decision: "deny",
        reason,
        data: { userId, osUsername },
      });
      return c.json({ error: reason, reason }, status);
    };

    if (!userId || !osUsername) return deny("missing_fields");
    if (!getFoundationUserById(state.db, userId))
      return deny("unknown_user", 404);

    // Resolve uid/gid server-side + enforce the full eligibility policy (the
    // same one the broker independently re-checks). The client never supplies
    // numeric ids (invariant §7.2).
    const facts = gatherOsAccountFacts(osUsername, osMappingProtectedPaths());
    if (!facts.exists) return deny("account_missing");
    const eligibility = evaluateOsAccountEligibility(
      facts,
      resolveEligibilityPolicy(process.env),
    );
    if (!eligibility.ok) return deny(`ineligible:${eligibility.reason}`);

    try {
      const mapping = createOsMapping(state.db, {
        userId,
        osUsername,
        osUid: facts.uid,
        osGid: facts.gid,
        createdBy: gate.ownerId,
      });
      writeAuditEvent(state.db, {
        actorUserId: gate.ownerId,
        action: "os_mapping.create",
        resourceType: "user",
        resourceId: userId,
        decision: "allow",
        data: { osUsername, osUid: facts.uid, osGid: facts.gid },
      });

      // B4-S6: give the mapped user a default root over their OWN home so the
      // brokered fs/git surfaces have a granted root to resolve against. The home
      // is eligibility-checked first (Codex #7): absolute, not /, not a shared/
      // system dir, a non-symlink directory owned by the mapped uid, not group/
      // world-writable. On failure the mapping still stands but no auto-root is
      // provisioned (owner grants one manually). Note: the grant is not auto-
      // revoked on suspend/delete — uid isolation makes a stale home-root grant
      // inert (a remapped account's uid cannot read the old home), and the
      // resolver denies any unmapped/suspended actor before a grant is consulted.
      let rootProvisioned: string | null = null;
      const home = facts.home;
      const homeEligible = (() => {
        try {
          if (!home || !home.startsWith("/") || home === "/") return false;
          if (
            osMappingProtectedPaths().some(
              (p) =>
                home === p ||
                home.startsWith(p + "/") ||
                p.startsWith(home + "/"),
            )
          )
            return false;
          if (home === "/tmp" || home.startsWith("/tmp/")) return false;
          const st = lstatSync(home);
          if (!st.isDirectory() || st.isSymbolicLink()) return false;
          if (st.uid !== facts.uid) return false;
          if (st.mode & 0o0022) return false; // group/world-writable
          return true;
        } catch {
          return false;
        }
      })();
      if (homeEligible) {
        try {
          const { rootId } = await provisionProjectRoot(
            state,
            home,
            process.env,
          );
          grantScopedCapability(state.db, {
            userId,
            capability: "root.use",
            resourceType: "root",
            resourceId: rootId,
          });
          rootProvisioned = rootId;
          writeAuditEvent(state.db, {
            actorUserId: gate.ownerId,
            action: "root.provision",
            resourceType: "root",
            resourceId: rootId,
            decision: "allow",
            data: { userId, home, osUsername },
          });
        } catch {
          rootProvisioned = null;
        }
      }
      if (!rootProvisioned) {
        writeAuditEvent(state.db, {
          actorUserId: gate.ownerId,
          action: "root.provision_skipped",
          resourceType: "user",
          resourceId: userId,
          decision: "deny",
          reason: "home_ineligible",
          data: { userId, home, osUsername },
        });
      }
      return c.json({ mapping, rootProvisioned });
    } catch (err) {
      // The active-uid partial unique index rejects a second active mapping on
      // one uid (B1 Codex #2).
      return deny("uid_already_mapped", 409);
    }
  });

  app.post("/api/os-mappings/:userId/suspend", async (c) => {
    const userId = c.req.param("userId");
    const body = await c.req.json().catch(() => ({}));
    const reason =
      typeof body.reason === "string" && body.reason.trim()
        ? body.reason.trim()
        : "owner_suspended";
    const gate = await requireRole(c, ["owner"], "os_mapping.suspend", {
      targetId: userId,
    });
    if (!gate.ok) return c.json(gate.body, gate.status as never);
    const state = await getFoundationState();
    const suspendMapping = getOsMapping(state.db, userId);
    if (!suspendMapping) {
      writeAuditEvent(state.db, {
        actorUserId: gate.ownerId,
        action: "os_mapping.suspend",
        resourceType: "user",
        resourceId: userId,
        decision: "deny",
        reason: "no_mapping",
      });
      return c.json({ error: "no_mapping", reason: "no_mapping" }, 404);
    }
    suspendOsMapping(state.db, { userId, reason });
    // Suspension synchronously tears down the user's live sessions AND the
    // per-uid tmux-server scope (Codex #6, inv 12) — no open shell survives.
    await killUserSessions(userId, `os_mapping_suspended:${reason}`);
    try {
      await brokerKill({ tmuxServerUid: suspendMapping.osUid });
    } catch (err) {
      debug(`[os-mapping] brokerKill tmux-server failed for ${userId}`, err);
    }
    writeAuditEvent(state.db, {
      actorUserId: gate.ownerId,
      action: "os_mapping.suspend",
      resourceType: "user",
      resourceId: userId,
      decision: "allow",
      reason,
    });
    return c.json({ mapping: getOsMapping(state.db, userId) });
  });

  app.post("/api/os-mappings/:userId/reactivate", async (c) => {
    const userId = c.req.param("userId");
    const gate = await requireRole(c, ["owner"], "os_mapping.reactivate", {
      targetId: userId,
    });
    if (!gate.ok) return c.json(gate.body, gate.status as never);
    const state = await getFoundationState();
    const mapping = getOsMapping(state.db, userId);
    if (!mapping) {
      writeAuditEvent(state.db, {
        actorUserId: gate.ownerId,
        action: "os_mapping.reactivate",
        resourceType: "user",
        resourceId: userId,
        decision: "deny",
        reason: "no_mapping",
      });
      return c.json({ error: "no_mapping", reason: "no_mapping" }, 404);
    }
    // Reactivation re-runs the full eligibility validation (§2 — suspension is
    // never auto-reversed).
    const facts = gatherOsAccountFacts(
      mapping.osUsername,
      osMappingProtectedPaths(),
    );
    const drift =
      !facts.exists ||
      facts.uid !== mapping.osUid ||
      facts.gid !== mapping.osGid;
    const eligibility = evaluateOsAccountEligibility(
      facts,
      resolveEligibilityPolicy(process.env),
    );
    if (drift || !eligibility.ok) {
      const reason = drift
        ? "drift"
        : `ineligible:${!eligibility.ok ? eligibility.reason : "unknown"}`;
      writeAuditEvent(state.db, {
        actorUserId: gate.ownerId,
        action: "os_mapping.reactivate",
        resourceType: "user",
        resourceId: userId,
        decision: "deny",
        reason,
      });
      return c.json({ error: "reactivate_refused", reason }, 409);
    }
    reactivateOsMapping(state.db, { userId });
    writeAuditEvent(state.db, {
      actorUserId: gate.ownerId,
      action: "os_mapping.reactivate",
      resourceType: "user",
      resourceId: userId,
      decision: "allow",
    });
    return c.json({ mapping: getOsMapping(state.db, userId) });
  });

  app.delete("/api/os-mappings/:userId", async (c) => {
    const userId = c.req.param("userId");
    const gate = await requireRole(c, ["owner"], "os_mapping.delete", {
      targetId: userId,
    });
    if (!gate.ok) return c.json(gate.body, gate.status as never);
    const state = await getFoundationState();
    const mapping = getOsMapping(state.db, userId);
    if (!mapping) {
      writeAuditEvent(state.db, {
        actorUserId: gate.ownerId,
        action: "os_mapping.delete",
        resourceType: "user",
        resourceId: userId,
        decision: "deny",
        reason: "no_mapping",
      });
      return c.json({ error: "no_mapping", reason: "no_mapping" }, 404);
    }
    // Refuse while a brokered session is still recorded active (integrated-review
    // #2): check the PERSISTED sessions, not just in-memory `terminals` (which is
    // empty after a restart while a brokered tmux server may still be alive).
    const persistedActive = state.db
      .query(
        "SELECT 1 FROM terminal_sessions WHERE actor_user_id = ? AND status = 'active' AND exec_kind = 'brokered' LIMIT 1",
      )
      .get(userId);
    if (persistedActive) {
      writeAuditEvent(state.db, {
        actorUserId: gate.ownerId,
        action: "os_mapping.delete",
        resourceType: "user",
        resourceId: userId,
        decision: "deny",
        reason: "live_brokered_sessions",
      });
      return c.json(
        { error: "live_brokered_sessions", reason: "live_brokered_sessions" },
        409,
      );
    }
    // Tear down any residual sessions BEFORE removing the mapping (Codex #6 +
    // integrated-review #2): killUserSessions + the per-uid tmux-server scope
    // need the uid, so brokerKill the server scope while we still hold it, then
    // delete the mapping.
    await killUserSessions(userId, "os_mapping_deleted");
    try {
      await brokerKill({ tmuxServerUid: mapping.osUid });
    } catch (err) {
      debug(`[os-mapping] brokerKill tmux-server failed for ${userId}`, err);
    }
    deleteOsMapping(state.db, userId);
    // Revoke the auto-provisioned home-root grant (Codex integrated #1) so a later
    // remap to a DIFFERENT unix account cannot inherit root.use over this account's
    // home. Best-effort: resolve the account's home → its project root → revoke.
    try {
      const facts = gatherOsAccountFacts(
        mapping.osUsername,
        osMappingProtectedPaths(),
      );
      const homeCanon = facts.home ? canonicalizeLexical(facts.home) : null;
      if (homeCanon) {
        const rootRow = state.roots.find(
          (r) => canonicalizeLexical(r.path) === homeCanon,
        );
        if (rootRow && revokeRootUseGrant(state.db, userId, rootRow.id)) {
          writeAuditEvent(state.db, {
            actorUserId: gate.ownerId,
            action: "root.revoke",
            resourceType: "root",
            resourceId: rootRow.id,
            decision: "allow",
            reason: "os_mapping_deleted",
            data: { userId, home: facts.home },
          });
        }
      }
    } catch (err) {
      debug(`[os-mapping] home-root grant revoke failed for ${userId}`, err);
    }
    writeAuditEvent(state.db, {
      actorUserId: gate.ownerId,
      action: "os_mapping.delete",
      resourceType: "user",
      resourceId: userId,
      decision: "allow",
    });
    return c.json({ ok: true });
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

  // S3 (Traycer patterns): enabled harnesses + availability for the task
  // form. Same auth shape as GET /api/tasks; summaries are probe results
  // (60s cached), disabled harnesses never appear.
  app.get("/api/harnesses", async (c) => {
    getCurrentUser(c);
    return c.json({ harnesses: await listHarnessSummaries() });
  });

  app.post("/api/tasks", async (c) => {
    const { ownerId } = getCurrentUser(c);
    const body = await c.req.json().catch(() => ({}));

    // B4-S6: task workspaces/worktrees live under the service-owned state dir —
    // permanently unsupported under isolation (deny BEFORE createTask touches it).
    const createDeny = await denyIfOsIsolationUnsupported(c, "tasks");
    if (createDeny) return c.json(createDeny.body, createDeny.status);

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

  // S7 (Traycer patterns): task messages. GET folds the append-only event
  // log; POST creates a user-originated message (from is ALWAYS "user" —
  // judge feedback is an internal server event, never HTTP) and attempts
  // pointer-only delivery into the task's recorded agent terminal. D1:
  // message bodies NEVER enter the PTY — only the fixed, server-built,
  // shell-inert pointer line naming the inbox file.
  app.get("/api/tasks/:id/messages", async (c) => {
    const { ownerId } = getCurrentUser(c);
    // Design invariant 1: task-MESSAGE routes carry the isolation deny on
    // both verbs (unlike the older read-only task routes) — this is a new
    // surface and inherits B4's task denial wholesale.
    const deny = await denyIfOsIsolationUnsupported(c, "tasks");
    if (deny) return c.json(deny.body, deny.status);
    try {
      const task = await taskRunner.getTask(c.req.param("id"), { ownerId });
      return c.json({
        messages: readTaskMessages(taskMessagesPath(task.taskDir)),
      });
    } catch (err) {
      return taskErrorResponse(c, err);
    }
  });

  app.post("/api/tasks/:id/messages", async (c) => {
    const { ownerId } = getCurrentUser(c);
    const deny = await denyIfOsIsolationUnsupported(c, "tasks");
    if (deny) return c.json(deny.body, deny.status);
    const body = await c.req.json().catch(() => ({}));
    try {
      // Ownership gate first: foreign/missing tasks 404 like every task route.
      const task = await taskRunner.getTask(c.req.param("id"), { ownerId });
      const to = body?.to === "worker" || body?.to === "judge" ? body.to : null;
      const sanitized =
        typeof body?.body === "string" ? sanitizeMessageBody(body.body) : "";
      if (!to || !sanitized.trim()) {
        return c.json(
          { error: "Message requires to: worker|judge and a non-empty body" },
          400,
        );
      }

      // Create + deliver under the per-task mutex so the recorded terminal
      // ids can't shift mid-sequence (serializes with start/exit/verdict).
      const result = await taskRunner.withTaskLock(task.id, async () => {
        const fresh = await taskRunner.getTask(task.id, { ownerId });
        const msgId = crypto.randomUUID();
        const at = new Date().toISOString();
        const inboxDir = taskInboxDir(fresh.taskDir);
        const inboxPath = join(inboxDir, `${msgId}.md`);
        await mkdir(inboxDir, { recursive: true });
        writeTaskFileAtomic(
          inboxPath,
          renderInboxFile({ id: msgId, from: "user", body: sanitized, at }),
        );
        // The created event must be durable BEFORE anything touches a PTY —
        // a delivered pointer naming a message the log never recorded would
        // be an unauditable injection (Codex integrated pass, HIGH).
        const createdRecorded = appendTaskMessageEvent(
          taskMessagesPath(fresh.taskDir),
          {
            type: "message-created",
            id: msgId,
            at,
            from: "user",
            to,
            body: sanitized,
          },
        );
        if (!createdRecorded) {
          return {
            msgId,
            to,
            delivered: false,
            reason: "event_log_failed",
            recorded: false,
            targetTerminalId: null as string | null,
            bodyBytes: Buffer.byteLength(sanitized, "utf8"),
            taskDir: fresh.taskDir,
          };
        }

        // Target provenance: terminal ids come from the task record ONLY.
        const targetTerminalId =
          to === "worker" ? fresh.terminalId : fresh.judgeTerminalId;
        const expectedAgent =
          to === "worker" ? fresh.workerProvider : fresh.judgeProvider;
        const roleActive =
          to === "worker"
            ? fresh.status === "worker-running"
            : fresh.status === "judge-running";
        const target = targetTerminalId
          ? terminals.get(targetTerminalId)
          : undefined;
        let delivered = false;
        let reason: string | null = null;
        if (!roleActive) {
          // A recorded terminal id can outlive its phase (an old judge
          // terminal still hosting an agent while the worker runs) — the
          // task's status decides which role is live, not the terminal
          // (Codex integrated pass, HIGH).
          reason = "role_not_active";
        } else if (!targetTerminalId) {
          reason = "no_target_terminal";
        } else if (!target) {
          reason = "terminal_not_live";
        } else if (target.ownerId !== ownerId) {
          reason = "owner_mismatch";
        } else if (
          !expectedAgent ||
          !target.agentName ||
          target.agentName !== expectedAgent
        ) {
          // Live telemetry must show the expected agent running RIGHT NOW —
          // otherwise the pointer would land on a shell prompt (it is inert
          // there, but delivery must still be reported as failed).
          reason = "agent_not_running";
        } else {
          try {
            target.terminal.write(buildPointerLine("user", inboxPath));
            delivered = true;
          } catch (err) {
            // PTY closed between the lookup and the write: a failed delivery,
            // not a route error (the message itself is already recorded).
            debug("Task message PTY write failed:", err);
            reason = "terminal_write_failed";
          }
        }
        const outcome: TaskMessageEvent = delivered
          ? {
              type: "message-delivered",
              id: msgId,
              at: new Date().toISOString(),
              terminalId: targetTerminalId as string,
            }
          : {
              type: "message-delivery-failed",
              id: msgId,
              at: new Date().toISOString(),
              reason: reason || "undeliverable",
            };
        if (!appendTaskMessageEvent(taskMessagesPath(fresh.taskDir), outcome)) {
          // The message stays "pending" in the fold; the audit row below
          // still records the true outcome.
          debug("Task message outcome append failed for", msgId);
        }
        return {
          msgId,
          to,
          delivered,
          reason,
          recorded: true,
          targetTerminalId,
          bodyBytes: Buffer.byteLength(sanitized, "utf8"),
          taskDir: fresh.taskDir,
        };
      });

      // Audit every outcome (invariant 3): never the body, only its size.
      const state = await getFoundationState();
      writeAuditEvent(state.db, {
        actorUserId: ownerId,
        action: "task.message",
        resourceType: "task",
        resourceId: task.id,
        decision: result.delivered ? "allow" : "deny",
        reason: result.reason,
        data: {
          taskId: task.id,
          from: "user",
          to: result.to,
          targetTerminalId: result.targetTerminalId,
          delivery: result.delivered ? "delivered" : "failed",
          bodyBytes: result.bodyBytes,
        },
      });

      if (result.recorded === false) {
        // The event log rejected the append (symlinked/replaced file): the
        // message was NOT recorded and nothing was delivered.
        return c.json({ error: "Failed to record task message" }, 500);
      }

      const message =
        readTaskMessages(taskMessagesPath(result.taskDir)).find(
          (entry) => entry.id === result.msgId,
        ) || null;
      return c.json({
        message,
        delivery: result.delivered ? "delivered" : "failed",
        reason: result.reason,
      });
    } catch (err) {
      return taskErrorResponse(c, err);
    }
  });

  app.post("/api/tasks/:id/start", async (c) => {
    const { ownerId, ownerEmail } = getCurrentUser(c);
    // Task workspaces spawn agent PTYs as the service account — a B4 surface,
    // denied under isolation until B4 brokers them (§4.3, inv 17).
    const taskDeny = await denyIfOsIsolationUnsupported(c, "tasks");
    if (taskDeny) return c.json(taskDeny.body, taskDeny.status);
    try {
      const task = await taskRunner.getTask(c.req.param("id"), { ownerId });
      const creationError = getTerminalCreationError(ownerId);
      if (creationError) {
        return c.json(creationError.body, creationError.status);
      }
      rateLimitState.record(ownerId);
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
    const checkDeny = await denyIfOsIsolationUnsupported(c, "tasks");
    if (checkDeny) return c.json(checkDeny.body, checkDeny.status);
    try {
      return c.json(await taskRunner.runChecks(c.req.param("id"), { ownerId }));
    } catch (err) {
      return taskErrorResponse(c, err);
    }
  });

  app.post("/api/tasks/:id/judge", async (c) => {
    const { ownerId, ownerEmail } = getCurrentUser(c);
    const judgeDeny = await denyIfOsIsolationUnsupported(c, "tasks");
    if (judgeDeny) return c.json(judgeDeny.body, judgeDeny.status);
    try {
      const task = await taskRunner.getTask(c.req.param("id"), { ownerId });
      const prompt = await taskRunner.buildJudgePrompt(task.id, { ownerId });
      await writeFile(task.controlFiles.judgePromptFile, prompt);
      const creationError = getTerminalCreationError(ownerId);
      if (creationError) {
        return c.json(creationError.body, creationError.status);
      }
      rateLimitState.record(ownerId);
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
    const deny = await denyIfOsIsolationUnsupported(c, "tasks");
    if (deny) return c.json(deny.body, deny.status);
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
    const deny = await denyIfOsIsolationUnsupported(c, "tasks");
    if (deny) return c.json(deny.body, deny.status);
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
    // Deletes remove the service-owned workspace/worktree — deny under isolation
    // before touching it (Codex integrated #9).
    const deny = await denyIfOsIsolationUnsupported(c, "tasks");
    if (deny) return c.json(deny.body, deny.status);
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
    const actor = getCurrentActor(c);
    const ownerEmail = actor.email;
    const body = await c.req.json().catch(() => ({}));
    const routeCapability = getRouteCapability(c.req.method, c.req.url);
    if (!routeCapability) {
      return c.json({ error: "Missing route capability" }, 500);
    }
    const requestedCwd = body.cwd || process.env.HOME || "/";
    // Resolve the start dir first (side-effect-free) so BOTH capability checks
    // key on the resolved root's id, mirroring requireFileAccess. Before S1
    // (Alice/Bob e2e), terminal.create was checked on (terminal, "*") and
    // root.use on the raw cwd path — neither is grantable to a member (wildcard
    // grants are forbidden; the S6 auto-grant / scoped grants are keyed by
    // rootId), so members could never create even in their own home. Owner/
    // admin still pass via the check-time role bundle regardless of resource,
    // and legacy bypass short-circuits inside requireFoundationCapability, so
    // their outcomes are unchanged.
    //
    // Isolation (brokered) vs legacy split: under isolation the cwd is resolved
    // LEXICALLY against the actor's registered roots (the service account can't
    // realpath-traverse a mapped user's 0700 home; the broker's post-drop chdir
    // enforces the real traversal). Legacy keeps the realpath resolver, which
    // falls back to an allowed root when the requested cwd is within roots but
    // deleted; only a genuinely out-of-roots path returns null (→ 403).
    const state = await getFoundationState();

    // Early actor-validity gate (Codex integrated #1/#2): enforce identity-
    // conflict / disabled-wins / isolation source-trust BEFORE resolving the
    // cwd, so those resource-independent denials keep their precedence and audit
    // attribution rather than being masked by a forbidden_root/no_matching_root
    // path deny. Legacy bypass short-circuits to the raw actor id (byte-
    // identical). The capability checks below still enforce the grant/bootstrap.
    const pre = preflightTerminalActor(state, actor);
    if (!pre.ok) {
      writeAuditEvent(state.db, {
        actorUserId: pre.auditOwnerId,
        action: "terminal.create",
        resourceType: "terminal",
        resourceId: "*",
        decision: "deny",
        reason: pre.reason,
        data: { cwd: body.cwd ?? null },
      });
      return c.json(
        foundationGateJson({
          message: pre.message,
          reason: pre.reason,
          capability: "terminal.create",
          resourceType: "terminal",
          resourceId: "*",
        }),
        403,
      );
    }
    const actorOwnerId = pre.ownerId;

    const resolvedCwd = isOsIsolationEnabled(process.env)
      ? await resolveBrokeredStartDir(c, body.cwd ? String(body.cwd) : null)
      : await resolveTerminalStartDir(requestedCwd);
    if (!resolvedCwd) {
      writeAuditEvent(state.db, {
        actorUserId: actorOwnerId,
        action: "terminal.create",
        resourceType: "root",
        decision: "deny",
        reason: "forbidden_root",
        data: { cwd: requestedCwd },
      });
      return c.json({ error: "Forbidden terminal root" }, 403);
    }

    // Lexical (no realpath) root match, same helper requireFileAccess uses.
    // resolveTerminalStartDir already kept the path within roots, so a null
    // here is a defensive guard (root row removed mid-request) → deny like the
    // fs surfaces do.
    const cwdRootId = resolveFoundationRootIdForPath(state, resolvedCwd);
    if (!cwdRootId) {
      writeAuditEvent(state.db, {
        actorUserId: actorOwnerId,
        action: "terminal.create",
        resourceType: "root",
        decision: "deny",
        reason: "no_matching_root",
        data: { cwd: resolvedCwd },
      });
      return c.json(
        {
          error: "Forbidden path (no matching registered root)",
          reason: "no_matching_root",
        },
        403,
      );
    }

    // terminal.create keyed on the resolved root (was terminal/"*"). Owner/admin
    // pass via the role bundle; a member needs a scoped (terminal.create, root,
    // <rootId>) grant. This call also enforces disabled-wins / bootstrap /
    // identity / tunnel gating (unchanged) and yields the canonical ownerId.
    const foundationAuth = await requireFoundationCapability({
      actor,
      capability: routeCapability.capability,
      resourceType: "root",
      resourceId: cwdRootId,
      data: { cwd: resolvedCwd },
    });
    if (!foundationAuth.ok) {
      return c.json(foundationGateJson(foundationAuth), foundationAuth.status);
    }
    // Canonical ownerId (plan §2, invariant §9.9): every downstream seam in
    // this handler — live-count checks, PTY spawn, session recording, audit
    // — stores/compares this resolved id, not the raw actor id.
    const ownerId = foundationAuth.ownerId;

    const rootAuth = await requireFoundationCapability({
      actor,
      capability: "root.use",
      resourceType: "root",
      resourceId: cwdRootId,
      data: { cwd: resolvedCwd },
    });
    if (!rootAuth.ok) {
      return c.json(foundationGateJson(rootAuth), rootAuth.status);
    }

    const creationError = getTerminalCreationError(ownerId);
    if (creationError) {
      return c.json(creationError.body, creationError.status);
    }

    // Pre-side-effect disabled re-check (invariant §9.2): closes the race
    // where a disable lands between the capability gate above and the PTY
    // spawn below. (`state` was resolved above for the cwd/root checks.)
    const recheckUser = getFoundationUserById(state.db, ownerId);
    if (recheckUser?.disabled) {
      writeAuditEvent(state.db, {
        actorUserId: ownerId,
        action: "terminal.create",
        resourceType: "terminal",
        decision: "deny",
        reason: "user_disabled",
        data: { cwd: resolvedCwd },
      });
      return c.json(
        foundationGateJson({
          message: "DeckTerm account disabled",
          reason: "user_disabled",
          capability: "terminal.create",
          resourceType: "terminal",
          resourceId: "*",
        }),
        403,
      );
    }

    // B2 OS isolation (§4.3): resolve legacy vs brokered vs deny. Off ⇒ legacy
    // (byte-identical). A deny is audited + 403'd here; a drift/ineligibility
    // deny also tore down the user's live sessions inside the resolver path.
    const execResolution = await resolvePtyExecutionContext(
      state,
      actor,
      ownerId,
      resolvedCwd,
    );
    if (!execResolution.ok) {
      return c.json(execResolution.body, execResolution.status);
    }
    const exec = execResolution.exec;

    rateLimitState.record(ownerId);
    const terminal = await createOwnedTerminal({
      cwd: resolvedCwd,
      cols: body.cols || 120,
      rows: body.rows || 30,
      ownerId,
      ownerEmail,
      exec,
    });

    recordTerminalSession(state.db, {
      id: terminal.id,
      actorUserId: ownerId,
      rootId: cwdRootId,
      cwd: resolvedCwd,
      status: "active",
      // Persist the execution kind so the isolation reconcile refuses to
      // resurrect non-brokered sessions after a restart (§4.4, Codex #8).
      execKind: exec ? "brokered" : "legacy",
      osUid: exec?.uid ?? null,
    });

    // Post-registration recheck (Fix 2, invariant §9.2/§9.7): the terminal
    // is now registered in `terminals` and its session recorded — closes the
    // race where a disable lands AFTER the pre-side-effect recheck above but
    // DURING the PTY spawn inside createOwnedTerminal (a real async
    // subprocess-start await, a genuine interleaving window) and BEFORE this
    // point. Skipped under legacy bypass: those envs have no DB gating at
    // all (invariant §9.10, zero behavior change).
    if (!isFoundationLegacyBypassEnabled()) {
      const postRegistrationUser = getFoundationUserById(state.db, ownerId);
      if (postRegistrationUser?.disabled) {
        await killSingleTerminal(state, terminal, "user_disabled_postcheck");
        writeAuditEvent(state.db, {
          actorUserId: ownerId,
          action: "terminal.create",
          resourceType: "terminal",
          resourceId: terminal.id,
          decision: "deny",
          reason: "user_disabled_postcheck",
          data: { cwd: resolvedCwd },
        });
        return c.json(
          foundationGateJson({
            message: "DeckTerm account disabled",
            reason: "user_disabled_postcheck",
            capability: "terminal.create",
            resourceType: "terminal",
            resourceId: "*",
          }),
          403,
        );
      }
    }

    // Post-registration mapping recheck for brokered terminals (integrated-
    // review #4): closes the resolve→spawn race where a suspend/delete/drift
    // lands between the first resolution and the PTY spawn. Re-resolving here
    // (and only for a brokered terminal) catches it — a deny already suspended
    // the mapping and ran the kill path, and any uid change is a divergent
    // identity — so we tear the just-created terminal down and 403.
    if (exec) {
      const recheck = await resolvePtyExecutionContext(
        state,
        actor,
        ownerId,
        resolvedCwd,
      );
      if (
        !recheck.ok ||
        !recheck.exec ||
        recheck.exec.uid !== exec.uid ||
        recheck.exec.gid !== exec.gid
      ) {
        // The resolver's own deny path may already have killed this terminal via
        // killUserSessions; guard so we don't double-kill (integrated-review
        // residual #1). killSingleTerminal is idempotent, but skipping is cleaner.
        if (terminals.has(terminal.id)) {
          await killSingleTerminal(state, terminal, "os_mapping_postcheck");
        }
        writeAuditEvent(state.db, {
          actorUserId: ownerId,
          action: "terminal.create",
          resourceType: "terminal",
          resourceId: terminal.id,
          decision: "deny",
          reason: "os_mapping_postcheck",
          data: { cwd: resolvedCwd, os_uid: exec.uid },
        });
        return c.json(
          { error: "OS isolation denied", reason: "os_mapping_postcheck" },
          403,
        );
      }
    }

    writeAuditEvent(state.db, {
      actorUserId: ownerId,
      action: "terminal.create",
      resourceType: "terminal",
      resourceId: terminal.id,
      decision: "allow",
      data: exec
        ? {
            cwd: resolvedCwd,
            brokered: true,
            os_uid: exec.uid,
            os_username: exec.osUsername,
          }
        : { cwd: resolvedCwd },
    });

    return c.json(serializeTerminal(terminal));
  });

  app.post("/api/terminals/:id/linked-view", async (c) => {
    const actor = getCurrentActor(c);
    const ownerEmail = actor.email;
    const sourceId = c.req.param("id");
    const sourceTerm = terminals.get(sourceId);

    if (!sourceTerm) {
      return c.json({ error: "Terminal not found" }, 404);
    }
    const sourceAccess = await requireTerminalSessionAccess({
      actor,
      term: sourceTerm,
      capability: "terminal.attach",
    });
    if (!sourceAccess.ok) {
      return c.json(foundationGateJson(sourceAccess), sourceAccess.status);
    }
    // Canonical ownerId (plan §2, invariant §9.9), resolved once by the
    // access check above — the same id primary terminal creation uses.
    const ownerId = sourceAccess.ownerId;
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

    // A linked view spawns a NEW client, so it goes through the resolver
    // chokepoint again (integrated-review #1) — never reuse the source's cached
    // exec. If the mapping was suspended/drifted/made-ineligible since the
    // source was created, this denies + audits + tears down (via the resolver),
    // and a brokered result must match the source session's uid.
    const state = await getFoundationState();
    const linkExec = await resolvePtyExecutionContext(
      state,
      actor,
      ownerId,
      sourceTerm.cwd,
    );
    if (!linkExec.ok) {
      return c.json(linkExec.body, linkExec.status);
    }
    // Refuse any execution-kind change between the source and the re-resolve
    // (integrated-review residual #2): a legacy source must not gain a brokered
    // client, a brokered source must not drop to legacy, and a brokered source's
    // uid must still match — otherwise the linked view would attach a divergent
    // identity to the shared session.
    if (
      Boolean(sourceTerm.exec) !== Boolean(linkExec.exec) ||
      (sourceTerm.exec && linkExec.exec?.uid !== sourceTerm.exec.uid)
    ) {
      return c.json(
        { error: "OS isolation denied", reason: "os_mapping_changed" },
        403,
      );
    }

    rateLimitState.record(ownerId);

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
      exec: linkExec.exec,
    });
    recordTerminalSession(state.db, {
      id: terminal.id,
      actorUserId: ownerId,
      rootId: resolveFoundationRootIdForPath(state, terminal.cwd),
      cwd: terminal.cwd,
      status: "active",
      execKind: linkExec.exec ? "brokered" : "legacy",
      osUid: linkExec.exec?.uid ?? null,
    });

    return c.json(serializeTerminal(terminal));
  });

  // List terminals
  app.get("/api/terminals", async (c) => {
    const requestingClientId =
      c.req.header("x-deckterm-client-id")?.trim() || null;
    const backendMode = getBackendMode();
    const state = await getFoundationState();
    // Scope by the CANONICAL owner id — the same id terminal.create/attach store
    // and compare (invariant §9.9). getCurrentUser returns the raw actor id,
    // which for an invited user (canonical id ≠ subject) does not match the
    // stored session owner, so they would never see their own terminals. Legacy
    // bypass still resolves to the raw actor id (no user rows), unchanged.
    const actor = getCurrentActor(c);
    let ownerId: string;
    try {
      ownerId = isFoundationLegacyBypassEnabled()
        ? actor.id
        : resolveCanonicalOwnerId(state, actor).ownerId;
    } catch (err) {
      if (err instanceof IdentityConflictError) {
        return c.json(
          {
            error: "DeckTerm identity resolution conflict",
            reason: "identity_conflict",
          },
          403,
        );
      }
      throw err;
    }
    const recordedSessions = listTerminalSessionsForActor(state.db, ownerId, {
      endedLimit: TERMINAL_LIST_ENDED_LIMIT,
    });
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
    const actor = getCurrentActor(c);
    const id = c.req.param("id");
    const term = terminals.get(id);
    if (!term) {
      return c.json({ error: "Terminal not found" }, 404);
    }
    const access = await requireTerminalSessionAccess({
      actor,
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
    await killTmuxSessionIfLast(term.sessionName, undefined, term.backend);

    term.proc.kill();
    term.terminal.close();
    return c.json({ ok: true });
  });

  // Resize terminal - now with proper PTY resize support via Bun.Terminal
  app.post("/api/terminals/:id/resize", async (c) => {
    const actor = getCurrentActor(c);
    const id = c.req.param("id");
    const term = terminals.get(id);
    if (!term) {
      return c.json({ error: "Terminal not found" }, 404);
    }
    const access = await requireTerminalSessionAccess({
      actor,
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

    // B4: resolve the execution context (legacy vs mapped-user broker vs deny).
    const execCtx = await resolveExecFsContext(c, "files");
    if (!execCtx.ok) {
      return c.json(execCtx.body, { status: execCtx.status as any });
    }
    const fx = getFsExecutor(execCtx.ctx);

    // Default root: brokered actors default to their OWN granted (home) root, not
    // the service account's HOME (Codex integrated #6); legacy keeps the
    // realpath'd allowlist fallback exactly as before.
    const fallbackPath =
      execCtx.ctx.kind === "brokered"
        ? (await brokeredDefaultRoot(c)) || requestedPath
        : await getDefaultBrowseRoot();

    let scoped = await resolveScopedFsPath(c, execCtx.ctx, requestedPath);
    let fellBack = false;
    if (!scoped.ok) {
      // Legacy fell back to the default browse root ONLY for an out-of-root /
      // missing path (no_matching_root) — an actual capability/auth denial must
      // propagate, not be masked by a fallback (Codex integrated #5).
      if (scoped.body?.reason !== "no_matching_root") {
        return c.json(scoped.body, { status: scoped.status as any });
      }
      const fb = await resolveScopedFsPath(c, execCtx.ctx, fallbackPath);
      if (!fb.ok) return c.json(scoped.body, { status: scoped.status as any });
      scoped = fb;
      fellBack = requestedPath !== fallbackPath;
    }

    const readDirectory = async (
      root: string,
      relPath: string,
      displayPath: string,
    ) => {
      const entries = await fx.list(root, relPath);
      const dirs = entries
        .filter((e) => e.kind === "dir" && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort();

      const result: {
        path: string;
        dirs: string[];
        files?: { name: string; size: number }[];
        fallback?: boolean;
      } = { path: displayPath, dirs };

      if (includeFiles) {
        result.files = entries
          .filter((e) => e.kind === "file" && !e.name.startsWith("."))
          .map((e) => ({ name: e.name, size: e.size }))
          .sort((a, b) => a.name.localeCompare(b.name));
      }

      if (fellBack) {
        result.fallback = true;
      }

      return result;
    };

    const displayPath = scoped.relPath
      ? `${scoped.root}/${scoped.relPath}`
      : scoped.root;
    try {
      return c.json(
        await readDirectory(scoped.root, scoped.relPath, displayPath),
      );
    } catch (err: unknown) {
      const error = err as { code?: string };
      const missing =
        error.code === "ENOENT" ||
        (err instanceof FsExecError && err.code === "not_found");
      if (missing && !fellBack) {
        const fb = await resolveScopedFsPath(c, execCtx.ctx, fallbackPath);
        if (fb.ok) {
          fellBack = true;
          const fbDisplay = fb.relPath ? `${fb.root}/${fb.relPath}` : fb.root;
          return c.json(await readDirectory(fb.root, fb.relPath, fbDisplay));
        }
      }
      if (err instanceof FsExecError)
        return fsErrorResponse(c, err, "Cannot read directory");
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

    // ── Isolation gate FIRST (B4 deferred fast-follow) ───────────────────────
    // Workspace search is not brokered in 1.0, so under isolation it must deny
    // explicitly and BEFORE the realpath gate below. Otherwise the deny would
    // depend on filesystem permissions: `resolveAllowedPath` realpaths as the
    // service account and only incidentally fails on a mapped user's 0700 home
    // — on a world-traversable granted root, grep would run AS THE SERVICE
    // ACCOUNT and read files the mapped user cannot. Fail closed regardless.
    const searchIsolationDeny = await denyIfOsIsolationPending(
      c,
      "search",
      typeof requestId === "string" ? requestId : String(requestId),
    );
    if (searchIsolationDeny) {
      return c.json(
        { ...searchIsolationDeny.body, requestId },
        { status: searchIsolationDeny.status as any },
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
    const execCtx = await resolveExecFsContext(c, "files");
    if (!execCtx.ok) {
      return c.json(execCtx.body, { status: execCtx.status as any });
    }
    const scoped = await resolveScopedFsPath(c, execCtx.ctx, requestedPath);
    if (!scoped.ok)
      return c.json(scoped.body, { status: scoped.status as any });
    const fx = getFsExecutor(execCtx.ctx);

    try {
      const st = await fx.statPath(scoped.root, scoped.relPath);
      if (st.kind !== "file") {
        return c.json({ error: "Not a file" }, 400);
      }
      // Download reuses the editor byte cap under isolation (B4 §2.2 / Codex #12);
      // legacy is uncapped so pass through the observed size.
      const cap =
        execCtx.ctx.kind === "brokered" ? EDITOR_MAX_FILE_BYTES : st.size + 1;
      const { content } = await fx.read(scoped.root, scoped.relPath, cap);
      const filename = basename(scoped.relPath || scoped.root);

      return new Response(new Uint8Array(content), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Length": String(content.length),
        },
      });
    } catch (err) {
      if (err instanceof FsExecError)
        return fsErrorResponse(c, err, "Cannot read file");
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
    const execCtx = await resolveExecFsContext(c, "files");
    if (!execCtx.ok) {
      return c.json(execCtx.body, { status: execCtx.status as any });
    }
    const scoped = await resolveScopedFsPath(c, execCtx.ctx, requestedPath);
    if (!scoped.ok)
      return c.json(scoped.body, { status: scoped.status as any });
    const fx = getFsExecutor(execCtx.ctx);

    try {
      const fileStat = await fx.statPath(scoped.root, scoped.relPath);
      if (fileStat.kind !== "file") {
        return c.json({ error: "Not a file" }, 400);
      }
      if (fileStat.size > EDITOR_MAX_FILE_BYTES) {
        return c.json(
          { error: "File too large to edit", maxBytes: EDITOR_MAX_FILE_BYTES },
          413,
        );
      }
      const { content: data } = await fx.read(
        scoped.root,
        scoped.relPath,
        EDITOR_MAX_FILE_BYTES,
      );
      if (data.includes(0)) {
        return c.json({ error: "Binary file cannot be edited" }, 415);
      }
      return c.json({
        path: scoped.relPath ? `${scoped.root}/${scoped.relPath}` : scoped.root,
        content: data.toString("utf8"),
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size,
      });
    } catch (err) {
      if (err instanceof FsExecError)
        return fsErrorResponse(c, err, "Cannot read file");
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
    const execCtx = await resolveExecFsContext(c, "files");
    if (!execCtx.ok) {
      return c.json(execCtx.body, { status: execCtx.status as any });
    }
    const scoped = await resolveScopedFsPath(c, execCtx.ctx, requestedPath, {
      allowMissing: true,
    });
    if (!scoped.ok)
      return c.json(scoped.body, { status: scoped.status as any });
    const fx = getFsExecutor(execCtx.ctx);
    const displayPath = scoped.relPath
      ? `${scoped.root}/${scoped.relPath}`
      : scoped.root;

    try {
      const expectedMtimeMs = Number(body.expectedMtimeMs);
      if (Number.isFinite(expectedMtimeMs)) {
        try {
          const current = await fx.statPath(scoped.root, scoped.relPath);
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

      await fx.write(scoped.root, scoped.relPath, Buffer.from(content, "utf8"));
      const saved = await fx.statPath(scoped.root, scoped.relPath);

      const state = await getFoundationState();
      writeAuditEvent(state.db, {
        actorUserId: getCurrentUser(c).ownerId,
        action: "file.write",
        resourceType: "root",
        decision: "allow",
        reason: "editor_save",
        data: { path: displayPath, bytes: saved.size, brokered: fx.brokered },
      });

      return c.json({ ok: true, path: displayPath, mtimeMs: saved.mtimeMs });
    } catch (err) {
      if (err instanceof FsExecError)
        return fsErrorResponse(c, err, "Cannot write file");
      return c.json({ error: "Cannot write file", message: String(err) }, 500);
    }
  });

  // File upload
  app.post("/api/files/upload", async (c) => {
    const requestedPath = c.req.query("path");
    if (!requestedPath) {
      return c.json({ error: "Path required" }, 400);
    }
    const execCtx = await resolveExecFsContext(c, "files");
    if (!execCtx.ok) {
      return c.json(execCtx.body, { status: execCtx.status as any });
    }
    const scoped = await resolveScopedFsPath(c, execCtx.ctx, requestedPath);
    if (!scoped.ok)
      return c.json(scoped.body, { status: scoped.status as any });
    const fx = getFsExecutor(execCtx.ctx);

    try {
      // Check if target is a directory
      const st = await fx.statPath(scoped.root, scoped.relPath);
      if (st.kind !== "dir") {
        return c.json({ error: "Target must be a directory" }, 400);
      }

      // Parse multipart form data
      const formData = await c.req.formData();
      const file = formData.get("file") as File | null;

      if (!file) {
        return c.json({ error: "No file provided" }, 400);
      }

      const fileName = basename(file.name);
      const destRel = scoped.relPath
        ? `${scoped.relPath}/${fileName}`
        : fileName;
      const buffer = await file.arrayBuffer();
      await fx.write(scoped.root, destRel, Buffer.from(buffer));

      const destDisplay = `${scoped.root}/${destRel}`;
      debug(`File uploaded: ${destDisplay}`);

      return c.json({ ok: true, path: destDisplay });
    } catch (err) {
      debug(`Upload error:`, err);
      if (err instanceof FsExecError)
        return fsErrorResponse(c, err, "Failed to upload file");
      return c.json({ error: "Failed to upload file" }, 500);
    }
  });

  // Create directory
  app.post("/api/files/mkdir", async (c) => {
    const requestedPath = c.req.query("path");
    if (!requestedPath) {
      return c.json({ error: "Path required" }, 400);
    }
    const execCtx = await resolveExecFsContext(c, "files");
    if (!execCtx.ok) {
      return c.json(execCtx.body, { status: execCtx.status as any });
    }
    const scoped = await resolveScopedFsPath(c, execCtx.ctx, requestedPath, {
      allowMissing: true,
    });
    if (!scoped.ok)
      return c.json(scoped.body, { status: scoped.status as any });
    const fx = getFsExecutor(execCtx.ctx);
    const dirDisplay = scoped.relPath
      ? `${scoped.root}/${scoped.relPath}`
      : scoped.root;

    try {
      await fx.mkdir(scoped.root, scoped.relPath);
      return c.json({ ok: true, path: dirDisplay });
    } catch (err: unknown) {
      const error = err as { code?: string };
      if (
        error.code === "EEXIST" ||
        (err instanceof FsExecError && err.code === "exists")
      ) {
        return c.json({ error: "Directory already exists" }, 400);
      }
      if (err instanceof FsExecError)
        return fsErrorResponse(c, err, "Failed to create directory");
      return c.json({ error: "Failed to create directory" }, 500);
    }
  });

  // Delete file or directory
  app.delete("/api/files", async (c) => {
    const requestedPath = c.req.query("path");
    if (!requestedPath) {
      return c.json({ error: "Path required" }, 400);
    }
    const execCtx = await resolveExecFsContext(c, "files");
    if (!execCtx.ok) {
      return c.json(execCtx.body, { status: execCtx.status as any });
    }
    const scoped = await resolveScopedFsPath(c, execCtx.ctx, requestedPath);
    if (!scoped.ok)
      return c.json(scoped.body, { status: scoped.status as any });
    const fx = getFsExecutor(execCtx.ctx);

    // Security: never delete a root itself. The reconstructed abs path guards the
    // legacy realpath'd roots; brokered additionally can never target the root
    // (relPath === "" is refused by the helper) — belt and suspenders here.
    const absPath = scoped.relPath
      ? `${scoped.root}/${scoped.relPath}`
      : scoped.root;
    const protectedRoots = await getAllowedRealRoots();
    if (
      scoped.relPath === "" ||
      absPath === "/" ||
      protectedRoots.includes(absPath)
    ) {
      return c.json({ error: "Cannot delete root or home directory" }, 403);
    }

    try {
      const st = await fx.statPath(scoped.root, scoped.relPath);
      await fx.remove(scoped.root, scoped.relPath, st.kind === "dir");
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof FsExecError)
        return fsErrorResponse(c, err, "Failed to delete");
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
    const execCtx = await resolveExecFsContext(c, "files");
    if (!execCtx.ok) {
      return c.json(execCtx.body, { status: execCtx.status as any });
    }
    const scopedFrom = await resolveScopedFsPath(c, execCtx.ctx, fromInput);
    if (!scopedFrom.ok)
      return c.json(scopedFrom.body, { status: scopedFrom.status as any });
    const scopedTo = await resolveScopedFsPath(c, execCtx.ctx, toInput, {
      allowMissing: true,
    });
    if (!scopedTo.ok)
      return c.json(scopedTo.body, { status: scopedTo.status as any });
    // BROKERED only: the helper resolves both endpoints beneath ONE root fd, so a
    // cross-root move is refused. LEGACY preserves the prior behavior (each
    // endpoint access-checked independently, fs.rename across allowed roots works
    // — Codex integrated #7).
    if (execCtx.ctx.kind === "brokered" && scopedFrom.root !== scopedTo.root) {
      return c.json(
        { error: "Cannot rename across roots", reason: "cross_root" },
        400,
      );
    }
    try {
      if (execCtx.ctx.kind === "legacy" && scopedFrom.root !== scopedTo.root) {
        // Legacy cross-root move: both endpoints were access-checked; rename the
        // two absolute paths directly (the executor's rename is single-root).
        const fromAbs = scopedFrom.relPath
          ? join(scopedFrom.root, scopedFrom.relPath)
          : scopedFrom.root;
        const toAbs = scopedTo.relPath
          ? join(scopedTo.root, scopedTo.relPath)
          : scopedTo.root;
        const fsp = await import("node:fs/promises");
        await fsp.rename(fromAbs, toAbs);
        return c.json({ ok: true });
      }
      const fx = getFsExecutor(execCtx.ctx);
      await fx.rename(scopedFrom.root, scopedFrom.relPath, scopedTo.relPath);
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof FsExecError)
        return fsErrorResponse(c, err, "Failed to rename");
      return c.json({ error: "Failed to rename" }, 500);
    }
  });

  // =============================================================================
  // GIT API - Secure git operations with realpath validation
  // =============================================================================

  // B4-S5: git routes resolve their cwd through the execution context (legacy vs
  // mapped-user broker), replacing the old boolean `validateGitCwd`. A resolved
  // git working dir carries the context + the granted root + the subdir beneath
  // it. Legacy runs git in `root/reldir`; brokered passes root+reldir to the
  // broker `git` profile (fd-resolved cwd, hardened env, schema-rebuilt argv).
  type GitCwd = { ctx: FsExecutorContext; root: string; reldir: string };

  async function resolveGitCwd(
    c: any,
    cwd: string | undefined,
  ): Promise<
    | { ok: true; git: GitCwd }
    | { ok: false; status: number; body: Record<string, unknown> }
  > {
    if (!cwd) {
      return {
        ok: false,
        status: 403,
        body: { error: "Forbidden path", reason: "no_matching_root" },
      };
    }
    const execCtx = await resolveExecFsContext(c, "git");
    if (!execCtx.ok) return execCtx;
    const scoped = await resolveScopedFsPath(c, execCtx.ctx, cwd);
    if (!scoped.ok) return scoped;
    return {
      ok: true,
      git: { ctx: execCtx.ctx, root: scoped.root, reldir: scoped.relPath },
    };
  }

  // Shared runner for git child processes. Legacy: direct spawn with
  // GIT_TERMINAL_PROMPT=0 so credential prompts fail fast. Brokered: the broker
  // `git` profile (argv rebuilt from the fixed schema; cwd resolved fd-safely
  // beneath the granted root as the mapped user). `args` is the argv AFTER `git`.
  async function runGit(
    git: GitCwd,
    args: string[],
    timeoutMs = 10000,
  ): Promise<{ ok: boolean; output: string; stderr: string; code: number }> {
    if (git.ctx.kind === "brokered") {
      // Brokered git shares the per-uid/global broker concurrency cap so it can't
      // fork-storm sudo/systemd-run (Codex integrated #3). Over the cap the call
      // fails fast (surfaced as a normal git failure by the routes).
      try {
        acquireBrokerSlot(git.ctx.uid);
      } catch (err) {
        if (err instanceof FsExecError && err.code === "isolation_busy") {
          return {
            ok: false,
            output: "",
            stderr: "isolation_busy: too many concurrent isolated operations",
            code: 429,
          };
        }
        throw err;
      }
      try {
        const res = await brokerExec(
          {
            session:
              "git" +
              Math.random().toString(36).slice(2).padEnd(10, "0").slice(0, 12),
            username: git.ctx.osUsername,
            uid: git.ctx.uid,
            gid: git.ctx.gid,
            cwd: git.root,
            reldir: git.reldir,
            profile: "git",
            profileArgs: args,
          },
          process.env,
          timeoutMs,
        );
        return {
          ok: res.code === 0,
          output: res.stdout,
          stderr: res.stderr,
          code: res.code,
        };
      } finally {
        releaseBrokerSlot(git.ctx.uid);
      }
    }
    const cwd = git.reldir ? join(git.root, git.reldir) : git.root;
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
      // B7 (D-B7-2, Codex #7): `policy.*` is reserved for the C3 admin-managed
      // per-user session policy store. Actor-scoped self-service must never be
      // able to squat on it — that would let users set their own limits.
      if (key === "policy" || key.startsWith("policy.")) {
        return c.json({ error: `reserved settings key: ${key}` }, 400);
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
    const g = await resolveGitCwd(c, cwd);
    if (!g.ok) {
      return c.json(g.body, { status: g.status as any });
    }

    try {
      const statusRes = await runGit(g.git, [
        "status",
        "--porcelain",
        "-uall",
        "-b",
      ]);
      const output = statusRes.output;
      const stderr = statusRes.stderr;
      const exitCode = statusRes.code;

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
        const rootRes = await runGit(g.git, ["rev-parse", "--show-toplevel"]);
        if (rootRes.code === 0) root = rootRes.output.trim() || null;
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
    const g = await resolveGitCwd(c, cwd);
    if (!g.ok) {
      return c.json(g.body, { status: g.status as any });
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
        args = ["show", "--format=", "--color=never", commit];
      } else if (stagedEnabled) {
        args = ["diff", "--staged", "--color=never"];
      } else {
        args = ["diff", "--color=never"];
      }

      if (path) {
        args.push("--", path);
      }

      const { output, stderr, code: exitCode } = await runGit(g.git, args);

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
      //
      // B4-S5: --no-index takes an ABSOLUTE path and is refused by the broker git
      // schema (it is an escape vector). It is therefore LEGACY-ONLY; under
      // isolation an untracked file simply shows in the tree without an inline
      // content preview (documented 1.0 limitation).
      if (
        g.git.ctx.kind === "legacy" &&
        !commit &&
        !stagedEnabled &&
        path &&
        output.trim() === ""
      ) {
        const cwd = g.git.reldir ? join(g.git.root, g.git.reldir) : g.git.root;
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

    const g = await resolveGitCwd(c, cwd);
    if (!g.ok) {
      return c.json(g.body, { status: g.status as any });
    }

    if (!paths || !Array.isArray(paths) || paths.length === 0) {
      return c.json({ error: "Paths required" }, 400);
    }

    try {
      const result = await runGit(g.git, ["add", "--", ...paths]);
      if (!result.ok) {
        return c.json(
          { error: "Git add failed", message: result.stderr.trim() },
          400,
        );
      }
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: "Git add failed", message: String(err) }, 400);
    }
  });

  // POST /api/git/unstage { cwd, paths: string[] }
  app.post("/api/git/unstage", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { cwd, paths } = body;

    const g = await resolveGitCwd(c, cwd);
    if (!g.ok) {
      return c.json(g.body, { status: g.status as any });
    }

    if (!paths || !Array.isArray(paths) || paths.length === 0) {
      return c.json({ error: "Paths required" }, 400);
    }

    try {
      const result = await runGit(g.git, [
        "restore",
        "--staged",
        "--",
        ...paths,
      ]);
      if (!result.ok) {
        return c.json(
          { error: "Git restore failed", message: result.stderr.trim() },
          400,
        );
      }
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: "Git restore failed", message: String(err) }, 400);
    }
  });

  // POST /api/git/commit { cwd, message }
  app.post("/api/git/commit", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { cwd, message, amend } = body;

    const g = await resolveGitCwd(c, cwd);
    if (!g.ok) {
      return c.json(g.body, { status: g.status as any });
    }

    if (!message?.trim()) {
      return c.json({ error: "Message required" }, 400);
    }

    try {
      const args = amend
        ? ["commit", "--amend", "-m", message]
        : ["commit", "-m", message];
      const result = await runGit(g.git, args);

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
    const g = await resolveGitCwd(c, cwd);
    if (!g.ok) {
      return c.json(g.body, { status: g.status as any });
    }

    try {
      const { output } = await runGit(g.git, [
        "branch",
        "-a",
        "--format=%(refname:short)",
      ]);
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

    const g = await resolveGitCwd(c, cwd);
    if (!g.ok) {
      return c.json(g.body, { status: g.status as any });
    }

    if (path && (path.startsWith("/") || path.includes(".."))) {
      return c.json({ error: "Invalid path" }, 400);
    }

    try {
      const args = [
        "log",
        `--max-count=${Math.min(limit, 200)}`,
        "--format=%h|%H|%s|%an|%aI",
        "--graph",
        "--",
      ];
      if (path) args.push(path);
      const { output } = await runGit(g.git, args);

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
    const g = await resolveGitCwd(c, cwd);
    if (!g.ok) {
      return c.json(g.body, { status: g.status as any });
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
    const res = await runGit(g.git, [
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

    const g = await resolveGitCwd(c, cwd);
    if (!g.ok) {
      return c.json(g.body, { status: g.status as any });
    }

    if (
      !branch ||
      typeof branch !== "string" ||
      !/^[\w\-\/\.]+$/.test(branch)
    ) {
      return c.json({ error: "Invalid branch name" }, 400);
    }

    try {
      const { stderr, code: exitCode } = await runGit(g.git, [
        "checkout",
        branch,
        "--",
      ]);

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
    const g = await resolveGitCwd(c, cwd);
    if (!g.ok) {
      return c.json(g.body, { status: g.status as any });
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
    const result = await runGit(g.git, args);
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
    const g = await resolveGitCwd(c, cwd);
    if (!g.ok) {
      return c.json(g.body, { status: g.status as any });
    }
    const result = await runGit(g.git, ["stash", "list", "--format=%gd%x09%s"]);
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
    const g = await resolveGitCwd(c, cwd);
    if (!g.ok) {
      return c.json(g.body, { status: g.status as any });
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
    const result = await runGit(g.git, args);
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
    const g = await resolveGitCwd(c, cwd);
    if (!g.ok) {
      return c.json(g.body, { status: g.status as any });
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
    const status = await runGit(g.git, [
      "status",
      "--porcelain",
      "--",
      ...paths,
    ]);
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
      const res = await runGit(g.git, [
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
      const res = await runGit(g.git, ["clean", "-f", "--", ...untracked]);
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
      const g = await resolveGitCwd(c, cwd);
      if (!g.ok) {
        return c.json(g.body, { status: g.status as any });
      }
      // Network git needs credential-helper + network execution the broker git
      // profile deliberately does not support (B4 D-B4-6); under isolation it is
      // permanently unsupported — conflict/remote work belongs in the terminal.
      if (g.git.ctx.kind === "brokered") {
        const state = await getFoundationState();
        writeAuditEvent(state.db, {
          actorUserId: getCurrentActor(c).id,
          action: "surface.access",
          resourceType: "surface",
          resourceId: `git.${op}`,
          decision: "deny",
          reason: "os_isolation_unsupported",
          data: { surface: "git", op, osIsolation: true },
        });
        return c.json(
          {
            error: "Network git is not available under OS isolation",
            reason: "os_isolation_unsupported",
            surface: "git",
          },
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
      const result = await runGit(g.git, args, 30000);
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

    const g = await resolveGitCwd(c, cwd);
    if (!g.ok) {
      return c.json(g.body, { status: g.status as any });
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
      const { output: content, code: exitCode } = await runGit(g.git, [
        "show",
        `${ref}:${path}`,
        "--",
      ]);

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

      // Re-validate the dir per request (a symlink/owner swap could have happened
      // since startup) — throws → caught below → 500 (Codex integrated #2).
      await ensureClipboardDir();

      const timestamp = Date.now();
      const random = Math.random().toString(36).slice(2, 8);
      const filename = `clipboard-${timestamp}-${random}.${extension}`;
      const filePath = join(CLIPBOARD_IMAGES_DIR, filename);

      // O_CREAT|O_EXCL|O_WRONLY ("wx") + 0600: never overwrite, and refuse a
      // planted symlink at the path (O_EXCL fails on an existing symlink) — no
      // Bun.write symlink-follow (B4 / Codex #14). The server-generated random
      // name makes a collision effectively impossible.
      writeFileSync(filePath, imageData, { flag: "wx", mode: 0o600 });

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

  // B2 (§4.4.1, B1 §1.2, invariant §7.15): `cloudflare-tunnel` publish mode
  // trusts an edge proxy for identity. On a NON-loopback bind that trust is
  // only sound if a real proxy fronts the port; refuse to start bound to a
  // public interface unless the operator explicitly accepts that
  // (DECKTERM_DANGEROUSLY_TRUST_PROXY_HEADERS=1). Dev/CI (loopback) and prod
  // (access mode, not tunnel) are unaffected.
  if (
    !hasExplicitLegacyDevActorMode(process.env) &&
    isEdgeProtectedTunnelMode(process.env) &&
    !isLoopbackHost(host) &&
    process.env.DECKTERM_DANGEROUSLY_TRUST_PROXY_HEADERS !== "1"
  ) {
    throw new Error(
      `DECKTERM_PUBLISH_MODE=cloudflare-tunnel refuses to bind non-loopback host ${host}: ` +
        "in tunnel mode identity is edge-asserted, so a public bind is only safe " +
        "behind a trusted proxy. Bind a loopback address, or set " +
        "DECKTERM_DANGEROUSLY_TRUST_PROXY_HEADERS=1 to accept the risk.",
    );
  }

  // B2 (§4.4.2, invariant §7.15): isolation mode has no meaning without a
  // working broker — fail closed rather than silently run every mapped user on
  // the service account. Only the flag-on path pays this check (legacy startups
  // are byte-identical). Exempt ONLY CI/test (integrated-review #5), where no
  // broker is installed and a brokered spawn would still fail closed at
  // runtime — a real dev/prod deploy with isolation on DOES check the broker.
  const isCiOrTestEnv =
    process.env.CI === "true" ||
    process.env.NODE_ENV === "test" ||
    process.env.BUN_ENV === "test";
  if (process.env.DECKTERM_OS_ISOLATION === "1" && !isCiOrTestEnv) {
    const brokerOk = await brokerCheck(process.env);
    if (!brokerOk) {
      throw new Error(
        "DECKTERM_OS_ISOLATION=1 but the launch broker self-check failed. Install/repair it " +
          "(scripts/broker/install-broker.sh --service-user <acct>) so `sudo -n " +
          "/usr/local/lib/deckterm/deckterm-broker check` returns 0, then restart. Refusing to " +
          "start in a half-isolated state where mapped users would fall back to the service account.",
      );
    }
  }

  // B3 §1.6 multiuser enablement gate (fail-closed startup, plan
  // docs/plans/2026-07-03-b3-user-provisioning-roles-revocation.md §6,
  // invariant §9.8). DECKTERM_OS_ISOLATION is the only multiuser flag until
  // C1 (OIDC/sessions) and does nothing else in B3 — B2 implements actual OS
  // isolation. Guarded entirely behind the flag check so startups with the
  // flag unset/anything-but-"1" are byte-identical to pre-gate behavior
  // (invariant §9.10): no early foundation-state load, no audit row, no
  // throw. getFoundationState() is a memoized singleton promise, so this
  // hoist does not initialize foundation state twice even when the
  // TMUX_BACKEND branch below also awaits it.
  if (process.env.DECKTERM_OS_ISOLATION === "1") {
    const state = await getFoundationState();

    const users = listFoundationUsers(state.db);
    const owner = users.find((user) => user.role === "owner") ?? null;
    const unreviewedAdmins = users.filter(
      (user) => user.role === "admin" && user.multiuserReviewedAt === null,
    );
    // Wildcard principals whose own role is not "owner" — the owner's
    // implicit bundle is exempt; every other wildcard-bearing principal
    // (admin, member, or orphan with no users row at all) must be reviewed.
    const wildcardPrincipals = listWildcardGrantPrincipals(state.db).filter(
      (principal) => principal.role !== "owner",
    );

    const violations: string[] = [];
    if (!owner) violations.push("no_owner");
    if (unreviewedAdmins.length > 0) violations.push("unreviewed_admin");
    if (wildcardPrincipals.length > 0) {
      violations.push("unreviewed_wildcard_grants");
    }
    // Fix 8: DECKTERM_LEGACY_NO_BOOTSTRAP bypasses DB-backed authorization
    // entirely on terminal/root surfaces (requireFoundationCapability's
    // first check), so "disabled wins" and the role/grant precedence this
    // gate exists to protect cannot actually hold under that bypass — the
    // combination must fail closed rather than silently coexist.
    if (isFoundationLegacyBypassEnabled()) {
      violations.push("legacy_bypass_conflict");
    }

    if (violations.length > 0) {
      writeAuditEvent(state.db, {
        actorUserId: owner?.id ?? null,
        action: "multiuser.gate",
        resourceType: "system",
        resourceId: null,
        decision: "deny",
        reason: violations.join(","),
        data: {
          violations,
          unreviewedAdminIds: unreviewedAdmins.map((user) => user.id),
          wildcardPrincipalIds: wildcardPrincipals.map(
            (principal) => principal.userId,
          ),
        },
      });

      const details: string[] = [];
      if (!owner) {
        details.push(
          "no_owner: no user with role 'owner' exists. DECKTERM_OS_ISOLATION=1 refuses to start until an owner is established via the manual owner-recovery repair procedure (plan §1.3/E3).",
        );
      }
      if (unreviewedAdmins.length > 0) {
        details.push(
          `unreviewed_admin: admin user(s) not yet reviewed for multiuser enablement: ${unreviewedAdmins
            .map((user) => user.id)
            .join(", ")}. Review each via POST /api/users/:id/review.`,
        );
      }
      if (wildcardPrincipals.length > 0) {
        details.push(
          `unreviewed_wildcard_grants: principal(s) still hold wildcard scoped_grants rows that have not been reviewed: ${wildcardPrincipals
            .map((principal) => principal.userId)
            .join(
              ", ",
            )}. Review each via POST /api/users/:id/review (existing user) or POST /api/grants/review (orphan principal with no users row).`,
        );
      }
      if (isFoundationLegacyBypassEnabled()) {
        details.push(
          "legacy_bypass_conflict: DECKTERM_LEGACY_NO_BOOTSTRAP=1 bypasses DB-backed authorization on terminal/root surfaces, so DECKTERM_OS_ISOLATION=1's disabled-wins/role precedence cannot hold while it is set. Unset DECKTERM_LEGACY_NO_BOOTSTRAP to enable multiuser mode.",
        );
      }

      throw new Error(
        `DECKTERM_OS_ISOLATION=1 multiuser enablement gate refused startup:\n${details.join("\n")}`,
      );
    }

    writeAuditEvent(state.db, {
      actorUserId: owner?.id ?? null,
      action: "multiuser.gate",
      resourceType: "system",
      resourceId: null,
      decision: "allow",
      reason: "clean",
    });
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
        const routeCapability = getRouteCapability(req.method, url.pathname);
        if (!routeCapability) {
          return new Response("Missing route capability", { status: 500 });
        }

        const state = await getFoundationState();

        // Canonical ownerId (plan §2, invariant §9.9): the attach/write
        // authorization below and the socket's actorUserId compare against
        // this resolved id — the same id terminal creation stores as
        // ownerId. IdentityConflictError means a self-heal collision: fail
        // closed (invariant §9.1). `auth.actor` is always set when
        // `auth.ok`.
        let ownerId: string;
        try {
          ({ ownerId } = resolveCanonicalOwnerId(state, auth.actor!));
        } catch (err) {
          if (err instanceof IdentityConflictError) {
            writeAuditEvent(state.db, {
              actorUserId: auth.ownerId,
              action: routeCapability.capability,
              resourceType: routeCapability.resourceType,
              resourceId: id,
              decision: "deny",
              reason: "identity_conflict",
            });
            return new Response("Forbidden", { status: 403 });
          }
          throw err;
        }

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

        // Pre-side-effect disabled re-check (invariant §9.2): closes the
        // race where a disable lands between the attach decision above and
        // the socket accept below.
        const recheckUser = getFoundationUserById(state.db, ownerId);
        if (recheckUser?.disabled) {
          writeAuditEvent(state.db, {
            actorUserId: ownerId,
            action: routeCapability.capability,
            resourceType: routeCapability.resourceType,
            resourceId: id,
            decision: "deny",
            reason: "user_disabled",
          });
          return new Response("Forbidden", { status: 403 });
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

        // Post-registration recheck (Fix 2+3(b)): fire-and-forget so open()
        // itself stays synchronous. Runs after the socket is already added
        // to `sockets` above — the recheck's job is to close it right back
        // down if it should never have opened. Any unexpected error here
        // fails closed (close the socket) rather than ever leaving a socket
        // alive on an error we didn't anticipate.
        void (async () => {
          try {
            const state = await getFoundationState();
            const validation = await validateLiveSocket(state, data);
            if (!validation.ok) {
              try {
                writeAuditEvent(state.db, {
                  actorUserId: data.actorUserId,
                  action: "terminal.attach",
                  resourceType: "terminal",
                  resourceId: terminalId,
                  decision: "deny",
                  reason: validation.reason,
                });
              } catch (err) {
                debug(
                  `[ws] post-registration audit write failed for ${terminalId}`,
                  err,
                );
              }
              try {
                ws.close();
              } catch {
                // ignore
              }
            }
          } catch (err) {
            console.error(
              `[ws] post-registration validation error for ${terminalId}:`,
              err,
            );
            try {
              ws.close();
            } catch {
              // ignore
            }
          }
        })();
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

  const cleanupIdleTerminals = async () => {
    const now = Date.now();

    for (const [id, term] of terminals) {
      const sockets = terminalSockets.get(id);
      const activeSocketsCount = sockets ? sockets.size : 0;

      // Only clean up idle active/attached terminals. Detached terminals are reaped after 8 hours!
      if (activeSocketsCount > 0) {
        const idleTime = now - term.lastActivityAt;

        if (idleTime > resolveSessionPolicy(term.ownerId).idleTimeoutMs) {
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
            await killTmuxSessionIfLast(
              term.sessionName,
              undefined,
              term.backend,
            );
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
        // Detached and inactive past the owner's detached TTL
        const timeSinceLastActivityOrDetach = Math.max(detachedTime, idleTime);

        if (
          timeSinceLastActivityOrDetach >
          resolveSessionPolicy(term.ownerId).detachedTtlMs
        ) {
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
            await killTmuxSessionIfLast(
              term.sessionName,
              undefined,
              term.backend,
            );
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

  // B6 retention scheduler (plan D-B6-5): an hourly tick consults the
  // durable `retention_runs` bookkeeping, so cadence survives restarts and a
  // daily-restarted service still prunes daily and checkpoints weekly. No
  // VACUUM anywhere in-process (I12).
  const RETENTION_DISABLED = process.env.DECKTERM_RETENTION_DISABLED === "1";
  const EVENT_RETENTION_DAYS = parseInt(
    process.env.DECKTERM_EVENT_RETENTION_DAYS || "30",
    10,
  );
  const SESSION_RETENTION_DAYS = parseInt(
    process.env.DECKTERM_SESSION_RETENTION_DAYS || "30",
    10,
  );
  const STATE_EVENT_RETENTION_DAYS = (() => {
    const parsed = parseInt(
      process.env.DECKTERM_STATE_EVENT_RETENTION_DAYS || "2",
      10,
    );
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2;
  })();
  const retentionTick = async () => {
    if (RETENTION_DISABLED) return;
    try {
      const state = await getFoundationState();
      const now = new Date();
      const lastPrune = getLastSuccessfulRunAt(state.db, RETENTION_JOB_PRUNE);
      if (!lastPrune || now.getTime() - lastPrune.getTime() > 24 * 3600_000) {
        const result = await runRetentionPrune(state.db, {
          eventTtlDays: EVENT_RETENTION_DAYS,
          endedSessionTtlDays: SESSION_RETENTION_DAYS,
          stateEventTtlDays: STATE_EVENT_RETENTION_DAYS,
          liveTerminalIds: new Set(terminals.keys()),
          now,
        });
        console.log(
          `[retention] prune completed: output=${result.outputEventsPurged} expired=${result.expiredEventsPruned} staleState=${result.staleStateEventsPruned} endedSessions=${result.endedSessionsPruned}`,
        );
      }
      const lastCheckpoint = getLastSuccessfulRunAt(
        state.db,
        RETENTION_JOB_WAL_CHECKPOINT,
      );
      if (
        !lastCheckpoint ||
        now.getTime() - lastCheckpoint.getTime() > 7 * 24 * 3600_000
      ) {
        runWalCheckpoint(state.db, now);
        console.log(`[retention] wal_checkpoint(TRUNCATE) completed`);
      }
    } catch (err) {
      console.error(`[retention] tick failed:`, err);
    }
  };
  setInterval(retentionTick, 60 * 60 * 1000);
  setTimeout(retentionTick, 60 * 1000);

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
