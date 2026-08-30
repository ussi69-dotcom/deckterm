import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  TmuxServerUnavailableError,
  TmuxTerminalBackend,
} from "./tmux-terminal-backend";

// These run against the real tmux binary rather than a mock. The behaviour
// under test is tmux's own — that `new-session` starts a server implicitly, and
// that `list-sessions` distinguishes "running but idle" from "not running" —
// so mocking the spawn would test the mock's assumptions instead of tmux's.

const dirs: string[] = [];
const socketsToKill: string[] = [];

function freshSocketPath(): string {
  // Short prefix on purpose: a unix socket path is capped near 108 bytes, and
  // the repo's usual nested tmp dirs overflow it.
  const dir = mkdtempSync(join(tmpdir(), "dtx-"));
  dirs.push(dir);
  return join(dir, "t.sock");
}

function makeBackend(socketPath: string, requireExternalServer: boolean) {
  return new TmuxTerminalBackend({
    namespace: "test",
    socketPath,
    pipeDir: join(tmpdir(), "dtx-pipes"),
    shellCommandResolver: async () => ["/bin/sh", "-c", "sleep 30"],
    env: process.env,
    requireExternalServer,
  });
}

afterEach(() => {
  for (const socketPath of socketsToKill.splice(0)) {
    Bun.spawnSync(["tmux", "-S", socketPath, "kill-server"], {
      stderr: "ignore",
    });
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses to start the tmux server implicitly when the unit owns it", async () => {
  // This is the whole point of the flag. Without it, tmux would start a server
  // as a child of this process — in production that means inside
  // deckterm.service's control group, where the next restart of the backend
  // destroys every session.
  const socketPath = freshSocketPath();
  const backend = makeBackend(socketPath, true);

  await expect(
    backend.createSession("t1", tmpdir(), 80, 24, "u1", "u@example.com"),
  ).rejects.toBeInstanceOf(TmuxServerUnavailableError);

  // And it really did not start one behind our back.
  const check = Bun.spawnSync(["tmux", "-S", socketPath, "list-sessions"], {
    stderr: "ignore",
  });
  expect(check.exitCode).not.toBe(0);
});

test("the error names the unit to start", async () => {
  const socketPath = freshSocketPath();
  const backend = makeBackend(socketPath, true);
  const error = await backend
    .createSession("t1", tmpdir(), 80, 24, "u1", "u@example.com")
    .then(() => null)
    .catch((caught) => caught as Error);
  expect(error?.message).toContain("deckterm-tmux.service");
  expect(error?.message).toContain(socketPath);
});

test("accepts a server that is running but holds no sessions", async () => {
  // The unit starts the server with `exit-empty off` before any terminal
  // exists, so the very first createSession meets an idle server. A liveness
  // check that treated "no sessions" as "no server" would reject it and no
  // terminal could ever be created.
  const socketPath = freshSocketPath();
  socketsToKill.push(socketPath);
  Bun.spawnSync([
    "tmux",
    "-S",
    socketPath,
    "start-server",
    ";",
    "set-option",
    "-s",
    "exit-empty",
    "off",
  ]);

  const listing = Bun.spawnSync(["tmux", "-S", socketPath, "list-sessions"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(listing.exitCode).toBe(0);
  expect(listing.stdout.toString().trim()).toBe("");

  const backend = makeBackend(socketPath, true);
  const session = await backend.createSession(
    "t1",
    tmpdir(),
    80,
    24,
    "u1",
    "u@example.com",
  );
  expect(session).toBeTruthy();
});

test("default behaviour is unchanged: the server may still start implicitly", async () => {
  // Local checkouts run with no unit installed. Leaving the flag off must keep
  // today's behaviour rather than breaking development.
  const socketPath = freshSocketPath();
  socketsToKill.push(socketPath);
  const backend = makeBackend(socketPath, false);

  const session = await backend.createSession(
    "t1",
    tmpdir(),
    80,
    24,
    "u1",
    "u@example.com",
  );
  expect(session).toBeTruthy();

  const check = Bun.spawnSync(["tmux", "-S", socketPath, "list-sessions"], {
    stderr: "ignore",
  });
  expect(check.exitCode).toBe(0);
});
