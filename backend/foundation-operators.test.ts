import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import net from "node:net";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  grantScopedCapability,
  revokeScopedCapability,
  setUserRole,
} from "./services/foundation-state";

// Operator sessions (design docs/plans/2026-11-14-operator-sessions-panel-
// design.md) on the REAL authorization path: a child DeckTerm server without
// the legacy bootstrap bypass, bootstrapped by token, so the bootstrap gate,
// role bundles, scoped grants and audit rows all run as in production. The
// "operator" is a throwaway system-tmux server in a private socket folder.
//
// Isolation as in operator-api.test.ts: explicit child environment and
// `--no-env-file`; cleanup kills only processes under this file's temp root.

const SYSTEM_TMUX = "/usr/bin/tmux";
const AVAILABLE = existsSync(SYSTEM_TMUX) && Boolean(Bun.which("tmux"));
const REPO_ROOT = join(import.meta.dir, "..");
const it = AVAILABLE ? test : test.skip;

let root = "";
let port = 0;
let opDir = "";
let workRoot = "";
let stateDir = "";
let ownerId = "";
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
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { ok: code === 0, stdout };
}

const opSock = (name: string) => join(opDir, `op-${name}`);

function api(path: string, init: RequestInit = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, init);
}

function attach(name: string) {
  return api(`/api/operators/${name}/attach`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-deckterm-request": "1" },
    body: JSON.stringify({ cols: 80, rows: 24 }),
  });
}

async function listNames(): Promise<string[]> {
  const res = await api("/api/operators");
  expect(res.status).toBe(200);
  return ((await res.json()) as Array<{ name: string }>).map((o) => o.name);
}

function withDb<T>(fn: (db: Database) => T): T {
  const db = new Database(join(stateDir, "deckterm.db"));
  // The child server holds the same database: wait for its locks.
  db.exec("PRAGMA busy_timeout = 5000");
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

type AuditRow = { action: string; decision: string; reason: string | null };
function auditRows(): AuditRow[] {
  return withDb(
    (db) =>
      db
        .query("SELECT action, decision, reason FROM audit_events ORDER BY rowid")
        .all() as AuditRow[],
  );
}

async function waitFor<T>(probe: () => Promise<T | null | false>, ms = 10_000): Promise<T> {
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

beforeAll(async () => {
  if (!AVAILABLE) return;
  root = await mkdtemp(join(tmpdir(), "dtfo-"));
  opDir = join(root, "o");
  workRoot = join(root, "w");
  stateDir = join(root, "s");
  for (const dir of [opDir, workRoot, join(root, "h"), join(workRoot, "proj")]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  port = await getFreePort();
  const env: Record<string, string> = {
    HOME: join(root, "h"),
    USER: process.env.USER || "deckterm-test",
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    SHELL: "/bin/bash",
    HOST: "127.0.0.1",
    PORT: String(port),
    TMUX_BACKEND: "1",
    TMUX_SESSION_NAMESPACE: `fo${port}`,
    TMUX_REQUIRE_EXTERNAL_SERVER: "0",
    DECKTERM_STATE_DIR: stateDir,
    ALLOWED_FILE_ROOTS: workRoot,
    // No DECKTERM_LEGACY_NO_BOOTSTRAP: the real bootstrap and grant path.
    DECKTERM_RUNTIME_ENV: "development",
    DECKTERM_PUBLISH_MODE: "local",
    DECKTERM_OS_ISOLATION: "0",
    DECKTERM_RETENTION_DISABLED: "1",
    DECKTERM_STARTUP_TMUX_TIMEOUT_MS: "3000",
    DECKTERM_OPERATOR_TMUX_DIR: opDir,
    DECKTERM_OPERATOR_TMUX_BIN: SYSTEM_TMUX,
    TERMINAL_RATE_LIMIT_PER_USER_MAX: "100",
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
  const started = await sys(
    opSock("alpha"),
    "new-session", "-d", "-s", "alpha", "-c", join(workRoot, "proj"), "sleep", "600",
  );
  expect(started.ok).toBe(true);
}, 30_000);

afterAll(async () => {
  if (!AVAILABLE) return;
  child?.kill("SIGTERM");
  await child?.exited;
  await killUnderRoot();
  await rm(root, { recursive: true, force: true });
}, 30_000);

it("before bootstrap: nothing is listed and attach is refused with an audited reason", async () => {
  expect(await listNames()).toEqual([]);
  const res = await attach("alpha");
  expect(res.status).toBe(404);
  expect((await res.json()).reason).toBe("operator_not_available");
  const denies = auditRows().filter(
    (r) => r.action === "terminal.operator_attach" && r.decision === "deny",
  );
  expect(denies.map((r) => r.reason)).toEqual(["bootstrap_required"]);
  // Refused before any socket is looked at, also for a name with none.
  expect((await attach("nobody")).status).toBe(404);
  expect(auditRows().at(-1)?.reason).toBe("bootstrap_required");
}, 20_000);

it("owner: listed; list polls write no audit rows; one attach writes one row of each kind", async () => {
  await api("/api/foundation/status");
  const token = (await readFile(join(stateDir, "bootstrap-token"), "utf8")).trim();
  const boot = await api("/api/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-deckterm-request": "1" },
    body: JSON.stringify({ token }),
  });
  expect(boot.status).toBe(200);

  // A name with no socket at all is "not running", not "untrusted".
  expect((await attach("nobody")).status).toBe(404);
  expect(auditRows().at(-1)?.reason).toBe("operator_not_running");

  const before = auditRows().length;
  for (let i = 0; i < 3; i++) {
    expect(await listNames()).toEqual(["alpha"]);
  }
  expect(auditRows().length).toBe(before);

  // The audit rows of a plain terminal create, for comparison.
  const plainStart = auditRows().length;
  const plain = await api("/api/terminals", {
    method: "POST",
    headers: { "content-type": "application/json", "x-deckterm-request": "1" },
    body: JSON.stringify({ cwd: join(workRoot, "proj"), cols: 80, rows: 24 }),
  });
  expect(plain.status).toBe(200);
  const plainRows = auditRows().slice(plainStart);
  const plainId = ((await plain.json()) as { id: string }).id;
  await api(`/api/terminals/${plainId}`, {
    method: "DELETE",
    headers: { "x-deckterm-request": "1" },
  });

  const attachStart = auditRows().length;
  const res = await attach("alpha");
  expect(res.status).toBe(200);
  const view = (await res.json()) as { id: string };
  // Exactly the create path's rows plus one operator_attach allow: the
  // quiet folder check added none.
  const added = auditRows().slice(attachStart);
  expect(added).toEqual([
    ...plainRows,
    { action: "terminal.operator_attach", decision: "allow", reason: null },
  ]);
  expect(plainRows.some((r) => r.action === "root.use")).toBe(true);

  ownerId = withDb(
    (db) =>
      (
        db
          .query("SELECT actor_user_id FROM terminal_sessions WHERE id = ?")
          .get(view.id) as { actor_user_id: string }
      ).actor_user_id,
  );
  expect(ownerId).toBeTruthy();
  const del = await api(`/api/terminals/${view.id}`, {
    method: "DELETE",
    headers: { "x-deckterm-request": "1" },
  });
  expect(del.ok).toBe(true);
  await waitFor(async () =>
    (await sys(opSock("alpha"), "list-clients", "-F", "#{client_pid}")).stdout.trim() === "",
  );
  expect((await sys(opSock("alpha"), "has-session", "-t", "=alpha")).ok).toBe(true);
}, 30_000);

it("member: operators are the owner's, so hidden and refused, also with grants on the root", async () => {
  withDb((db) => setUserRole(db, { userId: ownerId, role: "member" }));
  const grantIds: string[] = [];
  try {
    expect(await listNames()).toEqual([]);
    const refused = await attach("alpha");
    expect(refused.status).toBe(404);
    const last = auditRows()
      .filter((r) => r.action === "terminal.operator_attach")
      .at(-1);
    expect(last).toEqual({
      action: "terminal.operator_attach",
      decision: "deny",
      reason: "missing_capability",
    });

    const rootId = withDb(
      (db) =>
        (
          db
            .query("SELECT id FROM project_roots WHERE path = ?")
            .get(workRoot) as { id: string }
        ).id,
    );
    withDb((db) => {
      for (const capability of ["terminal.create", "root.use"]) {
        grantIds.push(
          grantScopedCapability(db, {
            userId: ownerId,
            capability: capability as never,
            resourceType: "root",
            resourceId: rootId,
          }),
        );
      }
    });
    // Root grants let a member open terminals there, not reach operators.
    expect(await listNames()).toEqual([]);
    expect((await attach("alpha")).status).toBe(404);
    expect(auditRows().at(-1)?.reason).toBe("missing_capability");
  } finally {
    withDb((db) => {
      for (const id of grantIds) revokeScopedCapability(db, id);
      setUserRole(db, { userId: ownerId, role: "owner" });
    });
  }
}, 30_000);
