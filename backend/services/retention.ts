/**
 * B6 — retention/pruning for foundation state (plan
 * docs/plans/2026-07-04-b6-b7-retention-limits.md, B1 design §3.1).
 *
 * Structural separation (invariants I1/I2): this module knows exactly three
 * table names — `terminal_events`, `terminal_sessions`, `retention_runs` —
 * and exposes no way to point it at anything else. Audit pruning does not
 * exist here by design: it requires C2's export-gated flow. Recordings (C4)
 * are likewise out of reach. Brokered capture dirs on disk belong to the
 * broker GC / C4 policy, never to this module (D-B6-6).
 *
 * The destructive work is chunked with an event-loop yield between chunks —
 * the foundation DB is a single in-process connection, so the failure mode
 * being avoided is a long synchronous DELETE stalling live PTY traffic, not
 * lock contention (Codex #3). No VACUUM here, ever (I12): space reclaim is
 * the operator's `scripts/db-maintenance.ts --vacuum`.
 */

import type { Database } from "bun:sqlite";
import { writeAuditEvent } from "./foundation-state";

const EVENTS_TABLE = "terminal_events";
const SESSIONS_TABLE = "terminal_sessions";
const RUNS_TABLE = "retention_runs";

export const RETENTION_JOB_PRUNE = "prune";
export const RETENTION_JOB_WAL_CHECKPOINT = "wal_checkpoint";

export type RetentionPruneOptions = {
  /** TTL for terminal_events rows (all kinds). Default 30 days. */
  eventTtlDays?: number;
  /** TTL for terminal_sessions rows with status='ended'. Default 30 days. */
  endedSessionTtlDays?: number;
  /**
   * Ids of terminals currently live in the server's in-memory map. Their
   * session rows and events are never pruned regardless of timestamps
   * (invariant I3 — belt over the status check, protects against drift).
   */
  liveTerminalIds?: ReadonlySet<string>;
  now?: Date;
  /** Max rows deleted per chunk before yielding the event loop. */
  chunkSize?: number;
};

export type RetentionPruneResult = {
  outputEventsPurged: number;
  expiredEventsPruned: number;
  endedSessionsPruned: number;
  runId: number;
};

const DEFAULT_TTL_DAYS = 30;
const DEFAULT_CHUNK_SIZE = 5_000;

function isoCutoff(now: Date, ttlDays: number): string {
  const safeTtl = Number.isFinite(ttlDays) ? Math.max(0, ttlDays) : 30;
  return new Date(now.getTime() - safeTtl * 24 * 60 * 60 * 1000).toISOString();
}

const yieldEventLoop = () => new Promise<void>((r) => setTimeout(r, 0));

function startRun(db: Database, job: string, now: Date): number {
  db.query(
    `INSERT INTO ${RUNS_TABLE} (job, started_at, status) VALUES (?, ?, 'running')`,
  ).run(job, now.toISOString());
  const row = db.query("SELECT last_insert_rowid() AS id").get() as {
    id: number | bigint;
  };
  return Number(row.id);
}

function finishRun(
  db: Database,
  runId: number,
  status: "completed" | "failed",
  detail: Record<string, unknown>,
): void {
  db.query(
    `UPDATE ${RUNS_TABLE} SET finished_at = ?, status = ?, detail = ? WHERE id = ?`,
  ).run(new Date().toISOString(), status, JSON.stringify(detail), runId);
}

export function getLastSuccessfulRunAt(db: Database, job: string): Date | null {
  const row = db
    .query(
      `SELECT finished_at FROM ${RUNS_TABLE}
       WHERE job = ? AND status = 'completed' AND finished_at IS NOT NULL
       ORDER BY id DESC LIMIT 1`,
    )
    .get(job) as { finished_at: string } | null;
  if (!row?.finished_at) return null;
  const at = new Date(row.finished_at);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * Deletes rows matching `where` in bounded chunks, yielding the event loop
 * between chunks. `where` and its params must select on the events or
 * sessions table only (module-private call sites).
 */
async function deleteChunked(
  db: Database,
  table: typeof EVENTS_TABLE | typeof SESSIONS_TABLE,
  where: string,
  params: (string | number)[],
  chunkSize: number,
): Promise<number> {
  let total = 0;
  for (;;) {
    db.query(
      `DELETE FROM ${table}
       WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ?)`,
    ).run(...params, chunkSize);
    const changes = db.query("SELECT changes() AS n").get() as { n: number };
    total += Number(changes.n);
    if (Number(changes.n) < chunkSize) break;
    await yieldEventLoop();
  }
  return total;
}

function notLiveClause(
  column: string,
  liveIds: ReadonlySet<string>,
): { clause: string; params: string[] } {
  if (liveIds.size === 0) return { clause: "", params: [] };
  const ids = [...liveIds];
  return {
    clause: ` AND ${column} NOT IN (${ids.map(() => "?").join(", ")})`,
    params: ids,
  };
}

/**
 * The daily prune (D-B6-3/D-B6-5): purges dead `output` events (a standing
 * rule — S1 stopped writing them; this keeps the table output-free even if a
 * downgrade re-introduced rows), prunes events past TTL, prunes `ended`
 * sessions past TTL (their remaining events cascade via FK). Records a
 * `retention_runs` row and an audit row (I10). Idempotent and resumable —
 * every predicate re-selects only what still matches.
 */
export async function runRetentionPrune(
  db: Database,
  options: RetentionPruneOptions = {},
): Promise<RetentionPruneResult> {
  const now = options.now ?? new Date();
  const chunkSize = Math.max(100, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const liveIds = options.liveTerminalIds ?? new Set<string>();
  const eventCutoff = isoCutoff(now, options.eventTtlDays ?? DEFAULT_TTL_DAYS);
  const sessionCutoff = isoCutoff(
    now,
    options.endedSessionTtlDays ?? DEFAULT_TTL_DAYS,
  );

  const runId = startRun(db, RETENTION_JOB_PRUNE, now);
  try {
    const liveEvents = notLiveClause("terminal_id", liveIds);
    const outputEventsPurged = await deleteChunked(
      db,
      EVENTS_TABLE,
      `kind = 'output'${liveEvents.clause}`,
      [...liveEvents.params],
      chunkSize,
    );
    const expiredEventsPruned = await deleteChunked(
      db,
      EVENTS_TABLE,
      `created_at < ?${liveEvents.clause}`,
      [eventCutoff, ...liveEvents.params],
      chunkSize,
    );

    const liveSessions = notLiveClause("id", liveIds);
    const endedSessionsPruned = await deleteChunked(
      db,
      SESSIONS_TABLE,
      `status = 'ended' AND ended_at IS NOT NULL AND ended_at < ?${liveSessions.clause}`,
      [sessionCutoff, ...liveSessions.params],
      chunkSize,
    );

    const counts = {
      outputEventsPurged,
      expiredEventsPruned,
      endedSessionsPruned,
      eventCutoff,
      sessionCutoff,
    };
    finishRun(db, runId, "completed", counts);
    writeAuditEvent(db, {
      action: "retention.prune",
      resourceType: "foundation_state",
      decision: "allow",
      data: counts,
      now,
    });
    return {
      outputEventsPurged,
      expiredEventsPruned,
      endedSessionsPruned,
      runId,
    };
  } catch (err) {
    finishRun(db, runId, "failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/** Weekly WAL bound (D-B6-5). Never VACUUMs (I12). */
export function runWalCheckpoint(db: Database, now = new Date()): void {
  const runId = startRun(db, RETENTION_JOB_WAL_CHECKPOINT, now);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    finishRun(db, runId, "completed", {});
  } catch (err) {
    finishRun(db, runId, "failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
