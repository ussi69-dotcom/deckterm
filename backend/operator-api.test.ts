import { afterAll, beforeAll, expect, test } from "bun:test";
import net from "node:net";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Operator sessions API (design docs/plans/2026-11-14-operator-sessions-panel-
// design.md): GET /api/operators and POST /api/operators/:name/attach against
// a real DeckTerm child server (tmux backend) and a throwaway "operator" tmux
// server started with the SYSTEM tmux in a private socket folder, the way
// operator-tmux does. Nothing here touches the host's real operators: the
// child's DECKTERM_OPERATOR_TMUX_DIR points at this file's temp folder.
//
// Isolation as in attach-exit-liveness.test.ts: the child gets a fully
// explicit environment and `--no-env-file`; cleanup kills only processes
// whose command line references this file's temp root.

const SYSTEM_TMUX = "/usr/bin/tmux";
const AVAILABLE = existsSync(SYSTEM_TMUX) && Boolean(Bun.which("tmux"));
const REPO_ROOT = join(import.meta.dir, "..");

let root = "";
let port = 0;
let opDir = "";
let workRoot = "";
let outside = "";
let stateDir = "";
let child: Bun.Subprocess | null = null;
const output: string[] = [];

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (!address || typeof address === "string") {
        srv.close();
        reject(new Error("no port"));
        return;
      }
      const p = address.port;
      srv.close((err) => (err ? reject(err) : resolve(p)));
    });
  });
}

function drain(stream: ReadableStream<Uint8Array> | number | undefined | null) {
  if (!stream || typeof stream === "number") return;
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) output.push(decoder.decode(chunk, { stream: true }));
  })().catch(() => {});
}

async function sys(sock: string, ...args: string[]) {
  const proc = Bun.spawn([SYSTEM_TMUX, "-S", sock, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: "/usr/bin:/bin", HOME: join(root, "h"), LANG: "C.UTF-8" },
  });
  const [stdout, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return { ok: code === 0, stdout };
}

const opSock = (name: string) => join(opDir, `op-${name}`);

async function startOperator(name: string, cwd: string) {
  const res = await sys(opSock(name), "new-session", "-d", "-s", name, "-c", cwd, "sleep", "600");
  expect(res.ok).toBe(true);
}

async function api(path: string, init: RequestInit = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, init);
}

async function attach(name: string) {
  return api(`/api/operators/${name}/attach`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cols: 80, rows: 24 }),
  });
}

async function listOperators(): Promise<any[]> {
  const res = await api("/api/operators");
  expect(res.status).toBe(200);
  return (await res.json()) as any[];
}

async function waitFor<T>(probe: () => Promise<T | null | false>, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await Bun.sleep(150);
  }
  throw new Error(`timed out\n${output.join("")}`);
}

async function killUnderRoot() {
  if (!root) return;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const ps = Bun.spawnSync(["ps", "-eo", "pid=,args="]).stdout.toString();
    const pids = ps
      .split("\n")
      .map((line) => line.match(/^\s*(\d+)\s+(.*)$/))
      .filter((m): m is RegExpMatchArray => Boolean(m && m[2]!.includes(`${root}/`)))
      .map((m) => Number(m[1]))
      .filter((pid) => pid !== process.pid);
    if (!pids.length) return;
    for (const pid of pids) {
      try {
        process.kill(pid, signal);
      } catch {
        // gone
      }
    }
    await Bun.sleep(200);
  }
}

const describeIf = AVAILABLE ? test : test.skip;

beforeAll(async () => {
  if (!AVAILABLE) return;
  root = await mkdtemp(join(tmpdir(), "dtop-"));
  opDir = join(root, "o");
  workRoot = join(root, "w");
  outside = join(root, "x");
  stateDir = join(root, "s");
  for (const dir of [opDir, workRoot, outside, join(root, "h"), join(workRoot, "proj")]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  port = await getFreePort();
  const namespace = `op${port}`;
  const env: Record<string, string> = {
    HOME: join(root, "h"),
    USER: process.env.USER || "deckterm-test",
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    SHELL: "/bin/bash",
    HOST: "127.0.0.1",
    PORT: String(port),
    TMUX_BACKEND: "1",
    TMUX_SESSION_NAMESPACE: namespace,
    TMUX_REQUIRE_EXTERNAL_SERVER: "0",
    DECKTERM_STATE_DIR: stateDir,
    ALLOWED_FILE_ROOTS: workRoot,
    DECKTERM_LEGACY_NO_BOOTSTRAP: "1",
    DECKTERM_RUNTIME_ENV: "development",
    DECKTERM_PUBLISH_MODE: "local",
    DECKTERM_OS_ISOLATION: "0",
    DECKTERM_RETENTION_DISABLED: "1",
    DECKTERM_STARTUP_TMUX_TIMEOUT_MS: "3000",
    DECKTERM_OPERATOR_TMUX_DIR: opDir,
    DECKTERM_OPERATOR_TMUX_BIN: SYSTEM_TMUX,
    CF_ACCESS_REQUIRED: "0",
    CF_ACCESS_TEAM_NAME: "",
    CF_ACCESS_AUD: "",
  };
  child = Bun.spawn([process.execPath, "--no-env-file", "run", "backend/index.ts"], {
    cwd: REPO_ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  drain(child.stdout);
  drain(child.stderr);
  await waitFor(async () => {
    try {
      return (await api("/api/health")).ok;
    } catch {
      return false;
    }
  }, 15_000);
}, 30_000);

afterAll(async () => {
  if (!AVAILABLE) return;
  child?.kill("SIGTERM");
  await child?.exited;
  await killUnderRoot();
  await rm(root, { recursive: true, force: true });
}, 30_000);

describeIf("lists running operators, ignores stale sockets and folders outside the roots", async () => {
  expect(await listOperators()).toEqual([]);
  await startOperator("alpha", join(workRoot, "proj"));
  await startOperator("outsider", outside);
  // A stale name: a server that ended.
  await startOperator("gone", workRoot);
  await sys(opSock("gone"), "kill-server");

  const list = await waitFor(async () => {
    const rows = await listOperators();
    return rows.length ? rows : null;
  });
  expect(list.map((o) => o.name)).toEqual(["alpha"]);
  expect(list[0]).toMatchObject({
    name: "alpha",
    cwd: join(workRoot, "proj"),
    agentName: null,
    agentStatus: null,
    attachedTerminalId: null,
  });
}, 20_000);

describeIf("attach refuses bad names, ended operators and folders outside the roots", async () => {
  expect((await attach("Bad_Name")).status).toBe(400);
  expect((await attach("x%3Bid")).status).toBe(400);
  // Not running and a folder outside the roots answer the same: the
  // endpoint reveals neither which operators run nor where.
  const missing = await attach("nobody");
  expect(missing.status).toBe(404);
  const missingBody = await missing.json();
  expect(missingBody.reason).toBe("operator_not_available");
  const forbidden = await attach("outsider");
  expect(forbidden.status).toBe(404);
  const forbiddenBody = await forbidden.json();
  expect(forbiddenBody).toEqual(missingBody);
  expect(JSON.stringify(forbiddenBody)).not.toContain(outside);
  // Nothing was created by any of them.
  const terminals = (await (await api("/api/terminals")).json()) as any[];
  expect(terminals.filter((t) => t.sessionStatus !== "ended")).toEqual([]);
}, 20_000);

describeIf("attach opens one attached view; a second attach returns it; closing only detaches", async () => {
  const res = await attach("alpha");
  expect(res.status).toBe(200);
  const view = (await res.json()) as any;
  expect(view.attachedOperator).toBe("alpha");
  expect(view.cwd).toBe(join(workRoot, "proj"));

  // The operator now has exactly one client: DeckTerm's view.
  await waitFor(async () => {
    const clients = (await sys(opSock("alpha"), "list-clients", "-F", "#{client_pid}")).stdout;
    return clients.trim().split("\n").filter(Boolean).length === 1;
  });

  const again = await attach("alpha");
  expect(again.status).toBe(200);
  const second = (await again.json()) as any;
  expect(second.id).toBe(view.id);
  expect(second.existing).toBe(true);

  // The list links the operator to its view, and the terminal row says so.
  const list = await listOperators();
  expect(list.find((o) => o.name === "alpha")?.attachedTerminalId).toBe(view.id);
  const terminals = (await (await api("/api/terminals")).json()) as any[];
  expect(terminals.find((t) => t.id === view.id)?.attachedOperator).toBe("alpha");

  // No transcript: the view has no pipe-pane log.
  const pipeDir = join(stateDir, "tmux", "pipes");
  const pipes = existsSync(pipeDir) ? readdirSync(pipeDir) : [];
  expect(pipes.some((file) => file.includes(view.id))).toBe(false);

  // Closing the view: the client goes, the operator stays.
  const del = await api(`/api/terminals/${view.id}`, { method: "DELETE" });
  expect(del.ok).toBe(true);
  await waitFor(async () => {
    const clients = (await sys(opSock("alpha"), "list-clients", "-F", "#{client_pid}")).stdout;
    return clients.trim() === "";
  });
  expect((await sys(opSock("alpha"), "has-session", "-t", "=alpha")).ok).toBe(true);
}, 30_000);

describeIf("an operator that ends disappears from the list without an error", async () => {
  await sys(opSock("alpha"), "kill-server");
  await waitFor(async () => {
    const rows = await listOperators();
    return rows.every((o) => o.name !== "alpha");
  });
}, 20_000);
