import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { TmuxTerminalBackend } from "./tmux-terminal-backend";
import { TmuxEnvironmentUnverifiedError } from "./terminal-env";

// Real tmux, private sockets. What matters is tmux's own behaviour — the
// server keeps the environment it was started with and hands it to every new
// pane, and a session's own environment overrides the global one — so a mock
// would only test the mock.
//
// Isolation: every private server gets a temporary HOME and an explicit empty
// config (`-f /dev/null`), so the developer's ~/.tmux.conf and plugins never
// run here. Socket dirs live directly under /tmp with a short prefix (unix
// socket paths are capped near 108 bytes; TMPDIR may be long).

const dirs: string[] = [];
const sockets: string[] = [];
const lockedDirs: string[] = [];

function freshDir(): { dir: string; home: string } {
  const dir = mkdtempSync("/tmp/dts0-");
  dirs.push(dir);
  const home = join(dir, "h");
  mkdirSync(home);
  return { dir, home };
}

function baseEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: home,
    LANG: "C.UTF-8",
    SHELL: "/bin/sh",
  };
}

function tmux(
  socket: string,
  home: string,
  args: string[],
  extraEnv?: Record<string, string>,
) {
  return Bun.spawnSync(["tmux", "-f", "/dev/null", "-S", socket, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...baseEnv(home), ...extraEnv },
  });
}

function backendFor(
  socket: string,
  dir: string,
  home: string,
  shell: () => string[],
  env?: Record<string, string>,
) {
  return new TmuxTerminalBackend({
    namespace: "s0",
    socketPath: socket,
    pipeDir: join(dir, "pipes"),
    shellCommandResolver: async () => shell(),
    env: env ?? baseEnv(home),
    configFile: "/dev/null",
  });
}

/** PIDs whose command line names this socket (the server and its clients). */
function pidsForSocket(socket: string): number[] {
  const pids: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8");
      if (cmdline.split("\0").join(" ").includes(socket)) pids.push(pid);
    } catch {
      // process exited while scanning
    }
  }
  return pids;
}

// Stop each private server by the PID whose args contain its socket path
// (never kill-server), then drop its files.
afterEach(() => {
  for (const dir of lockedDirs.splice(0)) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // already gone
    }
  }
  for (const socket of sockets.splice(0)) {
    for (const pid of pidsForSocket(socket)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const SECRETS: Record<string, string> = {
  DECKTERM_VAPID_PRIVATE_KEY: "s0-fake-private-key",
  CF_ACCESS_AUD: "s0-fake-aud",
  DECKTERM_PUBLISH_MODE: "cloudflare-access",
  DECKTERM_STATE_DIR: "/nonexistent/s0",
  PORT: "4173",
};

function envNames(
  socket: string,
  home: string,
  scope: string[] = ["-g"],
): string[] {
  const shown = tmux(socket, home, ["show-environment", ...scope]);
  expect(shown.exitCode).toBe(0);
  return shown.stdout
    .toString()
    .split("\n")
    .filter((line) => line && !line.startsWith("-"))
    .map((line) => line.split("=")[0]);
}

async function waitForFile(path: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8");
      if (text.includes("S0_DONE=1")) return text;
    }
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${path}`);
}

function dumpShell(out: string): string[] {
  // `env` first, then a marker so a half-written file is never read.
  return [
    "/bin/sh",
    "-c",
    `env > "${out}.tmp"; echo S0_DONE=1 >> "${out}.tmp"; ` +
      `mv "${out}.tmp" "${out}"; sleep 30`,
  ];
}

test("a tmux server started by DeckTerm holds no service variables, and neither does the shell", async () => {
  const { dir, home } = freshDir();
  const socket = join(dir, "t.sock");
  sockets.push(socket);
  const out = join(dir, "env.txt");
  const backend = backendFor(socket, dir, home, () => dumpShell(out), {
    ...baseEnv(home),
    ...SECRETS,
  });

  await backend.createSession("t1", dir, 80, 24, "u1", "u@example.com");

  const names = envNames(socket, home);
  for (const name of Object.keys(SECRETS)) {
    expect(names).not.toContain(name);
  }
  expect(names).toContain("PATH");
  expect(names).toContain("HOME");
  expect(names).toContain("LANG");

  const dump = await waitForFile(out);
  for (const name of Object.keys(SECRETS)) {
    expect(dump).not.toContain(`${name}=`);
  }
  expect(dump).toContain("PATH=");
  expect(dump).toContain(`HOME=${home}`);
  expect(dump).toContain("LANG=");
});

test("scrubServerEnvironment cleans a server that was started with the secrets", async () => {
  const { dir, home } = freshDir();
  const socket = join(dir, "t.sock");
  sockets.push(socket);
  const out = join(dir, "env.txt");

  // A pre-hygiene server: started straight from a polluted environment.
  const seeded = tmux(
    socket,
    home,
    ["new-session", "-d", "-s", "seed", "sleep 30"],
    SECRETS,
  );
  expect(seeded.exitCode).toBe(0);
  // Control: the leak is real before the scrub.
  expect(envNames(socket, home)).toContain("DECKTERM_VAPID_PRIVATE_KEY");

  const backend = backendFor(socket, dir, home, () => dumpShell(out));
  const result = await backend.scrubServerEnvironment();
  expect(result.ok).toBe(true);
  expect(result.serverPresent).toBe(true);
  expect(result.removed.sort()).toEqual(Object.keys(SECRETS).sort());
  expect(backend.environmentVerified).toBe(true);

  const names = envNames(socket, home);
  for (const name of Object.keys(SECRETS)) {
    expect(names).not.toContain(name);
  }
  expect(names).toContain("PATH");

  // A pane created after the scrub no longer inherits them.
  await backend.createSession("t2", dir, 80, 24, "u1", "u@example.com");
  const dump = await waitForFile(out);
  for (const name of Object.keys(SECRETS)) {
    expect(dump).not.toContain(`${name}=`);
  }

  // Idempotent: a second scrub has nothing left to remove.
  const again = await backend.scrubServerEnvironment();
  expect(again).toMatchObject({
    ok: true,
    serverPresent: true,
    removed: [],
    sessions: [],
  });
});

test("scrubServerEnvironment also cleans a session's own environment", async () => {
  const { dir, home } = freshDir();
  const socket = join(dir, "t.sock");
  sockets.push(socket);

  // A clean server whose session carries denied names in its OWN
  // environment, which overrides the (clean) global one for new panes.
  expect(
    tmux(socket, home, ["new-session", "-d", "-s", "seed", "sleep 30"])
      .exitCode,
  ).toBe(0);
  for (const [name, value] of [
    ["DECKTERM_VAPID_PRIVATE_KEY", "s0-session-key"],
    ["CF_ACCESS_AUD", "s0-session-aud"],
    ["S0_USER_VAR", "keep-me"],
  ]) {
    expect(
      tmux(socket, home, ["set-environment", "-t", "seed", name, value])
        .exitCode,
    ).toBe(0);
  }
  expect(envNames(socket, home)).not.toContain("DECKTERM_VAPID_PRIVATE_KEY");

  const newPaneEnv = async (label: string) => {
    const out = join(dir, `${label}.txt`);
    const made = tmux(socket, home, [
      "new-window",
      "-d",
      "-t",
      "seed:",
      ...dumpShell(out),
    ]);
    expect(made.exitCode).toBe(0);
    return waitForFile(out);
  };

  // Control: before the scrub a new pane in that session gets the secret.
  expect(await newPaneEnv("before")).toContain(
    "DECKTERM_VAPID_PRIVATE_KEY=s0-session-key",
  );

  const backend = backendFor(socket, dir, home, () => ["/bin/sh"]);
  const result = await backend.scrubServerEnvironment();
  expect(result.ok).toBe(true);
  expect(result.removed).toEqual([]);
  expect(result.sessions).toEqual([
    {
      session: "seed",
      id: expect.stringMatching(/^\$[0-9]+$/),
      removed: ["CF_ACCESS_AUD", "DECKTERM_VAPID_PRIVATE_KEY"],
    },
  ]);

  const sessionNames = envNames(socket, home, ["-t", "seed"]);
  expect(sessionNames).not.toContain("DECKTERM_VAPID_PRIVATE_KEY");
  expect(sessionNames).not.toContain("CF_ACCESS_AUD");
  expect(sessionNames).toContain("S0_USER_VAR");

  const after = await newPaneEnv("after");
  expect(after).not.toContain("DECKTERM_VAPID_PRIVATE_KEY=");
  expect(after).not.toContain("CF_ACCESS_AUD=");
  expect(after).toContain("S0_USER_VAR=keep-me");
});

test("scrubServerEnvironment with no server running reports an absent server", async () => {
  const { dir, home } = freshDir();
  const socket = join(dir, "none.sock");
  const backend = backendFor(socket, dir, home, () => ["/bin/sh"]);
  expect(await backend.scrubServerEnvironment()).toEqual({
    ok: true,
    serverPresent: false,
    removed: [],
    sessions: [],
  });
  // Absent is not "verified": the next create checks the server it starts.
  expect(backend.environmentVerified).toBe(false);
  expect(tmux(socket, home, ["list-sessions"]).exitCode).not.toBe(0);
});

// Permission bits do not stop root, so the failure cannot be produced there.
test.skipIf(process.getuid?.() === 0)(
  "createSession refuses while the server cannot be verified, and recovers once it can",
  async () => {
    const { dir, home } = freshDir();
    const socketDir = join(dir, "s");
    const socket = join(socketDir, "t.sock");
    sockets.push(socket);
    const backend = backendFor(socket, dir, home, () => ["sleep", "30"]);

    // Starts the server (absent before → allowed, still unverified).
    await backend.createSession("t1", dir, 80, 24, "u1", "u@example.com");
    expect(backend.environmentVerified).toBe(false);

    // The server is running but unreachable: "Permission denied" is a
    // communication failure, not "no server". The create must be refused.
    chmodSync(socketDir, 0o000);
    lockedDirs.push(socketDir);
    await expect(
      backend.createSession("t2", dir, 80, 24, "u1", "u@example.com"),
    ).rejects.toBeInstanceOf(TmuxEnvironmentUnverifiedError);
    expect(backend.environmentVerified).toBe(false);

    // The fault clears: the next create re-runs the scrub and goes through.
    chmodSync(socketDir, 0o700);
    await backend.createSession("t3", dir, 80, 24, "u1", "u@example.com");
    expect(backend.environmentVerified).toBe(true);

    const listed = tmux(socket, home, [
      "list-sessions",
      "-F",
      "#{session_name}",
    ]);
    const names = listed.stdout.toString().trim().split("\n");
    expect(names.some((n) => n.endsWith("t1"))).toBe(true);
    expect(names.some((n) => n.endsWith("t2"))).toBe(false);
    expect(names.some((n) => n.endsWith("t3"))).toBe(true);
  },
);

async function stopServer(socket: string) {
  for (const pid of pidsForSocket(socket)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  for (let i = 0; i < 100 && pidsForSocket(socket).length > 0; i++) {
    await Bun.sleep(20);
  }
  expect(pidsForSocket(socket)).toEqual([]);
}

test("a different server appearing on the socket after verification is scrubbed before the next create", async () => {
  const { dir, home } = freshDir();
  const socket = join(dir, "t.sock");
  sockets.push(socket);
  const out = join(dir, "env.txt");
  let shell: string[] = ["sleep", "30"];
  const backend = backendFor(socket, dir, home, () => shell);

  // Server A: started clean by DeckTerm and verified.
  await backend.createSession("t1", dir, 80, 24, "u1", "u@example.com");
  expect((await backend.scrubServerEnvironment()).ok).toBe(true);
  expect(backend.environmentVerified).toBe(true);

  // A exits; server B is started on the same socket from a polluted
  // environment (e.g. by hand from a shell that still had the secrets).
  await stopServer(socket);
  expect(
    tmux(socket, home, ["new-session", "-d", "-s", "evil", "sleep 30"], SECRETS)
      .exitCode,
  ).toBe(0);
  expect(envNames(socket, home)).toContain("DECKTERM_VAPID_PRIVATE_KEY");

  // The next create notices the new server identity and scrubs it first.
  shell = dumpShell(out);
  await backend.createSession("t2", dir, 80, 24, "u1", "u@example.com");
  const dump = await waitForFile(out);
  for (const name of Object.keys(SECRETS)) {
    expect(dump).not.toContain(`${name}=`);
  }
  const names = envNames(socket, home);
  for (const name of Object.keys(SECRETS)) {
    expect(names).not.toContain(name);
  }
  expect(backend.environmentVerified).toBe(true);
});
