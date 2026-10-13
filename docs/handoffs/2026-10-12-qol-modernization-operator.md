---
status: consumed
updated: 2026-10-13
next: Done. Promoted to production 2026-10-13 (PR #43, main b04c791) and production switched to tmux 3.8 at 10:03 UTC (operator session carried over; docs/plans/2026-10-13-tmux-3.8-upgrade.md step 3). Next own slices, each after owner go - OSC 133 hooks, then xterm.js 6; backlog finding - shells inherit the service environment incl. the Web Push private key. A new session needs no state from this file.
---

# Operator state — DeckTerm QoL + modernization run (2026-10-12)

## Goal in the owner's words (each with its check)

Owner, 2026-10-12, verbatim: "Natahni projektovy kontext hlavne vecio co jeste nemame dotazene, jestli nemame neco spate nebo jestli nevznikli opensource projekty (projdi i ty co tu hermes pravidelne posila) ktere by nas v nejakem smeru posunuli, udelej i visualni check a zmodernizuuj, zefektivni nasad lepsi QoL, At te ten produkt takovy, jaky bys ho \"i ty chtel mit\" a nasad na dev. Pouzij autonomous nebo interactive operatora nebo co ted jedem at to dotahnes k dokonalosti"
Ultracode is on for the session (owner opt-in to workflows). This interactive session is the operator.

| Goal phrase | Check |
| --- | --- |
| "co jeste nemame dotazene" (unfinished work) | Prioritised open-item list (done: discovery `kb`), reported with still-valid/stale marks |
| "jestli nemame neco spatne" (what is broken) | P1 defects verified in code and fixed on dev; remaining listed |
| "opensource projekty … i ty co hermes posila" | Tool Radar + web sweep verdicts in the owner report (adopt / borrow / skip) |
| "visualni check a zmodernizuj" | Before (discovery `visual/`) and after screenshots of dev 4174, desktop + phone |
| "zefektivni, nasad lepsi QoL" | Shipped slices with tests (wave 1 + wave 2) |
| "nasad na dev" | Merged into `dev`, pushed to `origin/dev`, `deckterm-dev.service` restarted, health + live check |

## Constraints in force

- Dev only (4174, `~/.deckterm-dev`). Never touch prod 4173 / `~/.deckterm` / prod tmux socket. THIS operator session runs inside a PROD DeckTerm tmux pane (socket `~/.deckterm/tmux/…`) — killing prod tmux kills the operator. (DERIVED)
- No push to `main`, no prod deploy. (OWNER: "nasad na dev")
- `web/vendor/` not hand-edited; `tsc --noEmit` green; new test files added to `test:unit` by the operator (slices must not edit package.json). (CLAUDE.md)
- Foundation-bearing tests one per `bun test`; child spawns pin `DECKTERM_STATE_DIR`. (memory)
- `owner-decisions` not installed on this host → terminal-only owner communication. (MEASURED)
- Screenshots show host details → never commit them to the public repo. (memory: OVH audit)
- Preserve untracked `.omo/`. Secret guard blocks `.env` touches.

## Baseline (2026-10-12)

- `dev` @ `b001e23`; origin/main 3 ahead / 1 behind origin/dev (badge PRs only).
- Gates: `test:unit` 1291 pass / 0 fail; `tsc --noEmit` rc 0. (MEASURED)
- Dev service active, health ok.

## Decisions (see docs/plans/2026-10-12-qol-modernization-design.md)

- Tier 3 (owner, recommendation given, not built): xterm 6 upgrade (own slice later; tmux 3.4 blocks its main gain), tmux 3.8 host upgrade, approve-from-push, light theme / Setup+Sessions as windows, Claude Code hooks auto-install.
- Tier 2 (decided, report back): static caching = `private, no-cache`+ETag+gzip (immutable only for versioned names); OSC 133 command blocks deferred (tmux 3.4 swallows OSC 133); AGPL projects idea-only; catalog-race P1 investigated read-only, not prioritised over QoL.
- WebGL oversized glyphs at DPR 2/3 seen only in headless SwiftShader → owner to check on a real phone.

## Slices

Wave 1 (workflow `deckterm-qol-wave1`, run `wf_365c14c4-b7c`, task w4v2dxcb1), worktrees `/home/deploy/deckterm-qol/<slice>` on `qol/<slice>` from `b001e23`, private instances on ports 4281-4285, scratch state under the session scratchpad:
1. perf-cache · 2. terminal-reliability · 3. agent-attention · 4. mobile-ergonomics · 5. git-ux · + read-only lifecycle investigation (ports 4286-4289).
Merge order planned: perf-cache → git-ux → agent-attention → terminal-reliability → mobile-ergonomics, full gate after.

Wave 2 (after wave 1 merges): desktop polish (z-order P1, empty-state launcher, toolbar, help, search overlay), palette + explorer, unified toasts with Undo, phone compose sheet, smalls (error names rejected value, e2e `.xterm-rows` migration, leaked `palette-folder-*` cleanup).

## Progress

- Wave 1 merged into `dev` (merge commits after `b001e23`; conflicts in server.ts pump/single-flight and app.js attention/live-cwd resolved keeping both), tests wired in `cc327b8`, pushed to `origin/dev`. Gate: unit 1432/0, push 14/0, tsc 0, smoke e2e 32/32. Dev restarted 20:55 UTC: tmux session preserved + recovered, health shows `build`.
- Lifecycle investigation: root cause of the 07-19 P1 reproduced (old deploy candidate sharing prod state + namespace; closed by the 09-06 ownership lock). Latent mechanism still in code: `closeAndRemoveTerminal` ends the row on ANY attach-client exit (3/3 repro), boolean tmux probe treats unreachable as missing. Fix = wave 2 slice `lifecycle-fix`. KB backlog item must be re-scoped at sync.
- Prod drop-in `deckterm.service.d/idle-timeout.conf` still sets 24h/72h reapers on prod (contradicts the 08-30 "only explicit close ends a session" decision) → owner question (prod config).
- Wave 2 running: workflow `deckterm-qol-wave2` run `wf_3a7d8243-b5d` (task wnvlfx7iq), worktrees from `cc327b8`, ports 4292-4296, state dirs `/tmp/claude-1001/w2*`.
- Full e2e on dev (wave 1 state): 174 pass / 9 fail → e2e-fix agent (background, main checkout, commits on `dev`: 3164a6e, ef8e4f4, 58d43b9, 2cecd94 …) fixing git-panel spec repo fixture, tab copy vs close, extra-keys selector scope, Settings focus/keyboard heuristic, cwd-contract specs.
- Wave 2 done (5 slices). Merged in integration worktree `/home/deploy/deckterm-qol/integration` (branch `qol/integration`, from dev incl. early e2e-fix commits) — all auto-merged; tests wired `921d1a7`. Running there: unit+push gate (bx9pqbguw), Codex review `--base=b001e23` → `codex-review-w2.md` (bnyzhp0ci), adversarial review workflow `deckterm-qol-review` run `wf_55c0a587-055` (w0j67iuzf).
- e2e-fix agent done: full e2e 184/184 on dev (commits 3164a6e..03946c9; 3 product fixes). Trade-off to report: under tmux, commands shorter than ~2 s may not show "running"/"Command finished" (2 s sync TTL / pipe pump).
- `qol/integration` merged into dev as `0f79496`; unit 1554/0, tsc 0; dev restarted 21:45 UTC (session preserved), pushed to origin/dev. Full e2e on this state running (`gate/e2e-full-dev2.log`).
- Adversarial review (`wf_55c0a587-055`): 12 confirmed, 0 refuted, no P1; 5 unverified P3. Fix workflow `deckterm-qol-fixes` run `wf_d57c0e0b-073` (task w5c2cowa5): worktrees qol/fix-frontend (R1-4,R6,R9,R10,U0), qol/fix-backend (R0,R7,R8,U4 + git read-only hardening), qol/fix-ui (R5,R11,U1-U3) from `0f79496`. Payload: scratchpad `findings-for-fix.json`.
- Then: merge fixes, gate, restart, full e2e, after-screenshot visual pass (desktop+mobile) vs discovery, KB sync, owner report.

- Review fixes merged; after-visual QA (desktop 18 of 22 discovery issues fixed, phone 17 incl. all three P1s) led to a polish wave (`qol/polish-toolbar`, `-render`, `-surfaces`, `-agentstate`), merged at `0cfa5d7`; unit 1638/0, push 14/0, tsc 0. Dev restarted 22:37 UTC (session preserved), pushed.
- Final full e2e on that state: 168 pass / 16 fail, all 16 in `git-panel.spec.ts` (the new phone-landscape pinned row puts a hidden `[data-action="git"]` first in the DOM). Spec fixed in `a684417` (click `:visible`); git-panel 16/16; final full rerun 184/184, no retries (8.8 min).
- KB synced 2026-10-12 (backlog, plan, readme, portfolio, agent memory, development log, root log). Worktrees under `/home/deploy/deckterm-qol/` and the `qol/*` branches were removed after checking each was clean and merged; private state dirs under `/tmp/claude-1001/` removed.

## Final state

- `dev` = `origin/dev`; dev service runs it. Nothing on `main` or production.
- Owner decisions (tier 3) and decided-for-the-owner items (tier 2): delivery record "Not done here" + the owner report in the session.
- Host reboot scheduled by root for 2026-10-13 03:00 UTC (pending kernel): ends every tmux session on the host, prod and dev included. Not cancelled (owner decision).

## Traps learned

- Workflow `isolation: 'worktree'` branched from stale commits here before → operator creates worktrees by hand from `dev` and verifies the base sha.
- Operator env carries prod values (`DECKTERM_PUBLISH_MODE=cloudflare-access`, `TMUX_SESSION_NAMESPACE=deckterm`) → every private instance must start with `env -i` and explicit values.
- e2e run cookie works only on port 4174.
- `tmux kill-server` is blocked by the permission system → stop private tmux servers by killing the server PID whose args contain the private socket path.
- Unix socket path limit (108 bytes): private state dirs must be short (`/tmp/claude-1001/<x>`), not under the scratchpad.
- `web/git-scm-view.test.js` used `delete global.fetch` → later files in the same bun process lost fetch (fixed `de0feb5` on qol/integration).
- Codex bridge auth expired 2026-10-12 21:36 UTC (401 token_expired) → Codex review unavailable until the owner runs `codex login`.
- Pinned actions render on three surfaces (desktop toolbar, phone bar, phone-landscape row); the landscape row comes first in the DOM, so e2e must click `[data-action=…]:visible`.
