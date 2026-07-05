# Traycer Patterns — Implementation Plan (tiered delivery)

Date: 2026-07-04 · Design: `2026-07-04-traycer-patterns-design.md` (v3) · Status: **IMPLEMENTED 2026-07-05** (all phases; S9 spike PASSED on tmux backend — see design doc §D3; per-slice Codex on S6/S7 + integrated passes after Phase 2 and Phase 3, all findings fixed)

Execution mode: **tiered delivery, Path A (sequential)** — multiple slices touch
`server.ts`/`task-runner.ts`, so slices dispatch one at a time; the orchestrator (Opus main
loop) reviews every real diff against the slice's checklist. Codex cadence: plan validation
(2 passes done) → per-slice Codex on S6+S7 (security profile) → one integrated Codex pass
after Phase 2 → a separate one after Phase 3 (if the S9 spike passes).

Branch: `feature/traycer-patterns` → `dev`. Gates per slice: `bun run test:unit`,
`bun x tsc --noEmit`. New test files must be added to the `test:unit` script; none of these
tests should touch foundation state (keep it that way — singleton rules in `CLAUDE.md`).

## Phase 0 — parity snapshots (prerequisite, main loop, low)

Golden tests capturing TODAY's behavior, committed before any refactor:

- `buildWorkerCommand`/`buildJudgeCommand` output strings for claude+codex, incl. task
  dirs containing spaces/quotes/`$`.
- `handleTerminalExit` behavior matrix: worker exit on `worker-running`, judge exit on
  `judge-running`, exits in other statuses, unknown terminal ids.

## Phase 1 — Harness registry

### S1 — registry module + tests · **Sonnet, medium**

- **Files (allowlist):** `backend/services/agent-harnesses.ts` (new),
  `backend/services/agent-harnesses.test.ts` (new), `package.json` (add to `test:unit`).
- **Read first:** `backend/task-runner.ts:12,132-142,331-362`, `backend/telemetry.ts:93-105`.
- **Interface:**
  `AgentHarness { id: string; label: string; binary: string; enabled: boolean; buildPromptCommand(promptFile: string): string; detectPattern: RegExp }`;
  `listAgentHarnesses()` (claude, codex enabled; opencode, gemini `enabled: false`);
  `getAgentHarness(id)` → enabled only, null otherwise;
  `probeHarnessAvailability(harness, deps?)` — `Bun.which(binary)` (injectable), then
  fixed-argv `[binary, "--version"]` spawn, 3 s timeout, stdout capped 4 KB →
  `{ available, version, error }`; never probes disabled harnesses;
  `listHarnessSummaries(deps?)` with a module-level 60 s probe cache.
- **Invariants:** `buildPromptCommand` for claude/codex returns exactly
  `` `${id} "$(cat ${shellQuote(file)})"` `` (copy `shellQuote` from
  `task-runner.ts:331-333`); **no shell-string construction anywhere in the probe**.
- **Tests:** `[unavailable: err]` summaries; probe timeout → unavailable; cache TTL;
  disabled harness invisible + unprobed.
- **Non-goals:** no task-runner/server edits; no model listing.

### S2 — task-runner delegates to registry · **main loop** (byte-identical invariant)

- **Files:** `backend/task-runner.ts`, task-runner tests.
- `normalizeProvider` validates via `getAgentHarness` ∩ `allowedProviders` (unknown AND
  disabled → 400); `buildPromptCommand` delegates to the harness. Phase 0 golden tests
  pass unchanged.

### S3 — `GET /api/harnesses` · **main loop** (server.ts chokepoint)

- **Files:** `backend/server.ts`.
- Same auth shape as `GET /api/tasks` (`getCurrentUser`); returns
  `{ harnesses: [{ id, label, available, version, error }] }` — **enabled only**.

### S4 — task form availability · **Sonnet, medium**

- **Files (allowlist):** `web/app.js` (task modal wiring only), `web/index.html`
  (`#task-worker-provider`, `#task-judge-provider`), `web/tasks-view.js` if it renders
  provider labels.
- On task-modal open, fetch `/api/harnesses`; rebuild both selects; unavailable →
  `disabled` + `(unavailable)` suffix; default stays claude. Fetch failure → keep today's
  hardcoded options. `textContent` rendering only.

## Phase 2 — Task messages (A2A worker↔judge)

### S5 — safe file IO + task-messages module + tests · **Sonnet, medium→high**

- **Files (allowlist):** `backend/task-file-io.ts` (new), `backend/task-messages.ts` (new),
  their test files (new), `package.json`.
- **Read first:** `backend/task-runner.ts:232-263`, `backend/telemetry.ts:89-113`.
- **`task-file-io.ts` (D0 — the single primitive S6/S7 also use):**
  `readTaskFileSafe(path, { maxBytes })` — `fs.openSync(path, O_RDONLY | O_NOFOLLOW)`,
  `fstat` the fd, require regular file, enforce `maxBytes` from the fstat, read via the fd,
  always close; null on any violation.
  `appendTaskFileSafe(path, data)` — `O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW`, fstat
  regular-file check, write via fd.
  `writeTaskFileAtomic(path, data)` — fd-safe (Codex v3): open parent dir
  `O_RDONLY | O_DIRECTORY | O_NOFOLLOW` (rejects a swapped-in symlink dir), create temp
  `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`, `fstat` fd → regular file + `nlink === 1`,
  write+fsync via fd, `rename` into place.
  Tests: symlinked target → null/throw, symlinked parent dir → throw, FIFO → rejected
  (use `mkfifo` guarded by platform check), oversized → null, happy path.
- **`task-messages.ts`:**
  `sanitizeMessageBody(raw)` — strip ESC/C0/C1/DEL, cap 8 KB — applied **at creation**;
  the canonical form is the only thing stored.
  Events `message-created { id, from: "user" | "judge" | "system", to, body, at }`,
  `message-delivered { id, at, terminalId }`, `message-delivery-failed { id, at, reason }`;
  `appendTaskMessageEvent` (via `appendTaskFileSafe`) / `readTaskMessages` → folded
  `TaskMessage[]` with `delivery: "pending" | "delivered" | "failed"`, tolerant of
  malformed lines;
  `renderInboxFile(msg)` → markdown body for `<taskDir>/inbox/<msgId>.md`;
  `buildPointerLine(from, inboxPath)` → `` ` # deckterm task message from <from> — read: cat '<path>'\n` ``
  (leading space, `#`, single-quoted server-built path — the ONLY thing ever written to a
  PTY);
  `readVerdictFile(taskDir, round)` — reads `verdict-r<round>.json` via `readTaskFileSafe`
  (64 KB), strict schema `{ round, verdict: "PASS" | "NEEDS_WORK" | "BLOCKED", summary? }`,
  null on round mismatch or anything off;
  `renderWorkerPrompt({ task, feedback, round })` (feedback capped 16 KB, sectioned).
- **Tests:** sanitization/caps; folding incl. failed+re-created; verdict round mismatch →
  null; symlinked verdict → null; pointer line contains no unquoted metacharacters.

### S6 — verdict → task lifecycle · **main loop, xhigh · per-slice Codex (security)**

- **Files:** `backend/task-runner.ts`, `backend/server.ts` (agent-done parse site ~524–570
  and exit hook site ~3880), tests.
- `TaskRecord` gains `round: number`, `processedVerdictAtRound: number | null`
  (absent → `0`/`null` on load).
- `handleJudgeCompletion(ownerId, terminalId)` under a **per-task promise-chain mutex**,
  with the **exact D4 ordering**: snapshot `judgedRound = task.round`; bail if already
  processed; read `verdict-r<judgedRound>.json`; apply transitions; mark
  `processedVerdictAtRound = judgedRound`; only then `round = judgedRound + 1` on
  NEEDS_WORK-continue. NEEDS_WORK also appends the internal `from: "judge"` system message
  with the summary.
- **Triggers:** shell-integration `agent-done` accepted only as the running→done edge
  whose `agentName` matches the task's `judgeProvider` on the recorded `judgeTerminalId`;
  `handleTerminalExit` as fallback. Idempotency makes double-fire safe; Phase 0 exit
  matrix passes unchanged for tasks without verdict files.
- `renderJudgePromptFile`: renders the absolute `verdict-r<round>.json` path + exact
  schema (incl. the round number) as the judge's mandatory final step.
- `buildWorkerCommand`: round 0 byte-identical to today; round > 0 same shape over
  `WORKER_PROMPT.md`.
- **Review checklist:** D4 ordering (mark-then-increment); idempotency under
  agent-done + exit double-fire; mutex covers start/exit/verdict/message; provider-matched
  edge only; no transition for non-judge terminals; all agent-file reads via task-file-io;
  round-0 parity.

### S7 — message routes + pointer-only injection · **main loop, xhigh · per-slice Codex (security)**

- **Files:** `backend/server.ts`.
- `GET /api/tasks/:id/messages` — auth shape of existing task-id routes → folded list.
- `POST /api/tasks/:id/messages` `{ to, body }`: ownership + `denyIfOsIsolationUnsupported`;
  `from` is always `"user"` (judge messages are internal, S6); sanitize+cap at creation;
  append `message-created`; write inbox file (atomic); **deliver only if** the
  task-recorded target terminal is live, owner-matched, and live telemetry shows the
  expected agent running — then `terminal.write(buildPointerLine(...))` +
  `message-delivered`, else `message-delivery-failed { reason }`. Audit row per design
  invariant 3. Bodies NEVER written to the PTY.
- **Acceptance incl. TUI smoke test:** pointer line lands as plain input in Claude Code
  TUI (leading space must dodge the `#` memory shortcut — verify) and Codex TUI, and is a
  no-op comment on bash/zsh/fish prompts.
- **Review checklist:** target provenance (task record only); agent-running gate reads
  live state; pointer-only invariant (grep the diff for any other `terminal.write` of
  message content); audit fields complete; 404/403 semantics match existing task routes.

### S8 — messages UI · **Sonnet, medium**

- **Files (allowlist):** `web/tasks-view.js`, `web/tasks-view.test.js`, `web/app.js`
  (task detail wiring), `web/index.html` (detail panel markup).
- Message timeline in the task detail (from/at/body, delivery-state badge) + compose box
  posting to S7; re-render on the existing task poll; `textContent` only. Follow the
  render-signature pattern in `tasks-view.js:114-135`.

## Phase 3 — Structured telemetry (gated by S9)

### S9 — spike: hook → /dev/tty → parser · **main loop, timeboxed 1 h**

- Test a Claude Code PreToolUse hook writing `\x1b]9;9;deckterm;tool;Bash;<b64>\x07` to
  `/dev/tty`: (a) raw backend, (b) tmux backend via the `pipe-pane` capture path on 4174.
  Record: BEL vs ST terminators, chunk fragmentation, controlling-tty availability inside
  hooks, tmux options needed. **Fail → stop Phase 3**, write findings into the design doc,
  add the HTTP-ingest fallback to the OK backlog.

### S10 — parser + summary port · **Sonnet, medium** (after S9 pass)

- **Files (allowlist):** `backend/telemetry.ts`, its co-located test file,
  `THIRD_PARTY_NOTICES.md` (new), `package.json` if a new test file.
- Extend `parseShellIntegrationChunk`: `tool;<name>;<b64>` → event
  `{ type: "tool-used", name, summary }`; name must match `/^[A-Za-z][\w.-]{0,63}$/`;
  payload capped BEFORE base64 decode (2 KB); decoded summary through the ported
  `toSummaryLine` (single line, 80-char cap, Apache 2.0 attribution); malformed → today's
  pass-through. Existing tests stay green; markerless streams byte-identical.

### S11 — ring buffer + API + badge tooltip · **main loop (server) + Sonnet (web)**

- Server: per-terminal ring buffer (last 50 tool events, per-terminal rate limit ~20/s
  drop-oldest) fed from the parse site; exposed as `recentTools` in terminal telemetry.
  Display-only: never feeds task transitions or authz.
- Web (Sonnet, allowlist: badge/tooltip region of `web/app.js` + test): tooltip/activity
  strip with last few `name · summary` lines, `textContent` only.
- Hook emitter `scripts/deckterm-agent-hook.sh` + README opt-in snippet (Sonnet, low).

## Integration & finalization

1. Merge slices sequentially on the feature branch; after each phase run full
   `bun run test:unit` + `bun x tsc --noEmit` + e2e smoke if the terminal surface was
   touched (from a NON-DeckTerm-hosted shell — resetAppState kills host sessions).
2. Integrated Codex pass after Phase 2 (mandatory — cross-slice security), again after
   Phase 3. Fix findings before `dev` merge; validate on 4174 before any `main` promotion.
3. Update OK docs (development plan/log) at session end via `/ok-project-sync`.
