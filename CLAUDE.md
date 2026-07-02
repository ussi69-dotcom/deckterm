# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What DeckTerm Is

Browser-based terminal workspace for long-running remote dev sessions: persistent tmux-backed shells, a floating/tiling window manager, mobile-first controls, a file explorer + git panel scoped to allowed roots, agent-aware status badges, and a supervised task runner. It is a powerful host-shell/filesystem tool, so most recent work is **security foundation** (below), not new terminal features.

**Stack:** Bun runtime (needs `Bun.Terminal` PTY API) · Hono (routing/CORS) + native Bun WebSocket backend · vanilla JS + xterm.js frontend · `bun:sqlite` for foundation state · tmux for session persistence. Only runtime deps: `hono`, `@hono/cloudflare-access`.

## Environment & Critical Rules

- **Dev** (all work happens here): `/home/deploy/deckterm_dev`, branch `dev`, port **4174**, service `deckterm-dev.service` (user systemd). The unit sets `DECKTERM_STATE_DIR=~/.deckterm-dev` and `DECKTERM_LEGACY_NO_BOOTSTRAP=1` — dev foundation state is isolated from prod's `~/.deckterm`.
- **Prod:** port 4173, release symlink under `/home/deploy/apps/deckterm/prod/current`, service `deckterm.service`, state dir `~/.deckterm`.
- **ALL tests run against 4174, never 4173.** Playwright `baseURL` / `PW_BASE_URL` = `http://localhost:4174`. Backend default port is 4174 (`backend/index.ts`).
- Prod no longer runs from a live checkout — `main` deploys via GitHub Actions (`.github/workflows/deploy-main.yml`). After "push to main", verify the `Deploy Main` workflow succeeded before claiming prod is updated. Don't manually deploy prod unless explicitly asked.

```bash
systemctl --user restart deckterm-dev.service   # restart · journalctl --user -u deckterm-dev.service -f for logs
curl http://localhost:4174/api/health
```

## Commands

```bash
bun install
bun run dev                                          # DECKTERM_RUNTIME_ENV=development, serves on 4174
bun run test:unit                                    # Bun test runner — the canonical correctness gate
bun test ./backend/foundation-c1.test.ts -t "name"   # single file / single test
bun run test:e2e:smoke                               # Playwright; bun run test:e2e for full suite, test:all for both
cd tests && PW_BASE_URL=http://localhost:4174 npx playwright test some.spec.ts
```

- `tsc --noEmit` currently **fails on clean HEAD** (pre-existing errors) — do not rely on it; tests are the gate.
- `test:unit` lists every unit-test file explicitly. New `*.test.ts`/`*.test.js` must be added to that script in `package.json` or CI skips it. Foundation-bearing API tests (`foundation-c2`, `foundation-bootstrap`, `foundation-tunnel`) run as **separate chained `bun test` invocations** in that script because of the foundation-state singleton — keep that structure when adding similar tests.

## Architecture

**Backend (`backend/`)**

- `index.ts` — thin entry, calls `startWebServer(host, port)`.
- `server.ts` — **~5.3k lines, the entire HTTP/WS surface.** Seams: `createWebApp()` (Hono routes), `startWebServer()` (`Bun.serve` + WS handlers), `reconcileSessionsOnStartup()`. All terminal/file/git/task/onboarding routes live here.
- `task-runner.ts` — supervised Codex/Claude task workspaces (worker/judge terminals, checks, optional git worktrees).
- `telemetry.ts` — agent output-phase classification, tmux state, shell-integration parsing, worktree detection (powers agent badges).
- `onboarding-doctor.ts` — Setup wizard: profiles, health checks, `applyOnboardingRemediation()`.
- Helpers with co-located `*.test.ts`: `cloudflare-access-guards.ts`, `terminal-capabilities.ts`, `tmux-*.ts`.

**Terminal backend abstraction (`backend/services/`)** — `TerminalBackend` interface with two impls: `raw-terminal-backend.ts` (direct `Bun.Terminal` PTY) and `tmux-terminal-backend.ts` (persistence that survives reconnects/restarts; enabled via `TMUX_BACKEND=1`, default in deployed envs). The tmux socket is **state-dir scoped** (`$DECKTERM_STATE_DIR/tmux/deckterm_<ns>.sock`, commit 2618203) — dev and prod must never share one tmux server — and persistence across service restarts requires `KillMode=process` in the systemd unit (both dev and prod have it as of 2026-06-20, verified via `systemctl --user cat deckterm.service`; see `docs/plans/2026-06-12-cloudflare-access-switch-runbook.md`).

**Foundation security layer (dominant recent work).** Commits labeled **C0 / C1 / C1b / C2** are security "foundation" slices (rationale: `docs/plans/2026-05-12-deckterm-foundation-decisions.md`). Principle: strengthen the working product with small mergeable security slices, don't rewrite.

- `services/foundation-state.ts` — `bun:sqlite` DB with numbered migrations, bootstrap status (env-admin or one-time token), allowed roots, scoped capability grants (`terminal.create/attach/write/manage`, `root.use`), recorded sessions + events sequence log, audit rows.
- `services/foundation-authorization.ts` — `authorizeTerminalSessionAccess()`, route-capability resolution, legacy-bypass logic.
- `services/foundation-actors.ts` — actor resolution: `cloudflare_access` / `cloudflare_tunnel` (edge-authenticated, `DECKTERM_PUBLISH_MODE=cloudflare-tunnel`) / `tunnel_default` / `legacy_dev`.
- **Auth flow:** host-access endpoints (terminal/file/git/task) resolve actor → map path/resource to an allowed root → require a capability grant, writing allow/deny audit rows. Shared `requireFileAccess()` gate in `server.ts` enforces this for file/git.
- **Gotchas:** `foundationStatePromise` is a **module-level singleton** (one foundation state per process — API tests keep to one foundation-bearing test per file, see `task-api.test.ts`). `DECKTERM_LEGACY_NO_BOOTSTRAP=1` bypasses bootstrap but only in CI/test/dev — preserve it; it's the migration path.

**Frontend (`web/`, no build step — served static)** — `app.js` is **~12k lines, mostly one file**: `TileManager` (floating/tiling WM), `TerminalManager` (lifecycle), `ReconnectingWebSocket` (heartbeat reconnect + exponential backoff + reconnect classification), `ExtraKeysManager` (mobile keys), `KEY_SEQUENCES`. Extracted modules with `*.test.js`: `action-registry`, `command-palette`, `palette-providers` (`@` sessions / `$` saved commands), `navigation-surface`, `file-explorer`, `file-editor` (CodeMirror 6 modal), `surface-windows` (movable/snappable windows for Files/Git/Tasks/Editor on desktop + sessions bottom dock; mobile keeps sheets), `settings-store` (client for `/api/settings`, localStorage fallback), `search-overlay` (Ctrl+Shift+F scrollback search), `task-signals` (toolbar badge + toasts), `task-board` (kanban view), `access-denied` (explainable 403s), `terminal-colors`, `terminal-sizing`, `bootstrap-routing`, `input-fallback`, `git-error`, `session-actions`, `reconnect-classify`.

**VS Code-grade workspace (in progress).** Umbrella design `docs/plans/2026-06-12-vscode-grade-workspace-design.md`, four phases. Phase 1 (done): surface windows + bottom dock + actor-scoped settings KV (`user_settings` table, migration 4, `GET/PUT /api/settings`). Phases 2–4 planned: VS Code-grade git panel (`@codemirror/merge` diffs, push/pull/discard/stash), explorer⇄git decorations + per-file timeline, settings UI. **Don't modify `vendor/`** (xterm.js + addons; `vendor/codemirror.js` is regenerated via `scripts/build-codemirror-vendor.js`, never hand-edited). WS protocol on `/ws/terminals/:id`: client `{type:"input"|"resize"|"ping"}`, server `{type:"pong"|"exit"}` + raw PTY output.

## Config & Conventions

- Config via `.env` (see `.env.example`); full table in `README.md`. Key: `PORT` (4174), `TMUX_BACKEND`, `ALLOWED_FILE_ROOTS` (`$HOME`), `DECKTERM_STATE_DIR` (`$HOME/.deckterm`), `MAX_TERMINALS_PER_USER` (10), `CF_ACCESS_*` / `TRUSTED_ORIGINS` (Cloudflare Access).
- **Per-slice plan docs:** non-trivial features get a design + impl doc pair in `docs/plans/` (`YYYY-MM-DD-name-design.md` + `-name.md`); security slices ship _with tests_.
- Use native `Bun.Terminal` (not Node PTY). Don't drop CORS, `/api/terminals` rate limits, or WS disconnect cleanup. Don't hardcode paths — use env vars / allowed roots.
- The OpenCode proxy and `gateway.py` were removed (June 2026). `OPENCODE_WEB_*` env vars remain for deployment compatibility — they configure DeckTerm itself (debug, terminal caps, rate limits).
- Tests inherit env from both Bun's `.env` auto-load **and** the DeckTerm service environment when run inside a DeckTerm terminal — foundation-bearing tests must pin/delete `DECKTERM_PUBLISH_MODE` and `DECKTERM_LEGACY_NO_BOOTSTRAP` in setup (see 5fcd118).
- Branch flow: `feature/*` → `dev` (validate on 4174) → `main` (production; `Deploy Main` CI packages + atomically rolls out).
- **Notion docs:** project state & docs live on the DeckTerm Notion page (landing `33377ff522ce81af89c5c9bfbe3554bb`) per the workspace template convention — Readme / Operations Guide / Development Plan / append-only Development Log / Backlog / agent memory pages. Session-end sync via `/notion-project-sync`; repo stays authoritative for technical spec — link, don't copy.
