import { ApiRequest as Request } from "./test-support/api-request";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  clearAgentSession,
  getTerminalSession,
  grantScopedCapability,
  initializeFoundationState,
  markTerminalSessionEnded,
  recordAgentSession,
  recordTerminalSession,
  releaseAgentResume,
  reserveAgentResume,
  revokeScopedCapability,
  scheduleTerminalSessionTermination,
  setUserRole,
} from "./services/foundation-state";

// S3 one-tap agent resume (design docs/plans/2026-10-22-agent-attention-
// design.md section 6): migration 11, the agent columns, the `resume` field
// of ended rows in GET /api/terminals and POST /api/terminals/:id/resume.
//
// Foundation state is a module-level singleton in server.ts, so this file
// runs as its OWN chained `bun test` invocation in test:unit (CLAUDE.md). It
// runs in non-bypass mode (real DB authz) with the legacy_dev "anonymous"
// actor bootstrapped as owner, like foundation-terminal-member.test.ts.
//
// Nothing here can start a real agent: TMUX_BACKEND is off and SHELL is a
// fake shell (a /bin/sh script, not bash) that only logs the lines typed
// into it, so a typed `claude --resume <id>` is recorded, never run.

const TEST_ISSUER = "test-team.cloudflareaccess.com";
const U1 = "0f0e0d0c-1111-2222-3333-444455556666";
const U2 = "7a7b7c7d-aaaa-4bbb-8ccc-ddddeeeeffff";
const U3 = "12345678-90ab-4cde-8f01-234567890abc";

let stateDir: string;
let allowedRoot: string;
let fakeShellDir: string;
let shellLog: string;
let ownerId: string;
let app: { fetch: (req: Request) => Response | Promise<Response> };
const createdTerminalIds: string[] = [];

const PRESERVED_ENV = [
  "DECKTERM_STATE_DIR",
  "ALLOWED_FILE_ROOTS",
  "CF_ACCESS_TEAM_NAME",
  "CF_ACCESS_REQUIRED",
  "CF_ACCESS_AUD",
  "DECKTERM_BOOTSTRAP_ADMIN_EMAIL",
  "DECKTERM_PUBLISH_MODE",
  "DECKTERM_LEGACY_NO_BOOTSTRAP",
  "DECKTERM_OS_ISOLATION",
  "DECKTERM_RUNTIME_ENV",
  "TMUX_BACKEND",
  "SHELL",
  "TERMINAL_RATE_LIMIT_PER_USER_MAX",
  "DECKTERM_TERMINAL_LIST_ENDED_LIMIT",
] as const;
const previousEnv: Record<string, string | undefined> = {};

function openDb(): Database {
  return new Database(join(stateDir, "deckterm.db"));
}

function withDb<T>(fn: (db: Database) => T): T {
  const db = openDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

async function json(res: Response): Promise<any> {
  return res.json();
}

function post(path: string, body: unknown = {}): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request(`http://deckterm.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );
}

async function listTerminals(): Promise<any[]> {
  const res = await app.fetch(
    new Request("http://deckterm.test/api/terminals"),
  );
  expect(res.status).toBe(200);
  return json(res);
}

async function createTerminal(
  cwd: string,
): Promise<{ id: string; cwd: string }> {
  const res = await post("/api/terminals", { cwd, cols: 80, rows: 24 });
  expect(res.status).toBe(200);
  const body = await json(res);
  createdTerminalIds.push(body.id);
  return body;
}

async function deleteTerminal(id: string) {
  await app.fetch(
    new Request(`http://deckterm.test/api/terminals/${id}`, {
      method: "DELETE",
    }),
  );
}

// An ENDED session row of `actor` with the given agent columns.
function seedEnded(
  id: string,
  agent: {
    agentName: string;
    sessionId: string | null;
    cwd: string;
  } | null,
  actor = ownerId,
) {
  withDb((db) => {
    recordTerminalSession(db, {
      id,
      actorUserId: actor,
      cwd: allowedRoot,
      status: "active",
    });
    if (agent) recordAgentSession(db, id, agent);
    markTerminalSessionEnded(db, id);
  });
}

function shellLines(): string[] {
  return existsSync(shellLog)
    ? readFileSync(shellLog, "utf8").split("\n").filter(Boolean)
    : [];
}

function resumeDenials(): Array<{ resource_id: string; reason: string }> {
  return withDb(
    (db) =>
      db
        .query(
          "SELECT resource_id, reason FROM audit_events WHERE action = 'terminal.resume' AND decision = 'deny' ORDER BY rowid",
        )
        .all() as Array<{ resource_id: string; reason: string }>,
  );
}

// Simulates a crash: SIGKILL to the fake shell that started in `folder`.
function killFakeShellIn(folder: string) {
  const line = shellLines().find((l) => l.endsWith(` cwd=${folder}`));
  expect(line).toBeDefined();
  process.kill(Number(line!.split(" ")[0]), "SIGKILL");
}

async function waitFor<T>(
  probe: () => T | null | undefined | false,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value;
    await Bun.sleep(25);
  }
  throw new Error("timed out waiting for condition");
}

beforeAll(async () => {
  for (const key of PRESERVED_ENV) previousEnv[key] = process.env[key];
  const home = process.env.HOME || "/tmp";
  stateDir = await mkdtemp(join(home, ".deckterm-agent-resume-state-"));
  allowedRoot = await mkdtemp(join(home, ".deckterm-agent-resume-root-"));
  fakeShellDir = await mkdtemp(join(home, ".deckterm-agent-resume-shell-"));
  for (const dir of ["proj-a", "proj-b", "proj-c"]) {
    mkdirSync(join(allowedRoot, dir));
  }

  // The fake shell: logs its cwd and every typed line (PID-prefixed). When
  // its start folder holds a `.fake-markers` script, it first plays it:
  // `emit <payload>` prints the DeckTerm shell marker with that payload (the
  // way the bash wrapper does around a real agent), `sleep <s>` waits.
  shellLog = join(fakeShellDir, "shell.log");
  const fakeShell = join(fakeShellDir, "fake-shell");
  writeFileSync(
    fakeShell,
    [
      "#!/bin/sh",
      `log='${shellLog}'`,
      'printf \'%s cwd=%s\\n\' "$$" "$PWD" >> "$log"',
      // A folder holding `.fake-exit` gets a shell that dies at once.
      'if [ -f "$PWD/.fake-exit" ]; then exit 0; fi',
      'if [ -f "$PWD/.fake-markers" ]; then',
      "  while IFS= read -r step; do",
      '    case "$step" in',
      '      "emit "*) printf \'\\033]9;9;deckterm;%s\\007\' "${step#emit }" ;;',
      '      "sleep "*) sleep "${step#sleep }" ;;',
      "    esac",
      '  done < "$PWD/.fake-markers"',
      "fi",
      "while IFS= read -r line; do",
      '  printf \'%s line=%s\\n\' "$$" "$line" >> "$log"',
      "done",
      "",
    ].join("\n"),
  );
  chmodSync(fakeShell, 0o755);

  process.env.DECKTERM_STATE_DIR = stateDir;
  process.env.ALLOWED_FILE_ROOTS = allowedRoot;
  process.env.CF_ACCESS_TEAM_NAME = TEST_ISSUER;
  process.env.CF_ACCESS_REQUIRED = "0";
  delete process.env.CF_ACCESS_AUD;
  delete process.env.DECKTERM_BOOTSTRAP_ADMIN_EMAIL;
  // A DeckTerm-hosted shell carries the service's publish mode and legacy
  // bypass; both would change the actor and the authz path under test.
  delete process.env.DECKTERM_PUBLISH_MODE;
  delete process.env.DECKTERM_LEGACY_NO_BOOTSTRAP;
  delete process.env.DECKTERM_OS_ISOLATION;
  process.env.DECKTERM_RUNTIME_ENV = "development";
  process.env.TMUX_BACKEND = "0";
  process.env.SHELL = fakeShell;
  process.env.TERMINAL_RATE_LIMIT_PER_USER_MAX = "100";
  // This file seeds more ended rows than the default listing cap (10).
  process.env.DECKTERM_TERMINAL_LIST_ENDED_LIMIT = "200";

  const serverModule = await import("./server");
  app = serverModule.createWebApp();

  await app.fetch(new Request("http://deckterm.test/api/foundation/status"));
  const token = (
    await readFile(join(stateDir, "bootstrap-token"), "utf8")
  ).trim();
  const res = await app.fetch(
    new Request("http://deckterm.test/api/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }),
  );
  expect(res.status).toBe(200);

  // The canonical owner id, as the create path stores it.
  const probe = await createTerminal(allowedRoot);
  ownerId = withDb((db) => getTerminalSession(db, probe.id)?.actorUserId) || "";
  expect(ownerId).toBeTruthy();
  await deleteTerminal(probe.id);
});

afterAll(async () => {
  for (const id of createdTerminalIds) await deleteTerminal(id);
  await Promise.all(
    [stateDir, allowedRoot, fakeShellDir].map((dir) =>
      rm(dir, { recursive: true, force: true }),
    ),
  );
  for (const key of PRESERVED_ENV) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

// --- Migration 11 and the row helpers (no server involved) -----------------

const AGENT_COLUMNS = [
  "agent_name",
  "agent_session_id",
  "agent_cwd",
  "agent_session_updated_at",
  "agent_resume_reserved_at",
];

function sessionColumns(db: Database): string[] {
  return (
    db.query("PRAGMA table_info(terminal_sessions)").all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

test("migration 11 on a fresh database: the four agent columns and the marker", async () => {
  const dir = await mkdtemp(join(process.env.HOME || "/tmp", ".deckterm-m11-"));
  try {
    const state = await initializeFoundationState({
      stateDir: dir,
      allowedFileRoots: [],
      env: {},
    });
    expect(sessionColumns(state.db)).toEqual(
      expect.arrayContaining(AGENT_COLUMNS),
    );
    expect(
      state.db
        .query("SELECT version FROM schema_migrations WHERE version = 11")
        .all(),
    ).toHaveLength(1);
    state.db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migration 11 on an existing (version 10) database adds the columns and keeps rows", async () => {
  const dir = await mkdtemp(join(process.env.HOME || "/tmp", ".deckterm-m11-"));
  try {
    const first = await initializeFoundationState({
      stateDir: dir,
      allowedFileRoots: [],
      env: {},
    });
    recordTerminalSession(first.db, {
      id: "old-row",
      actorUserId: "u1",
      cwd: "/srv/old",
      status: "ended",
    });
    // Make it a version-10 database: no agent columns, no marker 11.
    first.db.exec("DROP INDEX IF EXISTS idx_terminal_sessions_agent_cwd");
    for (const column of AGENT_COLUMNS) {
      first.db.exec(`ALTER TABLE terminal_sessions DROP COLUMN ${column}`);
    }
    first.db.exec("DELETE FROM schema_migrations WHERE version = 11");
    expect(sessionColumns(first.db)).not.toContain("agent_name");
    first.db.close();

    const second = await initializeFoundationState({
      stateDir: dir,
      allowedFileRoots: [],
      env: {},
    });
    expect(sessionColumns(second.db)).toEqual(
      expect.arrayContaining(AGENT_COLUMNS),
    );
    expect(getTerminalSession(second.db, "old-row")).toMatchObject({
      id: "old-row",
      cwd: "/srv/old",
      status: "ended",
      agentName: null,
      agentSessionId: null,
      agentCwd: null,
      agentSessionUpdatedAt: null,
    });
    expect(
      second.db
        .query("SELECT version FROM schema_migrations WHERE version = 11")
        .all(),
    ).toHaveLength(1);
    second.db.close();

    // Idempotent: a third start changes nothing.
    const third = await initializeFoundationState({
      stateDir: dir,
      allowedFileRoots: [],
      env: {},
    });
    expect(
      sessionColumns(third.db).filter((c) => c.startsWith("agent_")),
    ).toHaveLength(AGENT_COLUMNS.length);
    // The same-folder Codex lookup has its own index.
    const indexes = (
      third.db.query("PRAGMA index_list(terminal_sessions)").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(indexes).toContain("idx_terminal_sessions_agent_cwd");
    third.db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recordAgentSession and clearAgentSession touch only the agent columns", async () => {
  const dir = await mkdtemp(join(process.env.HOME || "/tmp", ".deckterm-m11-"));
  try {
    const { db } = await initializeFoundationState({
      stateDir: dir,
      allowedFileRoots: [],
      env: {},
    });
    recordTerminalSession(db, {
      id: "t1",
      actorUserId: "u1",
      cwd: "/w",
      status: "active",
    });
    const now = new Date("2026-10-22T10:00:00Z");
    expect(
      recordAgentSession(db, "t1", {
        agentName: "claude",
        sessionId: U1,
        cwd: "/w/proj",
        now,
      }),
    ).toBe(true);
    expect(getTerminalSession(db, "t1")).toMatchObject({
      status: "active",
      cwd: "/w",
      agentName: "claude",
      agentSessionId: U1,
      agentCwd: "/w/proj",
      agentSessionUpdatedAt: "2026-10-22T10:00:00.000Z",
    });
    // The session's own upsert and its end keep the agent columns.
    recordTerminalSession(db, {
      id: "t1",
      actorUserId: "u1",
      cwd: "/w",
      status: "active",
    });
    markTerminalSessionEnded(db, "t1");
    expect(getTerminalSession(db, "t1")).toMatchObject({
      status: "ended",
      agentName: "claude",
      agentSessionId: U1,
    });
    expect(clearAgentSession(db, "t1")).toBe(true);
    expect(getTerminalSession(db, "t1")).toMatchObject({
      status: "ended",
      cwd: "/w",
      agentName: null,
      agentSessionId: null,
      agentCwd: null,
      agentSessionUpdatedAt: null,
    });
    // No row, no write.
    expect(
      recordAgentSession(db, "missing", {
        agentName: "codex",
        sessionId: null,
        cwd: "/w",
      }),
    ).toBe(false);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a session whose close the user scheduled ends without resume data", async () => {
  const dir = await mkdtemp(join(process.env.HOME || "/tmp", ".deckterm-m11-"));
  try {
    const { db } = await initializeFoundationState({
      stateDir: dir,
      allowedFileRoots: [],
      env: {},
    });
    for (const id of ["scheduled", "crashed"]) {
      recordTerminalSession(db, {
        id,
        actorUserId: "u1",
        cwd: "/w",
        status: "active",
      });
      recordAgentSession(db, id, {
        agentName: "claude",
        sessionId: U1,
        cwd: "/w",
      });
    }
    // The user closed the tab (15-minute restore window), then the session
    // ended (window expired, or a reboot inside it): the close counts.
    scheduleTerminalSessionTermination(
      db,
      "scheduled",
      new Date(Date.now() + 15 * 60_000),
    );
    markTerminalSessionEnded(db, "scheduled");
    markTerminalSessionEnded(db, "crashed");
    expect(getTerminalSession(db, "scheduled")).toMatchObject({
      status: "ended",
      terminationScheduledAt: null,
      agentName: null,
      agentSessionId: null,
      agentCwd: null,
    });
    expect(getTerminalSession(db, "crashed")).toMatchObject({
      status: "ended",
      agentName: "claude",
      agentSessionId: U1,
    });
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("only one resume can reserve a row; release and a stale reservation free it", async () => {
  const dir = await mkdtemp(join(process.env.HOME || "/tmp", ".deckterm-m11-"));
  try {
    const { db } = await initializeFoundationState({
      stateDir: dir,
      allowedFileRoots: [],
      env: {},
    });
    recordTerminalSession(db, {
      id: "r1",
      actorUserId: "u1",
      cwd: "/w",
      status: "active",
    });
    recordAgentSession(db, "r1", {
      agentName: "claude",
      sessionId: U1,
      cwd: "/w/p",
    });
    const expected = { agentName: "claude", sessionId: U1, cwd: "/w/p" };
    // A live row is never reserved.
    expect(reserveAgentResume(db, "r1", expected)).toBe(false);
    markTerminalSessionEnded(db, "r1");
    const t0 = new Date("2026-10-22T10:00:00Z");
    expect(reserveAgentResume(db, "r1", expected, { now: t0 })).toBe(true);
    // The second request loses while the first holds the row.
    expect(reserveAgentResume(db, "r1", expected, { now: t0 })).toBe(false);
    // Data that changed since the request read it never matches.
    releaseAgentResume(db, "r1");
    expect(
      reserveAgentResume(db, "r1", { ...expected, sessionId: U2 }, { now: t0 }),
    ).toBe(false);
    expect(reserveAgentResume(db, "r1", expected, { now: t0 })).toBe(true);
    // A reservation left by a process that died frees itself after the TTL.
    expect(
      reserveAgentResume(db, "r1", expected, {
        now: new Date(t0.getTime() + 10_000),
      }),
    ).toBe(false);
    expect(
      reserveAgentResume(db, "r1", expected, {
        now: new Date(t0.getTime() + 61_000),
      }),
    ).toBe(true);
    // Completing the hand-over clears the data and the reservation.
    clearAgentSession(db, "r1");
    expect(getTerminalSession(db, "r1")).toMatchObject({
      agentName: null,
      agentResumeReservedAt: null,
    });
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a late agent start never writes resume data onto an ended row", async () => {
  // The interleaving: a start marker's write waits (on tmux) while the user's
  // scheduled close ends the session; the late write must not restore it.
  const dir = await mkdtemp(join(process.env.HOME || "/tmp", ".deckterm-m11-"));
  try {
    const { db } = await initializeFoundationState({
      stateDir: dir,
      allowedFileRoots: [],
      env: {},
    });
    recordTerminalSession(db, {
      id: "late",
      actorUserId: "u1",
      cwd: "/w",
      status: "active",
    });
    scheduleTerminalSessionTermination(
      db,
      "late",
      new Date(Date.now() + 15 * 60_000),
    );
    markTerminalSessionEnded(db, "late");
    expect(
      recordAgentSession(db, "late", {
        agentName: "claude",
        sessionId: U1,
        cwd: "/w",
      }),
    ).toBe(false);
    expect(getTerminalSession(db, "late")).toMatchObject({
      status: "ended",
      agentName: null,
      agentSessionId: null,
    });
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- The live marker path: start records, done clears ----------------------

test("the agent start marker records the row; agent done clears it", async () => {
  // Its own folder, so only this shell plays the marker script. Each step
  // is held for a second so every intermediate row state can be observed.
  const folder = join(allowedRoot, "proj-markers");
  mkdirSync(folder);
  writeFileSync(
    join(folder, ".fake-markers"),
    [
      "sleep 0.5",
      // Forged extra fields: no id, but the start itself still records.
      "emit agent;claude;start;sid=x;$(id)",
      "sleep 1",
      `emit agent;claude;start;sid=${U3}`,
      "sleep 1",
      "emit agent;claude;done;0",
      "sleep 1",
      `emit agent;claude;start;sid=${U3}`,
      "",
    ].join("\n"),
  );
  const term = await createTerminal(folder);
  const rowOf = () => withDb((db) => getTerminalSession(db, term.id));

  const forged = await waitFor(() => {
    const row = rowOf();
    return row?.agentName === "claude" ? row : null;
  });
  expect(forged.agentSessionId).toBeNull();
  expect(forged.agentCwd).toBe(folder);

  const recorded = await waitFor(() => {
    const row = rowOf();
    return row?.agentSessionId === U3 ? row : null;
  });
  expect(recorded.agentName).toBe("claude");
  expect(recorded.agentSessionUpdatedAt).toBeTruthy();

  const cleared = await waitFor(() => {
    const row = rowOf();
    return row && row.agentName === null ? row : null;
  });
  expect(cleared).toMatchObject({
    agentSessionId: null,
    agentCwd: null,
    status: "active",
  });

  // Started again, then the shell dies with the agent alive (a crash, not
  // a close the user asked for): resumable.
  await waitFor(() => (rowOf()?.agentSessionId === U3 ? true : null));
  killFakeShellIn(folder);
  await waitFor(() => (rowOf()?.status === "ended" ? true : null));
  const listed = (await listTerminals()).find((row) => row.id === term.id);
  expect(listed?.sessionStatus).toBe("ended");
  expect(listed?.resume).toEqual({
    agent: "claude",
    mode: "exact",
    cwd: folder,
  });
});

// --- An explicit close is not a crash: no Resume afterwards ----------------

// A live terminal in its own folder whose fake agent started with `sid`.
async function liveAgentTerminal(name: string, sid: string) {
  const folder = join(allowedRoot, name);
  mkdirSync(folder);
  writeFileSync(
    join(folder, ".fake-markers"),
    [`emit agent;claude;start;sid=${sid}`, ""].join("\n"),
  );
  const term = await createTerminal(folder);
  await waitFor(() =>
    withDb((db) => getTerminalSession(db, term.id))?.agentSessionId === sid
      ? true
      : null,
  );
  return { ...term, folder };
}

test("closing a terminal (DELETE) with its agent alive leaves nothing to resume", async () => {
  const term = await liveAgentTerminal("proj-closed", U2);
  await deleteTerminal(term.id);
  expect(withDb((db) => getTerminalSession(db, term.id))).toMatchObject({
    status: "ended",
    agentName: null,
    agentSessionId: null,
    agentCwd: null,
  });
  const listed = (await listTerminals()).find((row) => row.id === term.id);
  expect(listed?.sessionStatus).toBe("ended");
  expect(listed?.resume).toBeNull();
  const dry = await post(`/api/terminals/${term.id}/resume`, { dryRun: true });
  expect(dry.status).toBe(409);
  expect((await json(dry)).reason).toBe("not_resumable");
});

test("the 15-minute close-later expiry the user started leaves nothing to resume", async () => {
  const term = await liveAgentTerminal("proj-close-later", U1);
  const scheduled = await post(`/api/terminals/${term.id}/close-later`, {});
  expect(scheduled.status).toBe(200);
  expect((await json(scheduled)).terminationScheduledAt).toBeGreaterThan(0);
  const { reapScheduledTerminalClosures } = await import("./server");
  await reapScheduledTerminalClosures(Date.now() + 16 * 60_000);
  expect(withDb((db) => getTerminalSession(db, term.id))).toMatchObject({
    status: "ended",
    agentName: null,
    agentSessionId: null,
    agentCwd: null,
  });
  const listed = (await listTerminals()).find((row) => row.id === term.id);
  expect(listed?.resume).toBeNull();
});

// --- GET /api/terminals: resume on ended rows --------------------------------

test("ended rows with an agent become resumable with the right mode", async () => {
  const a = join(allowedRoot, "proj-a");
  const b = join(allowedRoot, "proj-b");
  const c = join(allowedRoot, "proj-c");
  seedEnded("g-claude-exact", { agentName: "claude", sessionId: U1, cwd: a });
  seedEnded("g-claude-pick", { agentName: "claude", sessionId: null, cwd: a });
  seedEnded("g-codex-exact", { agentName: "codex", sessionId: U2, cwd: c });
  seedEnded("g-codex-last", { agentName: "codex", sessionId: null, cwd: b });
  seedEnded("g-codex-shared-1", {
    agentName: "codex",
    sessionId: null,
    cwd: c,
  });
  seedEnded("g-codex-shared-2", {
    agentName: "codex",
    sessionId: null,
    cwd: c,
  });
  seedEnded("g-plain", null);

  const rows = new Map((await listTerminals()).map((row) => [row.id, row]));
  expect(rows.get("g-claude-exact")?.resume).toEqual({
    agent: "claude",
    mode: "exact",
    cwd: a,
  });
  expect(rows.get("g-claude-pick")?.resume).toEqual({
    agent: "claude",
    mode: "pick",
    cwd: a,
  });
  expect(rows.get("g-codex-exact")?.resume).toEqual({
    agent: "codex",
    mode: "exact",
    cwd: c,
  });
  expect(rows.get("g-codex-last")?.resume).toEqual({
    agent: "codex",
    mode: "last",
    cwd: b,
  });
  // Two id-less Codex rows (and an exact one) share proj-c: `--last` could
  // pick the other conversation, so both open the picker.
  expect(rows.get("g-codex-shared-1")?.resume?.mode).toBe("pick");
  expect(rows.get("g-codex-shared-2")?.resume?.mode).toBe("pick");
  expect(rows.get("g-plain")?.resume).toBeNull();
  // The resume data never leaks the conversation id into the catalog.
  expect(JSON.stringify(rows.get("g-claude-exact"))).not.toContain(U1);
});

// --- POST /api/terminals/:id/resume ------------------------------------------

test("dryRun builds the exact, last and pick commands and creates nothing", async () => {
  const before = withDb(
    (db) =>
      (
        db.query("SELECT COUNT(*) AS n FROM terminal_sessions").get() as {
          n: number;
        }
      ).n,
  );
  const dry = async (id: string) => {
    const res = await post(`/api/terminals/${id}/resume`, { dryRun: true });
    expect(res.status).toBe(200);
    return json(res);
  };
  expect(await dry("g-claude-exact")).toEqual({
    command: `claude --resume ${U1}`,
    cwd: join(allowedRoot, "proj-a"),
    mode: "exact",
  });
  expect(await dry("g-claude-pick")).toEqual({
    command: "claude --resume",
    cwd: join(allowedRoot, "proj-a"),
    mode: "pick",
  });
  expect(await dry("g-codex-exact")).toEqual({
    command: `codex resume ${U2}`,
    cwd: join(allowedRoot, "proj-c"),
    mode: "exact",
  });
  expect(await dry("g-codex-last")).toEqual({
    command: "codex resume --last",
    cwd: join(allowedRoot, "proj-b"),
    mode: "last",
  });
  expect(await dry("g-codex-shared-1")).toEqual({
    command: "codex resume",
    cwd: join(allowedRoot, "proj-c"),
    mode: "pick",
  });
  const after = withDb(
    (db) =>
      (
        db.query("SELECT COUNT(*) AS n FROM terminal_sessions").get() as {
          n: number;
        }
      ).n,
  );
  expect(after).toBe(before);
  // Still offered after any number of dry runs.
  const row = (await listTerminals()).find((r) => r.id === "g-claude-exact");
  expect(row?.resume?.mode).toBe("exact");
});

test("a tampered stored id, agent or folder is refused", async () => {
  const cases: Array<[string, string, string]> = [
    ["t-sid", "agent_session_id", "x;$(id)"],
    ["t-sid-upper", "agent_session_id", U1.toUpperCase()],
    ["t-sid-newline", "agent_session_id", `${U1}\nrm -rf ~`],
    ["t-agent", "agent_name", "bash"],
    ["t-cwd", "agent_cwd", "relative/path"],
    ["t-cwd-newline", "agent_cwd", `${allowedRoot}\n`],
  ];
  for (const [id, column, value] of cases) {
    seedEnded(id, {
      agentName: "claude",
      sessionId: U1,
      cwd: join(allowedRoot, "proj-a"),
    });
    withDb((db) =>
      db
        .query(`UPDATE terminal_sessions SET ${column} = ? WHERE id = ?`)
        .run(value, id),
    );
    for (const body of [{ dryRun: true }, {}]) {
      const res = await post(`/api/terminals/${id}/resume`, body);
      expect(res.status).toBe(409);
      expect((await json(res)).reason).toBe("invalid_resume_data");
    }
  }
  const rows = new Map((await listTerminals()).map((row) => [row.id, row]));
  for (const [id] of cases) expect(rows.get(id)?.resume).toBeNull();
  // Nothing was typed anywhere.
  expect(shellLines().some((l) => l.includes("--resume"))).toBe(false);
  // The refusal is audited.
  const denies = withDb(
    (db) =>
      db
        .query(
          "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'terminal.resume' AND decision = 'deny' AND reason = 'invalid_resume_data'",
        )
        .get() as { n: number },
  );
  expect(denies.n).toBeGreaterThanOrEqual(cases.length);
});

test("another actor's row, a missing row and a plain ended row are refused", async () => {
  seedEnded(
    "other-actor",
    { agentName: "claude", sessionId: U1, cwd: join(allowedRoot, "proj-a") },
    "someone-else",
  );
  const deniesBefore = resumeDenials();
  for (const body of [{ dryRun: true }, {}]) {
    const other = await post("/api/terminals/other-actor/resume", body);
    expect(other.status).toBe(404);
    const missing = await post("/api/terminals/no-such-row/resume", body);
    expect(missing.status).toBe(404);
    // The same answer for both: no existence oracle.
    expect(await json(other)).toEqual(await json(missing));
  }
  // Both refusals are audited as terminal.resume denials.
  const denies = resumeDenials().slice(deniesBefore.length);
  expect(denies).toEqual([
    { resource_id: "other-actor", reason: "foreign_session" },
    { resource_id: "no-such-row", reason: "not_found" },
    { resource_id: "other-actor", reason: "foreign_session" },
    { resource_id: "no-such-row", reason: "not_found" },
  ]);
  // Not even listed for this actor.
  expect((await listTerminals()).some((r) => r.id === "other-actor")).toBe(
    false,
  );
  const plain = await post("/api/terminals/g-plain/resume", { dryRun: true });
  expect(plain.status).toBe(409);
  expect((await json(plain)).reason).toBe("not_resumable");
});

test("a running session is not resumed: attach to it instead", async () => {
  const term = await createTerminal(allowedRoot);
  const res = await post(`/api/terminals/${term.id}/resume`, { dryRun: true });
  expect(res.status).toBe(409);
  expect((await json(res)).reason).toBe("session_active");
});

test("resume creates a terminal in the agent folder through the create path and types the command", async () => {
  const res = await post("/api/terminals/g-claude-exact/resume", {
    cols: 100,
    rows: 30,
  });
  expect(res.status).toBe(200);
  const body = await json(res);
  createdTerminalIds.push(body.id);
  expect(body.id).not.toBe("g-claude-exact");
  expect(body.cwd).toBe(join(allowedRoot, "proj-a"));
  expect(body.cols).toBe(100);
  expect(body.resumed).toEqual({
    from: "g-claude-exact",
    agent: "claude",
    mode: "exact",
    typed: true,
  });

  // The fake shell started in the agent folder and received exactly the
  // command line (text, then the deferred Enter).
  const typed = await waitFor(() =>
    shellLines().find((l) => l.endsWith(` line=claude --resume ${U1}`)),
  );
  const pid = typed.split(" ")[0];
  expect(shellLines()).toContain(`${pid} cwd=${join(allowedRoot, "proj-a")}`);
  expect(shellLines().filter((l) => l.startsWith(`${pid} line=`))).toEqual([
    `${pid} line=claude --resume ${U1}`,
  ]);

  // The new terminal is an ordinary session of the same owner.
  const created = withDb((db) => getTerminalSession(db, body.id));
  expect(created).toMatchObject({ actorUserId: ownerId, status: "active" });
  // The ended row is not offered a second time.
  const old = (await listTerminals()).find((r) => r.id === "g-claude-exact");
  expect(old?.sessionStatus).toBe("ended");
  expect(old?.resume).toBeNull();
  expect(
    withDb((db) => getTerminalSession(db, "g-claude-exact")),
  ).toMatchObject({ agentName: null, agentSessionId: null, agentCwd: null });
  const again = await post("/api/terminals/g-claude-exact/resume", {
    dryRun: true,
  });
  expect(again.status).toBe(409);
  // Audited.
  const allow = withDb(
    (db) =>
      db
        .query(
          "SELECT data_json FROM audit_events WHERE action = 'terminal.resume' AND decision = 'allow' AND resource_id = ?",
        )
        .get(body.id) as { data_json: string } | null,
  );
  expect(JSON.parse(allow?.data_json || "{}")).toMatchObject({
    from: "g-claude-exact",
    agent: "claude",
    mode: "exact",
    typed: true,
  });
});

test("a folder outside the allowed roots is refused by the create path", async () => {
  seedEnded("outside-root", {
    agentName: "codex",
    sessionId: null,
    cwd: "/etc",
  });
  const res = await post("/api/terminals/outside-root/resume", {});
  expect(res.status).toBe(403);
  expect((await json(res)).reason).toBe("forbidden_root");
  // Still resumable later (nothing was cleared).
  const row = (await listTerminals()).find((r) => r.id === "outside-root");
  expect(row?.resume?.agent).toBe("codex");
});

test("a folder that is gone opens a shell but types nothing", async () => {
  seedEnded("gone-folder", {
    agentName: "codex",
    sessionId: null,
    cwd: join(allowedRoot, "deleted-project"),
  });
  const linesBefore = shellLines().length;
  const res = await post("/api/terminals/gone-folder/resume", {});
  expect(res.status).toBe(200);
  const body = await json(res);
  createdTerminalIds.push(body.id);
  expect(body.cwd).toBe(allowedRoot);
  expect(body.resumed).toMatchObject({ mode: "last", typed: false });
  await Bun.sleep(600);
  expect(
    shellLines()
      .slice(linesBefore)
      .some((l) => l.includes(" line=")),
  ).toBe(false);
  // Not consumed: the row still offers resume.
  const row = (await listTerminals()).find((r) => r.id === "gone-folder");
  expect(row?.resume?.mode).toBe("last");
});

test("a member without terminal.create and root.use grants cannot resume", async () => {
  seedEnded("member-row", {
    agentName: "claude",
    sessionId: U2,
    cwd: join(allowedRoot, "proj-b"),
  });
  withDb((db) => setUserRole(db, { userId: ownerId, role: "member" }));
  try {
    const res = await post("/api/terminals/member-row/resume", {});
    expect(res.status).toBe(403);
    expect((await json(res)).reason).toBe("missing_capability");
    // With both grants on the folder's root, the same tap works.
    const rootId = withDb(
      (db) =>
        (
          db
            .query("SELECT id FROM project_roots WHERE path = ?")
            .get(allowedRoot) as { id: string }
        ).id,
    );
    const grantIds = withDb((db) =>
      ["terminal.create", "root.use"].map((capability) =>
        grantScopedCapability(db, {
          userId: ownerId,
          capability: capability as never,
          resourceType: "root",
          resourceId: rootId,
        }),
      ),
    );
    const ok = await post("/api/terminals/member-row/resume", {});
    expect(ok.status).toBe(200);
    createdTerminalIds.push((await json(ok)).id);
    withDb((db) => {
      for (const id of grantIds) revokeScopedCapability(db, id);
    });
  } finally {
    withDb((db) => setUserRole(db, { userId: ownerId, role: "owner" }));
  }
});

test("two concurrent resumes of one row start exactly one agent", async () => {
  const folder = join(allowedRoot, "proj-race");
  mkdirSync(folder);
  seedEnded("race-row", { agentName: "claude", sessionId: U3, cwd: folder });
  const results = await Promise.all([
    post("/api/terminals/race-row/resume", {}),
    post("/api/terminals/race-row/resume", {}),
  ]);
  const statuses = results.map((r) => r.status).sort();
  expect(statuses).toEqual([200, 409]);
  const winner = results.find((r) => r.status === 200)!;
  const loser = results.find((r) => r.status === 409)!;
  createdTerminalIds.push((await json(winner)).id);
  expect(["resume_in_progress", "not_resumable"]).toContain(
    (await json(loser)).reason,
  );
  await Bun.sleep(600);
  // One shell in that folder, one typed resume line.
  const shells = shellLines().filter((l) => l.endsWith(` cwd=${folder}`));
  expect(shells).toHaveLength(1);
  expect(
    shellLines().filter((l) => l.endsWith(` line=claude --resume ${U3}`)),
  ).toHaveLength(1);
  expect(withDb((db) => getTerminalSession(db, "race-row"))).toMatchObject({
    agentName: null,
    agentResumeReservedAt: null,
  });
});

test("a resume whose terminal dies before the Enter keeps the data for a retry", async () => {
  const folder = join(allowedRoot, "proj-dies");
  mkdirSync(folder);
  writeFileSync(join(folder, ".fake-exit"), "");
  seedEnded("dies-row", { agentName: "claude", sessionId: U2, cwd: folder });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await post("/api/terminals/dies-row/resume", {});
    expect(res.status).toBe(500);
    expect((await json(res)).reason).toBe("resume_write_failed");
    // Nothing ran, so nothing was handed over: the row is still resumable
    // and not left reserved, so the retry is not refused as "in progress".
    expect(withDb((db) => getTerminalSession(db, "dies-row"))).toMatchObject({
      status: "ended",
      agentName: "claude",
      agentSessionId: U2,
      agentCwd: folder,
      agentResumeReservedAt: null,
    });
  }
  const dry = await post("/api/terminals/dies-row/resume", { dryRun: true });
  expect(dry.status).toBe(200);
});

// Last in the file: it buries every earlier ended row under 205 newer ones.
test("resumable rows are listed beyond the ended-row cap, newest 50", async () => {
  const folder = join(allowedRoot, "proj-a");
  // 55 resumable rows that ended long ago, then 205 plain ended rows that
  // ended later: the normal listing (newest 200 here) holds none of the 55.
  withDb((db) => {
    for (let i = 0; i < 55; i += 1) {
      const id = `cap-r-${String(i).padStart(2, "0")}`;
      recordTerminalSession(db, {
        id,
        actorUserId: ownerId,
        cwd: allowedRoot,
        status: "active",
      });
      recordAgentSession(db, id, {
        agentName: "claude",
        sessionId: U1,
        cwd: folder,
      });
      markTerminalSessionEnded(db, id, new Date(Date.UTC(2026, 0, 1, 0, i)));
    }
    for (let i = 0; i < 205; i += 1) {
      const id = `cap-p-${String(i).padStart(3, "0")}`;
      recordTerminalSession(db, {
        id,
        actorUserId: ownerId,
        cwd: allowedRoot,
        status: "active",
      });
      markTerminalSessionEnded(db, id, new Date(Date.UTC(2026, 5, 1, 0, i)));
    }
  });
  const rows = await listTerminals();
  const ids = new Set(rows.map((row) => row.id));
  const resumable = rows.filter((row) => row.resume);
  expect(resumable).toHaveLength(50);
  // Newest first: the oldest resumable rows fall off the 50 cap.
  const listedCap = [...ids].filter((id) => id.startsWith("cap-r-")).sort();
  const otherResumable = resumable.filter(
    (row) => !row.id.startsWith("cap-r-"),
  );
  // The newest cap rows fill what the newer resumable rows leave of the 50.
  const expectedCap = Array.from(
    { length: 50 - otherResumable.length },
    (_, k) => `cap-r-${String(54 - k).padStart(2, "0")}`,
  ).sort();
  expect(listedCap).toEqual(expectedCap);
  expect(ids.has("cap-r-00")).toBe(false);
  for (const row of rows.filter((r) => r.id.startsWith("cap-r-"))) {
    expect(row.resume).toEqual({ agent: "claude", mode: "exact", cwd: folder });
  }
  // The normal cap still bounds plain ended rows.
  expect([...ids].filter((id) => id.startsWith("cap-p-")).length).toBeLessThan(
    205,
  );
});

// After the cap test: a resumable Codex row in the same folder that the
// capped catalog no longer lists must still make the visible one a picker.
test("the Codex same-folder check sees resumable rows outside the catalog", async () => {
  const folder = join(allowedRoot, "proj-codex-hidden");
  mkdirSync(folder);
  withDb((db) => {
    recordTerminalSession(db, {
      id: "codex-hidden",
      actorUserId: ownerId,
      cwd: allowedRoot,
      status: "active",
    });
    recordAgentSession(db, "codex-hidden", {
      agentName: "codex",
      sessionId: null,
      cwd: folder,
    });
    markTerminalSessionEnded(
      db,
      "codex-hidden",
      new Date(Date.UTC(2025, 0, 1)),
    );
  });
  seedEnded("codex-visible", {
    agentName: "codex",
    sessionId: null,
    cwd: folder,
  });
  const rows = await listTerminals();
  expect(rows.some((row) => row.id === "codex-hidden")).toBe(false);
  expect(rows.find((row) => row.id === "codex-visible")?.resume).toEqual({
    agent: "codex",
    mode: "pick",
    cwd: folder,
  });
  const dry = await post("/api/terminals/codex-visible/resume", {
    dryRun: true,
  });
  expect(await json(dry)).toEqual({
    command: "codex resume",
    cwd: folder,
    mode: "pick",
  });
});
