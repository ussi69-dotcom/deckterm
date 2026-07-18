import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

// Restart/session lifecycle (backlog P1, discovered during release a006ae6):
// a service SIGTERM must detach from live tmux sessions WITHOUT persisting
// status=ended for them — the tmux server survives the restart
// (state-dir-scoped socket + KillMode=process), so ending the rows makes
// startup recovery skip perfectly healthy shells. These tests drive a real
// child server process (template: startup-failure.test.ts) against an
// isolated temp state dir, so the tmux server, socket, namespace and sqlite
// file never touch the dev/prod instances.

const TMUX_AVAILABLE = Boolean(Bun.which("tmux"));

const childProcesses = new Set<Bun.Subprocess>();
const tempDirs: string[] = [];
const tmuxSockets: string[] = [];

afterEach(async () => {
  for (const child of childProcesses) {
    child.kill();
    try {
      await child.exited;
    } catch {
      // Ignore shutdown races during cleanup.
    }
  }
  childProcesses.clear();

  for (const socket of tmuxSockets.splice(0)) {
    try {
      await Bun.spawn(["tmux", "-S", socket, "kill-server"], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited;
    } catch {
      // No server on that socket — fine.
    }
  }

  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

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
  stateDir: string;
  workRoot: string;
  tmuxSocket: string;
  child: Bun.Subprocess;
}

async function makeDirs(): Promise<{ stateDir: string; workRoot: string }> {
  const home = process.env.HOME || "/tmp";
  const stateDir = await mkdtemp(join(home, ".deckterm-shutdown-state-"));
  const workRoot = await mkdtemp(join(home, ".deckterm-shutdown-work-"));
  tempDirs.push(stateDir, workRoot);
  return { stateDir, workRoot };
}

function spawnServer(opts: {
  port: number;
  stateDir: string;
  workRoot: string;
  tmuxBackend: boolean;
  closeGraceMs?: number;
}): Bun.Subprocess {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(opts.port),
    TMUX_BACKEND: opts.tmuxBackend ? "1" : "0",
    CF_ACCESS_REQUIRED: "0",
    CF_ACCESS_TEAM_NAME: "",
    CF_ACCESS_AUD: "",
    DECKTERM_STATE_DIR: opts.stateDir,
    ALLOWED_FILE_ROOTS: opts.workRoot,
    // Deterministic legacy-bypass actor regardless of ambient shell env
    // (CLAUDE.md env-leak note), and never OS isolation.
    DECKTERM_LEGACY_NO_BOOTSTRAP: "1",
    DECKTERM_RUNTIME_ENV: "development",
    // Explicit per-port namespace: merely deleting the var is not enough —
    // the child's `bun run` auto-loads the repo .env, which would fill in
    // the dev namespace (TMUX_SESSION_NAMESPACE=deckterm) behind our back.
    TMUX_SESSION_NAMESPACE: `p${opts.port}`,
    // Explicit safe values, never deletions: an absent var would be
    // repopulated from the repo .env by the child's `bun run` auto-load.
    DECKTERM_PUBLISH_MODE: "local",
    DECKTERM_OS_ISOLATION: "0",
    DECKTERM_TAB_CLOSE_GRACE_MS: String(opts.closeGraceMs ?? 15 * 60 * 1000),
  };

  const child = Bun.spawn(["bun", "run", "backend/index.ts"], {
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  childProcesses.add(child);
  return child;
}

async function waitForHealth(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server on port ${port} never became healthy`);
}

async function startHarness(opts: {
  tmuxBackend: boolean;
  closeGraceMs?: number;
}): Promise<Harness> {
  const { stateDir, workRoot } = await makeDirs();
  const port = await getFreePort();
  const tmuxSocket = join(stateDir, "tmux", `deckterm_p${port}.sock`);
  if (opts.tmuxBackend) tmuxSockets.push(tmuxSocket);
  const child = spawnServer({
    port,
    stateDir,
    workRoot,
    tmuxBackend: opts.tmuxBackend,
    closeGraceMs: opts.closeGraceMs,
  });
  await waitForHealth(port);
  return { port, stateDir, workRoot, tmuxSocket, child };
}

async function restartHarness(
  h: Harness,
  opts: { tmuxBackend: boolean } = { tmuxBackend: true },
): Promise<Harness> {
  const child = spawnServer({
    port: h.port,
    stateDir: h.stateDir,
    workRoot: h.workRoot,
    tmuxBackend: opts.tmuxBackend,
  });
  await waitForHealth(h.port);
  return { ...h, child };
}

async function createTerminal(h: Harness): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${h.port}/api/terminals`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cols: 80, rows: 24, cwd: h.workRoot }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { id: string };
  expect(typeof body.id).toBe("string");
  return body.id;
}

interface WsHandle {
  ws: WebSocket;
  messages: string[];
  closed: Promise<void>;
}

async function attachWs(
  h: Harness,
  id: string,
  clientId: string | null = null,
): Promise<WsHandle> {
  const clientQuery = clientId
    ? `?clientId=${encodeURIComponent(clientId)}`
    : "";
  const ws = new WebSocket(
    `ws://127.0.0.1:${h.port}/ws/terminals/${id}${clientQuery}`,
  );
  const messages: string[] = [];
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") messages.push(event.data);
  });
  const closed = new Promise<void>((resolve) => {
    ws.addEventListener("close", () => resolve());
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("WS failed to open")));
  });
  return { ws, messages, closed };
}

function receivedExitMessage(handle: WsHandle): boolean {
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
  for (let attempt = 0; attempt < 50; attempt++) {
    const pong = handle.messages.slice(seen).some((raw) => {
      try {
        return JSON.parse(raw)?.type === "pong";
      } catch {
        return false;
      }
    });
    if (pong) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("No pong received on reattached WebSocket");
}

async function tmuxQuery(socket: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["tmux", "-S", socket, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = (await new Response(proc.stdout).text()).trim();
  if (exitCode !== 0) {
    // A swallowed failure would make e.g. two empty pane maps compare equal
    // and falsely pass the identity-preservation assertions.
    const stderr = (await new Response(proc.stderr).text()).trim();
    throw new Error(`tmux ${args.join(" ")} failed (${exitCode}): ${stderr}`);
  }
  return stdout;
}

/** session_name -> session_created for every session on the socket. */
async function tmuxSessions(socket: string): Promise<Map<string, string>> {
  const out = await tmuxQuery(socket, [
    "list-sessions",
    "-F",
    "#{session_name} #{session_created}",
  ]);
  const map = new Map<string, string>();
  for (const line of out.split("\n").filter(Boolean)) {
    const [name, created] = line.split(" ");
    map.set(name, created);
  }
  return map;
}

/** session_name -> pane_pid for every pane on the socket. */
async function tmuxPanePids(socket: string): Promise<Map<string, string>> {
  const out = await tmuxQuery(socket, [
    "list-panes",
    "-a",
    "-F",
    "#{session_name} #{pane_pid}",
  ]);
  const map = new Map<string, string>();
  for (const line of out.split("\n").filter(Boolean)) {
    const [name, pid] = line.split(" ");
    map.set(name, pid);
  }
  return map;
}

function dbSessionStatuses(stateDir: string): Map<string, string> {
  const db = new Database(join(stateDir, "deckterm.db"), { readonly: true });
  try {
    const rows = db.query("SELECT id, status FROM terminal_sessions").all() as {
      id: string;
      status: string;
    }[];
    return new Map(rows.map((row) => [row.id, row.status]));
  } finally {
    db.close();
  }
}

async function listTerminals(h: Harness): Promise<{ id: string }[]> {
  const res = await fetch(`http://127.0.0.1:${h.port}/api/terminals`);
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string }[];
}

async function scheduleClose(
  h: Harness,
  id: string,
  clientId: string,
): Promise<{
  terminationScheduledAt: number | null;
  preservedByOtherClient?: boolean;
}> {
  const response = await fetch(
    `http://127.0.0.1:${h.port}/api/terminals/${id}/close-later`,
    {
      method: "POST",
      headers: { "x-deckterm-client-id": clientId },
    },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    terminationScheduledAt: number | null;
    preservedByOtherClient?: boolean;
  };
}

test.skipIf(!TMUX_AVAILABLE)(
  "scheduled tab close ends a detached session after the grace window",
  async () => {
    const h = await startHarness({ tmuxBackend: true, closeGraceMs: 500 });
    const id = await createTerminal(h);
    const scheduled = await scheduleClose(h, id, "closing-client");
    expect(typeof scheduled.terminationScheduledAt).toBe("number");

    for (let attempt = 0; attempt < 30; attempt++) {
      if (dbSessionStatuses(h.stateDir).get(id) === "ended") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(dbSessionStatuses(h.stateDir).get(id)).toBe("ended");
    const listed = (await listTerminals(h)) as Array<{
      id: string;
      sessionStatus?: string;
    }>;
    expect(listed.find((terminal) => terminal.id === id)?.sessionStatus).toBe(
      "ended",
    );
  },
  15000,
);

test.skipIf(!TMUX_AVAILABLE)(
  "an attached or foreign client prevents scheduled termination",
  async () => {
    const h = await startHarness({ tmuxBackend: true, closeGraceMs: 500 });
    const id = await createTerminal(h);
    const attached = await attachWs(h, id, "same-client");

    const scheduled = await scheduleClose(h, id, "same-client");
    expect(typeof scheduled.terminationScheduledAt).toBe("number");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const afterSweep = (await listTerminals(h)) as Array<{
      id: string;
      sessionStatus?: string;
      terminationScheduledAt?: number | null;
    }>;
    expect(afterSweep.find((terminal) => terminal.id === id)).toMatchObject({
      sessionStatus: "active",
      terminationScheduledAt: null,
    });

    const foreign = await scheduleClose(h, id, "other-client");
    expect(foreign).toMatchObject({
      terminationScheduledAt: null,
      preservedByOtherClient: true,
    });
    expect(dbSessionStatuses(h.stateDir).get(id)).toBe("active");
    attached.ws.close();
  },
  15000,
);

test.skipIf(!TMUX_AVAILABLE)(
  "SIGTERM preserves live tmux sessions (rows stay active, tmux identity unchanged, restart recovers all)",
  async () => {
    const h = await startHarness({ tmuxBackend: true });

    // Three sessions in the shapes from the acceptance criteria: one with an
    // attached WebSocket, one fully detached, one detached but actively
    // producing output through shutdown.
    const attachedId = await createTerminal(h);
    const detachedId = await createTerminal(h);
    const activeId = await createTerminal(h);

    const attachedWs = await attachWs(h, attachedId);

    const activeWs = await attachWs(h, activeId);
    activeWs.ws.send(
      JSON.stringify({
        type: "input",
        data: "for i in $(seq 1 200); do date; sleep 0.1; done\n",
      }),
    );
    // Let the loop start, then detach so the session is output-active with no client.
    await new Promise((r) => setTimeout(r, 500));
    activeWs.ws.close();

    const sessionsBefore = await tmuxSessions(h.tmuxSocket);
    const panesBefore = await tmuxPanePids(h.tmuxSocket);
    expect(sessionsBefore.size).toBe(3);

    h.child.kill("SIGTERM");
    const exitCode = await h.child.exited;
    childProcesses.delete(h.child);
    expect(exitCode).toBe(0);
    await attachedWs.closed;

    // Deploy-detach must not tell clients the terminal exited — a plain close
    // lets ReconnectingWebSocket reconnect into the recovered session.
    expect(receivedExitMessage(attachedWs)).toBe(false);

    // tmux identity is untouched: same sessions, same creation time, same pane PID.
    const sessionsAfter = await tmuxSessions(h.tmuxSocket);
    const panesAfter = await tmuxPanePids(h.tmuxSocket);
    expect(sessionsAfter).toEqual(sessionsBefore);
    expect(panesAfter).toEqual(panesBefore);

    // The incident: shutdown raced status=ended rows for live tmux sessions.
    const statuses = dbSessionStatuses(h.stateDir);
    expect(statuses.get(attachedId)).toBe("active");
    expect(statuses.get(detachedId)).toBe("active");
    expect(statuses.get(activeId)).toBe("active");

    // Restart on the same state dir: catalog recovery, no duplicates.
    const h2 = await restartHarness(h);
    const listed = await listTerminals(h2);
    const listedIds = listed.map((t) => t.id).sort();
    expect(listedIds).toEqual([attachedId, detachedId, activeId].sort());
    expect(new Set(listedIds).size).toBe(3);

    const sessionsRecovered = await tmuxSessions(h.tmuxSocket);
    expect(sessionsRecovered).toEqual(sessionsBefore);

    // Reattach works after recovery.
    const reattached = await attachWs(h2, attachedId);
    await pingPong(reattached);
    reattached.ws.close();
  },
  30000,
);

test.skipIf(!TMUX_AVAILABLE)(
  "a genuinely missing tmux session still reconciles to ended on restart",
  async () => {
    const h = await startHarness({ tmuxBackend: true });

    const keepId = await createTerminal(h);
    const killedId = await createTerminal(h);

    h.child.kill("SIGTERM");
    await h.child.exited;
    childProcesses.delete(h.child);

    // Simulate a shell that truly died while the service was down.
    await tmuxQuery(h.tmuxSocket, [
      "kill-session",
      "-t",
      `deckterm_p${h.port}_${killedId}`,
    ]);

    const h2 = await restartHarness(h);
    const listed = await listTerminals(h2);
    expect(listed.map((t) => t.id)).toContain(keepId);

    const statuses = dbSessionStatuses(h.stateDir);
    expect(statuses.get(keepId)).toBe("active");
    expect(statuses.get(killedId)).toBe("ended");
  },
  30000,
);

test("raw mode SIGTERM deterministically marks sessions ended (no zombie active rows)", async () => {
  const h = await startHarness({ tmuxBackend: false });

  const firstId = await createTerminal(h);
  const secondId = await createTerminal(h);

  h.child.kill("SIGTERM");
  const exitCode = await h.child.exited;
  childProcesses.delete(h.child);
  expect(exitCode).toBe(0);

  // Raw PTYs die with the process, so the shutdown path itself must persist
  // ended — synchronously, not in a racy async callback.
  const statuses = dbSessionStatuses(h.stateDir);
  expect(statuses.get(firstId)).toBe("ended");
  expect(statuses.get(secondId)).toBe("ended");
}, 30000);

test("raw-mode startup reconciles active rows the shutdown write never saw (SIGKILL / backend switch)", async () => {
  const h = await startHarness({ tmuxBackend: false });

  const firstId = await createTerminal(h);
  const secondId = await createTerminal(h);

  // SIGKILL bypasses the shutdown handler entirely — the same DB shape a
  // crash or a tmux→raw backend switch leaves behind: active rows with no
  // surviving PTY.
  h.child.kill("SIGKILL");
  await h.child.exited;
  childProcesses.delete(h.child);

  const beforeRestart = dbSessionStatuses(h.stateDir);
  expect(beforeRestart.get(firstId)).toBe("active");
  expect(beforeRestart.get(secondId)).toBe("active");

  // The catalog may still list them as recent history, but never as live.
  const h2 = await restartHarness(h, { tmuxBackend: false });
  const listed = (await listTerminals(h2)) as { sessionStatus?: string }[];
  expect(listed.filter((t) => t.sessionStatus === "active")).toEqual([]);

  const statuses = dbSessionStatuses(h.stateDir);
  expect(statuses.get(firstId)).toBe("ended");
  expect(statuses.get(secondId)).toBe("ended");
}, 30000);

test.skipIf(!TMUX_AVAILABLE)(
  "tmux→raw backend switch ends the unreachable rows but leaves the tmux shells running",
  async () => {
    const h = await startHarness({ tmuxBackend: true });
    const id = await createTerminal(h);

    h.child.kill("SIGTERM");
    await h.child.exited;
    childProcesses.delete(h.child);

    // Operator flips the deployment to the raw backend: the row is
    // unreachable from DeckTerm (raw cannot attach tmux sessions), so
    // startup must end it — honestly — without killing the tmux shell.
    const h2 = await restartHarness(h, { tmuxBackend: false });
    const listed = (await listTerminals(h2)) as { sessionStatus?: string }[];
    expect(listed.filter((t) => t.sessionStatus === "active")).toEqual([]);
    expect(dbSessionStatuses(h.stateDir).get(id)).toBe("ended");

    const survivors = await tmuxSessions(h.tmuxSocket);
    expect(survivors.has(`deckterm_p${h.port}_${id}`)).toBe(true);
  },
  30000,
);
