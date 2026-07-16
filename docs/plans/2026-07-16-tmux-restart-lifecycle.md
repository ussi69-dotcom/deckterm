# Tmux Restart Lifecycle Fix — Implementation Plan

> **For Claude:** Execute this plan task-by-task with TDD (`superpowers:executing-plans` style). P1 from the backlog ("Restart/session lifecycle — P1 before next promotion", discovered 2026-07-13 during release `a006ae6`).

**Goal:** A service SIGTERM/SIGINT must never persist `status=ended` for a still-live tmux session; shutdown becomes deterministic and idempotent, and startup reconciliation remains the single source of truth for session liveness in tmux mode.

**Architecture:** Add a module-level shutdown latch in `backend/server.ts`. The signal handlers call one idempotent `shutdownGracefully()` that (1) sets the latch first, (2) closes WebSockets *without* an `exit` message so clients auto-reconnect, (3) marks sessions ended **synchronously and only in raw mode** (`TMUX_BACKEND` off — those PTYs die with the process), (4) kills only the attach/PTY subprocesses (tmux server survives via state-dir socket + `KillMode=process`), then exits. `closeAndRemoveTerminal` early-returns behind the latch, eliminating the timing-dependent async `markTerminalSessionEnded` write that caused the incident. In tmux mode nothing is written at shutdown: `reconcileSessionsOnStartup` already handles every case at next boot (session exists → recover; missing → ended; OS isolation → end-all + broker reap).

**Tech Stack:** Bun, `bun:sqlite`, tmux, `bun:test` subprocess integration tests (template: `backend/startup-failure.test.ts`).

**Why this shape (design decisions):**
- *No DB write at shutdown in tmux mode* — the truth about tmux liveness is only knowable at next startup; writing "ended" at shutdown is exactly the bug. Reconcile/recover paths (`server.ts:843`, `server.ts:926`) already cover exists/missing/isolation deterministically, with audit.
- *Raw mode writes synchronously in the handler* — the current async `.then()` write is racy against `process.exit(0)`; raw PTYs genuinely die, and nothing reconciles raw rows at startup (`reconcileSessionsOnStartup` returns 0 when `!TMUX_BACKEND`), so the handler must do it, synchronously (`markTerminalSessionEnded` is sync sqlite; foundation state is awaited once in `startWebServer` scope before handler registration).
- *No `{type:"exit"}` WS message at shutdown* — that tells clients the terminal died; a plain close lets `ReconnectingWebSocket` reconnect into the recovered session after restart.
- *Latch guards `closeAndRemoveTerminal` entirely* — killed attach clients may fire `onExit` before exit; behind the latch it must not write DB, not `notifyTerminalExit` (task-runner verdict fallback must not trigger on deploy), not double-close sockets.
- Explicit user delete, idle reap, revocation, and genuine tmux exit keep their existing paths untouched (they run only pre-latch).

**Acceptance (from backlog):** deterministic restart test with ≥3 sessions (attached, detached, active-output): unchanged tmux `session_created` + pane PID, DB rows stay `active`, catalog recovery on restart, WS reattach works, no duplicate terminals; failure-path test proving a truly missing tmux session still reconciles to `ended`; raw-mode rows end deterministically.

---

### Task 1: Failing integration tests — `backend/shutdown-lifecycle.test.ts`

**Files:**
- Create: `backend/shutdown-lifecycle.test.ts`
- Modify: `package.json` (`test:unit` main batch — the test spawns child server processes and never touches the in-process foundation singleton, so it belongs in the main list like `startup-failure.test.ts`)

**Step 1: Write the test file.** Reuse the `startup-failure.test.ts` fixtures (`getFreePort`, temp state dir under `$HOME`, child tracking + afterEach cleanup). Child env: `TMUX_BACKEND=1`, `DECKTERM_STATE_DIR=<tmp>`, `ALLOWED_FILE_ROOTS=<tmp-work>`, `DECKTERM_LEGACY_NO_BOOTSTRAP=1`, `DECKTERM_RUNTIME_ENV=development`, `CF_ACCESS_REQUIRED=0`, fixed free `PORT` (tmux socket = `<tmp>/tmux/deckterm_p<port>.sock`, namespace `p<port>` — fully isolated from dev/prod). Helper `tmuxQuery(sock, args)` shells out to `tmux -S`.

Test A — **SIGTERM preserves live tmux sessions (the incident)**:
1. Spawn server, poll `/api/health`.
2. Create 3 terminals via `POST /api/terminals` (cwd = tmp work root).
3. Shape them: #1 attach a WS (`/ws/terminals/:id`) and keep it open; #2 stays detached; #3 gets `{type:"input"}` starting a short output loop (active output).
4. Snapshot `tmux list-sessions -F '#{session_name} #{session_created}'` + pane PIDs (`#{pane_pid}`).
5. `child.kill("SIGTERM")`; await exit; expect code 0 and the WS to close *without* receiving `{type:"exit"}`.
6. Assert all 3 tmux sessions still exist with identical `session_created` and `pane_pid`; open the sqlite file readonly → all 3 `terminal_sessions` rows `status='active'`.
7. Restart (same port/state dir), poll health; `GET /api/terminals` → exactly the same 3 ids, no duplicates; re-attach WS to #1 → `ping`→`pong` round-trip works.

Test B — **missing tmux session still reconciles to ended**: after the SIGTERM stop, `tmux -S <sock> kill-session -t deckterm_p<port>_<id2>`; restart; `GET /api/terminals` shows #1/#3 active, and the DB row for #2 is `ended`.

Test C — **raw mode ends deterministically**: `TMUX_BACKEND=0`, create 2 terminals, SIGTERM, expect exit 0 and both DB rows `ended` (no zombie `active` rows — raw mode has no startup reconcile).

**Step 2: Run** `bun test ./backend/shutdown-lifecycle.test.ts`. Expected: Test A/B fail on current code (rows flip to `ended` and/or recovery misses sessions; the race may make it flaky-red — run 3× to observe). Test C may fail today too (async write can miss the exit).

**Step 3: Commit** the red tests? No — this repo's convention is test+fix in one commit per slice; keep them staged.

### Task 2: Implementation in `backend/server.ts`

**Files:**
- Modify: `backend/server.ts` — module scope near `closeTerminalSockets` (~4191), `closeAndRemoveTerminal` (~4779), signal handlers (~10251–10267)

**Step 1: Latch + guard.** Module scope:
```ts
let shutdownInProgress = false;
```
In `closeAndRemoveTerminal` (inside `createManagedTerminal`): first line
```ts
if (shutdownInProgress) return;
```

**Step 2: One idempotent shutdown routine** registered from `startWebServer` (which awaits `getFoundationState()` into scope before registering, so the DB write is synchronous):
```ts
const shutdownGracefully = (signal: string) => {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  console.log(`[shutdown] ${signal}: detaching ${terminals.size} terminal(s) (tmux=${TMUX_BACKEND ? "preserve" : "end"})`);
  for (const term of terminals.values()) {
    try { closeTerminalSockets(term.id); } catch {}
    if (!TMUX_BACKEND) {
      try { markTerminalSessionEnded(foundationState.db, term.id); } catch {}
    }
    try { term.proc.kill(); } catch {}
  }
  process.exit(0);
};
process.on("SIGINT", () => shutdownGracefully("SIGINT"));
process.on("SIGTERM", () => shutdownGracefully("SIGTERM"));
```
(Replaces both existing handlers. No WS `exit` payload; tmux attach clients are killed → detach only.)

**Step 3: Run the new tests** → green, 3× in a row (race regression check).

**Step 4: Full gates.** `bun run test:unit` (all green, incl. the new file in the main batch), `bun x tsc --noEmit`.

**Step 5: Commit** `fix(lifecycle): preserve live tmux sessions across service shutdown` (tests + impl + package.json).

### Task 3: Live verification on dev (4174)

1. `GET /api/terminals` snapshot + `tmux -S ~/.deckterm-dev/tmux/deckterm_*.sock list-sessions` before.
2. Deploy the fix: `systemctl --user restart deckterm-dev.service` (this restart itself still runs the OLD code's handler — the fix takes effect for subsequent restarts; restart twice and verify the second one preserves sessions + rows, `journalctl` shows the new `[shutdown]` line).
3. Verify: same tmux `session_created`/pane PIDs, `/api/terminals` catalog identical, no `ended` flips in the DB, web client reconnects (WS log `reconnect: true`).

### Task 4: Independent review + ship

1. `~/.claude/bin/codex-caller review` over the diff (advisor tool is down for this session); fix real findings.
2. Push to `dev`; update OK KB (session-end sync: agent memory delta, development-log milestone, plan "Now" section, backlog item resolution).

---

## Delivery record (2026-07-16)

Commits on `dev`: `f2e223a` (fix + tests + CI tmux install) + the review-fix follow-up. All 5 tests green 3× in a row; full `test:unit` rc=0; `tsc --noEmit` clean. Live-verified on 4174: double restart, owner's real session survived both with identical `session_created` + pane PID `419614`, DB row stayed `active`, journal shows `[shutdown] SIGTERM: detaching 1 terminal(s) (tmux sessions preserved)`.

**Deviation from Task 1 as written:** on this harness the pre-fix SIGTERM race never fired (the async `.then()` writes *never* land before `process.exit`, so tests A/B passed pre-fix and act as regression guards); the deterministic RED driver was raw mode (test C). Also discovered: merely *deleting* env vars in the child is not isolation — the child's `bun run` auto-loads the repo `.env` (namespace initially came back as `deckterm`); the harness now sets explicit values for `TMUX_SESSION_NAMESPACE`, `DECKTERM_PUBLISH_MODE`, `DECKTERM_OS_ISOLATION`.

**Codex review — pass 1 (commit `f2e223a`), 4 findings, all addressed:** (1) silent `catch {}` on the raw-mode ended write → now logged (exit stays 0: a deliberate stop must not flag the unit failed; raw startup reconcile is the backstop); (2) tmux-mode rows stranded `active` forever after a switch to raw mode → `reconcileSessionsOnStartup` now runs in raw mode too and ends every active row; (3) test env deletions repopulated by `.env` → explicit values; (4) `tmuxQuery` swallowed failures (two empty pane maps compare equal) → throws on non-zero exit.

**Incident during delivery (caught + root-caused + fixed):** right after the review fixes landed, the dev instance's live session row flipped to `ended` at 14:13:38 while its tmux session (and the in-memory terminal) stayed alive. Sentinel-state-dir bisection pinned it to `backend/startup-failure.test.ts`: five of its child-server spawns passed only `...process.env` without `DECKTERM_STATE_DIR`, and the child's `bun run` auto-loads the repo `.env` — so those children booted **against the real dev state dir**. Pre-fix that was a silent isolation hole (raw-mode reconcile was a no-op); the new raw-mode reconcile turned it into actual damage (child ended every active row in the dev DB). Fixes: (a) every spawned child in `startup-failure.test.ts` now gets an isolated temp `DECKTERM_STATE_DIR`; (b) defense in depth — `startWebServer` now probes its port BEFORE touching recorded sessions, so a second same-port instance fails with EADDRINUSE without writing to a live instance's DB. Verified: full `test:unit` against a seeded sentinel state dir leaves the sentinel row `active` (pre-fix it flipped), rc=0. The dev session row was conditionally reactivated (tmux session + pane PID verified alive) and recovered. This is a live demonstration of Codex pass-2 finding #2 — the residual (different-port process sharing a state dir) still needs the backlogged instance-ownership lock.

**Codex review — pass 2 (follow-up diff), dispositions:** (1-High) raw reconcile also ends rows of still-live tmux shells after a tmux→raw switch — **accepted as policy**: the raw backend cannot attach them, an "active" catalog row no surface can reach is a lie (same end-don't-adopt stance as the B2 isolation branch); shells are not killed; flip-flopping back to tmux does not auto-recover ended rows (never a supported flow). Pinned by a dedicated test. (2-High) a second process on the same state dir could reconcile-end a live instance's rows — **pre-existing exposure** (tmux reconcile since C1b, B2 end-all), needs an instance lock / ownership design → backlogged. (3-Med) one bad row aborted the reconcile loop → per-row try/catch. (4) tmux→raw switch test gap → added (test 5).
