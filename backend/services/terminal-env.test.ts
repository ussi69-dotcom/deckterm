import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  TERMINAL_ENV_DENY_LIST,
  TERMINAL_ENV_PROTECTED_NAMES,
  TmuxEnvironmentGuard,
  TmuxEnvironmentUnverifiedError,
  buildTmuxGlobalEnvUnsetArgs,
  buildTmuxSessionEnvUnsetArgs,
  isDeniedTerminalEnvName,
  isTmuxNoServerError,
  listDeniedTerminalEnvNames,
  parseTmuxEnvironmentNames,
  parseTmuxSessionRefs,
  readTmuxServerIdentity,
  sanitizeTerminalEnv,
  scrubTmuxEnvironment,
  scrubTmuxEnvironmentWithRetry,
  terminalEnvironmentErrorResponse,
  type TmuxCommandResult,
  type TmuxScrubResult,
  type TmuxServerIdentity,
} from "./terminal-env";
import { RawTerminalBackend } from "./raw-terminal-backend";
import { launchTmuxServer } from "../tmux-server-launch";
import { defaultRunCommand } from "../task-runner";

// A service environment shaped like production's (fake values). Every
// variable here except the "kept" ones must be stripped before a shell sees it.
const DENIED_SAMPLE: Record<string, string> = {
  DECKTERM_VAPID_PRIVATE_KEY: "s0-fake-private-key",
  DECKTERM_VAPID_PUBLIC_KEY: "s0-fake-public-key",
  DECKTERM_VAPID_SUBJECT: "mailto:s0@example.invalid",
  CF_ACCESS_AUD: "s0-fake-aud",
  CF_ACCESS_TEAM_NAME: "s0-team",
  CF_ACCESS_REQUIRED: "1",
  CF_ACCESS_SECRET: "s0-fake-secret",
  DECKTERM_BOOTSTRAP_ADMIN_EMAIL: "owner@example.invalid",
  DECKTERM_BOOTSTRAP_TOKEN_TTL_MS: "1000",
  DECKTERM_PUBLISH_MODE: "cloudflare-access",
  DECKTERM_LEGACY_NO_BOOTSTRAP: "1",
  DECKTERM_STATE_DIR: "/home/deploy/.deckterm",
  DECKTERM_RUNTIME_ENV: "development",
  DECKTERM_DANGEROUSLY_TRUST_PROXY_HEADERS: "1",
  DECKTERM_DEV_INSECURE_LOCAL_ADMIN: "1",
  DECKTERM_BROKER_PATH: "/tmp/evil-broker",
  DECKTERM_E2E_JWKS_FROM: "https://example.invalid",
  PORT: "4173",
  HOST: "127.0.0.1",
  TRUSTED_ORIGINS: "https://deckterm.example.invalid",
  ALLOWED_FILE_ROOTS: "/home/deploy",
  TMUX_BACKEND: "1",
  TMUX_SESSION_NAMESPACE: "deckterm",
  TMUX_REQUIRE_EXTERNAL_SERVER: "1",
  MAX_TERMINALS_PER_USER: "10",
  TERMINAL_IDLE_TIMEOUT_MS: "0",
  TERMINAL_RATE_LIMIT_PER_USER_MAX: "5",
  SCROLLBACK_MAX_LINES: "1000",
  OPENCODE_WEB_DEBUG: "1",
  OPENCODE_WEB_MAX_TERMINALS: "10",
  AGENT_RESPONDING_IDLE_MS: "100",
  CLAUDE_AGENT_RESPONDING_IDLE_MS: "100",
};

const KEPT_SAMPLE: Record<string, string> = {
  PATH: process.env.PATH || "/usr/bin:/bin",
  HOME: process.env.HOME || "/tmp",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  LC_CTYPE: "C.UTF-8",
  SHELL: "/bin/sh",
  TERM: "xterm-256color",
  USER: "deploy",
  LOGNAME: "deploy",
  TMPDIR: "/tmp",
  SSH_AUTH_SOCK: "/tmp/agent.sock",
  XDG_RUNTIME_DIR: "/run/user/1001",
  // The owner's own tooling tokens come from ~/.bashrc, not from DeckTerm:
  // the deny-list deliberately has no generic *_TOKEN / *_KEY pattern.
  GITHUB_PERSONAL_ACCESS_TOKEN: "user-owned",
  OPENCODE_URL: "http://127.0.0.1:1",
  TMUX: "/tmp/tmux-1001/default,1,0",
  TMUX_PANE: "%1",
};

const SERVICE_ENV = { ...KEPT_SAMPLE, ...DENIED_SAMPLE };

const tempDirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function envNames(dump: string): Set<string> {
  return new Set(
    dump
      .split("\n")
      .map((line) => line.split("=")[0])
      .filter(Boolean),
  );
}

describe("deny-list", () => {
  test("sanitize removes every denied variable and keeps the shell basics", () => {
    const clean = sanitizeTerminalEnv(SERVICE_ENV);
    for (const name of Object.keys(DENIED_SAMPLE)) {
      expect(clean[name]).toBeUndefined();
    }
    for (const [name, value] of Object.entries(KEPT_SAMPLE)) {
      expect(clean[name]).toBe(value);
    }
  });

  test("sanitize returns a new object and never mutates its input", () => {
    const input = { ...SERVICE_ENV };
    const clean = sanitizeTerminalEnv(input);
    expect(clean).not.toBe(input);
    expect(input).toEqual(SERVICE_ENV);
  });

  test("matches exact names exactly and prefixes by prefix", () => {
    expect(isDeniedTerminalEnvName("PORT")).toBe(true);
    expect(isDeniedTerminalEnvName("PORTABLE")).toBe(false);
    expect(isDeniedTerminalEnvName("MY_PORT")).toBe(false);
    expect(isDeniedTerminalEnvName("HOSTNAME")).toBe(false);
    expect(isDeniedTerminalEnvName("CF_ACCESS_ANYTHING_NEW")).toBe(true);
    expect(isDeniedTerminalEnvName("DECKTERM_SOMETHING_FUTURE")).toBe(true);
    // Case-sensitive like the environment itself.
    expect(isDeniedTerminalEnvName("port")).toBe(false);
  });

  test("no deny entry can remove a protected shell variable", () => {
    for (const name of [...TERMINAL_ENV_PROTECTED_NAMES, "LC_ALL", "LC_TIME"]) {
      expect(isDeniedTerminalEnvName(name)).toBe(false);
    }
  });

  test("every deny entry has a reason", () => {
    for (const entry of TERMINAL_ENV_DENY_LIST) {
      expect(entry.reason.length).toBeGreaterThan(10);
    }
  });

  test("lists denied names only (sorted), never values", () => {
    const names = listDeniedTerminalEnvNames(SERVICE_ENV);
    expect(names).toEqual(Object.keys(DENIED_SAMPLE).sort());
    expect(names.join(" ")).not.toContain("s0-fake-private-key");
  });
});

// Fake tmux: a server identity, a global env, sessions (id → name + env),
// and optional failures keyed by the first argv words. Records every call.
// `onCall` lets a test change the server between calls (e.g. a rename).
function fakeTmux(options: {
  serverId?: string;
  global?: string;
  sessions?: Record<string, string>;
  fail?: Record<string, TmuxCommandResult>;
  onCall?: (args: string[], state: FakeState) => void;
}) {
  const state: FakeState = {
    names: new Map(),
    envs: new Map(),
  };
  Object.entries(options.sessions ?? {}).forEach(([name, env], index) => {
    state.names.set(`$${index}`, name);
    state.envs.set(`$${index}`, env);
  });
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<TmuxCommandResult> => {
    calls.push(args);
    options.onCall?.(args, state);
    for (const [prefix, result] of Object.entries(options.fail ?? {})) {
      if (args.join(" ").startsWith(prefix)) return result;
    }
    if (args[0] === "display-message") {
      return { code: 0, stdout: `${options.serverId ?? "4242 1700000000"}\n` };
    }
    if (args[0] === "show-environment" && args[1] === "-g") {
      return { code: 0, stdout: options.global ?? "" };
    }
    if (args[0] === "list-sessions") {
      return {
        code: 0,
        stdout:
          [...state.names].map(([id, name]) => `${id} ${name}\n`).join(""),
      };
    }
    if (args[0] === "show-environment" && args[1] === "-t") {
      // Only an id resolves: a name-based target would miss a renamed session.
      if (!state.envs.has(args[2])) {
        return { code: 1, stdout: "", stderr: `no such session: ${args[2]}` };
      }
      return { code: 0, stdout: state.envs.get(args[2]) ?? "" };
    }
    return { code: 0, stdout: "" };
  };
  return { calls, run, state };
}
type FakeState = { names: Map<string, string>; envs: Map<string, string> };

const NO_SERVER: TmuxCommandResult = {
  code: 1,
  stdout: "",
  stderr: "error connecting to /tmp/x/t.sock (No such file or directory)\n",
};
const PERMISSION_DENIED: TmuxCommandResult = {
  code: 1,
  stdout: "",
  stderr: "error connecting to /tmp/x/t.sock (Permission denied)\n",
};

describe("tmux environment scrub (pure)", () => {
  test("parses show-environment output, skipping removed markers", () => {
    expect(
      parseTmuxEnvironmentNames(
        "PATH=/usr/bin\nDECKTERM_VAPID_PRIVATE_KEY=abc=def\n-CF_ACCESS_AUD\n\nHOME=/h\n",
      ),
    ).toEqual(["PATH", "DECKTERM_VAPID_PRIVATE_KEY", "HOME"]);
  });

  test("chains unset commands with a bare ; argument", () => {
    expect(buildTmuxGlobalEnvUnsetArgs([])).toEqual([]);
    expect(buildTmuxGlobalEnvUnsetArgs(["A", "B"])).toEqual([
      "set-environment",
      "-g",
      "-u",
      "A",
      ";",
      "set-environment",
      "-g",
      "-u",
      "B",
    ]);
    expect(buildTmuxSessionEnvUnsetArgs("$1", ["A", "B"])).toEqual([
      "set-environment",
      "-t",
      "$1",
      "-u",
      "A",
      ";",
      "set-environment",
      "-t",
      "$1",
      "-u",
      "B",
    ]);
  });

  test("only a missing socket or 'no server running' counts as no server", () => {
    expect(isTmuxNoServerError(NO_SERVER.stderr)).toBe(true);
    expect(isTmuxNoServerError("no server running on /tmp/x/t.sock")).toBe(
      true,
    );
    expect(isTmuxNoServerError(PERMISSION_DENIED.stderr)).toBe(false);
    expect(isTmuxNoServerError("server exited unexpectedly")).toBe(false);
    expect(isTmuxNoServerError("")).toBe(false);
    expect(isTmuxNoServerError(undefined)).toBe(false);
  });

  test("unsets only denied names, global in one call, each session in one call", async () => {
    const tmux = fakeTmux({
      global: "PATH=/bin\nDECKTERM_VAPID_PRIVATE_KEY=x\nPORT=4173\nHOME=/h\n",
      sessions: {
        seed: "-DISPLAY\nDECKTERM_VAPID_PRIVATE_KEY=y\nLANG=C.UTF-8\nTMUX_PANE=%1\n",
        clean: "SSH_AUTH_SOCK=/tmp/agent\n",
      },
    });
    const result = await scrubTmuxEnvironment(tmux.run);
    expect(result).toEqual({
      ok: true,
      serverPresent: true,
      serverId: "4242 1700000000",
      removed: ["DECKTERM_VAPID_PRIVATE_KEY", "PORT"],
      sessions: [
        { session: "seed", id: "$0", removed: ["DECKTERM_VAPID_PRIVATE_KEY"] },
      ],
    });
    expect(tmux.calls).toContainEqual(
      buildTmuxGlobalEnvUnsetArgs(["DECKTERM_VAPID_PRIVATE_KEY", "PORT"]),
    );
    expect(tmux.calls).toContainEqual(
      buildTmuxSessionEnvUnsetArgs("$0", ["DECKTERM_VAPID_PRIVATE_KEY"]),
    );
    // Protected and user variables are never unset; the clean session gets
    // no unset call at all.
    const unsetNames = tmux.calls
      .filter((c) => c[0] === "set-environment")
      .flatMap((c) => c.filter((_, i) => c[i - 1] === "-u"));
    expect(unsetNames).not.toContain("LANG");
    expect(unsetNames).not.toContain("TMUX_PANE");
    expect(unsetNames).not.toContain("SSH_AUTH_SOCK");
    expect(
      tmux.calls.some((c) => c[0] === "set-environment" && c[2] === "$1"),
    ).toBe(false);
  });

  test("an absent server is verified-absent, not a failure", async () => {
    const tmux = fakeTmux({ fail: { "display-message": NO_SERVER } });
    const result = await scrubTmuxEnvironment(tmux.run);
    expect(result).toMatchObject({ ok: true, serverPresent: false });
    expect(tmux.calls).toHaveLength(1);
  });

  test("a communication error is NOT treated as no server", async () => {
    const tmux = fakeTmux({ fail: { "display-message": PERMISSION_DENIED } });
    const result = await scrubTmuxEnvironment(tmux.run);
    expect(result.ok).toBe(false);
    expect(result.serverPresent).toBe(true);
    expect(result.error).toContain("Permission denied");
  });

  test("a failed global unset is reported (not thrown, not swallowed)", async () => {
    const result = await scrubTmuxEnvironment(
      fakeTmux({
        global: "CF_ACCESS_AUD=x\n",
        fail: {
          "set-environment -g": { code: 1, stdout: "", stderr: "boom" },
        },
      }).run,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("CF_ACCESS_AUD");
    expect(result.error).toContain("boom");
    // Names only, never values.
    expect(result.error).not.toContain("=x");
  });

  test("a failed session read or unset is a failure; a vanished session is skipped", async () => {
    const readFail = await scrubTmuxEnvironment(
      fakeTmux({
        sessions: { seed: "DECKTERM_X=1\n" },
        fail: {
          "show-environment -t": { code: 1, stdout: "", stderr: "lost server" },
        },
      }).run,
    );
    expect(readFail.ok).toBe(false);

    const unsetFail = await scrubTmuxEnvironment(
      fakeTmux({
        sessions: { seed: "DECKTERM_X=1\n" },
        fail: {
          "set-environment -t": { code: 1, stdout: "", stderr: "lost server" },
        },
      }).run,
    );
    expect(unsetFail.ok).toBe(false);
    expect(unsetFail.error).toContain("DECKTERM_X");

    // A session destroyed between list-sessions and its read is skipped.
    const vanished = await scrubTmuxEnvironment(
      fakeTmux({
        sessions: { gone: "DECKTERM_X=1\n" },
        fail: {
          "show-environment -t": {
            code: 1,
            stdout: "",
            stderr: "no such session: $0",
          },
        },
      }).run,
    );
    expect(vanished).toMatchObject({ ok: true, serverPresent: true });
  });

  test("sessions are targeted by id, so a rename during the scrub cannot skip one", async () => {
    const tmux = fakeTmux({
      sessions: { seed: "DECKTERM_VAPID_PRIVATE_KEY=y\n", " padded name ": "" },
      // Rename "seed" after it was listed, as its read arrives: a name
      // target would now miss it ("no such session") and skip it.
      onCall: (args, state) => {
        if (args[0] === "show-environment" && args[1] === "-t") {
          state.names.set("$0", "renamed");
        }
      },
    });
    const result = await scrubTmuxEnvironment(tmux.run);
    expect(result.ok).toBe(true);
    expect(result.sessions).toEqual([
      { session: "seed", id: "$0", removed: ["DECKTERM_VAPID_PRIVATE_KEY"] },
    ]);
    const targets = tmux.calls
      .filter((c) => c[1] === "-t")
      .map((c) => c[2]);
    expect(targets).toEqual(["$0", "$0", "$1"]);
  });

  test("session refs keep the name verbatim and only accept $N ids", () => {
    expect(
      parseTmuxSessionRefs("$0 seed\n$12  padded name \n$3 a b\nbogus\n\n"),
    ).toEqual([
      { id: "$0", name: "seed" },
      { id: "$12", name: " padded name " },
      { id: "$3", name: "a b" },
    ]);
  });

  test("server identity: present, absent, error", async () => {
    expect(await readTmuxServerIdentity(fakeTmux({}).run)).toEqual({
      status: "present",
      id: "4242 1700000000",
    });
    expect(
      await readTmuxServerIdentity(
        fakeTmux({ fail: { "display-message": NO_SERVER } }).run,
      ),
    ).toEqual({ status: "absent" });
    expect(
      (
        await readTmuxServerIdentity(
          fakeTmux({ fail: { "display-message": PERMISSION_DENIED } }).run,
        )
      ).status,
    ).toBe("error");
    expect(
      (await readTmuxServerIdentity(fakeTmux({ serverId: "garbage" }).run))
        .status,
    ).toBe("error");
  });

  test("startup retry: stops at the first success, returns the last failure otherwise", async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    const bad: TmuxScrubResult = {
      ok: false,
      serverPresent: true,
      removed: [],
      sessions: [],
      error: "busy",
    };
    const good: TmuxScrubResult = {
      ok: true,
      serverPresent: true,
      removed: ["PORT"],
      sessions: [],
    };
    const sequence = [bad, good];
    const healed = await scrubTmuxEnvironmentWithRetry(
      async () => sequence.shift()!,
      { attempts: 3, delayMs: 7, sleep },
    );
    expect(healed).toEqual({ result: good, attempts: 2 });
    expect(sleeps).toEqual([7]);

    let thrown = 0;
    const failing = await scrubTmuxEnvironmentWithRetry(
      async () => {
        thrown += 1;
        throw new Error("spawn failed");
      },
      { attempts: 3, delayMs: 1, sleep },
    );
    expect(thrown).toBe(3);
    expect(failing.attempts).toBe(3);
    expect(failing.result.ok).toBe(false);
    expect(failing.result.error).toBe("spawn failed");
  });
});

describe("tmux environment guard (create gate)", () => {
  function scripted(
    results: TmuxScrubResult[],
    identity: () => TmuxServerIdentity = () => ({
      status: "present",
      id: "100 1700000000",
    }),
  ) {
    let runs = 0;
    const guard = new TmuxEnvironmentGuard(
      async () => {
        runs += 1;
        const next = results.shift();
        if (!next) throw new Error("unexpected extra scrub");
        return next;
      },
      async () => identity(),
    );
    return { guard, runs: () => runs };
  }
  const OK: TmuxScrubResult = {
    ok: true,
    serverPresent: true,
    serverId: "100 1700000000",
    removed: [],
    sessions: [],
  };
  const ABSENT: TmuxScrubResult = {
    ok: true,
    serverPresent: false,
    removed: [],
    sessions: [],
  };
  const FAILED: TmuxScrubResult = {
    ok: false,
    serverPresent: true,
    removed: [],
    sessions: [],
    error: "tmux show-environment -g failed (exit 1): Permission denied",
  };

  test("a scrub failure refuses the create instead of silently continuing", async () => {
    const { guard } = scripted([FAILED]);
    await expect(guard.ensureVerified()).rejects.toBeInstanceOf(
      TmuxEnvironmentUnverifiedError,
    );
    expect(guard.isVerified).toBe(false);
  });

  test("a later successful scrub allows creates again, then stops scrubbing", async () => {
    const { guard, runs } = scripted([FAILED, FAILED, OK]);
    await expect(guard.ensureVerified()).rejects.toThrow();
    await expect(guard.ensureVerified()).rejects.toThrow();
    await guard.ensureVerified();
    expect(guard.isVerified).toBe(true);
    // Verified: further creates cost no scrub at all.
    await guard.ensureVerified();
    await guard.ensureVerified();
    expect(runs()).toBe(3);
  });

  test("a failed startup scrub (run) leaves creates gated until one succeeds", async () => {
    const { guard, runs } = scripted([FAILED, OK]);
    expect((await guard.run()).ok).toBe(false);
    expect(guard.isVerified).toBe(false);
    await guard.ensureVerified();
    expect(guard.isVerified).toBe(true);
    expect(runs()).toBe(2);
  });

  test("an absent server lets the create through but is re-checked next time", async () => {
    const { guard, runs } = scripted([ABSENT, OK]);
    await guard.ensureVerified();
    expect(guard.isVerified).toBe(false);
    await guard.ensureVerified();
    expect(guard.isVerified).toBe(true);
    expect(runs()).toBe(2);
  });

  test("a throwing scrub is a refusal, and concurrent creates share one scrub", async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const guard = new TmuxEnvironmentGuard(
      async () => {
        runs += 1;
        await gate;
        if (runs === 1) throw new Error("spawn EAGAIN");
        return OK;
      },
      async () => ({ status: "present", id: "100 1700000000" }),
    );
    const both = Promise.allSettled([
      guard.ensureVerified(),
      guard.ensureVerified(),
    ]);
    release();
    for (const settled of await both) {
      expect(settled.status).toBe("rejected");
      expect((settled as PromiseRejectedResult).reason).toBeInstanceOf(
        TmuxEnvironmentUnverifiedError,
      );
    }
    expect(runs).toBe(1);
    await guard.ensureVerified();
    expect(runs).toBe(2);
  });

  test("a different server on the socket after verification is scrubbed again", async () => {
    let current: TmuxServerIdentity = { status: "present", id: "100 1700000000" };
    const replacement: TmuxScrubResult = { ...OK, serverId: "200 1700000500" };
    const { guard, runs } = scripted([OK, replacement, FAILED], () => current);
    await guard.ensureVerified();
    await guard.ensureVerified(); // same server: identity read only
    expect(runs()).toBe(1);

    // The server exited and another one answers the socket.
    current = { status: "present", id: "200 1700000500" };
    await guard.ensureVerified();
    expect(runs()).toBe(2);
    expect(guard.verifiedServer).toBe("200 1700000500");

    // Same pid reused but a different start time is still another server,
    // and when that one cannot be verified the create is refused.
    current = { status: "present", id: "200 1700000999" };
    await expect(guard.ensureVerified()).rejects.toBeInstanceOf(
      TmuxEnvironmentUnverifiedError,
    );
    expect(runs()).toBe(3);
    expect(guard.isVerified).toBe(false);
  });

  test("an unreadable identity after verification triggers a scrub, not a pass", async () => {
    let current: TmuxServerIdentity = { status: "present", id: "100 1700000000" };
    const { guard, runs } = scripted([OK, FAILED], () => current);
    await guard.ensureVerified();
    current = { status: "error", error: "Permission denied" };
    await expect(guard.ensureVerified()).rejects.toBeInstanceOf(
      TmuxEnvironmentUnverifiedError,
    );
    expect(runs()).toBe(2);
  });

  test("the refusal maps to a 503 with a plain message; other errors do not", () => {
    const refusal = new TmuxEnvironmentUnverifiedError(
      "tmux show-environment -g failed (exit 1): Permission denied",
    );
    const response = terminalEnvironmentErrorResponse(refusal);
    expect(response?.status).toBe(503);
    expect(response?.body.reason).toBe("terminal_environment_unverified");
    expect(response?.body.error).toContain("did not open a new terminal");
    // tmux's raw error stays in the log, not in the HTTP answer.
    expect(response?.body.error).not.toContain("Permission denied");
    expect(terminalEnvironmentErrorResponse(new Error("other"))).toBeNull();
  });
});

describe("spawn sites", () => {
  test("tmux server launcher starts tmux with the sanitized env", async () => {
    const home = await tempDir("dt-s0-launch-");
    const seen: Array<Record<string, string | undefined>> = [];
    const code = await launchTmuxServer(
      { ...SERVICE_ENV, HOME: home, DECKTERM_STATE_DIR: join(home, "state") },
      (_argv, spawnEnv) => {
        seen.push(spawnEnv);
        return { exited: Promise.resolve(0) };
      },
    );
    expect(code).toBe(0);
    expect(seen).toHaveLength(1);
    for (const name of Object.keys(DENIED_SAMPLE)) {
      expect(seen[0][name]).toBeUndefined();
    }
    expect(seen[0].PATH).toBe(KEPT_SAMPLE.PATH);
    expect(seen[0].HOME).toBe(home);
    expect(seen[0].LANG).toBe("C.UTF-8");
  });

  test("raw backend shell gets no service variables, but keeps per-terminal env", async () => {
    const dir = await tempDir("dt-s0-raw-");
    const out = join(dir, "env.txt");
    const backend = new RawTerminalBackend({
      shellCommandResolver: async () => ["/bin/sh"],
      env: { ...SERVICE_ENV, HOME: dir },
    });
    let exited!: () => void;
    const done = new Promise<void>((resolve) => {
      exited = resolve;
    });
    await backend.attach("s0-raw", {
      cwd: dir,
      cols: 80,
      rows: 24,
      terminal: undefined,
      shellCommand: ["/bin/sh", "-c", `env > "${out}"`],
      // Per-terminal variables are applied after sanitizing on purpose, so a
      // deliberate DECKTERM_* per-terminal variable still reaches the shell.
      env: { DECKTERM_TERMINAL_ID: "s0-raw" },
      onExit: () => exited(),
    });
    await done;
    const dump = await readFile(out, "utf8");
    const names = envNames(dump);
    for (const name of Object.keys(DENIED_SAMPLE)) {
      expect(names.has(name)).toBe(false);
    }
    expect(dump).not.toContain("s0-fake-private-key");
    for (const name of ["PATH", "HOME", "LANG", "SHELL", "LC_ALL"]) {
      expect(names.has(name)).toBe(true);
    }
    expect(dump).toContain("DECKTERM_TERMINAL_ID=s0-raw");
  });

  test("task check commands run with the sanitized env", async () => {
    const saved: Record<string, string | undefined> = {
      DECKTERM_VAPID_PRIVATE_KEY: process.env.DECKTERM_VAPID_PRIVATE_KEY,
      CF_ACCESS_AUD: process.env.CF_ACCESS_AUD,
    };
    process.env.DECKTERM_VAPID_PRIVATE_KEY = "s0-fake-private-key";
    process.env.CF_ACCESS_AUD = "s0-fake-aud";
    try {
      const dir = await tempDir("dt-s0-task-");
      const result = await defaultRunCommand({ cwd: dir, args: ["env"] });
      expect(result.exitCode).toBe(0);
      const names = envNames(result.stdout);
      expect(names.has("DECKTERM_VAPID_PRIVATE_KEY")).toBe(false);
      expect(names.has("CF_ACCESS_AUD")).toBe(false);
      expect(result.stdout).not.toContain("s0-fake");
      expect(names.has("PATH")).toBe(true);
      expect(names.has("HOME")).toBe(true);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
