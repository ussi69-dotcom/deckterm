import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TmuxTerminalBackend } from "./tmux-terminal-backend";

// Real tmux, private sockets. What matters is tmux's own behaviour — the
// server keeps the environment it was started with and hands it to every new
// pane — so a mock would only test the mock.

const dirs: string[] = [];
const sockets: string[] = [];

function freshDir(): string {
  // Short prefix: unix socket paths are capped near 108 bytes.
  const dir = mkdtempSync(join(tmpdir(), "dts0-"));
  dirs.push(dir);
  return dir;
}

function tmux(socket: string, args: string[], env?: Record<string, string>) {
  return Bun.spawnSync(["tmux", "-S", socket, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: env ?? baseEnv(),
  });
}

// Stop a private server by its pid (not kill-server), then drop its files.
afterEach(() => {
  for (const socket of sockets.splice(0)) {
    const shown = tmux(socket, ["display-message", "-p", "#{pid}"]);
    const pid = Number(shown.stdout.toString().trim());
    if (shown.exitCode === 0 && Number.isInteger(pid) && pid > 1) {
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

function baseEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: process.env.HOME || "/tmp",
    LANG: "C.UTF-8",
    SHELL: "/bin/sh",
  };
}

const SECRETS: Record<string, string> = {
  DECKTERM_VAPID_PRIVATE_KEY: "s0-fake-private-key",
  CF_ACCESS_AUD: "s0-fake-aud",
  DECKTERM_PUBLISH_MODE: "cloudflare-access",
  DECKTERM_STATE_DIR: "/nonexistent/s0",
  PORT: "4173",
};

function globalEnvNames(socket: string): string[] {
  const shown = tmux(socket, ["show-environment", "-g"]);
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
  const dir = freshDir();
  const socket = join(dir, "t.sock");
  sockets.push(socket);
  const out = join(dir, "env.txt");
  const backend = new TmuxTerminalBackend({
    namespace: "s0",
    socketPath: socket,
    pipeDir: join(dir, "pipes"),
    shellCommandResolver: async () => dumpShell(out),
    env: { ...baseEnv(), ...SECRETS },
  });

  await backend.createSession("t1", dir, 80, 24, "u1", "u@example.com");

  const names = globalEnvNames(socket);
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
  expect(dump).toContain("HOME=");
  expect(dump).toContain("LANG=");
});

test("scrubServerEnvironment cleans a server that was started with the secrets", async () => {
  const dir = freshDir();
  const socket = join(dir, "t.sock");
  sockets.push(socket);
  const out = join(dir, "env.txt");

  // A pre-hygiene server: started straight from a polluted environment.
  const seeded = tmux(
    socket,
    ["new-session", "-d", "-s", "seed", "sleep 30"],
    { ...baseEnv(), ...SECRETS },
  );
  expect(seeded.exitCode).toBe(0);
  // Control: the leak is real before the scrub.
  expect(globalEnvNames(socket)).toContain("DECKTERM_VAPID_PRIVATE_KEY");

  const backend = new TmuxTerminalBackend({
    namespace: "s0",
    socketPath: socket,
    pipeDir: join(dir, "pipes"),
    shellCommandResolver: async () => dumpShell(out),
    env: baseEnv(),
  });
  const removed = await backend.scrubServerEnvironment();
  expect(removed.sort()).toEqual(Object.keys(SECRETS).sort());

  const names = globalEnvNames(socket);
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
  expect(await backend.scrubServerEnvironment()).toEqual([]);
});

test("scrubServerEnvironment with no server running is a no-op", async () => {
  const dir = freshDir();
  const backend = new TmuxTerminalBackend({
    namespace: "s0",
    socketPath: join(dir, "none.sock"),
    pipeDir: join(dir, "pipes"),
    shellCommandResolver: async () => ["/bin/sh"],
    env: baseEnv(),
  });
  expect(await backend.scrubServerEnvironment()).toEqual([]);
  expect(tmux(join(dir, "none.sock"), ["list-sessions"]).exitCode).not.toBe(0);
});
