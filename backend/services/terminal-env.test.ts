import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  TERMINAL_ENV_DENY_LIST,
  TERMINAL_ENV_PROTECTED_NAMES,
  buildTmuxGlobalEnvUnsetArgs,
  isDeniedTerminalEnvName,
  listDeniedTerminalEnvNames,
  parseTmuxEnvironmentNames,
  sanitizeTerminalEnv,
  scrubTmuxGlobalEnvironment,
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

describe("tmux global environment scrub (pure)", () => {
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
  });

  test("unsets only denied names, in one tmux call", async () => {
    const calls: string[][] = [];
    const removed = await scrubTmuxGlobalEnvironment(async (args) => {
      calls.push(args);
      if (args[0] === "show-environment") {
        return {
          code: 0,
          stdout: "PATH=/bin\nDECKTERM_VAPID_PRIVATE_KEY=x\nPORT=4173\nHOME=/h\n",
        };
      }
      return { code: 0, stdout: "" };
    });
    expect(removed).toEqual(["DECKTERM_VAPID_PRIVATE_KEY", "PORT"]);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(
      buildTmuxGlobalEnvUnsetArgs(["DECKTERM_VAPID_PRIVATE_KEY", "PORT"]),
    );
  });

  test("no server answering is not an error and changes nothing", async () => {
    const calls: string[][] = [];
    const removed = await scrubTmuxGlobalEnvironment(async (args) => {
      calls.push(args);
      return { code: 1, stdout: "" };
    });
    expect(removed).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test("a failed unset is reported, not swallowed", async () => {
    await expect(
      scrubTmuxGlobalEnvironment(async (args) =>
        args[0] === "show-environment"
          ? { code: 0, stdout: "CF_ACCESS_AUD=x\n" }
          : { code: 1, stdout: "" },
      ),
    ).rejects.toThrow("CF_ACCESS_AUD");
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
