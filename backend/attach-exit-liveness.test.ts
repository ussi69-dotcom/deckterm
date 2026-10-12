import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import net from "node:net";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// False-ended catalog race (backlog P1, "Restart/session lifecycle REOPENED
// 2026-07-19"). In tmux mode the PTY DeckTerm holds is a `tmux attach-session`
// CLIENT, not the shell. That client can exit while its tmux session keeps
// running — `tmux detach-client`, a stray or child-first kill, the OOM killer
// — and that is a DETACH, not a terminal exit: the catalog row must stay
// active, no exit frame may reach the browser, and the very same pane must be
// re-attachable now and after the next restart. Likewise a tmux server that is
// alive but unreachable at startup (EACCES, protocol mismatch) is "unknown",
// never "missing". Only proof that the session is gone may end a row.
//
// Isolation: every server is a child process with a fully explicit
// environment (no ...process.env) started with `--no-env-file`, so neither the
// repo .env nor a DeckTerm-hosted shell can point it at a live state dir or
// tmux namespace. State dir, tmux socket and HOME live under a short
// mkdtemp root in the OS temp dir (unix socket paths max out at 108 bytes);
// ports come from the OS. Cleanup kills only processes whose command line
// references one of this file's temp roots (the tmux servers the children
// started, and their pipe-pane writers).

const TMUX_AVAILABLE = Boolean(Bun.which("tmux"));
// chmod 000 does not stop root from connecting to the socket.
const RUNNING_AS_ROOT =
  typeof process.getuid === "function" && process.getuid() === 0;
const REPO_ROOT = join(import.meta.dir, "..");

const childProcesses = new Set<Bun.Subprocess>();
const runRoots: string[] = [];
const tmuxSockets: string[] = [];

afterEach(async () => {
  for (const child of childProcesses) {
    child.kill("SIGTERM");
    try {
      await child.exited;
    } catch {
      // Ignore shutdown races during cleanup.
    }
  }
  childProcesses.clear();
  for (const socket of tmuxSockets.splice(0)) {
    await chmod(socket, 0o700).catch(() => {});
  }
  await killProcessesUnder(runRoots);
  await Promise.all(
    runRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function processesReferencing(roots: string[]): Promise<number[]> {
  const ps = Bun.spawn(["ps", "-eo", "pid=,args="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(ps.stdout).text();
  await ps.exited;
  const pids: number[] = [];
  for (const line of out.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) continue;
    if (roots.some((root) => match[2].includes(`${root}/`))) pids.push(pid);
  }
  return pids;
}

/** Kills the tmux servers (and pipe-pane writers) these tests started. */
async function killProcessesUnder(roots: string[]): Promise<void> {
  if (roots.length === 0) return;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const pids = await processesReferencing(roots);
    if (pids.length === 0) return;
    for (const pid of pids) {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone.
      }
    }
    await Bun.sleep(200);
  }
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (!address || typeof address === "string") {
        srv.close();
        reject(new Error("Failed to allocate free port"));
        return;
      }
      const port = address.port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

interface Harness {
  port: number;
  root: string;
  stateDir: string;
  workRoot: string;
  home: string;
  namespace: string;
  socket: string;
  child: Bun.Subprocess;
  /** stdout+stderr of every server process this harness started. */
  output: string[];
}

function drain(
  stream: ReadableStream<Uint8Array> | number | undefined | null,
  sink: string[],
) {
  if (!stream || typeof stream === "number") return;
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      sink.push(decoder.decode(chunk, { stream: true }));
    }
  })().catch(() => {});
}

function spawnServer(h: Omit<Harness, "child">): Bun.Subprocess {
  // Fully explicit: nothing is inherited, and `--no-env-file` stops the
  // child's `bun run` from backfilling absent vars from the repo .env.
  const env: Record<string, string> = {
    HOME: h.home,
    USER: process.env.USER || "deckterm-test",
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    SHELL: "/bin/bash",
    HOST: "127.0.0.1",
    PORT: String(h.port),
    TMUX_BACKEND: "1",
    TMUX_SESSION_NAMESPACE: h.namespace,
    TMUX_REQUIRE_EXTERNAL_SERVER: "0",
    DECKTERM_STATE_DIR: h.stateDir,
    ALLOWED_FILE_ROOTS: h.workRoot,
    DECKTERM_LEGACY_NO_BOOTSTRAP: "1",
    DECKTERM_RUNTIME_ENV: "development",
    DECKTERM_PUBLISH_MODE: "local",
    DECKTERM_OS_ISOLATION: "0",
    DECKTERM_RETENTION_DISABLED: "1",
    CF_ACCESS_REQUIRED: "0",
    CF_ACCESS_TEAM_NAME: "",
    CF_ACCESS_AUD: "",
  };
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "run", "backend/index.ts"],
    { cwd: REPO_ROOT, env, stdout: "pipe", stderr: "pipe" },
  );
  childProcesses.add(child);
  drain(child.stdout, h.output);
  drain(child.stderr, h.output);
  return child;
}

async function waitForHealth(h: Omit<Harness, "child">): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${h.port}/api/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(100);
  }
  throw new Error(
    `Server on port ${h.port} never became healthy:\n${h.output.join("")}`,
  );
}

async function startHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "dtlc-"));
  runRoots.push(root);
  const port = await getFreePort();
  const namespace = `lc${port}`;
  const stateDir = join(root, "s");
  const base = {
    port,
    root,
    stateDir,
    workRoot: join(root, "w"),
    home: join(root, "h"),
    namespace,
    socket: join(stateDir, "tmux", `deckterm_${namespace}.sock`),
    output: [] as string[],
  };
  expect(base.socket.length).toBeLessThan(100);
  await mkdir(base.workRoot, { recursive: true });
  await mkdir(base.home, { recursive: true });
  tmuxSockets.push(base.socket);
  const child = spawnServer(base);
  await waitForHealth(base);
  return { ...base, child };
}

async function stopServer(h: Harness): Promise<void> {
  h.child.kill("SIGTERM");
  await h.child.exited;
  childProcesses.delete(h.child);
}

async function restartServer(h: Harness): Promise<Harness> {
  const child = spawnServer(h);
  await waitForHealth(h);
  return { ...h, child };
}

async function createTerminal(h: Harness, cwd = h.workRoot): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${h.port}/api/terminals`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cols: 80, rows: 24, cwd }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { id: string };
  expect(typeof body.id).toBe("string");
  return body.id;
}

type ListedTerminal = { id: string; status?: string; sessionStatus?: string };

async function listTerminals(h: Harness): Promise<ListedTerminal[]> {
  const res = await fetch(`http://127.0.0.1:${h.port}/api/terminals`);
  expect(res.status).toBe(200);
  return (await res.json()) as ListedTerminal[];
}

function dbStatus(h: Harness, id: string): string | undefined {
  const db = new Database(join(h.stateDir, "deckterm.db"), { readonly: true });
  try {
    const row = db
      .query("SELECT status FROM terminal_sessions WHERE id = ?")
      .get(id) as { status: string } | null;
    return row?.status;
  } finally {
    db.close();
  }
}

const sessionName = (h: Harness, id: string) => `deckterm_${h.namespace}_${id}`;

async function tmux(
  h: Harness,
  args: string[],
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["tmux", "-S", h.socket, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: h.home },
  });
  const code = await proc.exited;
  return {
    code,
    out: (await new Response(proc.stdout).text()).trim(),
    err: (await new Response(proc.stderr).text()).trim(),
  };
}

async function tmuxHasSession(h: Harness, id: string): Promise<boolean> {
  return (
    (await tmux(h, ["has-session", "-t", `=${sessionName(h, id)}`])).code === 0
  );
}

async function panePidOf(h: Harness, id: string): Promise<string> {
  const { code, out, err } = await tmux(h, [
    "display-message",
    "-p",
    "-t",
    // A pane target needs the trailing colon for an exact session match.
    `=${sessionName(h, id)}:`,
    "#{pane_pid}",
  ]);
  if (code !== 0) throw new Error(`display-message failed: ${err}`);
  expect(out).toMatch(/^\d+$/);
  return out;
}

async function attachClientPids(h: Harness, id: string): Promise<number[]> {
  const { out } = await tmux(h, [
    "list-clients",
    "-t",
    `=${sessionName(h, id)}`,
    "-F",
    "#{client_pid}",
  ]);
  return out
    .split("\n")
    .map((line) => Number.parseInt(line, 10))
    .filter((pid) => pid > 0);
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function attachClientPid(h: Harness, id: string): Promise<number> {
  let pids: number[] = [];
  await waitFor(async () => {
    pids = await attachClientPids(h, id);
    return pids.length > 0;
  }, "the tmux attach client");
  expect(pids).toHaveLength(1);
  return pids[0];
}

interface WsHandle {
  ws: WebSocket;
  messages: string[];
  closed: Promise<void>;
  isClosed: () => boolean;
}

async function attachWs(h: Harness, id: string): Promise<WsHandle> {
  const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws/terminals/${id}`);
  const messages: string[] = [];
  const decoder = new TextDecoder();
  ws.addEventListener("message", (event) => {
    const data = event.data as unknown;
    if (typeof data === "string") messages.push(data);
    else if (data instanceof ArrayBuffer) messages.push(decoder.decode(data));
    else if (data instanceof Uint8Array) messages.push(decoder.decode(data));
  });
  let closedFlag = false;
  const closed = new Promise<void>((resolve) => {
    ws.addEventListener("close", () => {
      closedFlag = true;
      resolve();
    });
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("WS failed to open")));
  });
  return { ws, messages, closed, isClosed: () => closedFlag };
}

function receivedExitFrame(handle: WsHandle): boolean {
  return handle.messages.some((raw) => {
    try {
      return JSON.parse(raw)?.type === "exit";
    } catch {
      return false;
    }
  });
}

async function pingPong(handle: WsHandle): Promise<void> {
  const seen = handle.messages.length;
  handle.ws.send(JSON.stringify({ type: "ping" }));
  await waitFor(
    () =>
      handle.messages.slice(seen).some((raw) => {
        try {
          return JSON.parse(raw)?.type === "pong";
        } catch {
          return false;
        }
      }),
    "a pong on the re-attached WebSocket",
    5_000,
  );
}

/** Proves input reaches the pane and its output comes back on this socket. */
async function expectShellRoundTrip(handle: WsHandle): Promise<void> {
  // The typed text contains `$((40+2))`; only the shell's output contains
  // the evaluated marker, so the terminal's own echo cannot satisfy this.
  handle.ws.send(
    JSON.stringify({ type: "input", data: "echo lc_$((40+2))_mark\r" }),
  );
  await waitFor(
    () => handle.messages.join("").includes("lc_42_mark"),
    "shell output on the re-attached WebSocket",
  );
}

const ATTACH_CLIENT_EXITS: Array<
  [string, (h: Harness, id: string) => Promise<void>]
> = [
  [
    "tmux detach-client",
    async (h, id) => {
      const { code, err } = await tmux(h, [
        "detach-client",
        "-s",
        `=${sessionName(h, id)}`,
      ]);
      if (code !== 0) throw new Error(`detach-client failed: ${err}`);
    },
  ],
  [
    "SIGTERM to the attach client",
    async (h, id) => {
      process.kill(await attachClientPid(h, id), "SIGTERM");
    },
  ],
  [
    "SIGKILL to the attach client",
    async (h, id) => {
      process.kill(await attachClientPid(h, id), "SIGKILL");
    },
  ],
];

for (const [label, exitAttachClient] of ATTACH_CLIENT_EXITS) {
  test.skipIf(!TMUX_AVAILABLE)(
    `attach client exit via ${label} while the tmux session lives is a detach: row stays active, same pane re-attaches, restart recovers it`,
    async () => {
      let h = await startHarness();
      const id = await createTerminal(h);
      const panePid = await panePidOf(h, id);
      const first = await attachWs(h, id);
      await attachClientPid(h, id);

      await exitAttachClient(h, id);

      // The dead attach's socket is closed so the browser reconnects...
      await waitFor(first.isClosed, "the server to close the socket");
      // ...and no async ended-write may land late.
      await Bun.sleep(500);
      expect(await tmuxHasSession(h, id)).toBe(true);
      expect(receivedExitFrame(first)).toBe(false);
      expect(dbStatus(h, id)).toBe("active");
      expect(h.output.join("")).toContain(
        `[lifecycle] attach client for ${id} exited`,
      );

      // The reconnect lands in the SAME live pane, through one attach client.
      const again = await attachWs(h, id);
      await pingPong(again);
      await expectShellRoundTrip(again);
      expect(await panePidOf(h, id)).toBe(panePid);
      expect(await attachClientPids(h, id)).toHaveLength(1);
      expect(
        (await listTerminals(h)).find((terminal) => terminal.id === id)?.status,
      ).toBe("active");
      again.ws.close();

      // The next restart recovers it instead of skipping an ended row.
      await stopServer(h);
      h = await restartServer(h);
      expect(dbStatus(h, id)).toBe("active");
      expect(
        (await listTerminals(h)).find((terminal) => terminal.id === id)?.status,
      ).toBe("active");
      expect(await panePidOf(h, id)).toBe(panePid);
    },
    60_000,
  );
}

test.skipIf(!TMUX_AVAILABLE)(
  "a real tmux session end still sends exit and ends the row",
  async () => {
    const h = await startHarness();
    const id = await createTerminal(h);
    const ws = await attachWs(h, id);
    await attachClientPid(h, id);

    const killed = await tmux(h, [
      "kill-session",
      "-t",
      `=${sessionName(h, id)}`,
    ]);
    expect(killed.code).toBe(0);

    await waitFor(ws.isClosed, "the server to close the socket");
    await waitFor(() => dbStatus(h, id) === "ended", "the row to end");
    expect(receivedExitFrame(ws)).toBe(true);
    expect(
      (await listTerminals(h)).find((terminal) => terminal.id === id)
        ?.sessionStatus,
    ).toBe("ended");
  },
  60_000,
);

test.skipIf(!TMUX_AVAILABLE)(
  "a dead tmux server (stale socket) still sends exit and ends the row",
  async () => {
    const h = await startHarness();
    const id = await createTerminal(h);
    const ws = await attachWs(h, id);
    await attachClientPid(h, id);
    const serverPid = Number.parseInt(
      (await tmux(h, ["display-message", "-p", "#{pid}"])).out,
      10,
    );
    expect(serverPid).toBeGreaterThan(0);

    // SIGKILL leaves the socket file behind: "no server running on ...".
    process.kill(serverPid, "SIGKILL");

    await waitFor(ws.isClosed, "the server to close the socket");
    await waitFor(() => dbStatus(h, id) === "ended", "the row to end");
    expect(receivedExitFrame(ws)).toBe(true);
  },
  60_000,
);

test.skipIf(!TMUX_AVAILABLE)(
  "DELETE still ends the row and the tmux session",
  async () => {
    const h = await startHarness();
    const id = await createTerminal(h);
    const ws = await attachWs(h, id);
    await attachClientPid(h, id);

    const res = await fetch(`http://127.0.0.1:${h.port}/api/terminals/${id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    await waitFor(ws.isClosed, "the server to close the socket");
    expect(dbStatus(h, id)).toBe("ended");
    expect(await tmuxHasSession(h, id)).toBe(false);
    // The late attach-exit handling must not resurrect or re-attach it.
    await Bun.sleep(500);
    expect(dbStatus(h, id)).toBe("ended");
    expect(
      (await listTerminals(h)).find((terminal) => terminal.id === id)
        ?.sessionStatus,
    ).toBe("ended");
  },
  60_000,
);

test.skipIf(!TMUX_AVAILABLE)(
  "a linked view cannot be re-attached by id, so its attach exit still ends only the view",
  async () => {
    const h = await startHarness();
    const id = await createTerminal(h);
    const res = await fetch(
      `http://127.0.0.1:${h.port}/api/terminals/${id}/linked-view`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    const viewId = ((await res.json()) as { id: string }).id;
    const primary = await attachWs(h, id);
    const view = await attachWs(h, viewId);
    await waitFor(
      async () => (await attachClientPids(h, id)).length === 2,
      "both attach clients",
    );

    // Detaches EVERY client of the shared session: the primary's and the view's.
    const detached = await tmux(h, [
      "detach-client",
      "-s",
      `=${sessionName(h, id)}`,
    ]);
    expect(detached.code).toBe(0);

    await waitFor(view.isClosed, "the view's socket to close");
    await waitFor(primary.isClosed, "the primary's socket to close");
    await waitFor(() => dbStatus(h, viewId) === "ended", "the view to end");
    expect(receivedExitFrame(view)).toBe(true);
    expect(receivedExitFrame(primary)).toBe(false);
    expect(dbStatus(h, id)).toBe("active");
    expect(await tmuxHasSession(h, id)).toBe(true);
  },
  60_000,
);

test.skipIf(!TMUX_AVAILABLE || RUNNING_AS_ROOT)(
  "an unreachable (alive but EACCES) tmux server at startup leaves live rows active",
  async () => {
    let h = await startHarness();
    const id = await createTerminal(h);
    const panePid = await panePidOf(h, id);
    await stopServer(h);

    // The tmux server keeps running; connect() now fails with EACCES.
    await chmod(h.socket, 0o000);
    try {
      h = await restartServer(h);
      expect(dbStatus(h, id)).toBe("active");
      // The catalog poll cannot restore it either, and must not end it.
      const listed = (await listTerminals(h)).find(
        (terminal) => terminal.id === id,
      );
      expect(listed?.sessionStatus).toBe("active");
      expect(dbStatus(h, id)).toBe("active");
      expect(h.output.join("")).toContain("unknown");
      await stopServer(h);
    } finally {
      await chmod(h.socket, 0o700);
    }

    h = await restartServer(h);
    expect(dbStatus(h, id)).toBe("active");
    expect(
      (await listTerminals(h)).find((terminal) => terminal.id === id)?.status,
    ).toBe("active");
    expect(await panePidOf(h, id)).toBe(panePid);
  },
  60_000,
);

test.skipIf(!TMUX_AVAILABLE)(
  "a truly missing tmux session still reconciles to ended at startup",
  async () => {
    let h = await startHarness();
    const kept = await createTerminal(h);
    const gone = await createTerminal(h);
    await stopServer(h);
    const killed = await tmux(h, [
      "kill-session",
      "-t",
      `=${sessionName(h, gone)}`,
    ]);
    expect(killed.code).toBe(0);

    h = await restartServer(h);
    expect(dbStatus(h, kept)).toBe("active");
    expect(dbStatus(h, gone)).toBe("ended");
  },
  60_000,
);

test.skipIf(!TMUX_AVAILABLE)(
  "concurrent catalog polls and a WebSocket upgrade restore ONE managed terminal",
  async () => {
    const h = await startHarness();
    const id = await createTerminal(h);
    const first = await attachWs(h, id);
    await attachClientPid(h, id);

    // Leave the row active and the session alive with nothing in memory:
    // the next requests must lazily restore it.
    const detached = await tmux(h, [
      "detach-client",
      "-s",
      `=${sessionName(h, id)}`,
    ]);
    expect(detached.code).toBe(0);
    await waitFor(first.isClosed, "the server to close the socket");
    await waitFor(
      async () => (await attachClientPids(h, id)).length === 0,
      "the old attach client to go away",
    );
    expect(dbStatus(h, id)).toBe("active");

    const [ws, ...lists] = await Promise.all([
      attachWs(h, id),
      ...Array.from({ length: 6 }, () => listTerminals(h)),
    ]);
    for (const list of lists) {
      expect(list.find((terminal) => terminal.id === id)?.status).toBe(
        "active",
      );
    }
    await pingPong(ws);
    await Bun.sleep(500);
    // One managed terminal = one tmux attach client. Duplicates would leave
    // orphaned attach clients behind that nothing ever cleans up.
    expect(await attachClientPids(h, id)).toHaveLength(1);
    await expectShellRoundTrip(ws);
    ws.ws.close();
  },
  60_000,
);

test.skipIf(!TMUX_AVAILABLE)(
  "a live session whose recorded cwd was deleted still re-attaches, and never 500s the catalog",
  async () => {
    // A task worktree removed under a running terminal: the recorded
    // creation cwd is gone, the tmux session lives on.
    const h = await startHarness();
    const doomed = join(h.workRoot, "worktree");
    await mkdir(doomed, { recursive: true });
    const id = await createTerminal(h, doomed);
    const healthy = await createTerminal(h);
    const panePid = await panePidOf(h, id);
    const first = await attachWs(h, id);
    await attachClientPid(h, id);

    await rm(doomed, { recursive: true, force: true });
    const detached = await tmux(h, [
      "detach-client",
      "-s",
      `=${sessionName(h, id)}`,
    ]);
    expect(detached.code).toBe(0);
    await waitFor(first.isClosed, "the server to close the socket");

    // The catalog keeps answering and lists both rows as live.
    for (let i = 0; i < 3; i++) {
      const listed = await listTerminals(h);
      expect(listed.find((t) => t.id === healthy)?.sessionStatus).toBe(
        "active",
      );
      expect(listed.find((t) => t.id === id)?.sessionStatus).toBe("active");
    }

    // The same pane re-attaches although its creation directory is gone.
    const again = await attachWs(h, id);
    await pingPong(again);
    await expectShellRoundTrip(again);
    expect(await panePidOf(h, id)).toBe(panePid);
    expect(dbStatus(h, id)).toBe("active");
    again.ws.close();
  },
  60_000,
);

test.skipIf(!TMUX_AVAILABLE)(
  "with no browser, a dead attach is re-attached server-side and output written in the gap is still processed",
  async () => {
    const h = await startHarness();
    const id = await createTerminal(h);
    const panePid = await panePidOf(h, id);
    const oldClient = await attachClientPid(h, id);

    // No WebSocket and no catalog poll from here on: only the server can
    // bring the attach back.
    process.kill(oldClient, "SIGKILL");
    await waitFor(
      () => h.output.join("").includes(`[lifecycle] attach client for ${id}`),
      "the detach to be handled",
    );
    // A notification the pane prints while nothing is attached. Only the
    // shell's output contains the evaluated marker, not the typed echo.
    const typed = await tmux(h, [
      "send-keys",
      "-t",
      `=${sessionName(h, id)}:`,
      "printf '\\033]9;%s\\007' lc_gap_$((40+2))",
      "Enter",
    ]);
    expect(typed.code).toBe(0);

    // The server re-attaches on its own (first retry after about 1 s).
    await waitFor(
      async () => {
        const pids = await attachClientPids(h, id);
        return pids.length === 1 && pids[0] !== oldClient;
      },
      "a server-side re-attach",
      8_000,
    );
    expect(await panePidOf(h, id)).toBe(panePid);
    expect(dbStatus(h, id)).toBe("active");

    // The gap's notification reached the re-attached handle (pump or poll).
    await waitFor(
      async () =>
        JSON.stringify(
          (await listTerminals(h)).find((terminal) => terminal.id === id),
        ).includes("lc_gap_42"),
      "the gap notification on the re-attached terminal",
      8_000,
    );
    expect(await attachClientPids(h, id)).toHaveLength(1);
  },
  60_000,
);
