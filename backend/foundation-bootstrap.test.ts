import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const tempDirs: string[] = [];
const servers: Array<{ stop: () => void }> = [];
const openSockets: WebSocket[] = [];
const ISOLATED_ENV_KEYS = [
  "DECKTERM_STATE_DIR",
  "ALLOWED_FILE_ROOTS",
  "TMUX_BACKEND",
  "CF_ACCESS_REQUIRED",
  "CF_ACCESS_TEAM_NAME",
  "CF_ACCESS_AUD",
  "DECKTERM_RUNTIME_ENV",
  "DECKTERM_PUBLISH_MODE",
  "DECKTERM_LEGACY_NO_BOOTSTRAP",
  "DECKTERM_BOOTSTRAP_ADMIN_EMAIL",
  "PORT",
  "SHELL",
] as const;
const previousEnv: Record<string, string | undefined> = {};
for (const key of ISOLATED_ENV_KEYS) {
  previousEnv[key] = process.env[key];
}

async function createTempDir(prefix: string) {
  const dir = await mkdtemp(join(process.env.HOME || "/tmp", prefix));
  tempDirs.push(dir);
  return dir;
}

async function openWebSocket(url: URL): Promise<WebSocket> {
  const wsUrl = url.toString().replace(/^http/, "ws");
  const socket = new WebSocket(wsUrl);
  openSockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out opening WebSocket ${wsUrl}`));
    }, 2000);
    socket.onopen = () => {
      clearTimeout(timeout);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket failed to open ${wsUrl}`));
    };
    socket.onclose = (event) => {
      if (socket.readyState !== WebSocket.OPEN) {
        clearTimeout(timeout);
        reject(new Error(`WebSocket closed before open ${event.code}`));
      }
    };
  });
  return socket;
}

afterEach(async () => {
  for (const socket of openSockets.splice(0)) {
    try {
      socket.close();
    } catch {
      // Best-effort cleanup for failed WebSocket assertions.
    }
  }
  for (const server of servers.splice(0)) {
    server.stop();
  }
  for (const key of ISOLATED_ENV_KEYS) {
    if (previousEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previousEnv[key];
    }
  }
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

test("foundation C0 bootstraps first admin with one-time token and allows terminal in imported root", async () => {
  const stateDir = await createTempDir(".deckterm-bootstrap-state-");
  const projectRoot = await createTempDir(".deckterm-bootstrap-project-");
  const outsideRoot = await createTempDir(".deckterm-bootstrap-outside-");

  process.env.DECKTERM_STATE_DIR = stateDir;
  process.env.ALLOWED_FILE_ROOTS = projectRoot;
  process.env.TMUX_BACKEND = "0";
  process.env.CF_ACCESS_REQUIRED = "0";
  delete process.env.CF_ACCESS_TEAM_NAME;
  delete process.env.CF_ACCESS_AUD;
  process.env.DECKTERM_RUNTIME_ENV = "development";
  process.env.PORT = "4174";
  delete process.env.DECKTERM_BOOTSTRAP_ADMIN_EMAIL;
  // Pin non-tunnel mode so this test deterministically exercises the
  // bootstrap-required gate. In cloudflare-tunnel mode that gate is bypassed by
  // design (see foundation-tunnel.test.ts), and a local .env enabling tunnel
  // mode would otherwise leak in and make this test pass in CI but fail locally.
  delete process.env.DECKTERM_PUBLISH_MODE;
  // Likewise: a shell running inside a DeckTerm dev terminal inherits the
  // service's DECKTERM_LEGACY_NO_BOOTSTRAP=1, which bypasses the very
  // bootstrap gate this test asserts.
  delete process.env.DECKTERM_LEGACY_NO_BOOTSTRAP;
  process.env.SHELL = "/bin/bash";

  const { createWebApp, startWebServer } = await import("./server");
  const app = createWebApp();

  const statusRes = await app.fetch(
    new Request("http://deckterm.test/api/foundation/status"),
  );
  expect(statusRes.status).toBe(200);
  await expect(statusRes.json()).resolves.toMatchObject({
    runtime: { environment: "development", backendMode: "raw" },
    auth: {
      actor: { id: "anonymous", email: "anonymous", source: "legacy_dev" },
      cloudflareAccessRequired: false,
    },
    bootstrap: { bootstrapped: false, mode: "token" },
    roots: [
      {
        name: projectRoot.split("/").pop(),
        path: projectRoot,
        status: "active",
        warning: null,
      },
    ],
  });

  const blockedRes = await app.fetch(
    new Request("http://deckterm.test/api/terminals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: projectRoot }),
    }),
  );
  expect(blockedRes.status).toBe(403);

  const server = await startWebServer("127.0.0.1", 0);
  servers.push(server);
  const wsRes = await fetch(
    new URL("/ws/terminals/fake-terminal", server.url),
    {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
      },
    },
  );
  expect(wsRes.status).toBe(403);
  await expect(wsRes.text()).resolves.toContain("DeckTerm bootstrap required");

  const token = (
    await readFile(join(stateDir, "bootstrap-token"), "utf8")
  ).trim();
  const bootstrapRes = await app.fetch(
    new Request("http://deckterm.test/api/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }),
  );
  expect(bootstrapRes.status).toBe(200);
  await expect(bootstrapRes.json()).resolves.toMatchObject({
    ok: true,
    user: { id: "anonymous" },
  });

  const forbiddenRootRes = await app.fetch(
    new Request("http://deckterm.test/api/terminals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: outsideRoot }),
    }),
  );
  expect(forbiddenRootRes.status).toBe(403);
  await expect(forbiddenRootRes.json()).resolves.toMatchObject({
    error: "Forbidden terminal root",
  });

  const createRes = await app.fetch(
    new Request("http://deckterm.test/api/terminals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: projectRoot, cols: 80, rows: 24 }),
    }),
  );
  expect(createRes.status).toBe(200);
  const created = (await createRes.json()) as { id: string; cwd: string };
  expect(created.cwd).toBe(projectRoot);

  const writeDb = new Database(join(stateDir, "deckterm.db"));
  expect(
    writeDb
      .query(
        "SELECT actor_user_id, cwd, status, ended_at FROM terminal_sessions WHERE id = ?",
      )
      .get(created.id),
  ).toEqual({
    actor_user_id: "anonymous",
    cwd: projectRoot,
    status: "active",
    ended_at: null,
  });

  // B3 S2: owner/admin now imply attach on ANY terminal via the check-time
  // role bundle (roleImpliesCapability), independent of materialized grant
  // rows — bootstrapFirstAdmin makes "anonymous" the owner (S1). Temporarily
  // demote to member so this grant-only deny/allow scenario still exercises
  // the scoped-grant path rather than short-circuiting via role_bundle;
  // restored to owner below before the final DELETE (which needs
  // terminal.manage on a terminal "anonymous" no longer owns).
  writeDb
    .query("UPDATE users SET role = 'member' WHERE id = ?")
    .run("anonymous");
  writeDb
    .query("DELETE FROM scoped_grants WHERE user_id = ? AND capability = ?")
    .run("anonymous", "terminal.attach");
  writeDb
    .query("UPDATE terminal_sessions SET actor_user_id = ? WHERE id = ?")
    .run("user_other", created.id);

  const deniedAttachRes = await fetch(
    new URL(`/ws/terminals/${created.id}`, server.url),
    {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
      },
    },
  );
  expect(deniedAttachRes.status).toBe(403);
  await expect(deniedAttachRes.text()).resolves.toContain("Forbidden");

  writeDb
    .query(
      `INSERT INTO scoped_grants (id, user_id, capability, resource_type, resource_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `grant_${crypto.randomUUID().replace(/-/g, "")}`,
      "anonymous",
      "terminal.attach",
      "terminal",
      created.id,
      new Date().toISOString(),
      new Date().toISOString(),
    );
  const socket = await openWebSocket(
    new URL(`/ws/terminals/${created.id}`, server.url),
  );
  expect(socket.readyState).toBe(WebSocket.OPEN);
  socket.close();

  // Restore "anonymous" to owner: the DELETE below needs terminal.manage on
  // a terminal it no longer owns (reassigned to "user_other" above), which
  // the owner role bundle covers exactly like the pre-B3 materialized
  // wildcard admin grant did.
  writeDb
    .query("UPDATE users SET role = 'owner' WHERE id = ?")
    .run("anonymous");

  const deleteRes = await app.fetch(
    new Request(`http://deckterm.test/api/terminals/${created.id}`, {
      method: "DELETE",
    }),
  );
  expect(deleteRes.status).toBe(200);

  expect(
    writeDb
      .query("SELECT status, ended_at FROM terminal_sessions WHERE id = ?")
      .get(created.id),
  ).toMatchObject({ status: "ended" });
  writeDb.close();

  const db = new Database(join(stateDir, "deckterm.db"), { readonly: true });
  const auditRows = db
    .query(
      "SELECT actor_user_id, action, resource_type, resource_id, decision, reason FROM audit_events ORDER BY created_at",
    )
    .all();
  db.close();
  expect(auditRows).toContainEqual(
    expect.objectContaining({
      actor_user_id: "anonymous",
      action: "terminal.create",
      decision: "deny",
      reason: "bootstrap_required",
    }),
  );
  expect(auditRows).toContainEqual(
    expect.objectContaining({
      actor_user_id: "anonymous",
      action: "terminal.create",
      resource_type: "terminal",
      resource_id: created.id,
      decision: "allow",
    }),
  );
  expect(auditRows).toContainEqual(
    expect.objectContaining({
      actor_user_id: "anonymous",
      action: "terminal.attach",
      resource_type: "terminal",
      resource_id: created.id,
      decision: "deny",
      reason: "missing_capability",
    }),
  );
  expect(auditRows).toContainEqual(
    expect.objectContaining({
      actor_user_id: "anonymous",
      action: "terminal.attach",
      resource_type: "terminal",
      resource_id: created.id,
      decision: "allow",
      reason: "granted",
    }),
  );
});
