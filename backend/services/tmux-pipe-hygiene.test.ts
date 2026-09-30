import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxTerminalBackend } from "./tmux-terminal-backend";

// Pipe logs are full terminal transcripts. They used to live world-readable in
// a shared /tmp directory and were never deleted (7.4 GB of orphans found on
// the OVH host, 2026-09-30). These run against the real tmux binary because the
// file is created by the shell tmux spawns for `pipe-pane`, not by our code.

const TMUX_AVAILABLE = Boolean(Bun.which("tmux"));
const dirs: string[] = [];

function freshDirs() {
  // Short prefix: a unix socket path is capped near 108 bytes.
  const dir = mkdtempSync(join(tmpdir(), "dtp-"));
  dirs.push(dir);
  return { socketPath: join(dir, "t.sock"), pipeDir: join(dir, "pipes") };
}

function makeBackend(socketPath: string, pipeDir: string) {
  return new TmuxTerminalBackend({
    namespace: "hyg",
    socketPath,
    pipeDir,
    shellCommandResolver: async () => ["/bin/sh", "-c", "sleep 30"],
    env: process.env,
  });
}

function tmux(socketPath: string, args: string[]) {
  return Bun.spawnSync(["tmux", "-S", socketPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 50 && !check(); attempt += 1) {
    await Bun.sleep(20);
  }
  return check();
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    tmux(join(dir, "t.sock"), ["kill-server"]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(!TMUX_AVAILABLE)(
  "pipe logs are private to the service account",
  async () => {
    const { socketPath, pipeDir } = freshDirs();
    const backend = makeBackend(socketPath, pipeDir);
    const session = await backend.createSession(
      "a1",
      tmpdir(),
      80,
      24,
      "owner",
      "owner@example.test",
    );

    expect(statSync(pipeDir).mode & 0o777).toBe(0o700);
    expect(await waitFor(() => existsSync(session.pipePath!))).toBe(true);
    expect(statSync(session.pipePath!).mode & 0o777).toBe(0o600);
  },
);

test.skipIf(!TMUX_AVAILABLE)(
  "killing a session deletes its pipe log",
  async () => {
    const { socketPath, pipeDir } = freshDirs();
    const backend = makeBackend(socketPath, pipeDir);
    const session = await backend.createSession(
      "k1",
      tmpdir(),
      80,
      24,
      "owner",
      "owner@example.test",
    );
    expect(await waitFor(() => existsSync(session.pipePath!))).toBe(true);

    await backend.kill(session.sessionName);

    expect(existsSync(session.pipePath!)).toBe(false);
  },
);

test.skipIf(!TMUX_AVAILABLE)(
  "pruneOrphanPipeLogs keeps live sessions and removes the rest",
  async () => {
    const { socketPath, pipeDir } = freshDirs();
    const backend = makeBackend(socketPath, pipeDir);
    const live = await backend.createSession(
      "p1",
      tmpdir(),
      80,
      24,
      "owner",
      "owner@example.test",
    );
    expect(await waitFor(() => existsSync(live.pipePath!))).toBe(true);
    const orphan = join(pipeDir, "deckterm_hyg_deadbeef.log");
    const unrelated = join(pipeDir, "notes.txt");
    writeFileSync(orphan, "old transcript");
    writeFileSync(unrelated, "keep");

    const removed = await backend.pruneOrphanPipeLogs([live.sessionName]);

    expect(removed).toBe(1);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(live.pipePath!)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  },
);

test.skipIf(!TMUX_AVAILABLE)(
  "a pane still piping to an old location is re-armed to the current pipe dir",
  async () => {
    const { socketPath, pipeDir } = freshDirs();
    const legacyDir = join(dirs[dirs.length - 1], "legacy");
    mkdirSync(legacyDir);
    const sessionName = "hyg_r1";
    expect(
      tmux(socketPath, [
        "new-session",
        "-d",
        "-s",
        sessionName,
        "/bin/sh",
        "-c",
        "sleep 30",
      ]).exitCode,
    ).toBe(0);
    // Simulate a session armed by a previous release that wrote to /tmp.
    expect(
      tmux(socketPath, [
        "pipe-pane",
        "-o",
        "-t",
        sessionName,
        `cat >> ${join(legacyDir, `${sessionName}.log`)}`,
      ]).exitCode,
    ).toBe(0);

    const backend = makeBackend(socketPath, pipeDir);
    const attached = await backend.attach(sessionName, {
      cols: 80,
      rows: 24,
    } as any);
    attached.proc.kill();

    const expected = join(pipeDir, `${sessionName}.log`);
    expect(attached.pipePath).toBe(expected);
    expect(await waitFor(() => existsSync(expected))).toBe(true);
  },
);
