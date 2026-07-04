import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendTerminalEvent,
  initializeFoundationState,
  recordTerminalSession,
} from "./foundation-state";
import {
  getLastSuccessfulRunAt,
  RETENTION_JOB_PRUNE,
  RETENTION_JOB_WAL_CHECKPOINT,
  runRetentionPrune,
  runWalCheckpoint,
} from "./retention";

async function createTempDir(prefix: string): Promise<string> {
  const dir = join(
    tmpdir(),
    `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

async function setupState() {
  const stateDir = await createTempDir(".deckterm-retention-");
  const projectRoot = await createTempDir(".deckterm-retention-root-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [projectRoot],
    env: {},
    now: new Date("2026-07-04T00:00:00Z"),
  });
  return { state, projectRoot };
}

function addSession(
  db: Database,
  id: string,
  rootId: string | undefined,
  cwd: string,
  createdAt: Date,
) {
  recordTerminalSession(db, {
    id,
    actorUserId: "user_owner",
    rootId,
    cwd,
    now: createdAt,
  });
}

function endSession(db: Database, id: string, endedAt: string) {
  db.query(
    `UPDATE terminal_sessions SET status = 'ended', ended_at = ?, updated_at = ? WHERE id = ?`,
  ).run(endedAt, endedAt, id);
}

function countRows(
  db: Database,
  table: "terminal_events" | "terminal_sessions",
) {
  const row = db.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as {
    c: number;
  };
  return Number(row.c);
}

test("retention prune: output purge, TTL boundaries, ended-only, live-id exclusion", async () => {
  const { state, projectRoot } = await setupState();
  const db = state.db;
  const rootId = state.roots[0]?.id;
  const now = new Date("2026-07-04T12:00:00Z");
  const old = new Date("2026-05-01T12:00:00Z"); // 64 days before `now`
  const fresh = new Date("2026-07-03T12:00:00Z"); // 1 day before `now`

  // Old ended session with old events — fully prunable.
  addSession(db, "term-old-ended", rootId, projectRoot, old);
  appendTerminalEvent(db, {
    terminalId: "term-old-ended",
    kind: "output",
    data: "old output",
    now: old,
  });
  appendTerminalEvent(db, {
    terminalId: "term-old-ended",
    kind: "state",
    dataJson: { running: true },
    now: old,
  });
  endSession(db, "term-old-ended", old.toISOString());

  // Old but still ACTIVE session — must survive (status gate).
  addSession(db, "term-old-active", rootId, projectRoot, old);
  appendTerminalEvent(db, {
    terminalId: "term-old-active",
    kind: "state",
    dataJson: { running: true },
    now: fresh,
  });

  // Old ended session that is LIVE in-memory — must survive (I3 belt).
  addSession(db, "term-live", rootId, projectRoot, old);
  appendTerminalEvent(db, {
    terminalId: "term-live",
    kind: "output",
    data: "live output",
    now: old,
  });
  endSession(db, "term-live", old.toISOString());

  // Fresh ended session — inside TTL, must survive.
  addSession(db, "term-fresh-ended", rootId, projectRoot, fresh);
  appendTerminalEvent(db, {
    terminalId: "term-fresh-ended",
    kind: "output",
    data: "fresh output",
    now: fresh,
  });
  endSession(db, "term-fresh-ended", fresh.toISOString());

  const result = await runRetentionPrune(db, {
    eventTtlDays: 30,
    endedSessionTtlDays: 30,
    liveTerminalIds: new Set(["term-live"]),
    now,
    chunkSize: 100,
  });

  // Output purge is kind-based and global (except live ids): fresh ended
  // session's output goes too — output events are dead data post-S1.
  expect(result.outputEventsPurged).toBe(2); // old-ended + fresh-ended
  // Old state event of term-old-ended dies with TTL or cascade; the old
  // active session's fresh state event survives.
  const sessions = db
    .query("SELECT id FROM terminal_sessions ORDER BY id")
    .all() as Array<{ id: string }>;
  expect(sessions.map((s) => s.id).sort()).toEqual([
    "term-fresh-ended",
    "term-live",
    "term-old-active",
  ]);
  expect(result.endedSessionsPruned).toBe(1);

  // Live terminal keeps even its output events (I3).
  const liveEvents = db
    .query("SELECT kind FROM terminal_events WHERE terminal_id = 'term-live'")
    .all() as Array<{ kind: string }>;
  expect(liveEvents.length).toBe(1);
  expect(liveEvents[0].kind).toBe("output");

  // Idempotence: a second run deletes nothing.
  const second = await runRetentionPrune(db, {
    eventTtlDays: 30,
    endedSessionTtlDays: 30,
    liveTerminalIds: new Set(["term-live"]),
    now,
    chunkSize: 100,
  });
  expect(second.outputEventsPurged).toBe(0);
  expect(second.expiredEventsPruned).toBe(0);
  expect(second.endedSessionsPruned).toBe(0);

  // Bookkeeping: two completed prune runs recorded, audit rows written.
  const runs = db
    .query("SELECT job, status FROM retention_runs WHERE job = ? ORDER BY id")
    .all(RETENTION_JOB_PRUNE) as Array<{ job: string; status: string }>;
  expect(runs.length).toBe(2);
  expect(runs.every((r) => r.status === "completed")).toBe(true);
  expect(getLastSuccessfulRunAt(db, RETENTION_JOB_PRUNE)).not.toBeNull();

  const audits = db
    .query(
      "SELECT COUNT(*) AS c FROM audit_events WHERE action = 'retention.prune' AND decision = 'allow'",
    )
    .get() as { c: number };
  expect(Number(audits.c)).toBe(2);

  // Never-run job reports null.
  expect(getLastSuccessfulRunAt(db, "no-such-job")).toBeNull();

  db.close();
});

test("retention prune: chunked deletion crosses chunk boundaries correctly", async () => {
  const { state, projectRoot } = await setupState();
  const db = state.db;
  const rootId = state.roots[0]?.id;
  const old = new Date("2026-05-01T12:00:00Z");

  addSession(db, "term-bulk", rootId, projectRoot, old);
  for (let i = 0; i < 257; i++) {
    appendTerminalEvent(db, {
      terminalId: "term-bulk",
      kind: "output",
      data: `chunk ${i}`,
      now: old,
    });
  }
  const before = countRows(db, "terminal_events");
  expect(before).toBe(257);

  const result = await runRetentionPrune(db, {
    eventTtlDays: 3650,
    endedSessionTtlDays: 3650,
    now: new Date("2026-07-04T12:00:00Z"),
    chunkSize: 100, // forces 3 chunks for the output purge
  });
  expect(result.outputEventsPurged).toBe(257);
  expect(countRows(db, "terminal_events")).toBe(0);

  db.close();
});

test("wal checkpoint job records a completed run", async () => {
  const { state } = await setupState();
  const db = state.db;

  expect(getLastSuccessfulRunAt(db, RETENTION_JOB_WAL_CHECKPOINT)).toBeNull();
  runWalCheckpoint(db, new Date("2026-07-04T12:00:00Z"));
  expect(
    getLastSuccessfulRunAt(db, RETENTION_JOB_WAL_CHECKPOINT),
  ).not.toBeNull();

  db.close();
});
