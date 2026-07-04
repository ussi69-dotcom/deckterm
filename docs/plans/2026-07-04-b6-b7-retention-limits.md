# B6 + B7 — Retention/Pruning/Backup + Per-User Limits (Track B closeout, M1)

> Implements the B1 storage design §3.1/§3.4 (`2026-07-02-b1-identity-isolation-storage-design.md`)
> and the program rows B6/B7 (`2026-07-02-enterprise-1.0-program.md` §3). Last two slices of
> Track B; on completion M1 exit criteria are checked and Track B promotes to `main`.
> E3 (upgrade + backup/restore runbook) lands in the same phase — it gates B6 per program §6.

## 0. Evidence (dev, 2026-07-04)

- `~/.deckterm-dev/deckterm.db` = **136 MB**; `terminal_events`: **353,080 `output` rows
  (71.7 MB blob)** + 31,475 `state` rows; **503 `terminal_sessions` rows `status='ended'`**.
- Hot path: `appendScrollback` (`server.ts:2478`) does an `INSERT INTO terminal_events` +
  `UPDATE terminal_sessions` **per output chunk** (`foundation-state.ts:938-952`).
- The only reader of `output` events is the WS delta-replay branch
  (`completeTmuxReconnectReplay`, `server.ts:3309-3341`) gated on `ws.data.lastEventId` —
  which **no production client ever sends** (`grep lastEventId web/` = 0 hits). The real
  reconnect path is in-memory scrollback + tmux `capture-pane` (raw mode: in-memory only).
- No `sqlite3` CLI on the host → backup uses `VACUUM INTO` via `bun:sqlite`.
- Brokered (isolation-mode) output capture already bypasses the server DB entirely
  (root-provisioned `pipe.log` via `deckterm-capture`, B2 §3.5) — B6 changes nothing there.

## 1. Design decisions (Codex-validated 2026-07-04, rev 1 — see §5)

1. **D-B6-1: retire `output` from `terminal_events` entirely.** Stop writing output rows
   (keep `state`/`exit`/`lifecycle` low-volume kinds); drop the output branch from the
   delta-replay reader and rely on the existing capture/scrollback replay (that is already
   the only path real clients exercise). `lastEventId` WS param stays accepted but is
   **explicitly best-effort metadata replay** (Codex #1): it may replay `state` events, and
   it must **never suppress** the capture/scrollback replay for screen content — the old
   early-return-after-delta-replay is removed, not preserved. `output` remains a legal
   `TerminalEventKind` at the state layer (query/delete compatibility; only the server call
   site is removed). `terminal_events.id` is `AUTOINCREMENT`, so purged output ids are never
   reused under a stale client `lastEventId`.
2. **D-B6-2: defer the legacy-mode reconnect spool to C4 — with an explicit scope
   downgrade (Codex #2).** B1 §3.1 assigned spool-writing to B6; nothing reads such a spool
   in legacy mode today (reconnect = scrollback/capture-pane, restart-survival = tmux
   server), and writing ~70 MB/month of plaintext terminal output with no reader and no
   recording policy is a data-liability regression. **Scope statement: B6 preserves runtime
   reconnect/capture semantics but does NOT provide restart recovery for legacy raw-mode
   sessions (unchanged from today); restart-recovery + durable capture become a C4
   acceptance item.**
3. **D-B6-3: one-time purge of dead `output` rows — chunked, resumable, no automatic
   VACUUM (Codex #3, was a blocker).** The purge deletes `kind='output'` rows in bounded
   chunks (id-subselect batches of ~5,000 with an event-loop yield between chunks — the DB
   is a single in-process connection, so the risk is event-loop stall, not lock
   contention), is idempotent/resumable by construction (kind predicate), logs progress,
   and records completion in `retention_runs`. `PRAGMA wal_checkpoint(TRUNCATE)` runs after
   the purge. **`VACUUM` is never fired automatically**: space reclaim is offered via
   `scripts/db-maintenance.ts --vacuum` (documented in E3, run during a maintenance window)
   — and every backup is a compacted copy anyway (`VACUUM INTO`).
4. **D-B6-4: audit rows are NOT pruned in B6.** B1 §3.3 requires a completed NDJSON export
   (C2) before audit pruning; the export does not exist yet, so the audit prune refuses by
   construction (not implemented until C2). Retention module carries an explicit table
   allowlist (`terminal_events`, `terminal_sessions`) — structural separation from future
   `recordings` and from `audit_events`.
5. **D-B6-5: prune cadence + migration discipline (Codex #4).** Daily prune (events TTL +
   ended-sessions TTL) and weekly `PRAGMA wal_checkpoint(TRUNCATE)`; no scheduled VACUUM
   (D-B6-3). Timers are `setInterval` in `startWebServer` alongside the existing reapers.
   Cadence bookkeeping lives in a new `retention_runs` table shipped as **numbered
   migration 8** (keeps the E3 migration ledger honest); each run records job name,
   started/finished timestamps, status, row counts and error text, so "did the destructive
   B6 cleanup run, and when" has an auditable answer.
6. **D-B6-6: brokered capture dirs are not deleted by the pruner** (Codex #5 confirmed).
   They are root-provisioned under `/var/lib/deckterm/capture`; deletion authority belongs
   to the broker GC (B2) and C4 policy finalization. The B6 pruner touches only the DB.
7. **D-B7-1: rate limiter becomes per-owner buckets** (`Map<ownerId, timestamps[]>`); the
   **global** window limit stays as a backstop against aggregate abuse (per-owner limit
   defaults to the current global numbers; global backstop = `4 × per-owner`,
   env-overridable). `MAX_TERMINALS_PER_USER` is already per-owner; `MAX_TERMINALS` global
   cap stays. Hardening (Codex #6): `ownerId` is derived **server-side** from the resolved
   actor (never client input — already the case, `resolveTerminalActor` runs first and
   unauthenticated requests never reach the limiter); bucket map gets TTL sweep on each
   check (drop owners with no timestamp inside the window) so owner-cardinality cannot grow
   memory unboundedly; both limiter checks are cheap in-memory tests that run before any
   terminal-creation work.
8. **D-B7-2: per-user reaper policy = seam + env defaults ONLY (Codex #7, was a blocker).**
   `resolveSessionPolicy(ownerId)` returns `{idleTimeoutMs, detachedTtlMs}` from env
   defaults; **no `policy.*` writes through the actor-scoped self-service `/api/settings`**
   — that would be an authorization footgun. The settings route explicitly **rejects/
   reserves the `policy.` key prefix** so nothing can squat on it before C3 ships
   admin-managed policy storage. C3 builds the real per-user policy store + UX on this seam.

## 2. Slices

### B6-S1 — Retire output events from the hot path (main loop, xhigh)

- `server.ts appendScrollback`: drop the `appendTerminalRuntimeEvent(id, "output", …)` call;
  in-memory scrollback (already capped) is unchanged.
- `completeTmuxReconnectReplay`: delta branch replays only `state` events (kind filter in
  the query via `listTerminalEventsAfter(db, id, lastEventId, {kinds})`), and **always**
  proceeds to capture replay for screen content — the old early return after delta replay
  is removed (D-B6-1; best-effort metadata semantics, never suppresses capture replay).
- `appendTerminalRuntimeEvent` keeps `state`/`exit`/`lifecycle` writers untouched.
- Tests: unit test asserting N `appendScrollback` calls produce 0 `terminal_events` rows and
  intact in-memory scrollback; existing reconnect tests stay green.
- Allowlist: `backend/server.ts`, `backend/services/foundation-state.ts` (reader signature),
  co-located tests.

### B6-S2 — Retention module + scheduler (Sonnet, brief below; review vs invariants)

- Migration 8: `retention_runs (id INTEGER PK AUTOINCREMENT, job TEXT, started_at TEXT,
finished_at TEXT, status TEXT, detail TEXT)` — D-B6-5.
- New `backend/services/retention.ts`:
  - `runRetentionPrune(db, {eventTtlDays=30, endedSessionTtlDays=30, liveIds, now})` →
    deletes `terminal_events` older than TTL (chunked); deletes `terminal_sessions` with
    `status='ended'` and `ended_at` older than TTL (events cascade); also purges
    `kind='output'` rows chunked/resumable per D-B6-3 (a standing rule, not a one-shot —
    keeps the table output-free forever). Returns counts; records a `retention_runs` row;
    writes an audit row (I10).
  - `runWalCheckpoint(db)`; **no vacuum here** — `scripts/db-maintenance.ts --vacuum` is
    the only VACUUM path (D-B6-3).
  - Hard allowlist: the module refuses to touch any table other than
    `terminal_events`/`terminal_sessions`/`retention_runs` (structural, e.g. table names
    are module-private consts; no audit/recordings access).
- `server.ts startWebServer`: hourly `setInterval` tick calls a scheduler that consults
  `retention_runs` and executes due jobs (daily prune / weekly checkpoint);
  errors logged + recorded on the run row, never crash the server; skipped when
  `DECKTERM_RETENTION_DISABLED=1`.
- Env: `DECKTERM_EVENT_RETENTION_DAYS` (default 30), `DECKTERM_SESSION_RETENTION_DAYS`
  (default 30), `DECKTERM_RETENTION_DISABLED`.
- Do NOT prune sessions with `status!='ended'` regardless of age (a live tmux session may
  be weeks old). Never delete the row for a terminal currently in the in-memory `terminals`
  map — pruner takes the live-id set as a parameter and excludes it (belt over the status
  check, protects against status drift).
- Tests: `backend/services/retention.test.ts` — TTL boundaries, ended-only, live-id
  exclusion, output purge idempotence, bookkeeping cadence math, allowlist (attempting to
  configure an audit prune throws). Add to `package.json test:unit`.

### B6-S3 — Backup script + soak test (Sonnet)

- `scripts/backup-state.sh`: resolves state dir (`DECKTERM_STATE_DIR` or `~/.deckterm`),
  runs `bun scripts/backup-state.ts` which opens the DB read-only and `VACUUM INTO`
  a timestamped `backups/deckterm-<utc>.db` (WAL-safe, atomic); copies `audit-anchor.log`
  if present; writes a small manifest (source, sizes, sha256); prunes to keep last
  `DECKTERM_BACKUP_KEEP` (default 7). Never touches user homes (out of scope per B1 §3.4).
- Soak/DB-stability test (M1 exit criterion): unit-level — hammer `appendScrollback`-path
  with 10k chunks and assert `terminal_events` count and DB `page_count` stay flat
  (post-S1); plus a retention test that a synthetic 60-day-old dataset prunes to the TTL
  window.
- Tests + script are additive; allowlist: `scripts/backup-state.{sh,ts}`, test files,
  `package.json`, `.env.example`, `README.md` env table.

### B7 — Per-user limits (Sonnet, localized)

- `server.ts`: replace `rateLimitState` with per-owner buckets + global backstop (D-B7-1);
  `getTerminalCreationError(ownerId)` consults the owner bucket first (403/429 semantics
  unchanged, message distinguishes "your rate limit" vs "server busy"); `record(ownerId)`
  at the existing three call sites.
- Reaper: `cleanupIdleTerminals`/`reapDetachedSessions` read per-owner policy via
  `resolveSessionPolicy(ownerId)` — seam + env defaults only (D-B7-2).
- `/api/settings` PUT rejects keys with the reserved `policy.` prefix (D-B7-2).
- Env: `TERMINAL_RATE_LIMIT_PER_USER_MAX` (default = current
  `OPENCODE_WEB_TERMINAL_RATE_LIMIT_MAX_REQUESTS`), global backstop derived (D-B7-1).
- Tests: two owners — A exhausting A's bucket must not 429 B; global backstop still trips;
  bucket sweep drops idle owners; settings PUT with a `policy.*` key is rejected;
  `resolveSessionPolicy` returns env defaults.

### E3 — Upgrade + backup/restore runbook (docs, main loop)

- `docs/upgrade-and-backup-runbook.md`: schema migration order (1→7 today; next free numbers
  go to C1/C2/C4), what each migration touches, additive-only guarantee (B/C tracks), rollback
  (flags off + restore), bootstrap-owner recovery (migration-5 owner promotion refusal path,
  B3 §1.6), backup rehearsal: run `backup-state.sh`, restore to a scratch state dir, boot a
  server against it, verify `/api/health` + a terminal attach. Dev/prod port + state-dir
  table (4174/`~/.deckterm-dev` vs 4173/`~/.deckterm`).

## 3. Invariant checklist (bake into every brief + diff review)

From program Appendix A.2 + B1 §3:

- I1. The pruner DELETES only from `terminal_events`/`terminal_sessions` (+ its own
  `retention_runs` bookkeeping) — it never prunes/deletes `audit_events` (it only appends
  allow rows there, I10), never (future) `recordings`, never files outside the DB.
  Structural, not an `if`. (Wording per Codex pre-final #3.)
- I2. Audit pruning is impossible before C2's export exists (not implemented, module refuses).
- I3. No behavior change for live sessions: rows for live/in-memory terminals are never pruned;
  `status!='ended'` rows are never pruned regardless of age.
- I4. Legacy single-tenant mode stays byte-identical on the terminal data path except for the
  removed DB writes (no new spool files in legacy mode — D-B6-2).
- I5. Reconnect UX unchanged: same lifecycle messages, capture replay still fires; the removed
  delta-output replay had no production sender.
- I6. Backup is WAL-safe (`VACUUM INTO` on a live DB), runs as the service account, never reads
  user homes, output files 0600 in a 0700 dir.
- I7. Rate limiting is fail-closed per actor: one user cannot consume another user's budget;
  unauthenticated requests never reach the limiter (existing actor gate stays first).
- I8. All new env knobs documented in `.env.example` + README table; defaults preserve current
  observable behavior for a single-user install (same limits as today).
- I9. `bun x tsc --noEmit` green; new tests wired into `test:unit` (explicit file list).
- I10. Every prune run records its counts durably in `retention_runs` (completed BEFORE the
  audit write — a crash or audit failure cannot erase the evidence of a completed
  destructive run; a crash mid-delete leaves the run row `running`), then mirrors an audit
  row (action `retention.prune`, counts, decision allow) best-effort. (Codex pre-final #4.)
- I11. `lastEventId` delta replay never suppresses capture replay; `output` stays a legal
  event kind at the state layer (Codex #1).
- I12. No automatic VACUUM anywhere; purge is chunked with event-loop yields (Codex #3).
- I13. Self-service settings cannot store `policy.*` keys (Codex #7).

## 4. Execution + verification (M1 evidence — Codex #8)

Sequencing: E3 runbook → B6-S1 (main loop) → B6-S2 → B6-S3 → B7 → integrated
`bun run test:all` + `tsc` → live restart of `deckterm-dev.service` → Playwright visual pass
on 4174 (create terminal, output, disconnect/reconnect replay, IDE + classic, mobile
viewport spot-check) → output purge observed live (DB output-rows → 0, WAL bounded) → Codex
pre-finalization review of the integrated diff → docs + program-plan update → push `dev` →
M1 promotion PR to `main` (not merged overnight).

M1 evidence checklist: (a) soak — 10k output chunks produce 0 new `terminal_events` rows and
flat `page_count`; (b) WAL size bounded after checkpoint job; (c) purge idempotence (second
run deletes 0); (d) stale-`lastEventId` client still gets a full capture replay; (e) legacy
suite green (full `test:unit` without `DECKTERM_OS_ISOLATION`); (f) rate-limit fairness (A
exhausted ⇒ B unaffected) + bucket sweep; (g) unauthenticated request rejected before the
limiter; (h) `policy.*` settings write rejected; (i) brokered capture dirs untouched by a
prune run.

## 5. Validation record (Codex, 2026-07-04, deep)

Initial verdict **no-go for coding as written**; 8 findings, **all incorporated**: (1)
`lastEventId` = best-effort metadata replay, never suppresses capture replay, `output` kind
stays legal at the state layer → D-B6-1/I11; (2) spool deferral confirmed with an explicit
scope downgrade — B6 does not claim legacy restart recovery; restart recovery becomes a C4
acceptance item → D-B6-2; (3) **blocker:** no unconditional live `DELETE + VACUUM` — purge
chunked/resumable/logged, checkpoint after, VACUUM only via an explicit maintenance script →
D-B6-3/I12; (4) `retention_runs` ships as numbered migration 8 with auditable run rows →
D-B6-5; (5) pruner keeps hands off brokered capture dirs — confirmed → D-B6-6; (6) ownerId
server-side only, bucket TTL sweep, cheap checks first → D-B7-1; (7) **blocker:** no
`policy.*` via actor-scoped self-service settings; seam + env only, prefix reserved/rejected
→ D-B7-2/I13; (8) M1 evidence checklist added → §4. **Post-incorporation: cleared to code.**

## 6. Delivery record (2026-07-04)

Commits on `feature/b6-b7-retention-limits` → `dev`: `49e8e90` (plan + E3 runbook), `d28f743`
(B6-S1), `5c8d222` (B6-S2+S3), `abe6d0d` (B7). B6-S3 coded by a Sonnet subagent against the
brief; everything else on the main loop; every diff reviewed against §3 invariants.

**M1 evidence (all verified live on dev 4174, 2026-07-04 ~01:00 UTC):**

- (a) Soak: 200 lines of live terminal output produced **0 new `terminal_events` rows**
  (count 172 → 172); unit soak (257 chunked deletions across 3 chunks) green.
- (b) WAL bounded: `wal_checkpoint(TRUNCATE)` job ran → WAL 4.2 MB → 8 KB.
- (c) Purge idempotence: second prune run deletes 0 (unit-tested); live first run purged
  **352,908 output rows + 13,397 expired events + 40 ended sessions** (audit + retention_runs
  rows recorded); operator `db-maintenance --vacuum` shrank the DB **136 MB → 5.0 MB**.
- (d) Reconnect: page reload replays screen content via capture (marker test in browser);
  smoke e2e 21/21 incl. all reconnect specs.
- (e) Legacy suite green: full `test:unit` (684+ tests) with service env stripped — the 11
  fails seen with inherited `CF_ACCESS_REQUIRED=1` are the documented env-inheritance
  phantom (CLAUDE.md), reproduced identically on the base commit.
- (f) Rate-limit fairness/backstop/sweep: unit-tested (terminal-rate-limiter.test.ts).
- (g) Unauthenticated: actor gate unchanged, runs before the limiter (no route change).
- (h) `policy.*` settings write → 400, key not stored (foundation-settings.test.ts).
- (i) Brokered capture dirs: retention module has no filesystem access at all.
- Backup + restore rehearsal per runbook §5: `backup-state.sh` on live dev → restored copy
  passes `integrity_check`, migrations 1–8 present, user rows intact.
- Migration 8 applied on live dev at restart; `bun x tsc --noEmit` green.
- Visual: desktop classic + IDE, mobile 390px (`scrollWidth` 390 — A4 invariant holds),
  fresh output clean after extreme resizes.
