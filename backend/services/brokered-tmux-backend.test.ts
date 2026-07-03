import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Capture every broker-client call so we can assert command assembly without
// spawning the real root broker. mock.module must be set BEFORE importing the
// backend (which binds the functions at import time).
type Call = { fn: string; opts: any };
const calls: Call[] = [];
let execResult = { code: 0, stdout: "", stderr: "" };

// mock.module is process-global and leaks into sibling test files that share
// this process (e.g. terminal-backend-exec.test.ts imports the pure
// resolveBrokerPath/buildBrokerArgv), so SPREAD the real module and override
// only the three side-effecting spawn functions.
const realBrokerClient = await import("./broker-client");
mock.module("./broker-client", () => ({
  ...realBrokerClient,
  brokerExec: async (opts: any) => {
    calls.push({ fn: "brokerExec", opts });
    return execResult;
  },
  brokerSpawn: (opts: any) => {
    calls.push({ fn: "brokerSpawn", opts });
    return { pid: 4242, exited: Promise.resolve(0), kill() {} } as any;
  },
  brokerKill: async (target: any) => {
    calls.push({ fn: "brokerKill", opts: target });
    return 0;
  },
}));

const { BrokeredTmuxBackend, BrokeredTmuxBackendCache } =
  await import("./brokered-tmux-backend");
const { RawTerminalBackend } = await import("./raw-terminal-backend");

const EXEC = { uid: 2000, gid: 2000, osUsername: "alice" };

beforeEach(() => {
  calls.length = 0;
  execResult = { code: 0, stdout: "", stderr: "" };
});

function backend(captureRoot = "/var/lib/deckterm/capture") {
  return new BrokeredTmuxBackend({
    namespace: "deckterm-dev",
    captureRoot,
    exec: EXEC,
  });
}

test("createSession assembles new-session with broker identity + session name", async () => {
  const b = backend();
  const session = await b.createSession(
    "abc12345-0000-0000-0000-000000000000",
    "/home/alice",
    80,
    24,
    "user_a",
    "a@example.com",
  );
  // sessionName doubles as broker --session id and -t target.
  expect(session.sessionName).toBe(
    "deckterm_decktermdev_abc12345-0000-0000-0000-000000000000",
  );
  const newSession = calls.find(
    (c) => c.fn === "brokerExec" && c.opts.profileArgs?.[0] === "new-session",
  );
  expect(newSession).toBeTruthy();
  expect(newSession!.opts.profile).toBe("tmux");
  expect(newSession!.opts.username).toBe("alice");
  expect(newSession!.opts.uid).toBe(2000);
  expect(newSession!.opts.profileArgs).toEqual([
    "new-session",
    "-d",
    "-s",
    session.sessionName,
    "-x",
    "80",
    "-y",
    "24",
    "-c",
    "/home/alice",
  ]);
  // pipe.log path is under the capture dir keyed by the session name.
  expect(session.pipePath).toBe(
    `/var/lib/deckterm/capture/${session.sessionName}/pipe.log`,
  );
  // Capture wiring passes ONLY the fixed -o + validated -t (broker owns cmd).
  const pipePane = calls.find(
    (c) => c.fn === "brokerExec" && c.opts.profileArgs?.[0] === "pipe-pane",
  );
  expect(pipePane!.opts.profileArgs).toEqual([
    "pipe-pane",
    "-o",
    "-t",
    session.sessionName,
  ]);
});

test("attach spawns a PTY attach-session through the broker", async () => {
  const b = backend();
  const term = {};
  await b.attach("deckterm_decktermdev_s1", {
    cwd: "/home/alice",
    cols: 100,
    rows: 40,
    terminal: term,
    waitForClient: true,
  });
  const spawn = calls.find((c) => c.fn === "brokerSpawn");
  expect(spawn).toBeTruthy();
  expect(spawn!.opts.profile).toBe("tmux");
  expect(spawn!.opts.profileArgs).toEqual([
    "attach-session",
    "-t",
    "deckterm_decktermdev_s1",
  ]);
  expect(spawn!.opts.terminal).toBe(term);
});

test("kill uses kill-session; killServer stops the per-uid server scope", async () => {
  const b = backend();
  await b.kill("deckterm_decktermdev_s1");
  const killSession = calls.find(
    (c) => c.fn === "brokerExec" && c.opts.profileArgs?.[0] === "kill-session",
  );
  expect(killSession!.opts.profileArgs).toEqual([
    "kill-session",
    "-t",
    "deckterm_decktermdev_s1",
  ]);

  calls.length = 0;
  await b.killServer();
  expect(calls).toEqual([{ fn: "brokerKill", opts: { tmuxServerUid: 2000 } }]);
});

test("sessionExists maps has-session exit code", async () => {
  const b = backend();
  execResult = { code: 0, stdout: "", stderr: "" };
  expect(await b.sessionExists("deckterm_decktermdev_s1")).toBe(true);
  execResult = { code: 1, stdout: "", stderr: "" };
  expect(await b.sessionExists("deckterm_decktermdev_s1")).toBe(false);
});

test("cache returns one backend instance per uid", () => {
  const cache = new BrokeredTmuxBackendCache({
    namespace: "deckterm-dev",
    captureRoot: "/var/lib/deckterm/capture",
  });
  const a1 = cache.get({ uid: 2000, gid: 2000, osUsername: "alice" });
  const a2 = cache.get({ uid: 2000, gid: 2000, osUsername: "alice" });
  const bob = cache.get({ uid: 2001, gid: 2001, osUsername: "bob" });
  expect(a1).toBe(a2);
  expect(a1).not.toBe(bob);
  expect(cache.peek(2000)).toBe(a1);
  expect(cache.peek(9999)).toBeUndefined();
});

// --- fd-safe readPipeDelta (real files; the security-load-bearing bit) -------

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brokered-spool-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("readPipeDelta reads a delta from a regular owner-owned spool", async () => {
  const b = new BrokeredTmuxBackend({
    namespace: "deckterm-dev",
    captureRoot: dir,
    // The test process owns the temp file; point the backend uid at ourselves
    // so the owner assertion passes.
    exec: { uid: process.getuid!(), gid: process.getgid!(), osUsername: "me" },
  });
  const spool = join(dir, "pipe.log");
  writeFileSync(spool, "hello");
  let delta = await b.readPipeDelta(spool, 0);
  expect(delta.chunk).toBe("hello");
  expect(delta.offset).toBe(5);

  writeFileSync(spool, "hello world");
  delta = await b.readPipeDelta(spool, delta.offset);
  expect(delta.chunk).toBe(" world");
  expect(delta.offset).toBe(11);
});

test("readPipeDelta ignores a spool owned by another uid (swap defense)", async () => {
  const b = new BrokeredTmuxBackend({
    namespace: "deckterm-dev",
    captureRoot: dir,
    // Expected owner uid deliberately different from the file's real owner.
    exec: { uid: (process.getuid!() ?? 0) + 12345, gid: 0, osUsername: "x" },
  });
  const spool = join(dir, "pipe.log");
  writeFileSync(spool, "attacker-controlled");
  chmodSync(spool, 0o644);
  const delta = await b.readPipeDelta(spool, 0);
  // Owner mismatch ⇒ treated as corrupt, no bytes replayed.
  expect(delta.chunk).toBe("");
  expect(delta.offset).toBe(0);
});

test("readPipeDelta returns empty for a missing spool", async () => {
  const b = backend(dir);
  const delta = await b.readPipeDelta(join(dir, "nope", "pipe.log"), 0);
  expect(delta.chunk).toBe("");
});

// --- raw backend brokered path ----------------------------------------------

test("raw backend attach with exec spawns the pty profile through the broker", async () => {
  const raw = new RawTerminalBackend({
    shellCommandResolver: async () => ["/bin/bash", "-l"],
  });
  await raw.attach("abc12345-raw", {
    cwd: "/home/alice",
    cols: 80,
    rows: 24,
    terminal: {},
    exec: { uid: 2000, gid: 2000, osUsername: "alice" },
  });
  const spawn = calls.find((c) => c.fn === "brokerSpawn");
  expect(spawn).toBeTruthy();
  expect(spawn!.opts.profile).toBe("pty");
  expect(spawn!.opts.session).toBe("abc12345-raw");
  expect(spawn!.opts.username).toBe("alice");
  expect(spawn!.opts.uid).toBe(2000);
  expect(spawn!.opts.cwd).toBe("/home/alice");
});

test("raw backend kill routes a brokered session through brokerKill", async () => {
  const raw = new RawTerminalBackend({
    shellCommandResolver: async () => ["/bin/bash", "-l"],
  });
  await raw.attach("abc12345-raw", {
    cwd: "/home/alice",
    cols: 80,
    rows: 24,
    terminal: {},
    exec: { uid: 2000, gid: 2000, osUsername: "alice" },
  });
  calls.length = 0;
  await raw.kill("abc12345-raw");
  expect(calls.find((c) => c.fn === "brokerKill")?.opts).toEqual({
    session: "abc12345-raw",
  });
});

test("raw backend attach without exec never touches the broker (legacy)", async () => {
  const raw = new RawTerminalBackend({
    shellCommandResolver: async () => ["/bin/true"],
  });
  await raw.attach("legacy-1", {
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    terminal: undefined,
  });
  expect(calls.filter((c) => c.fn === "brokerSpawn")).toHaveLength(0);
});
