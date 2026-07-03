import { Database } from "bun:sqlite";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { actorIdentityTriple, type DeckTermActor } from "./foundation-actors";

export type FoundationEnv = Record<string, string | undefined>;

export type FoundationRoot = {
  id: string;
  name: string;
  path: string;
  status: "active" | "missing";
  warning: "broad_home_root" | null;
};

export type FoundationBootstrapStatus = {
  bootstrapped: boolean;
  mode: "complete" | "env_admin" | "token";
  tokenPath: string | null;
  expectedEmail: string | null;
};

export type FoundationState = {
  db: Database;
  bootstrap: FoundationBootstrapStatus;
  roots: FoundationRoot[];
};

export type InitializeFoundationStateOptions = {
  stateDir: string;
  allowedFileRoots: string[];
  env?: FoundationEnv;
  now?: Date;
};

const INITIAL_MIGRATION = 1;
const C1_AUTH_GRANTS_MIGRATION = 2;
const C1B_TERMINAL_EVENTS_MIGRATION = 3;
const C3_USER_SETTINGS_MIGRATION = 4;
const B3_IDENTITY_ROLES_MIGRATION = 5;

export type ScopedGrantCapability =
  | "terminal.create"
  | "terminal.attach"
  | "terminal.write"
  | "terminal.manage"
  | "root.use";

export type RecordedTerminalSession = {
  id: string;
  actorUserId: string | null;
  rootId: string | null;
  cwd: string;
  status: "active" | "ended";
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  lastEventId: number;
};

export type TerminalEventKind = "output" | "state" | "exit" | "lifecycle";

export type RecordedTerminalEvent = {
  id: number;
  terminalId: string;
  kind: TerminalEventKind;
  data: string | null;
  dataJson: Record<string, unknown> | null;
  createdAt: string;
};

const ADMIN_DEFAULT_GRANTS: Array<{
  capability: ScopedGrantCapability;
  resourceType: string;
  resourceId: string;
}> = [
  { capability: "terminal.create", resourceType: "*", resourceId: "*" },
  { capability: "terminal.attach", resourceType: "*", resourceId: "*" },
  { capability: "terminal.write", resourceType: "*", resourceId: "*" },
  { capability: "terminal.manage", resourceType: "*", resourceId: "*" },
  { capability: "root.use", resourceType: "*", resourceId: "*" },
];

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function isoDate(now: Date): string {
  return now.toISOString();
}

function tableColumnExists(
  db: Database,
  tableName: string,
  columnName: string,
): boolean {
  const rows = db.query(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
  }>;
  return rows.some((row) => row.name === columnName);
}

export function openFoundationDb(stateDir: string): Database {
  const dbPath = join(stateDir, "deckterm.db");
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  // Wait for a contended write lock instead of failing immediately with
  // SQLITE_BUSY. The foundation DB can have more than one writer process when
  // dev (4174) and prod (4173) default to the same state dir, or under
  // concurrent requests in one process; without this, a colliding write throws
  // and surfaces as a 500 ("Failed to create terminal"). Writes are sub-ms, so
  // a 5s ceiling is ample headroom and effectively serializes the rare clash.
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

export function migrateFoundationDb(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT,
      display_name TEXT,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','member')),
      disabled INTEGER NOT NULL DEFAULT 0,
      multiuser_reviewed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_roots (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      warning TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS terminal_sessions (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT,
      root_id TEXT,
      cwd TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ended_at TEXT,
      last_event_id INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(root_id) REFERENCES project_roots(id)
    );

    CREATE TABLE IF NOT EXISTS terminal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      terminal_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      data_blob BLOB,
      data_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(terminal_id) REFERENCES terminal_sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_terminal_events_terminal_id_id
      ON terminal_events(terminal_id, id);

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      decision TEXT NOT NULL,
      reason TEXT,
      data_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_identities (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      issuer TEXT NOT NULL DEFAULT '',
      provider_subject TEXT NOT NULL,
      user_id TEXT NOT NULL,
      email TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(provider, issuer, provider_subject),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS scoped_grants (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, capability, resource_type, resource_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  const existing = db
    .query("SELECT version FROM schema_migrations WHERE version = ?")
    .get(INITIAL_MIGRATION);
  if (!existing) {
    db.query(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    ).run(INITIAL_MIGRATION, new Date().toISOString());
  }

  const c1Existing = db
    .query("SELECT version FROM schema_migrations WHERE version = ?")
    .get(C1_AUTH_GRANTS_MIGRATION);
  if (!c1Existing) {
    db.query(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    ).run(C1_AUTH_GRANTS_MIGRATION, new Date().toISOString());
  }

  if (!tableColumnExists(db, "terminal_sessions", "last_event_id")) {
    db.exec(
      "ALTER TABLE terminal_sessions ADD COLUMN last_event_id INTEGER NOT NULL DEFAULT 0",
    );
  }

  const c1bExisting = db
    .query("SELECT version FROM schema_migrations WHERE version = ?")
    .get(C1B_TERMINAL_EVENTS_MIGRATION);
  if (!c1bExisting) {
    db.query(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    ).run(C1B_TERMINAL_EVENTS_MIGRATION, new Date().toISOString());
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, key)
    );
  `);

  const c3Existing = db
    .query("SELECT version FROM schema_migrations WHERE version = ?")
    .get(C3_USER_SETTINGS_MIGRATION);
  if (!c3Existing) {
    db.query(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    ).run(C3_USER_SETTINGS_MIGRATION, new Date().toISOString());
  }

  const b3Existing = db
    .query("SELECT version FROM schema_migrations WHERE version = ?")
    .get(B3_IDENTITY_ROLES_MIGRATION);
  if (!b3Existing) {
    applyB3IdentityRolesMigration(db);
    db.query(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    ).run(B3_IDENTITY_ROLES_MIGRATION, new Date().toISOString());
  }
}

// Migration 5 (B3 S1): canonical (provider, issuer, subject) identity rows
// and real owner/admin/member roles. sqlite can't ALTER a column's UNIQUE
// constraint or add a CHECK constraint in place, so both tables use the
// standard "rebuild" recipe (create *_new with the target shape, copy rows,
// drop the old table, rename). Guarded per-table by column presence: a
// brand-new DB is already created with the target shape by the boot-time
// CREATE TABLE IF NOT EXISTS DDL above, so no rebuild is needed for it — only
// pre-B3 databases pay the rebuild cost, and only once (gated by the
// schema_migrations marker in the caller).
function applyB3IdentityRolesMigration(db: Database): void {
  const needsUsersRebuild = !tableColumnExists(db, "users", "disabled");
  const needsAuthIdentitiesRebuild = !tableColumnExists(
    db,
    "auth_identities",
    "issuer",
  );

  if (needsUsersRebuild || needsAuthIdentitiesRebuild) {
    // openFoundationDb runs PRAGMA foreign_keys = ON, and auth_identities /
    // scoped_grants hold FKs referencing users(id); dropping either table
    // under FK enforcement fails, so enforcement is suspended for the
    // duration of the rebuild only.
    db.exec("PRAGMA foreign_keys = OFF");
  }

  if (needsUsersRebuild) {
    db.exec(`
      CREATE TABLE users_new (
        id TEXT PRIMARY KEY,
        email TEXT,
        display_name TEXT,
        role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','member')),
        disabled INTEGER NOT NULL DEFAULT 0,
        multiuser_reviewed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.query(
      `INSERT INTO users_new
        (id, email, display_name, role, disabled, multiuser_reviewed_at, created_at, updated_at)
       SELECT id, email, display_name, role, 0, NULL, created_at, updated_at FROM users`,
    ).run();
    db.exec("DROP TABLE users");
    db.exec("ALTER TABLE users_new RENAME TO users");
  }

  if (needsAuthIdentitiesRebuild) {
    db.exec(`
      CREATE TABLE auth_identities_new (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        issuer TEXT NOT NULL DEFAULT '',
        provider_subject TEXT NOT NULL,
        user_id TEXT NOT NULL,
        email TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider, issuer, provider_subject),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
    db.query(
      `INSERT INTO auth_identities_new
        (id, provider, issuer, provider_subject, user_id, email, created_at, updated_at)
       SELECT id, provider, '', provider_subject, user_id, email, created_at, updated_at FROM auth_identities`,
    ).run();
    db.exec("DROP TABLE auth_identities");
    db.exec("ALTER TABLE auth_identities_new RENAME TO auth_identities");
  }

  if (needsUsersRebuild || needsAuthIdentitiesRebuild) {
    db.exec("PRAGMA foreign_keys = ON");
  }

  promoteDeterministicOwner(db);
}

// Deterministic single-run owner promotion (plan §1.3): (a) exactly one
// 'admin' row in the whole table promotes unambiguously; (b) with several
// admins, exactly one holding an auth_identities row promotes; (c) otherwise
// promote nobody and warn — single-tenant behavior is unaffected (grants are
// unchanged, only the role label), and the §1.6 multiuser gate (S4) refuses
// startup with a manual repair procedure until an owner exists.
function promoteDeterministicOwner(db: Database): void {
  const ownerExists = db
    .query("SELECT 1 FROM users WHERE role = 'owner' LIMIT 1")
    .get();
  if (ownerExists) return;

  const admins = db
    .query("SELECT id FROM users WHERE role = 'admin'")
    .all() as Array<{ id: string }>;
  if (admins.length === 0) return;

  const timestamp = new Date().toISOString();

  if (admins.length === 1) {
    db.query(
      "UPDATE users SET role = 'owner', updated_at = ? WHERE id = ?",
    ).run(timestamp, admins[0].id);
    return;
  }

  const adminIds = admins.map((admin) => admin.id);
  const placeholders = adminIds.map(() => "?").join(", ");
  const identityHolders = db
    .query(
      `SELECT DISTINCT user_id FROM auth_identities WHERE user_id IN (${placeholders})`,
    )
    .all(...adminIds) as Array<{ user_id: string }>;

  if (identityHolders.length === 1) {
    db.query(
      "UPDATE users SET role = 'owner', updated_at = ? WHERE id = ?",
    ).run(timestamp, identityHolders[0].user_id);
    return;
  }

  console.warn(
    `[foundation] migration 5: could not deterministically promote an owner among admins (${adminIds.join(", ")}); multiuser startup will refuse until an owner is assigned via the owner-recovery procedure`,
  );
}

function isFilesystemRoot(pathValue: string): boolean {
  return resolve(pathValue) === "/";
}

function isHomeRoot(pathValue: string, env: FoundationEnv): boolean {
  const home = env.HOME || process.env.HOME;
  return Boolean(home) && resolve(pathValue) === resolve(home as string);
}

async function normalizeAllowedRoot(
  inputPath: string,
  env: FoundationEnv,
): Promise<Omit<FoundationRoot, "id">> {
  const absolute = resolve(inputPath);
  if (
    isFilesystemRoot(absolute) &&
    env.DECKTERM_ALLOW_ROOT_FILESYSTEM !== "1"
  ) {
    throw new Error(
      "Refusing to import / as an allowed project root without DECKTERM_ALLOW_ROOT_FILESYSTEM=1",
    );
  }

  try {
    const real = await realpath(absolute);
    return {
      name: basename(real) || real,
      path: real,
      status: "active",
      warning: isHomeRoot(real, env) ? "broad_home_root" : null,
    };
  } catch {
    return {
      name: basename(absolute) || absolute,
      path: absolute,
      status: "missing",
      warning: isHomeRoot(absolute, env) ? "broad_home_root" : null,
    };
  }
}

async function importProjectRoots({
  db,
  allowedFileRoots,
  env,
  now,
}: {
  db: Database;
  allowedFileRoots: string[];
  env: FoundationEnv;
  now: Date;
}): Promise<FoundationRoot[]> {
  const uniqueRoots = [
    ...new Set(allowedFileRoots.map((root) => root.trim()).filter(Boolean)),
  ];
  const roots: FoundationRoot[] = [];
  const timestamp = isoDate(now);

  for (const allowedRoot of uniqueRoots) {
    const normalized = await normalizeAllowedRoot(allowedRoot, env);
    const existing = db
      .query("SELECT id FROM project_roots WHERE path = ?")
      .get(normalized.path) as { id: string } | null;
    const id = existing?.id || createId("root");
    db.query(
      `INSERT INTO project_roots (id, name, path, status, warning, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         name = excluded.name,
         status = excluded.status,
         warning = excluded.warning,
         updated_at = excluded.updated_at`,
    ).run(
      id,
      normalized.name,
      normalized.path,
      normalized.status,
      normalized.warning,
      timestamp,
      timestamp,
    );
    roots.push({ id, ...normalized });
  }

  return roots;
}

async function ensureBootstrapToken({
  db,
  stateDir,
  env,
}: {
  db: Database;
  stateDir: string;
  env: FoundationEnv;
}): Promise<FoundationBootstrapStatus> {
  // The legacy/tunnel era created an implicit `anonymous` admin row without a
  // real bootstrap; it must not make a fresh access-mode deployment look
  // bootstrapped, or no real identity ever receives grants. An `anonymous`
  // row still counts when a real bootstrap recorded it (legacy_dev token
  // path) — bootstrapFirstAdmin always writes a bootstrap.admin.create audit
  // row, the legacy-era row has none.
  const realUserCount = (
    db
      .query("SELECT COUNT(*) AS count FROM users WHERE id != 'anonymous'")
      .get() as { count: number }
  ).count;
  const anonymousBootstrapMarker = db
    .query(
      `SELECT 1 FROM audit_events
       WHERE action = 'bootstrap.admin.create'
         AND decision = 'allow'
         AND actor_user_id = 'anonymous'
       LIMIT 1`,
    )
    .get();
  const adminCount = realUserCount + (anonymousBootstrapMarker ? 1 : 0);
  const tokenPath = join(stateDir, "bootstrap-token");

  if (adminCount > 0) {
    return {
      bootstrapped: true,
      mode: "complete",
      tokenPath: null,
      expectedEmail: null,
    };
  }

  const expectedEmail = env.DECKTERM_BOOTSTRAP_ADMIN_EMAIL || null;
  if (expectedEmail) {
    return {
      bootstrapped: false,
      mode: "env_admin",
      tokenPath: null,
      expectedEmail,
    };
  }

  try {
    const tokenStat = await stat(tokenPath);
    if ((tokenStat.mode & 0o077) !== 0) {
      throw new Error(
        "bootstrap token file is readable by group or others; fix permissions to 0600 or delete it to regenerate",
      );
    }
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      const token = crypto.randomUUID().replace(/-/g, "");
      await writeFile(tokenPath, `${token}\n`, { mode: 0o600, flag: "wx" });
      await chmod(tokenPath, 0o600);
    } else {
      throw err;
    }
  }

  return {
    bootstrapped: false,
    mode: "token",
    tokenPath,
    expectedEmail: null,
  };
}

export async function initializeFoundationState({
  stateDir,
  allowedFileRoots,
  env = process.env,
  now = new Date(),
}: InitializeFoundationStateOptions): Promise<FoundationState> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700).catch(() => {});
  const db = openFoundationDb(stateDir);
  migrateFoundationDb(db);

  const roots = await importProjectRoots({ db, allowedFileRoots, env, now });
  const bootstrap = await ensureBootstrapToken({ db, stateDir, env });

  return { db, bootstrap, roots };
}

export function recordTerminalSession(
  db: Database,
  session: {
    id: string;
    actorUserId?: string | null;
    rootId?: string | null;
    cwd: string;
    status?: "active" | "ended";
    lastEventId?: number;
    now?: Date;
  },
): void {
  const timestamp = isoDate(session.now || new Date());
  db.query(
    `INSERT INTO terminal_sessions
      (id, actor_user_id, root_id, cwd, status, created_at, updated_at, ended_at, last_event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       actor_user_id = excluded.actor_user_id,
       root_id = excluded.root_id,
       cwd = excluded.cwd,
       status = excluded.status,
       updated_at = excluded.updated_at,
       ended_at = excluded.ended_at,
       last_event_id = MAX(terminal_sessions.last_event_id, excluded.last_event_id)`,
  ).run(
    session.id,
    session.actorUserId || null,
    session.rootId || null,
    session.cwd,
    session.status || "active",
    timestamp,
    timestamp,
    session.status === "ended" ? timestamp : null,
    session.lastEventId || 0,
  );
}

export function getUserSettings(
  db: Database,
  userId: string,
): Record<string, unknown> {
  const rows = db
    .query("SELECT key, value_json FROM user_settings WHERE user_id = ?")
    .all(userId) as Array<{ key: string; value_json: string }>;
  const settings: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      settings[row.key] = JSON.parse(row.value_json);
    } catch {
      // Skip unreadable rows instead of failing the whole read.
    }
  }
  return settings;
}

export function setUserSettings(
  db: Database,
  userId: string,
  entries: Record<string, unknown>,
  now: Date = new Date(),
): void {
  const timestamp = isoDate(now);
  const upsert = db.query(
    `INSERT INTO user_settings (user_id, key, value_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = excluded.updated_at`,
  );
  const remove = db.query(
    "DELETE FROM user_settings WHERE user_id = ? AND key = ?",
  );
  for (const [key, value] of Object.entries(entries)) {
    if (value === null) remove.run(userId, key);
    else upsert.run(userId, key, JSON.stringify(value), timestamp);
  }
}

export function markTerminalSessionEnded(
  db: Database,
  id: string,
  now: Date = new Date(),
): void {
  const timestamp = isoDate(now);
  db.query(
    `UPDATE terminal_sessions
     SET status = 'ended', updated_at = ?, ended_at = COALESCE(ended_at, ?)
     WHERE id = ?`,
  ).run(timestamp, timestamp, id);
}

export function getTerminalSession(
  db: Database,
  id: string,
): RecordedTerminalSession | null {
  const row = db
    .query(
      `SELECT id, actor_user_id, root_id, cwd, status, created_at, updated_at, ended_at, last_event_id
       FROM terminal_sessions
       WHERE id = ?`,
    )
    .get(id) as {
    id: string;
    actor_user_id: string | null;
    root_id: string | null;
    cwd: string;
    status: "active" | "ended";
    created_at: string;
    updated_at: string;
    ended_at: string | null;
    last_event_id: number;
  } | null;

  if (!row) return null;
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    rootId: row.root_id,
    cwd: row.cwd,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
    lastEventId: row.last_event_id || 0,
  };
}

export function listTerminalSessionsForActor(
  db: Database,
  actorUserId: string,
): RecordedTerminalSession[] {
  const rows = db
    .query(
      `SELECT id, actor_user_id, root_id, cwd, status, created_at, updated_at, ended_at, last_event_id
       FROM terminal_sessions
       WHERE actor_user_id = ?
       ORDER BY created_at DESC`,
    )
    .all(actorUserId) as Array<{
    id: string;
    actor_user_id: string | null;
    root_id: string | null;
    cwd: string;
    status: "active" | "ended";
    created_at: string;
    updated_at: string;
    ended_at: string | null;
    last_event_id: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    actorUserId: row.actor_user_id,
    rootId: row.root_id,
    cwd: row.cwd,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
    lastEventId: row.last_event_id || 0,
  }));
}

function decodeTerminalEventData(data: unknown): string | null {
  if (data == null) return null;
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) {
    return new TextDecoder().decode(data);
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }
  return String(data);
}

export function appendTerminalEvent(
  db: Database,
  event: {
    terminalId: string;
    kind: TerminalEventKind;
    data?: string | Uint8Array | null;
    dataJson?: Record<string, unknown> | null;
    now?: Date;
  },
): number {
  const timestamp = isoDate(event.now || new Date());
  const dataBlob = event.data == null ? null : Buffer.from(event.data);
  const dataJson = event.dataJson ? JSON.stringify(event.dataJson) : null;

  db.query(
    `INSERT INTO terminal_events (terminal_id, kind, data_blob, data_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(event.terminalId, event.kind, dataBlob, dataJson, timestamp);

  const idRow = db.query("SELECT last_insert_rowid() AS id").get() as {
    id: number | bigint;
  };
  const id = Number(idRow.id);
  db.query(
    `UPDATE terminal_sessions
     SET last_event_id = ?, updated_at = ?
     WHERE id = ?`,
  ).run(id, timestamp, event.terminalId);
  return id;
}

export function listTerminalEventsAfter(
  db: Database,
  terminalId: string,
  lastEventId: number,
  limit = 1000,
): RecordedTerminalEvent[] {
  const safeLastEventId = Number.isFinite(lastEventId)
    ? Math.max(0, Math.floor(lastEventId))
    : 0;
  const safeLimit = Math.max(1, Math.min(10_000, Math.floor(limit)));
  const rows = db
    .query(
      `SELECT id, terminal_id, kind, data_blob, data_json, created_at
       FROM terminal_events
       WHERE terminal_id = ? AND id > ?
       ORDER BY id ASC
       LIMIT ?`,
    )
    .all(terminalId, safeLastEventId, safeLimit) as Array<{
    id: number;
    terminal_id: string;
    kind: TerminalEventKind;
    data_blob: unknown;
    data_json: string | null;
    created_at: string;
  }>;

  return rows.map((row) => {
    let dataJson: Record<string, unknown> | null = null;
    if (row.data_json) {
      try {
        dataJson = JSON.parse(row.data_json) as Record<string, unknown>;
      } catch {
        dataJson = null;
      }
    }
    return {
      id: row.id,
      terminalId: row.terminal_id,
      kind: row.kind,
      data: decodeTerminalEventData(row.data_blob),
      dataJson,
      createdAt: row.created_at,
    };
  });
}

export function writeAuditEvent(
  db: Database,
  event: {
    actorUserId?: string | null;
    action: string;
    resourceType: string;
    resourceId?: string | null;
    decision: "allow" | "deny";
    reason?: string | null;
    data?: Record<string, unknown>;
    now?: Date;
  },
): string {
  const id = createId("audit");
  db.query(
    `INSERT INTO audit_events
      (id, actor_user_id, action, resource_type, resource_id, decision, reason, data_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    event.actorUserId || null,
    event.action,
    event.resourceType,
    event.resourceId || null,
    event.decision,
    event.reason || null,
    JSON.stringify(event.data || {}),
    isoDate(event.now || new Date()),
  );
  return id;
}

export function grantScopedCapability(
  db: Database,
  grant: {
    userId: string;
    capability: ScopedGrantCapability;
    resourceType: string;
    resourceId: string;
    now?: Date;
  },
): string {
  const existing = db
    .query(
      `SELECT id FROM scoped_grants
       WHERE user_id = ? AND capability = ? AND resource_type = ? AND resource_id = ?`,
    )
    .get(
      grant.userId,
      grant.capability,
      grant.resourceType,
      grant.resourceId,
    ) as { id: string } | null;
  const id = existing?.id || createId("grant");
  const timestamp = isoDate(grant.now || new Date());
  db.query(
    `INSERT INTO scoped_grants
      (id, user_id, capability, resource_type, resource_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, capability, resource_type, resource_id) DO UPDATE SET
       updated_at = excluded.updated_at`,
  ).run(
    id,
    grant.userId,
    grant.capability,
    grant.resourceType,
    grant.resourceId,
    timestamp,
    timestamp,
  );
  return id;
}

export function hasScopedGrant(
  db: Database,
  grant: {
    userId: string;
    capability: ScopedGrantCapability;
    resourceType: string;
    resourceId: string;
  },
): boolean {
  const row = db
    .query(
      `SELECT 1 AS allowed FROM scoped_grants
       WHERE user_id = ?
         AND capability = ?
         AND (resource_type = ? OR resource_type = '*')
         AND (resource_id = ? OR resource_id = '*')
       LIMIT 1`,
    )
    .get(
      grant.userId,
      grant.capability,
      grant.resourceType,
      grant.resourceId,
    ) as { allowed: number } | null;
  return Boolean(row);
}

export function isBootstrapComplete(state: FoundationState): boolean {
  return state.bootstrap.bootstrapped;
}

export function getUserById(
  db: Database,
  userId: string,
): { id: string; email: string | null; role: string } | null {
  const row = db
    .query("SELECT id, email, role FROM users WHERE id = ?")
    .get(userId) as { id: string; email: string | null; role: string } | null;
  return row || null;
}

// ---------------------------------------------------------------------------
// B3 S1 — user provisioning state primitives (migration 5).
// ---------------------------------------------------------------------------

export type FoundationUserRole = "owner" | "admin" | "member";

export type FoundationUser = {
  id: string;
  email: string | null;
  displayName: string | null;
  role: FoundationUserRole;
  disabled: boolean;
  multiuserReviewedAt: string | null;
};

export type FoundationIdentity = {
  id: string;
  provider: string;
  issuer: string;
  subject: string;
  email: string | null;
};

type UserRowRaw = {
  id: string;
  email: string | null;
  display_name: string | null;
  role: string;
  disabled: number;
  multiuser_reviewed_at: string | null;
};

function mapUserRow(row: UserRowRaw): FoundationUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role as FoundationUserRole,
    disabled: Boolean(row.disabled),
    multiuserReviewedAt: row.multiuser_reviewed_at,
  };
}

type IdentityRowRaw = {
  id: string;
  provider: string;
  issuer: string;
  provider_subject: string;
  user_id: string;
  email: string | null;
};

function mapIdentityRow(
  row: Omit<IdentityRowRaw, "user_id">,
): Omit<FoundationIdentity, "email"> & { email: string | null } {
  return {
    id: row.id,
    provider: row.provider,
    issuer: row.issuer,
    subject: row.provider_subject,
    email: row.email,
  };
}

/**
 * Opaque id for invited (non-grandfathered) users: `user_` + 12 lowercase hex
 * chars from a crypto-random source. Existing ids (Cloudflare Access `sub`
 * values, legacy `anonymous`, etc.) are grandfathered and never re-parsed.
 */
export function generateUserId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `user_${hex}`;
}

export function getFoundationUserById(
  db: Database,
  userId: string,
): FoundationUser | null {
  const row = db
    .query(
      `SELECT id, email, display_name, role, disabled, multiuser_reviewed_at
       FROM users WHERE id = ?`,
    )
    .get(userId) as UserRowRaw | null;
  return row ? mapUserRow(row) : null;
}

export function listFoundationUsers(db: Database): Array<
  FoundationUser & {
    identities: Array<
      Omit<FoundationIdentity, "email"> & { email: string | null }
    >;
  }
> {
  const userRows = db
    .query(
      `SELECT id, email, display_name, role, disabled, multiuser_reviewed_at
       FROM users ORDER BY created_at ASC`,
    )
    .all() as UserRowRaw[];
  const identityRows = db
    .query(
      `SELECT id, provider, issuer, provider_subject, user_id, email
       FROM auth_identities`,
    )
    .all() as IdentityRowRaw[];

  const identitiesByUser = new Map<
    string,
    Array<Omit<FoundationIdentity, "email"> & { email: string | null }>
  >();
  for (const row of identityRows) {
    const list = identitiesByUser.get(row.user_id) ?? [];
    list.push(mapIdentityRow(row));
    identitiesByUser.set(row.user_id, list);
  }

  return userRows.map((row) => ({
    ...mapUserRow(row),
    identities: identitiesByUser.get(row.id) ?? [],
  }));
}

export class IdentityConflictError extends Error {
  constructor(message = "identity conflict") {
    super(message);
    this.name = "IdentityConflictError";
  }
}

/**
 * Invite a new user by canonical identity in one transaction. Throws
 * IdentityConflictError (leaving no orphan user row) if the (provider,
 * issuer, subject) triple already exists — collisions never merge rows.
 * Inviting as 'admin' sets multiuser_reviewed_at at creation time: the owner
 * explicitly chose the role, so it does not need a later §1.6 review.
 */
export function createInvitedUser(
  db: Database,
  opts: {
    provider: string;
    issuer: string;
    subject: string;
    email?: string | null;
    displayName?: string | null;
    role: "admin" | "member";
    now?: Date;
  },
): { user: FoundationUser; identityId: string } {
  const now = opts.now || new Date();
  const timestamp = isoDate(now);

  const existing = db
    .query(
      `SELECT id FROM auth_identities
       WHERE provider = ? AND issuer = ? AND provider_subject = ?`,
    )
    .get(opts.provider, opts.issuer, opts.subject) as { id: string } | null;
  if (existing) {
    throw new IdentityConflictError(
      `identity already exists for provider=${opts.provider} issuer=${opts.issuer} subject=${opts.subject}`,
    );
  }

  const userId = generateUserId();
  const identityId = createId("ident");
  const reviewedAt = opts.role === "admin" ? timestamp : null;

  const run = db.transaction(() => {
    db.query(
      `INSERT INTO users
        (id, email, display_name, role, disabled, multiuser_reviewed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(
      userId,
      opts.email ?? null,
      opts.displayName ?? null,
      opts.role,
      reviewedAt,
      timestamp,
      timestamp,
    );
    db.query(
      `INSERT INTO auth_identities
        (id, provider, issuer, provider_subject, user_id, email, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      identityId,
      opts.provider,
      opts.issuer,
      opts.subject,
      userId,
      opts.email ?? null,
      timestamp,
      timestamp,
    );
  });
  try {
    run();
  } catch (err) {
    // Same fail-closed conversion as resolveUserForActor's self-heal: the
    // pre-check above races a concurrent writer and the UNIQUE index is the
    // backstop. The transaction rolled back, so no orphan user row remains.
    const message = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed/i.test(message)) {
      throw new IdentityConflictError(
        `identity already exists for provider=${opts.provider} issuer=${opts.issuer} subject=${opts.subject}`,
      );
    }
    throw err;
  }

  const user = getFoundationUserById(db, userId);
  if (!user) {
    throw new Error(`failed to create invited user: ${userId}`);
  }
  return { user, identityId };
}

/**
 * Change a user's role in one transaction. Demoting to 'member' deletes that
 * user's wildcard scoped_grants rows (resource_type='*' OR resource_id='*')
 * in the same transaction — 'member' never retains wildcards. Non-wildcard
 * (scoped) grants survive the demotion.
 */
export function setUserRole(
  db: Database,
  opts: { userId: string; role: FoundationUserRole; now?: Date },
): FoundationUser {
  const now = opts.now || new Date();
  const timestamp = isoDate(now);

  if (!getFoundationUserById(db, opts.userId)) {
    throw new Error(`user not found: ${opts.userId}`);
  }

  const run = db.transaction(() => {
    db.query("UPDATE users SET role = ?, updated_at = ? WHERE id = ?").run(
      opts.role,
      timestamp,
      opts.userId,
    );
    if (opts.role === "member") {
      db.query(
        `DELETE FROM scoped_grants
         WHERE user_id = ? AND (resource_type = '*' OR resource_id = '*')`,
      ).run(opts.userId);
    }
  });
  run();

  const updated = getFoundationUserById(db, opts.userId);
  if (!updated) {
    throw new Error(`user not found after role update: ${opts.userId}`);
  }
  return updated;
}

export function setUserDisabled(
  db: Database,
  opts: { userId: string; disabled: boolean; now?: Date },
): FoundationUser {
  const now = opts.now || new Date();
  const timestamp = isoDate(now);

  if (!getFoundationUserById(db, opts.userId)) {
    throw new Error(`user not found: ${opts.userId}`);
  }

  db.query("UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?").run(
    opts.disabled ? 1 : 0,
    timestamp,
    opts.userId,
  );

  const updated = getFoundationUserById(db, opts.userId);
  if (!updated) {
    throw new Error(`user not found after disabled update: ${opts.userId}`);
  }
  return updated;
}

/** Deletes a scoped grant by id. Returns whether a row was actually deleted. */
export function revokeScopedCapability(db: Database, grantId: string): boolean {
  const result = db
    .query("DELETE FROM scoped_grants WHERE id = ?")
    .run(grantId);
  return result.changes > 0;
}

export function listScopedGrants(
  db: Database,
  opts?: { userId?: string },
): Array<{
  id: string;
  userId: string;
  capability: string;
  resourceType: string;
  resourceId: string;
}> {
  const rows = (
    opts?.userId
      ? db
          .query(
            `SELECT id, user_id, capability, resource_type, resource_id
             FROM scoped_grants WHERE user_id = ? ORDER BY created_at ASC`,
          )
          .all(opts.userId)
      : db
          .query(
            `SELECT id, user_id, capability, resource_type, resource_id
             FROM scoped_grants ORDER BY created_at ASC`,
          )
          .all()
  ) as Array<{
    id: string;
    user_id: string;
    capability: string;
    resource_type: string;
    resource_id: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    capability: row.capability,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
  }));
}

/**
 * Every DISTINCT scoped_grants.user_id holding a wildcard row
 * (resource_type='*' OR resource_id='*'), joined against users. Grant rows
 * keyed on an id with no users row (orphan principals) are still returned
 * (hasUserRow: false) — the §1.6 gate inventories grants directly, not via
 * backfilled identity/user rows.
 */
export function listWildcardGrantPrincipals(db: Database): Array<{
  userId: string;
  hasUserRow: boolean;
  role: FoundationUserRole | null;
  grantIds: string[];
}> {
  const grantRows = db
    .query(
      `SELECT id, user_id FROM scoped_grants
       WHERE resource_type = '*' OR resource_id = '*'
       ORDER BY user_id ASC, id ASC`,
    )
    .all() as Array<{ id: string; user_id: string }>;

  const grantIdsByUser = new Map<string, string[]>();
  for (const row of grantRows) {
    const list = grantIdsByUser.get(row.user_id) ?? [];
    list.push(row.id);
    grantIdsByUser.set(row.user_id, list);
  }

  return [...grantIdsByUser.entries()].map(([userId, grantIds]) => {
    const user = getFoundationUserById(db, userId);
    return {
      userId,
      hasUserRow: Boolean(user),
      role: user ? user.role : null,
      grantIds,
    };
  });
}

/**
 * Resolve the canonical user + identity row for an actor (plan §2). Actor
 * identity is always (provider, issuer, subject) — never email — as the key.
 *
 * 1. Exact (provider, issuer, subject) lookup.
 * 2. Fallback to the grandfathered (provider, '', subject) row. If found and
 *    the actor's current issuer is non-empty, self-heal the row's issuer —
 *    unless that would collide with a row that already holds the exact
 *    target triple, in which case this throws IdentityConflictError rather
 *    than ever merging two identity rows.
 * 3. If no identity row exists at all, fall back to a grandfathered
 *    `users.id === actor.id` row (pre-B3 single-tenant installs) and lazily
 *    synthesize the identity row for it.
 * 4. Otherwise the actor is unknown: returns null.
 */
export function resolveUserForActor(
  db: Database,
  actor: DeckTermActor,
  env: Record<string, string | undefined> = process.env,
): {
  user: FoundationUser;
  identity: Omit<FoundationIdentity, "email"> & { email?: string | null };
} | null {
  const triple = actorIdentityTriple(actor, env);

  const exact = db
    .query(
      `SELECT id, provider, issuer, provider_subject, user_id, email
       FROM auth_identities
       WHERE provider = ? AND issuer = ? AND provider_subject = ?`,
    )
    .get(
      triple.provider,
      triple.issuer,
      triple.subject,
    ) as IdentityRowRaw | null;
  if (exact) {
    const user = getFoundationUserById(db, exact.user_id);
    if (!user) return null;
    return { user, identity: mapIdentityRow(exact) };
  }

  // Grandfathered rows predate the issuer column and carry issuer = ''.
  const grandfathered = db
    .query(
      `SELECT id, provider, issuer, provider_subject, user_id, email
       FROM auth_identities
       WHERE provider = ? AND issuer = '' AND provider_subject = ?`,
    )
    .get(triple.provider, triple.subject) as IdentityRowRaw | null;
  if (grandfathered) {
    if (triple.issuer === "") {
      const user = getFoundationUserById(db, grandfathered.user_id);
      if (!user) return null;
      return { user, identity: mapIdentityRow(grandfathered) };
    }

    const collision = db
      .query(
        `SELECT id FROM auth_identities
         WHERE provider = ? AND issuer = ? AND provider_subject = ? AND id != ?`,
      )
      .get(
        triple.provider,
        triple.issuer,
        triple.subject,
        grandfathered.id,
      ) as { id: string } | null;
    if (collision) {
      throw new IdentityConflictError(
        `identity self-heal collision for provider=${triple.provider} issuer=${triple.issuer} subject=${triple.subject}`,
      );
    }

    const timestamp = isoDate(new Date());
    try {
      db.query(
        "UPDATE auth_identities SET issuer = ?, updated_at = ? WHERE id = ?",
      ).run(triple.issuer, timestamp, grandfathered.id);
    } catch (err) {
      // Belt-and-suspenders: the pre-check above closes the common window,
      // but a genuinely concurrent writer (a second DeckTerm process sharing
      // this state dir — see openFoundationDb's busy_timeout note) can still
      // race between that SELECT and this UPDATE. The UNIQUE index is the
      // final backstop; convert its violation into the same fail-closed
      // error so callers never see a raw SQLite error here. Never merge.
      const message = err instanceof Error ? err.message : String(err);
      if (/UNIQUE constraint failed/i.test(message)) {
        throw new IdentityConflictError(
          `identity self-heal collision for provider=${triple.provider} issuer=${triple.issuer} subject=${triple.subject}`,
        );
      }
      throw err;
    }

    const user = getFoundationUserById(db, grandfathered.user_id);
    if (!user) return null;
    return {
      user,
      identity: {
        id: grandfathered.id,
        provider: grandfathered.provider,
        issuer: triple.issuer,
        subject: grandfathered.provider_subject,
        email: grandfathered.email,
      },
    };
  }

  // No identity row under this triple at all: fall back to the grandfathered
  // users.id === actor.id convention (pre-B3 single-tenant installs) and
  // lazily synthesize the identity row for future lookups. No collision
  // check is needed here — the exact-triple lookup above already established
  // no row holds this triple.
  const userRow = db
    .query("SELECT id FROM users WHERE id = ?")
    .get(actor.id) as { id: string } | null;
  if (userRow) {
    const identityId = createId("ident");
    const timestamp = isoDate(new Date());
    db.query(
      `INSERT INTO auth_identities
        (id, provider, issuer, provider_subject, user_id, email, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      identityId,
      triple.provider,
      triple.issuer,
      triple.subject,
      userRow.id,
      actor.email ?? null,
      timestamp,
      timestamp,
    );
    const user = getFoundationUserById(db, userRow.id);
    if (!user) return null;
    return {
      user,
      identity: {
        id: identityId,
        provider: triple.provider,
        issuer: triple.issuer,
        subject: triple.subject,
        email: actor.email ?? null,
      },
    };
  }

  return null;
}

export async function bootstrapFirstAdmin({
  state,
  stateDir,
  actorUserId,
  actorEmail,
  token,
  authIdentity,
  env = process.env,
  now = new Date(),
}: {
  state: FoundationState;
  stateDir: string;
  actorUserId: string;
  actorEmail: string;
  token?: string | null;
  authIdentity?: {
    provider: string;
    providerSubject: string;
  } | null;
  env?: FoundationEnv;
  now?: Date;
}): Promise<
  | { ok: true; user: { id: string; email: string } }
  | { ok: false; status: 400 | 403 | 410; error: string }
> {
  const bootstrapMode = state.bootstrap.mode;
  if (state.bootstrap.bootstrapped) {
    return { ok: true, user: { id: actorUserId, email: actorEmail } };
  }

  if (state.bootstrap.mode === "env_admin") {
    const expectedEmail = state.bootstrap.expectedEmail;
    if (!expectedEmail || actorEmail !== expectedEmail) {
      return {
        ok: false,
        status: 403,
        error: "Bootstrap admin identity mismatch",
      };
    }
  } else {
    const tokenPath =
      state.bootstrap.tokenPath || join(stateDir, "bootstrap-token");
    const tokenStat = await stat(tokenPath).catch(() => null);
    if (!tokenStat) {
      return { ok: false, status: 410, error: "Bootstrap token not found" };
    }
    if ((tokenStat.mode & 0o077) !== 0) {
      return {
        ok: false,
        status: 403,
        error: "Bootstrap token file is readable by group or others",
      };
    }
    const ttlMs = Number.parseInt(
      env.DECKTERM_BOOTSTRAP_TOKEN_TTL_MS || String(60 * 60 * 1000),
      10,
    );
    if (ttlMs > 0 && now.getTime() - tokenStat.mtimeMs > ttlMs) {
      return { ok: false, status: 410, error: "Bootstrap token expired" };
    }
    const expectedToken = (await readFile(tokenPath, "utf8")).trim();
    if (!token || token !== expectedToken) {
      return { ok: false, status: 403, error: "Invalid bootstrap token" };
    }
    await unlink(tokenPath).catch(() => {});
  }

  const timestamp = isoDate(now);
  state.db
    .query(
      `INSERT INTO users (id, email, display_name, role, created_at, updated_at)
       VALUES (?, ?, ?, 'owner', ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         email = excluded.email,
         display_name = excluded.display_name,
         role = 'owner',
         updated_at = excluded.updated_at`,
    )
    .run(actorUserId, actorEmail, actorEmail, timestamp, timestamp);

  if (authIdentity?.provider && authIdentity.providerSubject) {
    // authIdentity carries no issuer (pre-B3 call shape from server.ts,
    // untouched by S1) — stored under the grandfathered issuer '' convention
    // matching migration 5's copy-forward of pre-existing rows; the unique
    // index is now (provider, issuer, provider_subject), so both the lookup
    // and the ON CONFLICT target must include issuer.
    const existingIdentity = state.db
      .query(
        `SELECT id FROM auth_identities
         WHERE provider = ? AND issuer = '' AND provider_subject = ?`,
      )
      .get(authIdentity.provider, authIdentity.providerSubject) as {
      id: string;
    } | null;
    state.db
      .query(
        `INSERT INTO auth_identities
          (id, provider, issuer, provider_subject, user_id, email, created_at, updated_at)
         VALUES (?, ?, '', ?, ?, ?, ?, ?)
         ON CONFLICT(provider, issuer, provider_subject) DO UPDATE SET
           user_id = excluded.user_id,
           email = excluded.email,
           updated_at = excluded.updated_at`,
      )
      .run(
        existingIdentity?.id || createId("ident"),
        authIdentity.provider,
        authIdentity.providerSubject,
        actorUserId,
        actorEmail,
        timestamp,
        timestamp,
      );
  }

  // No boot-time/bootstrap-time grant materialization (plan §3.3): the owner
  // role granted above is covered by the check-time role bundle
  // (roleImpliesCapability in foundation-authorization.ts), so a bootstrapped
  // owner can act immediately without any scoped_grants rows.
  state.bootstrap = {
    bootstrapped: true,
    mode: "complete",
    tokenPath: null,
    expectedEmail: null,
  };

  writeAuditEvent(state.db, {
    actorUserId,
    action: "bootstrap.admin.create",
    resourceType: "server",
    resourceId: "*",
    decision: "allow",
    reason: bootstrapMode,
    data: { email: actorEmail },
    now,
  });

  return { ok: true, user: { id: actorUserId, email: actorEmail } };
}
