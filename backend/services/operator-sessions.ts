// Operator sessions (design docs/plans/2026-11-14-operator-sessions-panel-design.md).
//
// An operator is a long-lived Claude Code session the owner starts with
// `operator-tmux start <name> …` outside DeckTerm: a systemd unit of its own
// and a tmux server of its own on the socket `op-<name>` in the service
// user's tmux socket folder, with one session `<name>`. DeckTerm only OBSERVES
// them (list, read the visible screen in memory) and gives the owner a
// terminal that is an attached tmux client. It never starts, stops, kills or
// types into one.
//
// Operator servers run the SYSTEM tmux (3.4) while DeckTerm's panes run a
// private 3.8, and a client of one version cannot talk to a server of the
// other: every call here uses the configured binary by its full path and an
// explicit socket path (-S), never `tmux` from PATH, never a shell string.

import { lstat, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { RuleAgent, ScreenRuleInput, ScreenRuleResult } from "../agent-screen-rules";
import {
  collectProcessTreeArgs,
  type ProcessSnapshot,
} from "./runtime-sync-cache";

/** The pattern `operator-tmux` itself enforces for a name. */
export const OPERATOR_NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const OPERATOR_SOCKET_PREFIX = "op-";
/** One discovery is shared by every poll of every actor for this long. */
export const OPERATOR_DISCOVERY_TTL_MS = 3_000;
/** Per tmux call; a wedged operator server must not stall a poll. */
export const OPERATOR_TMUX_TIMEOUT_MS = 2_000;
/** At most this many sockets are probed per discovery. */
export const OPERATOR_MAX_CANDIDATES = 64;

const SAFE_PATH_RE = /^\/[A-Za-z0-9._/-]*$/;

export function isValidOperatorName(value: unknown): value is string {
  return typeof value === "string" && OPERATOR_NAME_RE.test(value);
}

export type OperatorConfig = {
  /** Absolute folder that holds the `op-<name>` sockets. */
  dir: string;
  /** Absolute path of the tmux binary the operator servers run. */
  tmuxBin: string;
  /** Unix uid that must own every socket (the service user). */
  uid: number;
};

/**
 * Reads DECKTERM_OPERATOR_TMUX_DIR (default `/tmp/tmux-<uid>`, tmux's default
 * for `-L` without TMUX_TMPDIR) and DECKTERM_OPERATOR_TMUX_BIN (default
 * `/usr/bin/tmux`). Null when a value is not a plain absolute path, so the
 * feature is off rather than pointed somewhere odd.
 */
export function resolveOperatorConfig(
  env: Record<string, string | undefined>,
  uid: number,
): OperatorConfig | null {
  if (!Number.isInteger(uid) || uid < 0) return null;
  const dir = (env.DECKTERM_OPERATOR_TMUX_DIR || `/tmp/tmux-${uid}`).trim();
  const tmuxBin = (env.DECKTERM_OPERATOR_TMUX_BIN || "/usr/bin/tmux").trim();
  if (!SAFE_PATH_RE.test(dir) || dir.includes("..")) return null;
  if (!SAFE_PATH_RE.test(tmuxBin) || tmuxBin.includes("..")) return null;
  return { dir: dir.replace(/\/+$/, "") || "/", tmuxBin, uid };
}

export function operatorSocketPath(config: OperatorConfig, name: string): string {
  if (!isValidOperatorName(name)) throw new Error("invalid operator name");
  return join(config.dir, `${OPERATOR_SOCKET_PREFIX}${name}`);
}

/**
 * The attached view's pane command, as an argv (tmux runs a multi-argument
 * command with execvp, so no shell parses it). `env -u TMUX`: a tmux client
 * refuses to attach while TMUX says it already runs inside a tmux. `-u`:
 * UTF-8 output whatever the locale. `=<name>` targets that session exactly.
 */
export function buildOperatorAttachArgv(
  config: OperatorConfig,
  name: string,
): string[] {
  return [
    "/usr/bin/env",
    "-u",
    "TMUX",
    config.tmuxBin,
    "-u",
    "-S",
    operatorSocketPath(config, name),
    "attach-session",
    "-t",
    `=${name}`,
  ];
}

// --- Pure parsers -------------------------------------------------------------

export const OPERATOR_PANE_FORMAT = [
  "#{pane_active}",
  "#{pane_pid}",
  "#{window_activity}",
  "#{pane_current_path}",
  "#{pane_title}",
].join("\t");

export type OperatorPane = {
  pid: number;
  /** Milliseconds since the epoch, 0 when unknown. */
  activityAt: number;
  cwd: string;
  title: string;
};

/** The active pane from `list-panes -F OPERATOR_PANE_FORMAT`, else the first. */
export function parseOperatorPanes(output: string): OperatorPane | null {
  let first: OperatorPane | null = null;
  for (const line of String(output || "").split("\n")) {
    if (!line.trim()) continue;
    const [active, pid, activity, cwd, ...titleParts] = line.split("\t");
    const pane: OperatorPane = {
      pid: Number.parseInt(pid || "", 10) || 0,
      activityAt: (Number.parseInt(activity || "", 10) || 0) * 1000,
      cwd: String(cwd || ""),
      title: titleParts.join("\t").slice(0, 256),
    };
    if (!pane.cwd.startsWith("/")) continue;
    if (active === "1") return pane;
    first ??= pane;
  }
  return first;
}

function commandBasename(token: string | undefined): string {
  return basename(String(token || ""));
}

/**
 * Which agent runs under the pane: the first process whose program (or, for
 * an interpreter, its script) is `claude` or `codex`. Wrappers such as
 * `timeout 5h claude …` have the agent as their own child, which matches.
 */
export function detectOperatorAgent(processArgs: string[]): RuleAgent | null {
  for (const args of processArgs) {
    const tokens = String(args || "").trim().split(/\s+/);
    const program = commandBasename(tokens[0]);
    const candidates =
      program === "node" || program === "bun" ? [tokens[1]] : [tokens[0]];
    for (const token of candidates) {
      const name = commandBasename(token);
      if (name === "claude" || name === "codex") return name;
    }
  }
  return null;
}

/**
 * The operator a DeckTerm attached view is attached to, or null. Only the
 * pane's OWN process counts (DeckTerm's view execs the client as the pane
 * command; a client typed into a shell is a child of that shell, and that
 * shell's pane keeps a transcript), and only a `-S` socket in the operator
 * folder `dir`. `processArgs[0]` is the pane process (collectProcessTreeArgs).
 */
export function parseOperatorAttachClient(
  processArgs: string[],
  dir: string,
): string | null {
  for (const args of processArgs.slice(0, 1)) {
    const tokens = String(args || "").trim().split(/\s+/);
    // The tmux client itself (also when started through `env -u TMUX`).
    let start = 0;
    if (commandBasename(tokens[0]) === "env") {
      start = tokens.findIndex((t, i) => i > 0 && commandBasename(t) === "tmux");
      if (start < 0) continue;
    }
    if (commandBasename(tokens[start]) !== "tmux") continue;
    let name: string | null = null;
    let attach = false;
    for (let i = start + 1; i < tokens.length; i++) {
      const token = tokens[i]!;
      if ((token === "-L" || token === "-S") && i + 1 < tokens.length) {
        const path = tokens[i + 1]!;
        const value = basename(path);
        if (
          token === "-S" &&
          dirname(path) === dir &&
          value.startsWith(OPERATOR_SOCKET_PREFIX)
        ) {
          const candidate = value.slice(OPERATOR_SOCKET_PREFIX.length);
          if (isValidOperatorName(candidate)) name = candidate;
        }
        i += 1;
        continue;
      }
      if (token.startsWith("-")) continue;
      // The first non-option word is the tmux command.
      attach = token === "attach" || token === "attach-session" || token === "a";
      break;
    }
    if (name && attach) return name;
  }
  return null;
}

// --- Discovery -----------------------------------------------------------------

export type OperatorInfo = {
  name: string;
  cwd: string;
  agentName: RuleAgent | null;
  agentStatus: "working" | "blocked" | "idle" | null;
  agentStatusRule: string | null;
  agentRulesVersion: string | null;
  lastActivityAt: number;
};

export type OperatorRunResult = { ok: boolean; stdout: string };
export type OperatorEntryStat = { isSocket: boolean; uid: number; mode?: number };

/**
 * The socket folder is trusted only when the service uid owns it and nobody
 * else may write to it (tmux makes it 0700): a tmux client obeys its server,
 * so a server planted by another user must never be connected to.
 */
export async function operatorDirTrusted(
  deps: Pick<OperatorDiscoveryDeps, "config" | "statEntry">,
): Promise<boolean> {
  const info = await deps.statEntry(deps.config.dir).catch(() => null);
  if (!info || info.uid !== deps.config.uid) return false;
  return typeof info.mode !== "number" || (info.mode & 0o022) === 0;
}

/** The trusted folder holds `op-<name>` as a socket of the service uid. */
export async function operatorSocketTrusted(
  deps: Pick<OperatorDiscoveryDeps, "config" | "statEntry">,
  name: string,
): Promise<boolean> {
  if (!isValidOperatorName(name)) return false;
  if (!(await operatorDirTrusted(deps))) return false;
  const info = await deps
    .statEntry(operatorSocketPath(deps.config, name))
    .catch(() => null);
  return Boolean(info && info.isSocket && info.uid === deps.config.uid);
}

export type OperatorDiscoveryDeps = {
  config: OperatorConfig;
  /** Runs an argv with a timeout; never throws. */
  run(argv: string[]): Promise<OperatorRunResult>;
  readDir(dir: string): Promise<string[]>;
  /** lstat: is it a socket, who owns it, its mode. Null when missing. */
  statEntry(path: string): Promise<OperatorEntryStat | null>;
  processSnapshot(): Promise<ProcessSnapshot | null>;
  evaluate(agent: RuleAgent, input: ScreenRuleInput): ScreenRuleResult;
};

/** Socket names in the folder that look like operators and are sockets of the service uid. */
export async function listOperatorCandidates(
  deps: Pick<OperatorDiscoveryDeps, "config" | "readDir" | "statEntry">,
): Promise<string[]> {
  const { config } = deps;
  if (!(await operatorDirTrusted(deps))) return [];
  let entries: string[];
  try {
    entries = await deps.readDir(config.dir);
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries.sort()) {
    if (!entry.startsWith(OPERATOR_SOCKET_PREFIX)) continue;
    const name = entry.slice(OPERATOR_SOCKET_PREFIX.length);
    if (!isValidOperatorName(name)) continue;
    const info = await deps
      .statEntry(join(config.dir, entry))
      .catch(() => null);
    if (!info || !info.isSocket || info.uid !== config.uid) continue;
    names.push(name);
    if (names.length >= OPERATOR_MAX_CANDIDATES) break;
  }
  return names;
}

/** The running operator's pane, or null (no server, no such session, stale socket). */
export async function probeOperator(
  deps: Pick<OperatorDiscoveryDeps, "config" | "run">,
  name: string,
): Promise<OperatorPane | null> {
  if (!isValidOperatorName(name)) return null;
  const result = await deps.run([
    deps.config.tmuxBin,
    "-S",
    operatorSocketPath(deps.config, name),
    "list-panes",
    "-t",
    `=${name}:`,
    "-F",
    OPERATOR_PANE_FORMAT,
  ]);
  if (!result.ok) return null;
  return parseOperatorPanes(result.stdout);
}

/**
 * Every running operator with its folder and, when an agent runs in it, the
 * screen-rule status of its visible screen. The capture is held in memory for
 * this one evaluation only: never logged, never stored.
 */
export async function discoverOperators(
  deps: OperatorDiscoveryDeps,
): Promise<OperatorInfo[]> {
  const names = await listOperatorCandidates(deps);
  if (!names.length) return [];
  const panes = await Promise.all(
    names.map(async (name) => ({ name, pane: await probeOperator(deps, name) })),
  );
  const live = panes.filter(
    (entry): entry is { name: string; pane: OperatorPane } => entry.pane !== null,
  );
  if (!live.length) return [];
  const snapshot = await deps.processSnapshot().catch(() => null);
  return Promise.all(
    live.map(async ({ name, pane }) => {
      const tree =
        snapshot && pane.pid > 0 ? collectProcessTreeArgs(snapshot, pane.pid) : [];
      const agent = detectOperatorAgent(tree);
      const info: OperatorInfo = {
        name,
        cwd: pane.cwd,
        agentName: agent,
        agentStatus: null,
        agentStatusRule: null,
        agentRulesVersion: null,
        lastActivityAt: pane.activityAt,
      };
      if (!agent) return info;
      const capture = await deps.run([
        deps.config.tmuxBin,
        "-S",
        operatorSocketPath(deps.config, name),
        "capture-pane",
        "-p",
        "-t",
        `=${name}:`,
      ]);
      if (!capture.ok) return info;
      try {
        const result = deps.evaluate(agent, {
          screen: capture.stdout,
          title: pane.title,
        });
        if (result.state !== "unknown") {
          info.agentStatus = result.state;
          info.agentStatusRule = result.ruleId;
          info.agentRulesVersion = result.manifestVersion || null;
        }
      } catch {
        // Broken rules: no status, the row still shows (as idle).
      }
      return info;
    }),
  );
}

/** One discovery at a time, its result shared for `ttlMs`. Failures are not cached. */
export function createOperatorDiscoveryCache(
  discover: () => Promise<OperatorInfo[]>,
  { ttlMs = OPERATOR_DISCOVERY_TTL_MS, now = Date.now } = {},
) {
  let inFlight: Promise<OperatorInfo[]> | null = null;
  let last: { at: number; value: OperatorInfo[] } | null = null;
  return {
    get(): Promise<OperatorInfo[]> {
      if (last && now() - last.at < ttlMs) return Promise.resolve(last.value);
      if (inFlight) return inFlight;
      inFlight = discover()
        .then((value) => {
          last = { at: now(), value };
          return value;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
    invalidate() {
      last = null;
    },
  };
}

// --- Real dependencies ------------------------------------------------------------

/** Runs an argv (never a shell) with a timeout; stdout only on success. */
export async function runOperatorArgv(
  argv: string[],
  { timeoutMs = OPERATOR_TMUX_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<OperatorRunResult> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key === "TMUX" || key === "TMUX_PANE") continue;
    env[key] = value;
  }
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env,
    });
  } catch {
    return { ok: false, stdout: "" };
  }
  const timer = setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
  }, timeoutMs);
  try {
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      proc.exited,
    ]);
    return code === 0 ? { ok: true, stdout } : { ok: false, stdout: "" };
  } catch {
    return { ok: false, stdout: "" };
  } finally {
    clearTimeout(timer);
  }
}

export async function readOperatorDir(dir: string): Promise<string[]> {
  return readdir(dir);
}

export async function statOperatorEntry(
  path: string,
): Promise<OperatorEntryStat | null> {
  try {
    const info = await lstat(path);
    return { isSocket: info.isSocket(), uid: info.uid, mode: info.mode & 0o7777 };
  } catch {
    return null;
  }
}
