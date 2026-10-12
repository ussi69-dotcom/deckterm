import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TmuxTerminalBackend,
  classifyTmuxHasSession,
} from "./tmux-terminal-backend";

// Tri-state tmux liveness (false-ended catalog race, backlog P1). `tmux
// has-session` exits 1 both when the session is gone AND when the server
// merely cannot be reached; only the first may end a catalog row.

const TMUX_AVAILABLE = Boolean(Bun.which("tmux"));
const RUNNING_AS_ROOT =
  typeof process.getuid === "function" && process.getuid() === 0;
const SOCKET = "/tmp/dtlv-x/tmux/deckterm_t.sock";

test("exit 0 is alive", () => {
  expect(classifyTmuxHasSession({ exitCode: 0, stderr: "" })).toBe("alive");
});

test("only proof of absence is missing", () => {
  for (const stderr of [
    "can't find session: deckterm_t_abc\n",
    `no server running on ${SOCKET}\n`,
    // Socket file absent: the server is gone (end-don't-adopt policy).
    `error connecting to ${SOCKET} (No such file or directory)\n`,
  ]) {
    expect(classifyTmuxHasSession({ exitCode: 1, stderr })).toBe("missing");
  }
});

test("an unreachable or wedged server is unknown, never missing", () => {
  for (const stderr of [
    `error connecting to ${SOCKET} (Permission denied)\n`,
    `error connecting to ${SOCKET} (Connection reset by peer)\n`,
    "protocol version mismatch (client 8, server 7)\n",
    "server version is too old for client\n",
    "lost server\n",
    "server exited unexpectedly\n",
    "",
  ]) {
    expect(classifyTmuxHasSession({ exitCode: 1, stderr })).toBe("unknown");
  }
  // A probe we had to kill proves nothing, whatever it printed.
  expect(
    classifyTmuxHasSession({
      exitCode: 1,
      stderr: "can't find session: deckterm_t_abc\n",
      timedOut: true,
    }),
  ).toBe("unknown");
  expect(classifyTmuxHasSession({ exitCode: null, stderr: "" })).toBe(
    "unknown",
  );
});

// --- against a real tmux server on a private socket -------------------------

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots) {
    await chmod(join(root, "tmux", "t.sock"), 0o700).catch(() => {});
  }
  for (const signal of ["SIGCONT", "SIGTERM", "SIGKILL"] as const) {
    const pids = await processesReferencing(roots);
    if (pids.length === 0) break;
    for (const pid of pids) {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone.
      }
    }
    await Bun.sleep(signal === "SIGCONT" ? 0 : 200);
  }
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function processesReferencing(dirs: string[]): Promise<number[]> {
  if (dirs.length === 0) return [];
  const ps = Bun.spawn(["ps", "-eo", "pid=,args="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(ps.stdout).text();
  await ps.exited;
  const pids: number[] = [];
  for (const line of out.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match || Number(match[1]) === process.pid) continue;
    if (dirs.some((dir) => match[2].includes(`${dir}/`))) {
      pids.push(Number(match[1]));
    }
  }
  return pids;
}

async function makeBackend(): Promise<{
  backend: TmuxTerminalBackend;
  socket: string;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "dtlv-"));
  roots.push(root);
  const socket = join(root, "tmux", "t.sock");
  const backend = new TmuxTerminalBackend({
    namespace: "t",
    socketPath: socket,
    pipeDir: join(root, "pipes"),
    shellCommandResolver: async () => ["/bin/sh"],
    env: { PATH: process.env.PATH, HOME: root },
  });
  return { backend, socket, root };
}

async function tmuxAt(socket: string, root: string, args: string[]) {
  const proc = Bun.spawn(["tmux", "-S", socket, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: root },
  });
  const code = await proc.exited;
  return { code, out: (await new Response(proc.stdout).text()).trim() };
}

async function startServer(socket: string, root: string, session: string) {
  // sessionLiveness() never starts a server: start one with one session.
  await mkdir(join(root, "tmux"), { recursive: true, mode: 0o700 });
  const created = await tmuxAt(socket, root, [
    "new-session",
    "-d",
    "-s",
    session,
    "sleep 600",
  ]);
  expect(created.code).toBe(0);
  const pid = Number.parseInt(
    (await tmuxAt(socket, root, ["display-message", "-p", "#{pid}"])).out,
    10,
  );
  expect(pid).toBeGreaterThan(0);
  return pid;
}

test.skipIf(!TMUX_AVAILABLE)(
  "no server and no socket file is missing",
  async () => {
    const { backend } = await makeBackend();
    expect(await backend.sessionLiveness("deckterm_t_a")).toBe("missing");
    expect(await backend.sessionExists("deckterm_t_a")).toBe(false);
  },
);

test.skipIf(!TMUX_AVAILABLE)(
  "a live session is alive; names match exactly, never by prefix",
  async () => {
    const { backend, socket, root } = await makeBackend();
    await startServer(socket, root, "deckterm_t_abcdef");
    expect(await backend.sessionLiveness("deckterm_t_abcdef")).toBe("alive");
    expect(await backend.sessionExists("deckterm_t_abcdef")).toBe(true);
    // tmux would otherwise resolve a unique prefix to the live session.
    expect(await backend.sessionLiveness("deckterm_t_abc")).toBe("missing");
    expect(await backend.sessionLiveness("deckterm_t_other")).toBe("missing");
  },
);

test.skipIf(!TMUX_AVAILABLE || RUNNING_AS_ROOT)(
  "an alive server behind an unreadable socket (EACCES) is unknown",
  async () => {
    const { backend, socket, root } = await makeBackend();
    await startServer(socket, root, "deckterm_t_a");
    await chmod(socket, 0o000);
    try {
      expect(await backend.sessionLiveness("deckterm_t_a")).toBe("unknown");
      expect(await backend.sessionExists("deckterm_t_a")).toBe(false);
    } finally {
      await chmod(socket, 0o700);
    }
    expect(await backend.sessionLiveness("deckterm_t_a")).toBe("alive");
  },
);

test.skipIf(!TMUX_AVAILABLE)(
  "a wedged server is unknown once the probe times out",
  async () => {
    const { backend, socket, root } = await makeBackend();
    const serverPid = await startServer(socket, root, "deckterm_t_a");
    process.kill(serverPid, "SIGSTOP");
    try {
      const started = Date.now();
      expect(await backend.sessionLiveness("deckterm_t_a", 300)).toBe(
        "unknown",
      );
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      process.kill(serverPid, "SIGCONT");
    }
    expect(await backend.sessionLiveness("deckterm_t_a")).toBe("alive");
  },
  15_000,
);

test.skipIf(!TMUX_AVAILABLE)(
  "a dead server that left its socket behind is missing",
  async () => {
    const { backend, socket, root } = await makeBackend();
    const serverPid = await startServer(socket, root, "deckterm_t_a");
    process.kill(serverPid, "SIGKILL");
    for (let i = 0; i < 50; i++) {
      if ((await processesReferencing([root])).length === 0) break;
      await Bun.sleep(50);
    }
    expect(await backend.sessionLiveness("deckterm_t_a")).toBe("missing");
  },
);

test.skipIf(!TMUX_AVAILABLE)(
  "a probe that cannot even start is unknown",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "dtlv-"));
    roots.push(root);
    // The socket directory cannot be created under a regular file.
    await writeFile(join(root, "file"), "");
    const backend = new TmuxTerminalBackend({
      namespace: "t",
      socketPath: join(root, "file", "tmux", "t.sock"),
      shellCommandResolver: async () => ["/bin/sh"],
      env: { PATH: process.env.PATH },
    });
    expect(await backend.sessionLiveness("deckterm_t_a")).toBe("unknown");
    expect(await backend.sessionExists("deckterm_t_a")).toBe(false);
  },
);
