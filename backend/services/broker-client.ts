import type { Subprocess } from "bun";

/**
 * B2 broker client (design §4.1). Thin typed wrapper over the root-owned
 * launch broker, always invoked as `sudo -n <BROKER_PATH> …` with argv ARRAYS
 * (never a shell string). The broker is the security boundary; this module
 * only assembles the fixed contract and classifies exit codes.
 */

const DEFAULT_BROKER_PATH = "/usr/local/lib/deckterm/deckterm-broker";

/**
 * Resolve the broker binary path. A `DECKTERM_BROKER_PATH` override is honored
 * ONLY in dev/test envs (invariant §7.9) so production can never be pointed at
 * an attacker-controlled binary via the environment.
 */
export function resolveBrokerPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env.DECKTERM_BROKER_PATH;
  const isDevOrTest =
    env.DECKTERM_RUNTIME_ENV === "development" ||
    env.DECKTERM_RUNTIME_ENV === "dev" ||
    env.NODE_ENV === "test" ||
    env.BUN_ENV === "test" ||
    env.CI === "true";
  if (override && isDevOrTest) return override;
  return DEFAULT_BROKER_PATH;
}

export type BrokerExecContext = {
  session: string;
  username: string;
  uid: number;
  gid: number;
  cwd: string;
};

export type BrokerSpawnOptions = BrokerExecContext & {
  profile: "pty" | "tmux" | "fs" | "git" | "search";
  cols?: number;
  rows?: number;
  /**
   * For `git`/`search` profiles: the subdirectory (relative to the granted root
   * passed as `cwd`) the tool runs in. The broker resolves it fd-safely beneath
   * the root as the dropped user, so a symlinked component can't escape the root.
   */
  reldir?: string;
  /** Extra profile args (e.g. tmux subcommand / git argv). Never a shell string. */
  profileArgs?: string[];
  /**
   * For `exec_stdin` profiles (B4 `fs` helper): a single request payload written
   * to the child's stdin. The whole request travels over stdin, so there is no
   * argv attack surface. Ignored by `spawn` (which hands the child a PTY).
   */
  stdin?: string;
  /** The PTY handle to hand the child (Bun.Terminal). */
  terminal?: unknown;
  onExit?: (
    proc: Subprocess,
    exitCode: number,
    signalCode?: number | null,
  ) => void;
};

/**
 * Build the argv for a broker `spawn`/`exec` invocation. Pure + exported so the
 * command assembly is unit-testable without spawning (invariant §7.2/§7.6:
 * argv arrays only, no shell, the client never invents uid/username).
 */
export function buildBrokerArgv(
  brokerPath: string,
  verb: "spawn" | "exec",
  opts: BrokerSpawnOptions,
): string[] {
  const argv = [
    "sudo",
    "-n",
    brokerPath,
    verb,
    "--session",
    opts.session,
    "--username",
    opts.username,
    "--uid",
    String(opts.uid),
    "--gid",
    String(opts.gid),
    "--cwd",
    opts.cwd,
    "--profile",
    opts.profile,
  ];
  if (opts.reldir != null) argv.push("--reldir", opts.reldir);
  if (opts.cols != null) argv.push("--cols", String(opts.cols));
  if (opts.rows != null) argv.push("--rows", String(opts.rows));
  if (opts.profileArgs && opts.profileArgs.length > 0) {
    argv.push("--", ...opts.profileArgs);
  }
  return argv;
}

export function buildKillArgv(
  brokerPath: string,
  target: { session: string } | { tmuxServerUid: number },
): string[] {
  if ("session" in target) {
    return ["sudo", "-n", brokerPath, "kill", "--session", target.session];
  }
  return [
    "sudo",
    "-n",
    brokerPath,
    "kill",
    "--tmux-server",
    "--uid",
    String(target.tmuxServerUid),
  ];
}

/**
 * Spawn a PTY (or tmux client) through the broker, handing it the server PTY.
 * The returned Subprocess' stdio IS the PTY (the server keeps the master side).
 */
export function brokerSpawn(
  opts: BrokerSpawnOptions,
  env: Record<string, string | undefined> = process.env,
): Subprocess {
  const argv = buildBrokerArgv(resolveBrokerPath(env), "spawn", opts);
  return Bun.spawn(argv, {
    // The broker constructs the child env from the target account; we forward
    // nothing (sudoers env_reset strips it anyway).
    // @ts-expect-error - terminal option is Bun 1.3.5+ API, not yet in bun-types
    terminal: opts.terminal,
    onExit: opts.onExit,
  });
}

export type BrokerExecResult = {
  code: number;
  stdout: string;
  stderr: string;
};

/**
 * Run a non-PTY broker `exec` (e.g. a tmux control command), capturing output.
 * A hard timeout (default 30s) kills a hung invocation (design §3.3).
 */
export async function brokerExec(
  opts: BrokerSpawnOptions,
  env: Record<string, string | undefined> = process.env,
  timeoutMs = 30_000,
): Promise<BrokerExecResult> {
  const argv = buildBrokerArgv(resolveBrokerPath(env), "exec", opts);
  const proc = Bun.spawn(argv, {
    // A stdin payload (fs helper request) is handed as the child's stdin; the
    // whole request travels over stdin so no request data reaches argv. When
    // absent, close stdin so a control command (e.g. tmux) can't block on it.
    stdin: opts.stdin != null ? Buffer.from(opts.stdin, "utf8") : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // already gone
    }
  }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

export async function brokerKill(
  target: { session: string } | { tmuxServerUid: number },
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const argv = buildKillArgv(resolveBrokerPath(env), target);
  const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" });
  return proc.exited;
}

/** Health probe (design §4.4): the broker's `check` verb. */
export async function brokerCheck(
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  try {
    const proc = Bun.spawn(["sudo", "-n", resolveBrokerPath(env), "check"], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}
