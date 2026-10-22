// Environment hygiene for everything DeckTerm starts on a user's behalf.
//
// Why this exists: the backend runs with the service environment — the Web
// Push signing key (DECKTERM_VAPID_PRIVATE_KEY), the Cloudflare Access
// audience, the bootstrap admin identity, security switches such as
// DECKTERM_DANGEROUSLY_TRUST_PROXY_HEADERS. A shell spawned with
// `...process.env` inherits all of it, so any program in a DeckTerm terminal —
// an agent included — could read the push key and sign pushes, or start a
// copy of DeckTerm that silently picks up production switches.
//
// The tmux server matters as much as the shell: tmux copies the environment
// of the process that started the server into its *global* environment and
// gives that to every pane it ever creates. So the server launch path is
// sanitized too, and `scrubTmuxGlobalEnvironment` cleans a server that was
// started before this module existed.
//
// The rule is ONE explicit deny-list (exact names and prefixes) rather than an
// allow-list: shells legitimately need an open-ended set of variables
// (SSH_AUTH_SOCK, XDG_*, DBUS_*, locale, the owner's own tooling), while the
// set of DeckTerm service variables is known and lives in this repository.
// Stripping never removes something the user sets for themselves: the shell
// sources ~/.bashrc / ~/.profile after it starts, so anything exported there
// comes back. Only values that leaked in from the service are lost.
//
// Per-terminal variables DeckTerm sets deliberately are applied AFTER
// sanitizing (callers spread them on top), so a future per-terminal
// DECKTERM_* variable still reaches the shell.

export type TerminalEnv = Record<string, string | undefined>;

export type TerminalEnvDenyEntry = {
  /** Exact variable name, or a prefix when `kind` is "prefix". */
  match: string;
  kind: "exact" | "prefix";
  reason: string;
};

export const TERMINAL_ENV_DENY_LIST: readonly TerminalEnvDenyEntry[] =
  Object.freeze([
    // --- Secrets and authentication material -------------------------------
    {
      match: "DECKTERM_VAPID_",
      kind: "prefix",
      reason:
        "Web Push VAPID keys/subject: the private key signs pushes to every subscribed device.",
    },
    {
      match: "CF_ACCESS_",
      kind: "prefix",
      reason:
        "Cloudflare Access JWT validation config (audience tag, team, required flag, any secret): service-only auth material.",
    },
    // --- All other DeckTerm service configuration ---------------------------
    {
      match: "DECKTERM_",
      kind: "prefix",
      reason:
        "DeckTerm service config (bootstrap admin email + token TTL, publish mode, legacy bootstrap bypass, state dir, runtime env, OS-isolation, broker path override, proxy-trust and insecure-admin switches, e2e JWKS overrides). No shell-side consumer exists; inherited copies make a DeckTerm or test started from a terminal pick up the parent instance's security switches and state dir.",
    },
    {
      match: "PORT",
      kind: "exact",
      reason:
        "DeckTerm listen port: an inherited PORT=4173 points a dev server or test started in a terminal at the production port.",
    },
    {
      match: "HOST",
      kind: "exact",
      reason: "DeckTerm bind address; service-only.",
    },
    {
      match: "TRUSTED_ORIGINS",
      kind: "exact",
      reason: "DeckTerm CORS/origin allow-list; service-only security config.",
    },
    {
      match: "ALLOWED_FILE_ROOTS",
      kind: "exact",
      reason: "DeckTerm file-access boundary; service-only security config.",
    },
    {
      match: "TMUX_BACKEND",
      kind: "exact",
      reason: "DeckTerm backend selector; service-only.",
    },
    {
      match: "TMUX_SESSION_NAMESPACE",
      kind: "exact",
      reason:
        "DeckTerm tmux namespace: inherited, it sends a DeckTerm started from a terminal to the parent instance's socket.",
    },
    {
      match: "TMUX_REQUIRE_EXTERNAL_SERVER",
      kind: "exact",
      reason: "DeckTerm tmux-server ownership switch; service-only.",
    },
    {
      match: "MAX_TERMINALS_PER_USER",
      kind: "exact",
      reason: "DeckTerm terminal cap; service-only.",
    },
    {
      match: "TERMINAL_IDLE_TIMEOUT_MS",
      kind: "exact",
      reason: "DeckTerm idle reaper config; service-only.",
    },
    {
      match: "TERMINAL_RATE_LIMIT_",
      kind: "prefix",
      reason: "DeckTerm terminal-creation rate limits; service-only.",
    },
    {
      match: "SCROLLBACK_MAX_",
      kind: "prefix",
      reason: "DeckTerm scrollback caps; service-only.",
    },
    {
      match: "OPENCODE_WEB_",
      kind: "prefix",
      reason:
        "Legacy-named DeckTerm service config (debug, terminal caps, rate limits); service-only.",
    },
    {
      match: "AGENT_RESPONDING_IDLE_MS",
      kind: "exact",
      reason: "DeckTerm agent-badge telemetry tuning; service-only.",
    },
    {
      match: "CLAUDE_AGENT_RESPONDING_IDLE_MS",
      kind: "exact",
      reason: "DeckTerm agent-badge telemetry tuning; service-only.",
    },
  ]);

/**
 * Variables a shell needs that no deny entry may ever remove, even if a future
 * prefix happened to cover them. `LC_*` is protected as a prefix.
 */
export const TERMINAL_ENV_PROTECTED_NAMES: readonly string[] = Object.freeze([
  "PATH",
  "HOME",
  "LANG",
  "LANGUAGE",
  "SHELL",
  "TERM",
  "COLORTERM",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMUX",
  "TMUX_PANE",
  "SSH_AUTH_SOCK",
  "XDG_RUNTIME_DIR",
  "COLUMNS",
  "LINES",
]);

const PROTECTED_PREFIXES: readonly string[] = Object.freeze(["LC_"]);

export function isProtectedTerminalEnvName(name: string): boolean {
  return (
    TERMINAL_ENV_PROTECTED_NAMES.includes(name) ||
    PROTECTED_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

export function isDeniedTerminalEnvName(name: string): boolean {
  if (isProtectedTerminalEnvName(name)) return false;
  return TERMINAL_ENV_DENY_LIST.some((entry) =>
    entry.kind === "exact" ? name === entry.match : name.startsWith(entry.match),
  );
}

/**
 * Returns a NEW environment object without the denied variables. The input is
 * never mutated (callers pass process.env).
 */
export function sanitizeTerminalEnv(env: TerminalEnv): TerminalEnv {
  const clean: TerminalEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!isDeniedTerminalEnvName(name)) clean[name] = value;
  }
  return clean;
}

/** Names in `env` the deny-list would remove (names only — never values). */
export function listDeniedTerminalEnvNames(env: TerminalEnv): string[] {
  return Object.keys(env).filter(isDeniedTerminalEnvName).sort();
}

/**
 * Parses `tmux show-environment -g` output into variable names. Lines are
 * `NAME=value` for set variables and `-NAME` for ones marked removed.
 */
export function parseTmuxEnvironmentNames(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split("\n")) {
    if (!line || line.startsWith("-")) continue;
    const eq = line.indexOf("=");
    const name = eq === -1 ? line : line.slice(0, eq);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names.push(name);
  }
  return names;
}

/**
 * Builds ONE tmux client argv tail that unsets each name from the server's
 * global environment (`set-environment -g -u NAME ; …`). Empty input → [].
 */
export function buildTmuxGlobalEnvUnsetArgs(names: string[]): string[] {
  const args: string[] = [];
  for (const name of names) {
    if (args.length > 0) args.push(";");
    args.push("set-environment", "-g", "-u", name);
  }
  return args;
}

export type TmuxCommandRunner = (
  args: string[],
) => Promise<{ code: number; stdout: string }>;

/**
 * Removes every denied variable from a running tmux server's global
 * environment, so panes created from now on no longer inherit them. Shells
 * that are already running keep their copy — only a new shell is clean.
 * Returns the names removed (empty when no server answers).
 */
export async function scrubTmuxGlobalEnvironment(
  runTmux: TmuxCommandRunner,
): Promise<string[]> {
  const shown = await runTmux(["show-environment", "-g"]);
  if (shown.code !== 0) return [];
  const denied = parseTmuxEnvironmentNames(shown.stdout).filter(
    isDeniedTerminalEnvName,
  );
  if (denied.length === 0) return [];
  const unset = await runTmux(buildTmuxGlobalEnvUnsetArgs(denied));
  if (unset.code !== 0) {
    throw new Error(
      `tmux set-environment -g -u failed (${unset.code}) for ${denied.join(", ")}`,
    );
  }
  return denied;
}
