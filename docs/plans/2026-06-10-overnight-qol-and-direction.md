# Overnight QoL + Direction Execution Plan (2026-06-10)

> **For Claude:** Execute this plan using `superpowers:executing-plans` (manual, in-session). TDD per task, frequent commits, push to `dev` after each verified slice. **Never touch prod.**

**Goal:** Make DeckTerm a polished agent-aware dev cockpit: green test gate, dead code removed, daily-driver QoL features, task UX, file-editor MVP, and a prepared (not executed) prod CF Access hardening switch.

**Architecture:** Continue the established strangler pattern — pure logic in small extracted modules (`web/*.js` + `*.test.js`, `backend/services/*.ts` + `*.test.ts`), thin wiring in `app.js`/`server.ts`. No build step on the frontend; third-party editors/addons get vendored ESM bundles in `web/vendor/`.

**Tech Stack:** Bun + Hono + Bun.Terminal/tmux backend, vanilla JS + xterm.js, `bun:sqlite` foundation state, Playwright E2E against 4174.

## Direction decisions (confirmed with Lukáš 2026-06-10)

1. **Product direction:** agent-aware cockpit for one dev + trusted few. No multi-tenant, no per-user containers. Container isolation _for task runs_ is a possible later slice.
2. **Deploy safety:** prepare `cloudflare-tunnel` → `cloudflare-access` switch (server-side JWT validation). Verify what's verifiable on dev; prod flip is Lukáš's manual step via runbook.
3. **Refactor appetite:** medium — delete dead code, extract where features touch code anyway.
4. **Features:** QoL pack, task UX (overlay + kanban MVP + model picker, default `claude`), access preflight UI, file editor MVP (vendored CodeMirror 6).
5. **Ops overnight:** push small commits to `dev`, restart `deckterm-dev.service` freely, verify on 4174. No promotion to `main`. Morning report in chat.

## Execution order & rationale

| #   | Task                                           | Why this order                                              |
| --- | ---------------------------------------------- | ----------------------------------------------------------- |
| 1   | Fix red C2 test                                | Gate must be green before anything else ships               |
| 2   | Dead-code cleanup (OpenCode proxy, gateway.py) | Shrinks server.ts before touching it for features           |
| 3   | Scrollback search                              | Smallest QoL, establishes vendoring pattern for addons      |
| 4   | Palette providers (`@`, `$`)                   | Pure-frontend, reuses ActionRegistry                        |
| 5   | Reconnect exponential backoff                  | Small, completes reconnect-classify arc                     |
| 6   | Scrollback replay on attach                    | Needs investigation (tmux repaint vs terminal_events)       |
| 7   | Access preflight / explainable 403s            | Backend deny reasons exist; surface them                    |
| 8   | Task-status overlay                            | Foundation for kanban                                       |
| 9   | Kanban MVP + model picker                      | Design doc first, then MVP                                  |
| 10  | File editor MVP (CodeMirror 6)                 | Biggest; do after dailies are banked                        |
| 11  | CF Access runbook + dev verification           | Docs + config prep, low regression risk, do when tired-safe |
| 12  | Docs sync + morning report                     | Always last                                                 |

Each task: write failing test → verify fail → minimal implementation → verify pass → full `bun run test:unit` → commit → push → (UI tasks) Playwright/live verify on 4174 → restart service if backend changed.

---

### Task 1: Fix red C2 test (.env publish-mode leak)

**Files:** Modify `backend/foundation-c2.test.ts` (beforeAll).

- Bun auto-loads `.env`; `DECKTERM_PUBLISH_MODE=cloudflare-tunnel` makes actor resolution fall back to `tunnel_default`, skipping the `legacy_path_resolution` audit row C2-1 asserts.
- Fix exactly like commit `95efecb` did for C0: pin `process.env.DECKTERM_PUBLISH_MODE` to a non-tunnel mode (e.g. `local`) in `beforeAll` before importing `./server`.
- Verify: `bun test ./backend/foundation-c2.test.ts` → 3 pass; then full `bun run test:unit` → green.
- Commit: `fix(test): pin non-tunnel publish mode in foundation C2 test`.

### Task 2: Dead-code cleanup

**Files:** Modify `backend/server.ts` (OpenCode proxy routes), delete `gateway.py`; sweep `web/` for OpenCode UI references, `.env.example`, docs, `test-git-api.sh` (check if stale too).

- First map references: `grep -rn -i opencode backend/ web/ docs/ scripts/ tests/ package.json .env.example`.
- Remove proxy routes + related env plumbing (`OPENCODE_URL`, `OPENCODE_WEB_*` — check what's actually still load-bearing; `OPENCODE_WEB_MAX_TERMINALS` may be the real terminals limit var — **verify before deleting, rename only if safe and grandfathered**).
- Delete `gateway.py` after confirming nothing invokes it (`grep -rn gateway.py`).
- Full unit suite + smoke E2E green; restart dev service; `curl /api/health`.
- Commit: `refactor(server): remove legacy OpenCode proxy and gateway.py prototype`.

### Task 3: Scrollback search (Ctrl+Shift+F)

**Files:** Add `web/vendor/xterm-addon-search/` (vendored from `@xterm/addon-search`, matching vendored xterm version), create `web/search-overlay.js` + `web/search-overlay.test.js`, wire in `web/app.js` (TerminalManager + KEY handling), CSS in existing stylesheet.

- Pure module: overlay state machine (open/close, query, next/prev, match count) decoupled from xterm addon via an injected `searchApi`.
- TDD the state machine; integration = thin glue calling `addon.findNext/findPrevious`.
- Keybinding: Ctrl+Shift+F opens (must respect `isEditableTarget` pattern); Esc closes and returns focus to terminal.
- Playwright: open terminal, generate output, search, assert overlay + navigation.
- Commit: `feat(terminal): scrollback search overlay (Ctrl+Shift+F)`.

### Task 4: Palette providers (`@` sessions, `$` saved commands)

**Files:** Modify `web/action-registry.js`/`web/command-palette.js` (follow existing provider seams), create tests alongside; reuse `web/session-actions.js` for `@`.

- `@` → fuzzy list of sessions from catalog + local map, activate = same dispatch as sessions drawer (`focus/attach/open-here`).
- `$` → saved commands in `localStorage` (add via palette action "Save command…"), run = write into active terminal (respect write mode) or new terminal.
- TDD provider filtering/ranking and the saved-commands store as pure functions.
- Commit per provider.

### Task 5: Reconnect exponential backoff

**Files:** Create `web/reconnect-backoff.js` + test; wire into `ReconnectingWebSocket` in `app.js`; overlay countdown text.

- Pure `nextBackoffDelay(attempt, {base=1000, cap=30000})` → 1s,2s,4s,…,30s with small jitter.
- Keep: classify on 3rd attempt, max attempts, `setup_required` overlay behavior.
- Commit: `feat(reconnect): exponential backoff with countdown`.

### Task 6: Scrollback replay on attach

**Files:** Investigate first — `backend/services/tmux-terminal-backend.ts`, `terminal_events` usage in `server.ts`, `lastEventId` cursor flow.

- Hypothesis: tmux attach already repaints visible screen, but full scrollback + raw backend sessions are blank. Determine actual gap on 4174 before coding.
- Prefer smallest correct fix: on WS attach send buffered recent output (`terminal_events` replay from cursor, or `tmux capture-pane -p -S -200` once) as plain output before live stream; document choice in commit.
- Guard payload size; test at backend level (unit on replay assembly) + live verify reload behavior.
- Commit: `feat(terminal): replay recent scrollback on attach`.

### Task 7: Access preflight / explainable 403s

**Files:** Inspect `requireFileAccess()` in `server.ts` for existing deny payload shape; create `web/access-denied.js` + test (formatter: root, capability, reason, CTA); wire file explorer + git panel error paths.

- Backend: ensure 403 responses carry `{reason, capability, root}` JSON (add if missing — small, audited change).
- Frontend: replace generic alerts with informative inline panel + "Open Setup" CTA (reuse `setup_required` overlay pattern).
- Commit: `feat(access): explainable denials for file/git actions`.

### Task 8: Task-status overlay

**Files:** `backend/task-runner.ts` (emit status transitions), `server.ts` (WS/event broadcast — check existing channel), `web/` small module + wiring for badge/overlay.

- Reuse `handleTerminalExit`/status sync; broadcast `{type:"task-status", taskId, status, durationMs, exitCode?}`.
- UI: compact indicator in sessions drawer/header; click → task detail.
- TDD event assembly backend-side; frontend formatter pure-tested.
- Commit: `feat(tasks): live task-status events + UI badge`.

### Task 9: Kanban MVP + model picker

**Files:** Create `docs/plans/2026-06-10-task-kanban-design.md` first; then `web/task-board.js` + test, wiring in app.js; `task-runner.ts`/`server.ts` for provider/model picker param (default `claude`).

- Columns = existing statuses (`draft? / worker-running / judge-running / checks-running / needs-user / done` — confirm actual set from task-runner.ts).
- MVP: read-only board + card actions reusing existing task actions; no drag-n-drop unless trivial.
- Picker: provider+model select at task create; persists per task; default claude (codex has no credits).
- Commit(s): design doc, then `feat(tasks): kanban board MVP + provider/model picker`.

### Task 10: File editor MVP

**Files:** Vendor CodeMirror 6 bundle → `web/vendor/codemirror/`; backend `GET /api/files/content` (check existing read endpoint) + `PUT /api/files/content` behind `requireFileAccess` with audit + size limit + atomic write (tmp+rename); `web/file-editor.js` + test; file-explorer wiring (open on click for text files).

- Short design doc section inside this plan suffices? **No** — repo convention wants a pair; write `docs/plans/2026-06-10-file-editor-design.md` (concise).
- Safety: refuse files > ~2 MB, detect binary, conflict guard (If-Match style mtime/hash check).
- TDD backend endpoint (one foundation-bearing test file, chained invocation pattern in `package.json` if needed) + pure frontend logic; Playwright open-edit-save roundtrip.
- Commit(s): vendoring, backend endpoint, UI.

### Task 11: CF Access switch — dev verification + prod runbook

**Files:** Create `docs/plans/2026-06-10-cloudflare-access-runbook.md`; possibly `.env.example` comments; no prod changes.

- Verify on dev what's verifiable without real CF secrets: doctor profile `cloudflare-access`, guard behavior with missing/invalid JWT (unit tests exist in `cloudflare-access-guards.ts` — extend if gaps).
- Runbook: exact env diff (`DECKTERM_PUBLISH_MODE=cloudflare-access`, `CF_ACCESS_TEAM_NAME`, `CF_ACCESS_AUD`, `CF_ACCESS_REQUIRED=1`), where to find values in CF dashboard, bootstrap/admin implications (first-admin via `DECKTERM_BOOTSTRAP_ADMIN_EMAIL`), verification steps (gated action live per memory), rollback (revert env + restart).
- Commit: `docs: cloudflare-access switch runbook + dev verification notes`.

### Task 12: Docs sync + morning report

- Update `CLAUDE.md`, `docs/deckterm-development-overview.md`, backlog doc with the night's outcomes.
- Final chat report: done/pushed/verified, awaiting-user items, risks.

## Quality gates (every task)

1. `bun run test:unit` green (and new test files added to `package.json` `test:unit` script — chained invocation for foundation-bearing tests).
2. Backend changes → `systemctl --user restart deckterm-dev.service` + `curl http://localhost:4174/api/health`.
3. UI changes → Playwright smoke or targeted spec against 4174.
4. Commit + push to `dev` per verified slice.
