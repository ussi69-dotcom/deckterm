-- Foundation schema of the production release b04c791 (2026-10-13): a fresh
-- database built by that release's migrateFoundationDb, dumped in creation
-- order with its schema_migrations rows. The rollback-compatibility test
-- (backend/foundation-schema-rollback.test.ts) migrates a copy with the
-- current code and runs the release driver's contract check against it.

CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT,
      display_name TEXT,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','member')),
      disabled INTEGER NOT NULL DEFAULT 0,
      multiuser_reviewed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

CREATE TABLE project_roots (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      warning TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

CREATE TABLE terminal_sessions (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT,
      root_id TEXT,
      cwd TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ended_at TEXT,
      termination_scheduled_at TEXT,
      last_event_id INTEGER NOT NULL DEFAULT 0,
      exec_kind TEXT,
      os_uid INTEGER,
      FOREIGN KEY(root_id) REFERENCES project_roots(id)
    );

CREATE TABLE terminal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      terminal_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      data_blob BLOB,
      data_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(terminal_id) REFERENCES terminal_sessions(id) ON DELETE CASCADE
    );

CREATE INDEX idx_terminal_events_terminal_id_id
      ON terminal_events(terminal_id, id);

CREATE TABLE audit_events (
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

CREATE TABLE auth_identities (
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

CREATE TABLE scoped_grants (
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

CREATE TABLE user_os_mappings (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      os_username TEXT NOT NULL,
      os_uid INTEGER NOT NULL,
      os_gid INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
      suspend_reason TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

CREATE UNIQUE INDEX idx_os_mappings_active_uid
      ON user_os_mappings(os_uid) WHERE status = 'active';

CREATE TABLE push_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      expiration_time INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

CREATE INDEX idx_push_subscriptions_user_id
      ON push_subscriptions(user_id);

CREATE TABLE user_settings (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, key)
    );

CREATE TABLE os_isolation_deny_counters (
      actor_user_id TEXT NOT NULL DEFAULT '',
      actor_source TEXT NOT NULL DEFAULT '',
      surface TEXT NOT NULL,
      reason TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      last_request_id TEXT,
      PRIMARY KEY (actor_user_id, actor_source, surface, reason)
    );

CREATE TABLE retention_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
      detail TEXT
    );

CREATE INDEX idx_retention_runs_job_finished
      ON retention_runs(job, finished_at);

INSERT INTO schema_migrations (version, applied_at) VALUES (1, '2026-10-13T00:00:00.000Z');

INSERT INTO schema_migrations (version, applied_at) VALUES (2, '2026-10-13T00:00:00.000Z');

INSERT INTO schema_migrations (version, applied_at) VALUES (3, '2026-10-13T00:00:00.000Z');

INSERT INTO schema_migrations (version, applied_at) VALUES (4, '2026-10-13T00:00:00.000Z');

INSERT INTO schema_migrations (version, applied_at) VALUES (5, '2026-10-13T00:00:00.000Z');

INSERT INTO schema_migrations (version, applied_at) VALUES (6, '2026-10-13T00:00:00.000Z');

INSERT INTO schema_migrations (version, applied_at) VALUES (7, '2026-10-13T00:00:00.000Z');

INSERT INTO schema_migrations (version, applied_at) VALUES (8, '2026-10-13T00:00:00.000Z');

INSERT INTO schema_migrations (version, applied_at) VALUES (9, '2026-10-13T00:00:00.000Z');

INSERT INTO schema_migrations (version, applied_at) VALUES (10, '2026-10-13T00:00:00.000Z');
