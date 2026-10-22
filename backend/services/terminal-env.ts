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
// sanitized too, and `scrubTmuxEnvironment` cleans a server that was started
// before this module existed — its global environment and every session's
// own environment, which overrides the global one for new panes. The
// `TmuxEnvironmentGuard` refuses to create a terminal while that clean-up has
// not been verified (see its comment).
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
 * Parses `tmux show-environment [-g | -t session]` output into variable
 * names. Lines are `NAME=value` for set variables and `-NAME` for ones marked
 * removed. A value containing a newline can make a later line look like
 * `NAME=…`; that only adds a harmless unset of a name that does not exist.
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

/** Parses `list-sessions -F '#{session_name}'` output (one name per line). */
export function parseTmuxSessionNames(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
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

/**
 * Builds ONE tmux client argv tail that unsets each name from one session's
 * own environment (`set-environment -t =SESSION -u NAME ; …`). `=` makes the
 * target an exact session name, never a prefix match. Empty input → [].
 */
export function buildTmuxSessionEnvUnsetArgs(
  session: string,
  names: string[],
): string[] {
  const args: string[] = [];
  for (const name of names) {
    if (args.length > 0) args.push(";");
    args.push("set-environment", "-t", `=${session}`, "-u", name);
  }
  return args;
}

export type TmuxCommandResult = {
  code: number;
  stdout: string;
  stderr?: string;
};

export type TmuxCommandRunner = (args: string[]) => Promise<TmuxCommandResult>;

/**
 * True when tmux's error says no server exists on the socket: the socket file
 * is missing ("error connecting to … (No such file or directory)") or nothing
 * listens on it ("no server running on …", also printed for a stale socket).
 * Anything else — permission denied, a server that exits or hangs up, an
 * unknown error — is a communication failure, NOT proof that no server holds
 * the secrets. Checked against tmux 3.4 and 3.8.
 */
export function isTmuxNoServerError(stderr: string | undefined): boolean {
  if (!stderr) return false;
  return (
    /no server running on /.test(stderr) ||
    /error connecting to .*\(No such file or directory\)/.test(stderr)
  );
}

/** True when tmux says the target session does not exist (it went away). */
export function isTmuxNoSuchSessionError(stderr: string | undefined): boolean {
  if (!stderr) return false;
  return /no such session|can't find session|session not found/i.test(stderr);
}

export type TmuxScrubResult = {
  /**
   * true: the server is verified free of denied variables (global and every
   * session), or provably absent. false: it could not be verified.
   */
  ok: boolean;
  /** false only when tmux proved no server exists on the socket. */
  serverPresent: boolean;
  /** Denied names removed from the global environment (names only). */
  removed: string[];
  /** Denied names removed per session (names only, never values). */
  sessions: Array<{ session: string; removed: string[] }>;
  /** Why verification failed; tmux's own error text, never a value. */
  error?: string;
};

function describeTmuxFailure(step: string, result: TmuxCommandResult): string {
  const detail = (result.stderr || "").trim().slice(0, 300);
  return `${step} failed (exit ${result.code})${detail ? `: ${detail}` : ""}`;
}

/**
 * Removes every denied variable from a running tmux server: first its global
 * environment, then each existing session's own environment (a session entry
 * overrides the global one for new panes in that session). Panes created from
 * now on no longer inherit them; shells that are already running keep their
 * copy until restarted. Protected names are never touched (the deny check
 * excludes them).
 *
 * Never throws for a tmux failure: it returns `ok: false` with the reason, so
 * the caller decides (TmuxEnvironmentGuard refuses new terminals). A server
 * that is absent — or vanishes mid-scrub — is `ok: true, serverPresent:
 * false`: the next new-session starts a fresh server from the sanitized env.
 */
export async function scrubTmuxEnvironment(
  runTmux: TmuxCommandRunner,
): Promise<TmuxScrubResult> {
  const removed: string[] = [];
  const sessions: Array<{ session: string; removed: string[] }> = [];
  const absent = (): TmuxScrubResult => ({
    ok: true,
    serverPresent: false,
    removed,
    sessions,
  });
  const failed = (error: string): TmuxScrubResult => ({
    ok: false,
    serverPresent: true,
    removed,
    sessions,
    error,
  });

  const shown = await runTmux(["show-environment", "-g"]);
  if (shown.code !== 0) {
    return isTmuxNoServerError(shown.stderr)
      ? absent()
      : failed(describeTmuxFailure("tmux show-environment -g", shown));
  }
  const globalDenied = parseTmuxEnvironmentNames(shown.stdout).filter(
    isDeniedTerminalEnvName,
  );
  if (globalDenied.length > 0) {
    const unset = await runTmux(buildTmuxGlobalEnvUnsetArgs(globalDenied));
    if (unset.code !== 0) {
      if (isTmuxNoServerError(unset.stderr)) return absent();
      return failed(
        describeTmuxFailure(
          `tmux set-environment -g -u (${globalDenied.join(", ")})`,
          unset,
        ),
      );
    }
    removed.push(...globalDenied);
  }

  const listed = await runTmux(["list-sessions", "-F", "#{session_name}"]);
  if (listed.code !== 0) {
    return isTmuxNoServerError(listed.stderr)
      ? absent()
      : failed(describeTmuxFailure("tmux list-sessions", listed));
  }
  for (const session of parseTmuxSessionNames(listed.stdout)) {
    const sessionShown = await runTmux([
      "show-environment",
      "-t",
      `=${session}`,
    ]);
    if (sessionShown.code !== 0) {
      if (isTmuxNoSuchSessionError(sessionShown.stderr)) continue;
      if (isTmuxNoServerError(sessionShown.stderr)) return absent();
      return failed(
        describeTmuxFailure(
          `tmux show-environment -t ${session}`,
          sessionShown,
        ),
      );
    }
    const denied = parseTmuxEnvironmentNames(sessionShown.stdout).filter(
      isDeniedTerminalEnvName,
    );
    if (denied.length === 0) continue;
    const unset = await runTmux(buildTmuxSessionEnvUnsetArgs(session, denied));
    if (unset.code !== 0) {
      if (isTmuxNoSuchSessionError(unset.stderr)) continue;
      if (isTmuxNoServerError(unset.stderr)) return absent();
      return failed(
        describeTmuxFailure(
          `tmux set-environment -t ${session} -u (${denied.join(", ")})`,
          unset,
        ),
      );
    }
    sessions.push({ session, removed: denied });
  }

  return { ok: true, serverPresent: true, removed, sessions };
}

/**
 * Runs the scrub up to `attempts` times, waiting `delayMs` between tries,
 * until one verifies. Returns the last result (a thrown runner error becomes
 * `ok: false`). Used at startup so a transient tmux hiccup does not leave the
 * environment unverified.
 */
export async function scrubTmuxEnvironmentWithRetry(
  scrub: () => Promise<TmuxScrubResult>,
  options: {
    attempts?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ result: TmuxScrubResult; attempts: number }> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const delayMs = options.delayMs ?? 500;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let result: TmuxScrubResult = {
    ok: false,
    serverPresent: true,
    removed: [],
    sessions: [],
    error: "scrub not run",
  };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      result = await scrub();
    } catch (err) {
      result = {
        ok: false,
        serverPresent: true,
        removed: [],
        sessions: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (result.ok) return { result, attempts: attempt };
    if (attempt < attempts) await sleep(delayMs);
  }
  return { result, attempts };
}

export const TERMINAL_ENVIRONMENT_UNVERIFIED_REASON =
  "terminal_environment_unverified";

/**
 * Thrown instead of creating a tmux session while the server's environment
 * could not be verified clean. The HTTP layer answers 503 with the message.
 */
export class TmuxEnvironmentUnverifiedError extends Error {
  readonly reason = TERMINAL_ENVIRONMENT_UNVERIFIED_REASON;
  readonly status = 503;
  /** tmux's error text for the log; not part of the HTTP answer. */
  readonly detail: string;

  constructor(detail: string) {
    super(
      "DeckTerm could not confirm that the terminal server is free of " +
        "service secrets, so it did not open a new terminal. Try again in a " +
        "moment; if this keeps happening, the operator should check the " +
        "DeckTerm log for '[tmux] environment'.",
    );
    this.name = "TmuxEnvironmentUnverifiedError";
    this.detail = detail;
  }
}

/** HTTP answer for a refused terminal creation, or null for other errors. */
export function terminalEnvironmentErrorResponse(
  err: unknown,
): { status: 503; body: { error: string; reason: string } } | null {
  if (!(err instanceof TmuxEnvironmentUnverifiedError)) return null;
  return {
    status: 503,
    body: { error: err.message, reason: err.reason },
  };
}

/**
 * Gate in front of every tmux new-session (the only call that creates shells
 * or starts the server).
 *
 * - Verified once the scrub succeeded against a PRESENT server; after that
 *   creation costs nothing extra.
 * - Until then, every create re-runs the scrub first. An absent server passes
 *   (new-session will start a clean one) but stays unverified, so the next
 *   create checks the server that now exists.
 * - A failed scrub refuses the create with TmuxEnvironmentUnverifiedError.
 *   Nothing is latched: the next create tries again, so a transient failure
 *   heals itself and the service is never bricked.
 * - Concurrent creates share one in-flight scrub.
 */
export class TmuxEnvironmentGuard {
  private verified = false;
  private inFlight: Promise<TmuxScrubResult> | null = null;
  private last: TmuxScrubResult | null = null;

  constructor(private readonly scrub: () => Promise<TmuxScrubResult>) {}

  get isVerified(): boolean {
    return this.verified;
  }

  get lastResult(): TmuxScrubResult | null {
    return this.last;
  }

  /** Runs (or joins) a scrub and records whether it verified the server. */
  run(): Promise<TmuxScrubResult> {
    if (!this.inFlight) {
      this.inFlight = (async () => {
        let result: TmuxScrubResult;
        try {
          result = await this.scrub();
        } catch (err) {
          result = {
            ok: false,
            serverPresent: true,
            removed: [],
            sessions: [],
            error: err instanceof Error ? err.message : String(err),
          };
        }
        this.verified = result.ok && result.serverPresent;
        this.last = result;
        return result;
      })().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  /** Resolves when creating a session is safe; throws when it is not. */
  async ensureVerified(): Promise<void> {
    if (this.verified) return;
    const result = await this.run();
    if (!result.ok) {
      throw new TmuxEnvironmentUnverifiedError(
        result.error || "tmux environment scrub failed",
      );
    }
  }
}
