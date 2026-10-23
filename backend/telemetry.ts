import { dirname } from "node:path";
import { hardenGitInvocation } from "./git-readonly";
import { sanitizeTerminalEnv } from "./services/terminal-env";
import { isAgentSessionId } from "./agent-resume";

const BUSY_ACTIVITY_WINDOW_MS = 30_000;
const BUSY_BOOTSTRAP_WINDOW_MS = 10_000;
const MAX_SCROLLBACK_CHUNKS = 200;
const GIT_COMMAND_TIMEOUT_MS = 3_000;
const WORKTREE_CACHE_TTL_MS = 5_000;
// projectRoot (the git top level of a session's cwd) changes rarely; every
// /api/terminals poll reuses it for this long per cwd.
export const PROJECT_ROOT_CACHE_TTL_MS = 60_000;
const SHELL_MARKER_PREFIX = "\x1b]9;9;deckterm;";
const SHELL_MARKER_SUFFIX = "\x07";
const TOOL_MARKER_MAX_PAYLOAD_LENGTH = 2048;
const TOOL_MARKER_NAME_RE = /^[A-Za-z][\w.-]{0,63}$/;
// Strict grouped base64 (length multiple of 4, valid padding):
// Buffer.from(..., "base64") is forgiving, and a lax check would swallow
// malformed markers as events instead of passing them through byte-identically.
const BASE64_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SUMMARY_LINE_MAX_LENGTH = 80;

const PORT_PATTERNS = [
  /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/gi,
  /\b(?:listening on|on port|port)\s+(\d{2,5})\b/gi,
];

export type BackendMode = "raw" | "tmux";
export type AgentName = "codex" | "claude";
export type AgentState = "thinking" | "responding";
export type RecoveredTmuxRuntimeState = {
  running: boolean;
  agentName: AgentName | null;
  agentState: AgentState | null;
};

export type TmuxRuntimeState = {
  running: boolean;
  lastExitCode: number | null;
  agentName: AgentName | null;
  agentState: AgentState | null;
  /**
   * Consecutive conclusive tmux samples in which a process-detected agent was
   * missing from both the process tree and pane_current_command.
   */
  agentMissedSamples?: number;
};

/**
 * A process-detected agent is dropped after this many consecutive samples
 * without it. The process tree is sampled, so one empty sample (a race with a
 * respawn, a short-lived exec) must not clear the badge.
 */
export const AGENT_MISSING_SAMPLES_TO_CLEAR = 2;

export type TerminalTelemetry = {
  busy: boolean;
  running: boolean;
  lastExitCode: number | null;
  agentName: AgentName | null;
  agentState: AgentState | null;
  ports: number[];
  isWorktree: boolean;
  projectRoot: string | null;
  backendMode: BackendMode;
};

type TelemetryTerminal = {
  cwd: string;
  createdAt: number;
  lastActivityAt: number;
  scrollback: string[];
  running?: boolean;
  lastExitCode?: number | null;
  agentName?: AgentName | null;
  agentState?: AgentState | null;
};

export type ShellIntegrationParseState = {
  carry: string;
  running: boolean;
  lastExitCode: number | null;
  agentName: AgentName | null;
  agentState: AgentState | null;
};

export type ShellIntegrationEvent =
  | { type: "running-start" }
  | { type: "running-done"; exitCode: number | null }
  | {
      type: "agent-start";
      agentName: AgentName;
      /** Validated agent conversation id from `sid=` (S3); absent if none. */
      sessionId?: string;
    }
  | { type: "agent-done"; agentName: AgentName; exitCode: number | null }
  | { type: "agent-turn-complete"; agentName: "codex" }
  | { type: "tool-used"; name: string; summary: string };

type WorktreeDetector = (cwd: string) => Promise<boolean>;
type ProjectRootDetector = (cwd: string) => Promise<string | null>;

type GetTerminalTelemetryOptions = {
  now?: number;
  detectWorktree?: WorktreeDetector;
  detectProjectRoot?: ProjectRootDetector;
};

type GitCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type GitRunner = (
  cwd: string,
  args: string[],
  extraEnv?: Record<string, string>,
) => Promise<GitCommandResult>;

type WorktreeCacheEntry = {
  expiresAt: number;
  linkedRoots: string[];
};

const worktreeCache = new Map<string, WorktreeCacheEntry>();
const CODEx_TITLE_SPINNER_RE =
  /\x1b\]0;[\u2800-\u28ff][^\u0007\u001b]*(?:\u0007|\x1b\\)/u;
const OSC_SEQUENCE_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI_SEQUENCE_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const C1_SEQUENCE_RE = /\x1b[@-_]/g;
const CONTROL_CHARS_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;
const RECOVERED_AGENT_CMD_PATTERNS: Array<[AgentName, RegExp]> = [
  ["claude", /(^|[\/\s])claude(?=[\/\s]|$)/i],
  ["codex", /(^|[\/\s])codex(?=[\/\s]|$)/i],
];
const IDLE_SHELL_COMMANDS = new Set(["bash", "fish", "sh", "zsh"]);

function hasCodexTurnCompleteTitle(chunk: string): boolean {
  for (const match of chunk.matchAll(
    /\x1b\]0;([^\x07\x1b]*)(?:\x07|\x1b\\)/gu,
  )) {
    const title = (match[1] || "").trim();
    if (title && !/^[\u2800-\u28ff]/u.test(title)) return true;
  }
  return false;
}

// The start marker is `agent;<name>;start` or `agent;<name>;start;sid=<uuid>`.
// It travels in pane output, so any program can forge it: the id counts only
// as a lowercase UUID in the single extra field.
function parseAgentStartSessionId(
  field: string | undefined,
  rest: string[],
): string | null {
  if (field === undefined || rest.length > 0) return null;
  if (!field.startsWith("sid=")) return null;
  const value = field.slice("sid=".length);
  return isAgentSessionId(value) ? value : null;
}

function normalizeAgentName(value: string): AgentName | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "codex" || normalized === "claude") {
    return normalized;
  }
  return null;
}

function stripTerminalControlSequences(input: string): string {
  return input
    .replace(OSC_SEQUENCE_RE, "")
    .replace(CSI_SEQUENCE_RE, "")
    .replace(C1_SEQUENCE_RE, "")
    .replace(CONTROL_CHARS_RE, "");
}

// Ported from Traycer's tool-input-summary normalization (Apache 2.0).
// See THIRD_PARTY_NOTICES.md.
export function toSummaryLine(input: string): string {
  const collapsed = stripTerminalControlSequences(input)
    .replace(/\s+/g, " ")
    .trim();

  if (collapsed.length <= SUMMARY_LINE_MAX_LENGTH) {
    return collapsed;
  }

  return `${collapsed.slice(0, SUMMARY_LINE_MAX_LENGTH - 1)}…`;
}

function parseToolMarkerPayload(
  payload: string,
): { type: "tool-used"; name: string; summary: string } | null {
  const parts = payload.split(";");
  if (parts.length !== 3) return null;

  const [, name, base64Summary] = parts;
  if (!name || !TOOL_MARKER_NAME_RE.test(name)) return null;
  if (!BASE64_RE.test(base64Summary)) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(base64Summary, "base64").toString("utf8");
  } catch {
    return null;
  }

  return { type: "tool-used", name, summary: toSummaryLine(decoded) };
}

export function classifyAgentOutputPhase(
  agentName: AgentName | null | undefined,
  chunk: string,
): AgentState | null {
  if (!agentName || !chunk) return null;

  if (agentName === "codex" && CODEx_TITLE_SPINNER_RE.test(chunk)) {
    return "thinking";
  }

  const visibleText = stripTerminalControlSequences(chunk)
    .replace(/\s+/g, " ")
    .trim();

  if (!visibleText) {
    return null;
  }

  if (agentName === "claude") {
    const normalized = visibleText.toLowerCase();
    if (
      normalized.includes("working…") ||
      normalized.includes("working...") ||
      normalized.includes("running stop hooks")
    ) {
      return "thinking";
    }
  }

  return "responding";
}

export function resolveAgentOutputState({
  currentState,
  classifiedState,
  hasUserPrompted,
}: {
  currentState: AgentState | null;
  classifiedState: AgentState | null;
  hasUserPrompted: boolean;
}): AgentState | null {
  if (!classifiedState) return currentState;

  if (classifiedState === "responding" && !hasUserPrompted) {
    return currentState;
  }

  if (currentState === "responding" && classifiedState === "thinking") {
    return currentState;
  }

  return classifiedState;
}

export function inferRecoveredTmuxRuntimeState({
  paneCurrentCommand,
  processTree = [],
  capture = "",
}: {
  paneCurrentCommand?: string | null;
  processTree?: string[];
  capture?: string | null;
}): RecoveredTmuxRuntimeState {
  const normalizedPaneCommand = String(paneCurrentCommand || "")
    .trim()
    .toLowerCase();
  const agentName = detectRecoveredAgentName([
    normalizedPaneCommand,
    ...processTree,
  ]);

  if (agentName) {
    return {
      running: true,
      agentName,
      agentState:
        classifyAgentOutputPhase(agentName, capture || "") || "responding",
    };
  }

  return {
    running:
      normalizedPaneCommand.length > 0 &&
      !IDLE_SHELL_COMMANDS.has(normalizedPaneCommand),
    agentName: null,
    agentState: null,
  };
}

export function inferPolledTmuxAgentState({
  agentName,
  previousCapture = "",
  capture = "",
}: {
  agentName: AgentName;
  previousCapture?: string | null;
  capture?: string | null;
}): AgentState {
  const currentCapture = capture || "";
  const priorCapture = previousCapture || "";

  if (currentCapture === priorCapture) {
    return "thinking";
  }

  const changedChunk = currentCapture.startsWith(priorCapture)
    ? currentCapture.slice(priorCapture.length)
    : currentCapture;
  const classifiedState = classifyAgentOutputPhase(agentName, changedChunk);

  return classifiedState || "thinking";
}

/**
 * Whether an explicit `agent;<name>;start` marker is still open after these
 * shell-integration events. `agent;done` closes it, and so does a returned
 * shell prompt (`running;done`): the prompt only comes back once the wrapped
 * agent has left the foreground, even if the wrapper never printed its done
 * marker (interrupted function).
 */
export function nextAgentMarkerActive(
  current: boolean,
  events: ShellIntegrationEvent[],
): boolean {
  let active = current;
  for (const event of events) {
    if (event.type === "agent-start") {
      active = true;
    } else if (event.type === "agent-done" || event.type === "running-done") {
      active = false;
    }
  }
  return active;
}

export function inferTmuxRuntimeState({
  paneCurrentCommand,
  processTree = [],
  previousCapture = "",
  capture = "",
  previousState = {
    running: false,
    lastExitCode: null,
    agentName: null,
    agentState: null,
  },
  hasUserPrompted = false,
  agentMarkerActive = false,
}: {
  paneCurrentCommand?: string | null;
  /** Agent process args under the pane; null when the read failed. */
  processTree?: string[] | null;
  previousCapture?: string | null;
  capture?: string | null;
  previousState?: TmuxRuntimeState;
  hasUserPrompted?: boolean;
  /** An explicit agent;start marker is open (see nextAgentMarkerActive). */
  agentMarkerActive?: boolean;
}): TmuxRuntimeState {
  const safeCapture = capture || "";
  const parsedCapture = parseShellIntegrationChunk(safeCapture);
  const hasRunningMarkers = parsedCapture.events.some(
    (event) => event.type === "running-start" || event.type === "running-done",
  );
  const hasAgentMarkers = parsedCapture.events.some(
    (event) => event.type === "agent-start" || event.type === "agent-done",
  );
  const recoveredState = inferRecoveredTmuxRuntimeState({
    paneCurrentCommand,
    processTree: processTree || [],
    capture: safeCapture,
  });

  // A previous agent that nothing confirms any more (no process, no pane
  // command, no open marker) is kept only until the miss count reaches
  // AGENT_MISSING_SAMPLES_TO_CLEAR. A sample is inconclusive when tmux gave
  // no pane command or the process tree read failed; it neither counts nor
  // resets.
  const sampleConclusive =
    String(paneCurrentCommand || "").trim().length > 0 && processTree !== null;
  const previousMisses = previousState.agentMissedSamples || 0;
  let agentMissedSamples = 0;
  let carriedAgentName = previousState.agentName;
  if (
    !hasAgentMarkers &&
    !recoveredState.agentName &&
    previousState.agentName &&
    !agentMarkerActive
  ) {
    agentMissedSamples = sampleConclusive ? previousMisses + 1 : previousMisses;
    if (agentMissedSamples >= AGENT_MISSING_SAMPLES_TO_CLEAR) {
      carriedAgentName = null;
      agentMissedSamples = 0;
    }
  }

  const running = hasRunningMarkers
    ? parsedCapture.state.running
    : recoveredState.running || previousState.running;
  const lastExitCode = hasRunningMarkers
    ? parsedCapture.state.lastExitCode
    : previousState.lastExitCode;
  const recoveredAgentName = recoveredState.agentName || carriedAgentName;
  const agentName = hasAgentMarkers
    ? parsedCapture.state.agentName
    : recoveredAgentName;
  const baseAgentState = hasAgentMarkers
    ? parsedCapture.state.agentState
    : recoveredState.agentState ||
      (recoveredAgentName === previousState.agentName
        ? previousState.agentState
        : null);

  if (!agentName) {
    return {
      running,
      lastExitCode,
      agentName: null,
      agentState: null,
      agentMissedSamples: 0,
    };
  }

  const classifiedState = inferPolledTmuxAgentState({
    agentName,
    previousCapture,
    capture: safeCapture,
  });
  const currentAgentState =
    previousState.agentName === agentName
      ? previousState.agentState
      : baseAgentState;
  const agentState =
    resolveAgentOutputState({
      currentState: currentAgentState,
      classifiedState,
      hasUserPrompted: hasAgentMarkers ? hasUserPrompted : true,
    }) || baseAgentState;

  return {
    running,
    lastExitCode,
    agentName,
    agentState,
    agentMissedSamples,
  };
}

export async function getTerminalTelemetry(
  terminal: TelemetryTerminal,
  backendMode: BackendMode,
  options: GetTerminalTelemetryOptions = {},
): Promise<TerminalTelemetry> {
  const now = options.now ?? Date.now();
  const ageMs = Math.max(0, now - terminal.createdAt);
  const activityAgeMs = Math.max(0, now - terminal.lastActivityAt);
  const hasDistinctActivity = terminal.lastActivityAt > terminal.createdAt;
  const hasRecentActivity =
    hasDistinctActivity && activityAgeMs <= BUSY_ACTIVITY_WINDOW_MS;
  const hasRecentBootstrapOutput =
    !hasDistinctActivity &&
    ageMs <= BUSY_BOOTSTRAP_WINDOW_MS &&
    terminal.scrollback.length > 0;
  let isWorktree = false;
  let projectRoot: string | null = null;

  if (options.detectWorktree) {
    try {
      isWorktree = await options.detectWorktree(terminal.cwd);
    } catch {
      isWorktree = false;
    }
  }
  if (options.detectProjectRoot) {
    try {
      projectRoot = await options.detectProjectRoot(terminal.cwd);
    } catch {
      projectRoot = null;
    }
  }

  return {
    busy:
      Boolean(terminal.running) ||
      hasRecentActivity ||
      hasRecentBootstrapOutput,
    running: Boolean(terminal.running),
    lastExitCode:
      typeof terminal.lastExitCode === "number" ? terminal.lastExitCode : null,
    agentName: terminal.agentName || null,
    agentState: terminal.agentState || null,
    ports: extractPortsFromScrollback(terminal.scrollback),
    isWorktree,
    projectRoot,
    backendMode,
  };
}

export function parseShellIntegrationChunk(
  chunk: string,
  state: ShellIntegrationParseState = {
    carry: "",
    running: false,
    lastExitCode: null,
    agentName: null,
    agentState: null,
  },
): {
  output: string;
  events: ShellIntegrationEvent[];
  state: ShellIntegrationParseState;
} {
  const input = `${state.carry || ""}${chunk || ""}`;
  const events: ShellIntegrationEvent[] = [];
  const codexWasActive = state.agentName === "codex";
  let output = "";
  let cursor = 0;
  let running = state.running;
  let lastExitCode = state.lastExitCode;
  let agentName = state.agentName;
  let agentState = state.agentState;
  let carry = "";

  while (cursor < input.length) {
    const prefixIndex = input.indexOf(SHELL_MARKER_PREFIX, cursor);
    if (prefixIndex === -1) {
      output += input.slice(cursor);
      cursor = input.length;
      break;
    }

    output += input.slice(cursor, prefixIndex);
    const payloadStart = prefixIndex + SHELL_MARKER_PREFIX.length;
    const suffixIndex = input.indexOf(SHELL_MARKER_SUFFIX, payloadStart);
    if (suffixIndex === -1) {
      carry = input.slice(prefixIndex);
      cursor = input.length;
      break;
    }

    const payload = input.slice(payloadStart, suffixIndex);
    if (payload === "running;start") {
      running = true;
      lastExitCode = null;
      events.push({ type: "running-start" });
    } else if (payload.startsWith("running;done;")) {
      const codeValue = Number.parseInt(
        payload.slice("running;done;".length),
        10,
      );
      const exitCode = Number.isFinite(codeValue) ? codeValue : null;
      running = false;
      lastExitCode = exitCode;
      events.push({ type: "running-done", exitCode });
    } else if (payload.startsWith("agent;")) {
      const [, rawAgentName, action, rawExitCode, ...rest] = payload.split(";");
      const normalizedAgentName = normalizeAgentName(rawAgentName || "");
      if (!normalizedAgentName) {
        output += input.slice(
          prefixIndex,
          suffixIndex + SHELL_MARKER_SUFFIX.length,
        );
      } else if (action === "start") {
        agentName = normalizedAgentName;
        agentState = "thinking";
        // S3: exactly one extra field, `sid=<uuid>`. Anything else (more
        // fields, a non-UUID) is dropped; the start itself still counts.
        const sessionId = parseAgentStartSessionId(rawExitCode, rest);
        events.push(
          sessionId
            ? { type: "agent-start", agentName: normalizedAgentName, sessionId }
            : { type: "agent-start", agentName: normalizedAgentName },
        );
      } else if (action === "done") {
        const codeValue = Number.parseInt(rawExitCode || "", 10);
        const exitCode = Number.isFinite(codeValue) ? codeValue : null;
        agentName = null;
        agentState = null;
        lastExitCode = exitCode;
        events.push({
          type: "agent-done",
          agentName: normalizedAgentName,
          exitCode,
        });
      } else {
        output += input.slice(
          prefixIndex,
          suffixIndex + SHELL_MARKER_SUFFIX.length,
        );
      }
    } else if (payload.startsWith("tool;")) {
      const toolEvent =
        payload.length <= TOOL_MARKER_MAX_PAYLOAD_LENGTH
          ? parseToolMarkerPayload(payload)
          : null;
      if (toolEvent) {
        events.push(toolEvent);
      } else {
        output += input.slice(
          prefixIndex,
          suffixIndex + SHELL_MARKER_SUFFIX.length,
        );
      }
    } else {
      output += input.slice(
        prefixIndex,
        suffixIndex + SHELL_MARKER_SUFFIX.length,
      );
    }

    cursor = suffixIndex + SHELL_MARKER_SUFFIX.length;
  }

  // Codex keeps its TUI process alive between turns. Its exact turn boundary
  // is the title reset from a braille-spinner title to the plain workspace
  // title. Keep the OSC bytes in output for xterm; this event is metadata only.
  if (codexWasActive && hasCodexTurnCompleteTitle(input)) {
    events.push({ type: "agent-turn-complete", agentName: "codex" });
  }

  return {
    output,
    events,
    state: {
      carry,
      running,
      lastExitCode,
      agentName,
      agentState,
    },
  };
}

export function createGitWorktreeDetector(options: {
  resolveAllowedPath: (inputPath: string) => Promise<string | null>;
  now?: () => number;
  cacheTtlMs?: number;
  runGit?: (cwd: string, args: string[]) => Promise<GitCommandResult>;
}): WorktreeDetector {
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? WORKTREE_CACHE_TTL_MS;
  const runGit = options.runGit ?? runGitCommand;

  return async (cwd: string) => {
    const resolvedCwd = await options.resolveAllowedPath(cwd);
    if (!resolvedCwd) return false;

    const commonDirResult = await runGit(resolvedCwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    if (commonDirResult.exitCode !== 0) {
      return false;
    }

    const commonDir = commonDirResult.stdout.trim();
    if (!commonDir) {
      return false;
    }

    const linkedRoots = await getLinkedWorktreeRoots(
      resolvedCwd,
      commonDir,
      now(),
      cacheTtlMs,
      runGit,
    );

    return linkedRoots.some(
      (root) => resolvedCwd === root || resolvedCwd.startsWith(`${root}/`),
    );
  };
}

// The Agents panel groups sessions by project: the git top level of the
// session's cwd (`git rev-parse --show-toplevel`, hardened read-only). Runs
// only for a cwd inside the allowed roots, and reports the top level only when
// it is inside them too; null otherwise (the panel then groups by cwd).
// Cached per cwd for PROJECT_ROOT_CACHE_TTL_MS, misses included, and
// concurrent polls share one git run.
export function createGitProjectRootDetector(options: {
  resolveAllowedPath: (inputPath: string) => Promise<string | null>;
  now?: () => number;
  cacheTtlMs?: number;
  runGit?: GitRunner;
}): ProjectRootDetector {
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? PROJECT_ROOT_CACHE_TTL_MS;
  const runGit = options.runGit ?? runGitCommand;
  const cache = new Map<
    string,
    { expiresAt: number; value: Promise<string | null> }
  >();

  async function detect(cwd: string): Promise<string | null> {
    const resolvedCwd = await options.resolveAllowedPath(cwd);
    if (!resolvedCwd) return null;
    const { argv, env } = hardenGitInvocation(["rev-parse", "--show-toplevel"]);
    const result = await runGit(resolvedCwd, argv, env);
    if (result.exitCode !== 0) return null;
    const topLevel = result.stdout.trim();
    if (!topLevel || topLevel.includes("\n")) return null;
    return (await options.resolveAllowedPath(topLevel)) ? topLevel : null;
  }

  return (cwd: string) => {
    const key = String(cwd || "");
    if (!key) return Promise.resolve(null);
    const at = now();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > at) return cached.value;
    for (const [entryKey, entry] of cache) {
      if (entry.expiresAt <= at) cache.delete(entryKey);
    }
    const value = detect(key).catch(() => null);
    cache.set(key, { expiresAt: at + cacheTtlMs, value });
    return value;
  };
}

function extractPortsFromScrollback(scrollback: string[]): number[] {
  const sample = scrollback.slice(-MAX_SCROLLBACK_CHUNKS).join("");
  if (!sample) return [];

  const ports = new Set<number>();

  for (const pattern of PORT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of sample.matchAll(pattern)) {
      const port = Number.parseInt(match[1] || "", 10);
      if (Number.isInteger(port) && port >= 1 && port <= 65535) {
        ports.add(port);
      }
    }
  }

  return Array.from(ports).sort((a, b) => a - b);
}

async function getLinkedWorktreeRoots(
  cwd: string,
  commonDir: string,
  now: number,
  cacheTtlMs: number,
  runGit: (cwd: string, args: string[]) => Promise<GitCommandResult>,
): Promise<string[]> {
  const cached = worktreeCache.get(commonDir);
  if (cached && cached.expiresAt > now) {
    return cached.linkedRoots;
  }

  const worktreeListResult = await runGit(cwd, [
    "worktree",
    "list",
    "--porcelain",
  ]);
  if (worktreeListResult.exitCode !== 0) {
    worktreeCache.delete(commonDir);
    return [];
  }

  const mainRoot = dirname(commonDir);
  const linkedRoots = worktreeListResult.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter((root) => root && root !== mainRoot);

  worktreeCache.set(commonDir, {
    expiresAt: now + cacheTtlMs,
    linkedRoots,
  });

  return linkedRoots;
}

function detectRecoveredAgentName(values: string[]): AgentName | null {
  for (const value of values) {
    if (!value) continue;
    for (const [agentName, pattern] of RECOVERED_AGENT_CMD_PATTERNS) {
      if (pattern.test(value)) {
        return agentName;
      }
    }
  }
  return null;
}

async function runGitCommand(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<GitCommandResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    // git runs in a user's repo (config, hooks, fsmonitor): no service secrets.
    env: { ...sanitizeTerminalEnv(process.env), ...extraEnv },
  });

  const timeoutId = setTimeout(() => proc.kill(), GIT_COMMAND_TIMEOUT_MS);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Terminal notification escapes
//
// Agents and tools ask the hosting terminal for attention with OSC
// notification sequences. DeckTerm reads them from the raw pane output (the
// tmux pipe log, or the raw PTY stream), next to — but independent of — the
// DeckTerm 9;9 markers parsed above:
//
//   OSC 9 ; <text>                     iTerm2 / Ghostty / WezTerm notification
//                                      (Claude Code `preferredNotifChannel:
//                                      "iterm2"`, Codex `tui.notifications`)
//   OSC 777 ; notify ; <title> ; <body> urxvt / Ghostty / Warp notification
//                                      (Claude Code `"ghostty"`)
//   OSC 99 ; <k=v:...> ; <payload>     kitty notification (`"kitty"`), minimal:
//                                      title/body payloads, d=0 chunking, e=1
//   OSC 9 ; 4 ; <state> ; <percent>    ConEmu / Windows Terminal progress
//
// Numeric OSC 9 subcommands (ConEmu 9;1..9;12, DeckTerm's own 9;9) are never
// notifications. Inside tmux both Claude Code and Codex wrap the sequence in
// a `ESC P tmux; ... ESC \` passthrough envelope, which is unwrapped here.
// Everything is untrusted in-band data: bounded carry, sanitized text, and a
// per-session rate limit in applyTerminalNotificationEvents.
// ---------------------------------------------------------------------------

export type AttentionKind = "needs-input" | "done" | "error" | "info";
export type TerminalProgressState =
  "normal" | "error" | "indeterminate" | "paused";

export type TerminalNotificationEvent =
  | {
      type: "notify";
      source: "osc9" | "osc777" | "osc99";
      title: string;
      body: string;
    }
  | {
      type: "progress";
      state: TerminalProgressState | null;
      percent: number | null;
    };

type KittyPending = { id: string; title: string; body: string };

export type TerminalNotificationParseState = {
  carry: string;
  kitty: KittyPending | null;
};

// Where an attention came from: the agent's own notification (OSC 9/777/99),
// DeckTerm's screen rules, or the agent's window title.
export type AttentionSource = "notification" | "screen" | "title";

export type TerminalAttention = {
  kind: AttentionKind;
  title: string;
  body: string;
  at: number;
  seq: number;
  source?: AttentionSource;
  /** Rule id when `source` is `screen` or `title`. */
  rule?: string;
};

export type TerminalProgress = {
  state: TerminalProgressState;
  percent: number | null;
  at: number;
};

export type AttentionTracker = {
  attention: TerminalAttention | null;
  progress: TerminalProgress | null;
  lastAcceptedAt: number;
  lastAcceptedKind: AttentionKind | null;
};

const NOTIFICATION_MAX_SEQUENCE_LENGTH = 8192;
const NOTIFICATION_TEXT_MAX_CHARS = 200;
const KITTY_PENDING_MAX_LENGTH = 2048;
const ATTENTION_RATE_WINDOW_MS = 2_000;
const TMUX_PASSTHROUGH_PREFIX = "\x1bPtmux;";
const NOTIFICATION_CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f​-‏‪-‮⁦-⁩﻿]/g;
const KITTY_ID_RE = /^[A-Za-z0-9_+.-]{0,64}$/;
const PROGRESS_STATES: Record<string, TerminalProgressState | null> = {
  "0": null,
  "1": "normal",
  "2": "error",
  "3": "indeterminate",
  "4": "paused",
};
const ATTENTION_PRIORITY: Record<AttentionKind, number> = {
  info: 1,
  done: 2,
  error: 3,
  "needs-input": 4,
};

// Texts come from the official sources: Claude Code Notification messages
// ("Claude needs your permission…", "Claude is waiting for your input") and
// Codex TUI notifications (codex-rs/tui/src/chatwidget/notifications.rs:
// "Approval requested: …", "Codex wants to edit …", "Question: …",
// "Plan mode prompt: …", and the agent-turn-complete preview).
const NEEDS_INPUT_PATTERNS = [
  /permission/i,
  /\bapprov(?:al|e)\b/i,
  /\bwaiting for (?:your )?(?:input|response|reply|answer)/i,
  /\bneeds? (?:your )?(?:input|attention|approval|response|answer)\b/i,
  /\b(?:input|action|attention|response) (?:is )?(?:needed|required)\b/i,
  /\bwants to (?:edit|run|write|delete)\b/i,
  /^question\b/i,
  /\bplan mode prompt\b/i,
  /\bconfirm(?:ation)?\b/i,
];
const ERROR_PATTERN =
  /\b(?:error|errors|failed|failure|fatal|crash(?:ed)?|exception|panic(?:ked)?)\b/i;
const DONE_PATTERN =
  /\b(?:complete|completed|finished|done|succeeded|success|successful(?:ly)?|ready)\b/i;

export function sanitizeNotificationText(input: string): string {
  const cleaned = String(input || "")
    .replace(/[\t\n\r\v\f]/g, " ")
    .replace(NOTIFICATION_CONTROL_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(cleaned);
  return chars.length > NOTIFICATION_TEXT_MAX_CHARS
    ? chars.slice(0, NOTIFICATION_TEXT_MAX_CHARS).join("")
    : cleaned;
}

export function classifyAttentionText(
  { title, body }: { title: string; body: string },
  { agentName = null }: { agentName?: AgentName | null } = {},
): AttentionKind {
  const text = `${title || ""} ${body || ""}`.trim();
  if (!text) return "info";
  if (NEEDS_INPUT_PATTERNS.some((pattern) => pattern.test(text))) {
    return "needs-input";
  }
  // Codex only sends approval/question prompts (handled above) and the
  // agent-turn-complete preview, whose text is the agent's own reply.
  if (agentName === "codex") return "done";
  if (ERROR_PATTERN.test(text)) return "error";
  if (DONE_PATTERN.test(text)) return "done";
  return "info";
}

export function createTerminalNotificationParseState(): TerminalNotificationParseState {
  return { carry: "", kitty: null };
}

export function createAttentionTracker(): AttentionTracker {
  return {
    attention: null,
    progress: null,
    lastAcceptedAt: 0,
    lastAcceptedKind: null,
  };
}

function parseProgressPayload(
  payload: string,
): TerminalNotificationEvent | null {
  // payload = "4;<state>[;<percent>]"
  const [, rawState = "", rawPercent = ""] = payload.split(";");
  if (!Object.prototype.hasOwnProperty.call(PROGRESS_STATES, rawState)) {
    return null;
  }
  const state = PROGRESS_STATES[rawState];
  if (!state) return { type: "progress", state: null, percent: null };
  if (state === "indeterminate") {
    return { type: "progress", state, percent: null };
  }
  const parsed = /^\d{1,6}$/.test(rawPercent)
    ? Number.parseInt(rawPercent, 10)
    : null;
  return {
    type: "progress",
    state,
    percent: parsed === null ? null : Math.max(0, Math.min(100, parsed)),
  };
}

const PROGRESS_STATE_CODES: Record<TerminalProgressState, string> = {
  normal: "1",
  error: "2",
  indeterminate: "3",
  paused: "4",
};

/**
 * Rebuilds a parsed OSC 9;4 progress event as `4;<state>[;<percent>]`, the
 * input of herdr's `osc_progress` screen-rule region (`4;0` = cleared).
 */
export function formatProgressPayload(
  event: Extract<TerminalNotificationEvent, { type: "progress" }>,
): string {
  if (!event.state) return "4;0";
  const code = PROGRESS_STATE_CODES[event.state];
  return event.percent === null ? `4;${code}` : `4;${code};${event.percent}`;
}

function capRaw(value: string): string {
  return value.length > KITTY_PENDING_MAX_LENGTH
    ? value.slice(0, KITTY_PENDING_MAX_LENGTH)
    : value;
}

function handleKittyPayload(
  rest: string,
  state: TerminalNotificationParseState,
): TerminalNotificationEvent | null {
  const separator = rest.indexOf(";");
  if (separator === -1) return null;
  const metadata = rest.slice(0, separator);
  let payload = rest.slice(separator + 1);
  const meta: Record<string, string> = {};
  for (const pair of metadata.split(":")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    meta[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  const id = KITTY_ID_RE.test(meta.i || "") ? meta.i || "" : "";
  const payloadType = meta.p || "title";
  if (payloadType !== "title" && payloadType !== "body") return null;
  if (meta.e === "1") {
    if (!BASE64_RE.test(payload)) return null;
    try {
      payload = Buffer.from(payload, "base64").toString("utf8");
    } catch {
      return null;
    }
  }

  const pending =
    state.kitty && state.kitty.id === id
      ? state.kitty
      : { id, title: "", body: "" };
  if (payloadType === "title") pending.title = capRaw(pending.title + payload);
  else pending.body = capRaw(pending.body + payload);

  if (meta.d === "0") {
    state.kitty = pending;
    return null;
  }
  state.kitty = null;
  const title = sanitizeNotificationText(pending.title);
  const body = sanitizeNotificationText(pending.body);
  if (!title && !body) return null;
  return { type: "notify", source: "osc99", title, body };
}

function handleOscPayload(
  payload: string,
  state: TerminalNotificationParseState,
): TerminalNotificationEvent | null {
  if (payload.startsWith("9;")) {
    const rest = payload.slice(2);
    if (rest.startsWith("4;")) return parseProgressPayload(rest);
    // ConEmu numeric subcommands, DeckTerm's own 9;9 markers.
    if (/^\d+(?:;|$)/.test(rest)) return null;
    const body = sanitizeNotificationText(rest);
    return body ? { type: "notify", source: "osc9", title: "", body } : null;
  }
  if (payload.startsWith("777;notify;")) {
    const rest = payload.slice("777;notify;".length);
    const separator = rest.indexOf(";");
    const title = sanitizeNotificationText(
      separator === -1 ? rest : rest.slice(0, separator),
    );
    const body = sanitizeNotificationText(
      separator === -1 ? "" : rest.slice(separator + 1),
    );
    return title || body
      ? { type: "notify", source: "osc777", title, body }
      : null;
  }
  if (payload.startsWith("99;")) {
    return handleKittyPayload(payload.slice(3), state);
  }
  return null;
}

// Scans `input` for notification sequences, pushing events. Returns the
// unterminated tail to carry into the next chunk ("" when nothing is pending
// or when `allowCarry` is false, as for an unwrapped tmux passthrough body).
function scanNotificationInput(
  input: string,
  state: TerminalNotificationParseState,
  events: TerminalNotificationEvent[],
  allowCarry: boolean,
): string {
  let cursor = 0;
  while (cursor < input.length) {
    const escIndex = input.indexOf("\x1b", cursor);
    if (escIndex === -1) return "";
    if (escIndex + 1 >= input.length) {
      return allowCarry ? input.slice(escIndex) : "";
    }
    const introducer = input[escIndex + 1];

    if (introducer === "]") {
      const payloadStart = escIndex + 2;
      let end = -1;
      let terminatorLength = 0;
      let incomplete = false;
      for (let i = payloadStart; i < input.length; i++) {
        const ch = input[i];
        if (ch === "\x07") {
          end = i;
          terminatorLength = 1;
          break;
        }
        if (ch === "\x1b") {
          if (i + 1 >= input.length) {
            incomplete = true;
          } else if (input[i + 1] === "\\") {
            end = i;
            terminatorLength = 2;
          } else {
            // ESC that is not ST aborts the OSC; rescan from that ESC.
            end = -2;
            cursor = i;
          }
          break;
        }
        if (i - escIndex > NOTIFICATION_MAX_SEQUENCE_LENGTH) {
          end = -3;
          break;
        }
      }
      if (end === -2) continue;
      if (end === -3) {
        // Oversized: drop it. Its eventual terminator arrives as plain text.
        cursor = escIndex + 2;
        const next = input.indexOf("\x1b", cursor);
        if (next === -1) return "";
        cursor = next;
        continue;
      }
      if (end === -1 || incomplete) {
        if (!allowCarry) return "";
        const pending = input.slice(escIndex);
        return pending.length > NOTIFICATION_MAX_SEQUENCE_LENGTH ? "" : pending;
      }
      const event = handleOscPayload(input.slice(payloadStart, end), state);
      if (event) events.push(event);
      cursor = end + terminatorLength;
      continue;
    }

    if (introducer === "P") {
      const head = input.slice(
        escIndex,
        escIndex + TMUX_PASSTHROUGH_PREFIX.length,
      );
      if (head.length < TMUX_PASSTHROUGH_PREFIX.length) {
        if (TMUX_PASSTHROUGH_PREFIX.startsWith(head)) {
          return allowCarry ? input.slice(escIndex) : "";
        }
        cursor = escIndex + 2;
        continue;
      }
      if (head !== TMUX_PASSTHROUGH_PREFIX) {
        cursor = escIndex + 2;
        continue;
      }
      let inner = "";
      let i = escIndex + TMUX_PASSTHROUGH_PREFIX.length;
      let status: "done" | "incomplete" | "abort" = "incomplete";
      while (i < input.length) {
        const ch = input[i];
        if (ch === "\x1b") {
          if (i + 1 >= input.length) break;
          const next = input[i + 1];
          if (next === "\x1b") {
            inner += "\x1b";
            i += 2;
            continue;
          }
          if (next === "\\") {
            status = "done";
            i += 2;
            break;
          }
          status = "abort";
          break;
        }
        inner += ch;
        i++;
        if (inner.length > NOTIFICATION_MAX_SEQUENCE_LENGTH) {
          status = "abort";
          break;
        }
      }
      if (status === "incomplete") {
        if (!allowCarry) return "";
        const pending = input.slice(escIndex);
        return pending.length > NOTIFICATION_MAX_SEQUENCE_LENGTH ? "" : pending;
      }
      if (status === "abort") {
        cursor = escIndex + 2;
        continue;
      }
      scanNotificationInput(inner, state, events, false);
      cursor = i;
      continue;
    }

    cursor = escIndex + 1;
  }
  return "";
}

export function parseTerminalNotifications(
  chunk: string,
  state: TerminalNotificationParseState = createTerminalNotificationParseState(),
): {
  events: TerminalNotificationEvent[];
  state: TerminalNotificationParseState;
} {
  const nextState: TerminalNotificationParseState = {
    carry: "",
    kitty: state.kitty ? { ...state.kitty } : null,
  };
  const events: TerminalNotificationEvent[] = [];
  const input = `${state.carry || ""}${chunk || ""}`;
  // Fast path: nothing escape-like at all.
  if (input.indexOf("\x1b") === -1) {
    return { events, state: nextState };
  }
  nextState.carry = scanNotificationInput(input, nextState, events, true);
  return { events, state: nextState };
}

export function applyTerminalNotificationEvents(
  tracker: AttentionTracker,
  events: TerminalNotificationEvent[],
  {
    now = Date.now(),
    agentName = null,
  }: { now?: number; agentName?: AgentName | null } = {},
): { tracker: AttentionTracker; accepted: TerminalAttention[] } {
  const next: AttentionTracker = { ...tracker };
  const accepted: TerminalAttention[] = [];
  for (const event of events) {
    if (event.type === "progress") {
      next.progress = event.state
        ? { state: event.state, percent: event.percent, at: now }
        : null;
      continue;
    }
    const kind = classifyAttentionText(event, { agentName });
    const withinWindow =
      next.lastAcceptedKind !== null &&
      now - next.lastAcceptedAt < ATTENTION_RATE_WINDOW_MS;
    if (
      withinWindow &&
      ATTENTION_PRIORITY[kind] <= ATTENTION_PRIORITY[next.lastAcceptedKind!]
    ) {
      continue;
    }
    const previousSeq = next.attention?.seq || 0;
    // Wall-clock based so a server restart never hands out a seq the browser
    // already marked as seen; +1 keeps it strictly monotonic.
    const attention: TerminalAttention = {
      kind,
      title: event.title,
      body: event.body,
      at: now,
      seq: Math.max(previousSeq + 1, now),
      source: "notification",
    };
    next.attention = attention;
    next.lastAcceptedAt = now;
    next.lastAcceptedKind = kind;
    accepted.push(attention);
  }
  return { tracker: next, accepted };
}

// ---------------------------------------------------------------------------
// Agent attention raised by DeckTerm itself (window title, screen rules).
// Same seq rule (wall clock, strictly increasing) and the same 2 s priority
// window as applyTerminalNotificationEvents. Title and body stay empty so
// toasts and pushes use their generic text.
// ---------------------------------------------------------------------------

export function applyAgentAttention(
  tracker: AttentionTracker,
  kind: AttentionKind,
  {
    now = Date.now(),
    source,
    rule,
    resolvesBlocked = false,
  }: {
    now?: number;
    source: AttentionSource;
    rule?: string | null;
    /** A screen-proven end of the prompt: bypass the priority window. */
    resolvesBlocked?: boolean;
  },
): { tracker: AttentionTracker; accepted: TerminalAttention | null } {
  const withinWindow =
    tracker.lastAcceptedKind !== null &&
    now - tracker.lastAcceptedAt < ATTENTION_RATE_WINDOW_MS;
  if (
    !resolvesBlocked &&
    withinWindow &&
    ATTENTION_PRIORITY[kind] <= ATTENTION_PRIORITY[tracker.lastAcceptedKind!]
  ) {
    return { tracker, accepted: null };
  }
  const previousSeq = tracker.attention?.seq || 0;
  const attention: TerminalAttention = {
    kind,
    title: "",
    body: "",
    at: now,
    seq: Math.max(previousSeq + 1, now),
    source,
  };
  if (rule) attention.rule = rule;
  return {
    tracker: {
      ...tracker,
      attention,
      lastAcceptedAt: now,
      lastAcceptedKind: kind,
    },
    accepted: attention,
  };
}

// ---------------------------------------------------------------------------
// Window title (OSC 0 / OSC 2). Read from the same raw source as the
// notifications (the tmux pipe log, or the raw PTY stream). Untrusted in-band
// text: control and bidi characters removed, capped at 256 characters.
// ---------------------------------------------------------------------------

export const OSC_TITLE_MAX_CHARS = 256;
const OSC_TITLE_CARRY_MAX = 1024;
const OSC_TITLE_RE = /\x1b\]([02]);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
// A possibly unterminated title sequence at the end of a chunk.
const OSC_TITLE_PARTIAL_RE = /^\x1b\](?:[02](?:;[^\x07\x1b]*\x1b?)?)?$/;

export type OscTitleParseState = { carry: string };

export function createOscTitleParseState(): OscTitleParseState {
  return { carry: "" };
}

export function sanitizeOscTitle(input: string): string {
  const cleaned = String(input || "")
    .replace(/[\t\n\r\v\f]/g, " ")
    .replace(NOTIFICATION_CONTROL_RE, "");
  const chars = Array.from(cleaned);
  return chars.length > OSC_TITLE_MAX_CHARS
    ? chars.slice(0, OSC_TITLE_MAX_CHARS).join("")
    : cleaned;
}

/**
 * Returns the latest complete OSC 0/2 title in `chunk` (BEL or ST ended),
 * sanitized, or `null` when the chunk sets none. An unterminated title at the
 * end is carried into the next chunk (bounded).
 */
export function parseLatestOscTitle(
  chunk: string,
  state: OscTitleParseState = createOscTitleParseState(),
): { title: string | null; state: OscTitleParseState } {
  const input = `${state.carry || ""}${chunk || ""}`;
  if (input.indexOf("\x1b") === -1) {
    return { title: null, state: { carry: "" } };
  }
  let latest: string | null = null;
  let lastEnd = 0;
  for (const match of input.matchAll(OSC_TITLE_RE)) {
    latest = match[2] ?? "";
    lastEnd = (match.index ?? 0) + match[0].length;
  }
  let carry = "";
  const oscStart = input.lastIndexOf("\x1b]");
  const oscTail = oscStart >= lastEnd ? input.slice(oscStart) : "";
  if (
    oscTail &&
    oscTail.length <= OSC_TITLE_CARRY_MAX &&
    OSC_TITLE_PARTIAL_RE.test(oscTail)
  ) {
    carry = oscTail;
  } else if (input.endsWith("\x1b") && input.length - 1 >= lastEnd) {
    carry = "\x1b";
  }
  return {
    title: latest === null ? null : sanitizeOscTitle(latest),
    state: { carry },
  };
}
