import { dirname } from "node:path";

const BUSY_ACTIVITY_WINDOW_MS = 30_000;
const BUSY_BOOTSTRAP_WINDOW_MS = 10_000;
const MAX_SCROLLBACK_CHUNKS = 200;
const GIT_COMMAND_TIMEOUT_MS = 3_000;
const WORKTREE_CACHE_TTL_MS = 5_000;
const SHELL_MARKER_PREFIX = "\x1b]9;9;deckterm;";
const SHELL_MARKER_SUFFIX = "\x07";
const TOOL_MARKER_MAX_PAYLOAD_LENGTH = 2048;
const TOOL_MARKER_NAME_RE = /^[A-Za-z][\w.-]{0,63}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
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
};

export type TerminalTelemetry = {
  busy: boolean;
  running: boolean;
  lastExitCode: number | null;
  agentName: AgentName | null;
  agentState: AgentState | null;
  ports: number[];
  isWorktree: boolean;
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
  | { type: "agent-start"; agentName: AgentName }
  | { type: "agent-done"; agentName: AgentName; exitCode: number | null }
  | { type: "tool-used"; name: string; summary: string };

type WorktreeDetector = (cwd: string) => Promise<boolean>;

type GetTerminalTelemetryOptions = {
  now?: number;
  detectWorktree?: WorktreeDetector;
};

type GitCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

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
}: {
  paneCurrentCommand?: string | null;
  processTree?: string[];
  previousCapture?: string | null;
  capture?: string | null;
  previousState?: TmuxRuntimeState;
  hasUserPrompted?: boolean;
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
    processTree,
    capture: safeCapture,
  });

  const running = hasRunningMarkers
    ? parsedCapture.state.running
    : recoveredState.running || previousState.running;
  const lastExitCode = hasRunningMarkers
    ? parsedCapture.state.lastExitCode
    : previousState.lastExitCode;
  const recoveredAgentName =
    recoveredState.agentName || previousState.agentName;
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

  if (options.detectWorktree) {
    try {
      isWorktree = await options.detectWorktree(terminal.cwd);
    } catch {
      isWorktree = false;
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
      const [, rawAgentName, action, rawExitCode] = payload.split(";");
      const normalizedAgentName = normalizeAgentName(rawAgentName || "");
      if (!normalizedAgentName) {
        output += input.slice(
          prefixIndex,
          suffixIndex + SHELL_MARKER_SUFFIX.length,
        );
      } else if (action === "start") {
        agentName = normalizedAgentName;
        agentState = "thinking";
        events.push({ type: "agent-start", agentName: normalizedAgentName });
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
): Promise<GitCommandResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
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
