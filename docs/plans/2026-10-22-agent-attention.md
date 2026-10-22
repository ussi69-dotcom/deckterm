# Agent attention: implementation plan (2026-10-22)

Design and contract: [2026-10-22-agent-attention-design.md](./2026-10-22-agent-attention-design.md). Run plan, authority and traps: `docs/handoffs/2026-10-22-herdr-adoption-operator.md`.

**Outcome.** Four code slices turn the design into working code on dev (port 4174):

- **S1a**: Codex approvals raise "needs your answer";
- **S1**: screen-rule agent state for Claude and Codex;
- **S2**: the Agents panel, the phone chip and server-side "seen";
- **S3**: one-tap resume.

Nothing here touches `main`, production (4173, `~/.deckterm`), `~/.claude`, `~/.codex` or `~/myclaude`.

## Order and parallelism

1. **S1a** first. It is small and backend-only, and may run alongside S0.
2. **S1 and S2 in parallel**, each in its own worktree made by hand from `dev` (verify the base sha). S2 builds against the contract in design sections 1-3. Until S1 merges, the view model falls back to attention plus `agentState`.
3. **S3** last, after S0 is merged. A one-tap agent relaunch must not inherit the Web Push key.

Rules that hold for every slice:

- At most two code slices run at once; the `dev` checkout and the e2e run on 4174 are serial resources.
- Every new `*.test.ts` or `*.test.js` is added to `test:unit` in `package.json`. `bun run test:census` (`scripts/check-test-census.ts`) fails otherwise.
- Foundation-bearing tests, which start the SQLite state, get their own chained `bun test ./file` invocation, like `foundation-settings.test.ts` today.
- Push tests belong to `test:push`.
- Gates per slice: `bun x tsc --noEmit`, `bun run test:unit`, `bun run test:push` (S1), then the slice's e2e on 4174.
- e2e runs only on 4174, and only when the operator session is not hosted on dev.
- e2e conventions: read terminal text with the `readActiveTerminalText` fixture (`.xterm-rows` is empty under WebGL); click pinned actions with `:visible` (they render three times); guard IDE specs against the persisted `layout.activeView`.
- Each slice gets one independent review (Codex via `~/.claude/bin/codex-caller`, or the Opus fallback) before it merges.

## S1a. Codex "Action Required" means needs-input

Branch `feat/agent-codex-title`.

**Files**

| File | Change |
| --- | --- |
| `backend/telemetry.ts` | Parse the latest OSC 0/2 title from a chunk: sanitize it, cap it at 256 characters, accept BEL or ST endings (the existing title regex is at `:116-124`). Add a pure `detectTitleAttention({ agentName, previousTitle, nextTitle })` that returns `{ kind: "needs-input", rule: "osc_title_blocked" }` on the edge into a Codex title containing `Action Required`, else `null`. Add a pure `applyAgentAttention(tracker, kind, { now, source, rule })` next to `applyTerminalNotificationEvents` (`:1143-1186`), with the same `seq` and rate-window rules. Extend `TerminalAttention` (`:781-787`) with optional `source` and `rule`. |
| `backend/server.ts` | Add `agentOscTitle: string` to `Terminal` (`:297-348`), initialized at creation (`:5850` area). In `processTerminalNotifications` (`:887-911`), which already has the one-raw-source rule, update the title and, on an edge, apply the attention and call `notifyCompletionPush(term, "input")`. Record `lastInputPushAt` in `notifyCompletionPush` (`:1582`). |

**Tests** (in the existing `backend/telemetry.test.ts`, already in `test:unit`):

- a captured Codex approval title fires once;
- a repeated `Action Required` title does not fire again;
- a non-Codex agent never fires;
- a spinner title does not fire;
- the attention carries `source: "title"` and `rule: "osc_title_blocked"`.

The captured title comes from `backend/fixtures/agent-screens/codex-0.163-blocked-approval.txt` (header `title:`), captured under the fixture policy (design section 4). If Codex is not logged in, use the `-synthetic` file and report the gap.

**Acceptance** (handoff, S1a): a unit test using a captured Codex approval title passes. Live check on dev: with Codex in a dev session and an approval prompt open, the Sessions list shows the attention and one push arrives.

## S1. Screen-rule agent state

Branch `feat/agent-screen-rules`.

**Files to create**

| File | Content |
| --- | --- |
| `backend/agent-rules/claude.toml`, `backend/agent-rules/codex.toml` | Copied from herdr `2ecf19a` `src/detect/manifests/`, with a header comment (source path, commit, upstream version, Apache-2.0, "modified by DeckTerm", list of edits). Read as data from `/home/deploy/.local/state/herdr-review/src`; never run anything there. |
| `backend/agent-screen-rules.ts` | Loader: reads the TOML with `Bun.TOML.parse(readFileSync(...))`, which needs no module declaration for `tsc` and no new dependency. It translates Rust regexes (design 1.2) and rejects unknown regions and mid-pattern inline flags. Evaluator: `evaluate(agent, { screen, title, progress })` returns `{ state, ruleId, visibleIdle, skip, manifestVersion }`. Regions are ported from herdr `src/detect/manifest.rs:1276-1420`, including the Codex prompt-marker helpers. |
| `backend/agent-status.ts` | Pure state machine with an injected clock: start grace (3 s), working→idle hold with one 700 ms re-check, the `skip_state_update` keep, commit, and effects (`raise needs-input`, `raise done`, `push input`, `push agent`, `nudge`) following the blocked-episode and `AGENT_DONE_PUSH_MIN_WORK_MS` rules (design 1.3-1.6). |
| `backend/fixtures/agent-screens/*.txt` | The required set (design section 4). |
| `backend/agent-screen-rules.test.ts` | Region slicing, matcher semantics (`contains` lower-cased, `line_regex` any line, `all`/`any`/`not`), priority ties to the earlier rule, `skip_state_update`, the `no_match` idle fallback, regex translation cases, and **every vendored regex compiles**. |
| `backend/agent-status.test.ts` | Grace, hold commits, hold dropped, immediate commits, the done edge, the blocked episode pushes once, a notification push in the last 10 s suppresses the screen push, and agent exit clears everything. |
| `backend/agent-screen-fixtures.test.ts` | Loads every fixture, asserts `state` (and `rule` when given), and prints the synthetic count. |

**Files to change**

| File | Change |
| --- | --- |
| `backend/services/terminal-backend.ts` (`:71`), `tmux-terminal-backend.ts` (`:259-267`), `brokered-tmux-backend.ts` (`:177-188`) | Add `captureVisible(sessionName)` = `capture-pane -p -t <session>`. If the broker's tmux schema refuses it, extend the schema with a test in `backend/broker-tmux-schema.test.ts`. If that is not small, leave brokered terminals at `null` and report it. |
| `backend/telemetry.ts` | Keep the raw OSC 9;4 payload for the `osc_progress` region (`:886-920`). |
| `backend/server.ts` | Add `Terminal` fields: `agentStatus`, `agentStatusRule`, `agentStatusChangedAt`, the state-machine record, `blockedEpisode`. Evaluate in `pumpTmuxPipeOutput` (`:5484-5500`) after the delta, for terminals with an agent, using the terminal's own backend. Serialize the four fields in `serializeTerminal` (`:4668-4695`) and `null`s in `serializeRecordedTerminalSession` (`:4708-4740`). Route effects through `applyAgentAttention` and `notifyCompletionPush`. Retire the S1a title path in favour of the evaluator. Add the `agents=1` WebSocket query flag (`:11347-11398`) and the owner-scoped, 500 ms-coalesced `{type:"agents_changed"}` frame. Do not add these fields to `broadcastTerminalState` (`:715-735`). |
| `backend/services/push-notifications.ts` (`:175-186`) | `data.url = "/?session=" + encodeURIComponent(terminalId)`. |
| `web/service-worker.js` (`:35-54`) | On click, focus an open window and `postMessage({ type: "deckterm-open-session", terminalId })`; otherwise `openWindow(url)`. Keep the same-origin path check (`:21-26`). |
| `THIRD_PARTY_NOTICES.md` | The `herdrdev/herdr` section (design section 7). |
| `package.json` | Add the three new test files to `test:unit`. |

**Tests to change:**

- `backend/push-notifications.test.ts` (`test:push`): the payload URL carries the session and the text stays generic;
- `web/push-notifications.test.js` (`test:push`, click handler at `:210`): the message is posted to an existing client, and the window opens when there is none;
- `backend/telemetry.test.ts`: the S1a cases now pass through the evaluator.

**e2e** (`tests/agent-status.spec.ts`, desktop, 4174). Seed a fake agent with the shell marker, keep the command in the foreground so the marker stays open (`printf '\033]9;9;deckterm;agent;claude;start\a'; …; sleep 300`, compare `tests/workspace-signals.spec.ts:440-450`; a returned prompt closes the marker, `backend/telemetry.ts:295-314`), then print the text of a synthetic question-form fixture.

- `/api/terminals` shows `agentStatus: "blocked"` and `agentStatusRule: "live_blocked_form"` within 6 s.
- Printing a prompt box then gives `idle` and an attention `done`.

**Acceptance** (goal table, "lepsi sledovani aktivity agentu"):

- The S1 fixture suite of real tmux captures is green.
- On dev, a Claude question form and a Codex approval prompt each show "needs your answer" within about 4 s and send the generic push.
- `/api/terminals` carries `agentStatus` and `agentStatusRule`.
- The one-line maintenance note is in design section 8.
- The live check uses the cheap model in a scratch folder (fixture policy). Record the measured delay and the rule id in Progress.

## S2. Agents overview in the default view

Branch `feat/agent-overview`.

**Files to create**

| File | Content |
| --- | --- |
| `web/agent-overview.js` | Pure view model, browser global plus `module.exports`, like `web/task-signals.js`. It covers `statusTier(session, seenMap, { activeVisibleId })` (design 2.4), the comparator, `groupSessions` (`projectRoot`, else `cwd`), `summaryCounts` and `summaryText` (desktop words, phone symbols with an aria text), `nextTarget`, `clampPanelWidth(px, innerWidth)` and `tooltipFor(session)`. |
| `web/agent-overview.test.js` | Every tier with and without `agentStatus`; the stale needs-input case; ties; grouping; counts text; Next skips the active visible session and is disabled with none; clamp bounds at 768, 1280 and 2560 px. |
| `backend/services/attention-seen.ts`, `backend/attention-seen.test.ts` | `mergeSeenMaps(stored, incoming)`: per-id max, invalid entries dropped, highest 200 kept. Not foundation-bearing. |
| `tests/agents-panel.spec.ts` | Desktop e2e (below). |
| `tests/agents-phone.spec.ts` | 390×844 touch e2e (below). Assert the chrome the context really gets, as `tests/hybrid-touch-regressions.spec.ts` does. |

**Files to change**

| File | Change |
| --- | --- |
| `backend/server.ts` (`:9750-9784`) | In `PUT /api/settings`, apply `mergeSeenMaps` for the key `attention.seen` against the stored value. |
| `backend/foundation-settings.test.ts` (own invocation already) | An older map PUT after a newer one keeps the newer values; `null` deletes; the cap holds. |
| `backend/telemetry.ts` (`:428-468`) | `projectRoot` via `git rev-parse --show-toplevel` with `hardenGitInvocation` (`backend/git-readonly.ts:47-61`). Only for a cwd inside the allowed roots; cached per cwd for 60 s. Unit tests in `backend/telemetry.test.ts`. |
| `web/index.html` (`:617-628`, toolbar `:62-66`) | `#workspace-row` wrapping `#agents-panel`, `#agents-panel-sash` and `#workspace-area`; `#agents-summary-chip` next to `#sessions-btn`. |
| `web/styles.css` (near `:7910-7930`) | Row and panel layout, `--agents-panel-width` (default 240 px), sash styles like `.dock-sash`. Hidden under `body.ide-mode`, `body.chrome-mobile` and below 768 px. |
| `web/app.js` | Panel controller: render from `_sessionCatalog` on every telemetry refresh (`:11828-11850`); `applyAgentsPanelWidth`, `startAgentsPanelSashDrag` and `resetAgentsPanelSash` modelled on `:13144-13202`; load the width with the other layout keys (`:13079-13085`). Toggle via `agents.panelVisible` with refit. Register the `agents` and `next-agent` actions. Add the IDE view through `ideShell.addView` next to `:13476-13524`. Phone chip. Sessions sheet ordered by the new comparator, with a Next button and status icons (`:7930-7990`). Seen map through `settingsStore` (`attention.seen`) instead of localStorage (`:12368-12421`), with a one-time legacy import. Refetch on visibility. Add `agents=1` to the terminal WebSocket URL and handle `agents_changed` with `queueTelemetryRefresh(0)` (`:603-662`). Handle `deckterm-open-session` messages and the `?session=` boot parameter (design 1.6). |
| `web/task-signals.js` (`:62-66,193-220`) | `orderSessionsForPanel` delegates to the agent-overview comparator. Seen helpers stay; the storage key constant stays only for the legacy import. Update `web/task-signals.test.js`. |
| `web/settings-schema.js` | The `agents.panelVisible` (desktop) and `agents.summaryVisibleTouch` (touch) entries, category "Agents". Update `web/settings-schema.test.js`. |
| `web/settings-store.js` | `refresh()` that refetches and merges a given key without dropping pending writes. Update `web/settings-store.test.js`. |
| `web/navigation-surface.js` (`:9-25`) | Add `agents` to `desktopPrimary` (first) and `overflow`. Update `web/navigation-surface.test.js`. |
| `web/keyboard-shortcuts.js` | Rows for `Ctrl+Shift+L` (`agents`) and `Ctrl+Shift+X` (`next-agent`). Update `web/keyboard-shortcuts.test.js`. |
| `web/feature-guide.js` | Lines for `agents`, `next-agent` and the phone chip. Update `web/feature-guide.test.js` (length limits). |
| `web/quick-replies.js` (`:81-112`) | When `agentStatus` is not `null`, show the chips only while it is `blocked`; otherwise keep today's logic. Update `web/quick-replies.test.js`. |
| `package.json` | Add `web/agent-overview.test.js` and `backend/attention-seen.test.ts` to `test:unit`. |

**Seeding states in e2e.** Seed each state in a way that works both before and after S1 merges. Every seed command stays in the foreground (`sleep 300`) so the agent marker stays open.

- *Needs you*: the agent start marker, an OSC 9 notification with "needs your input" (today's path), and the text of a synthetic Claude question form (S1's path).
- *Done*: the start marker, a working line, a pause longer than the 3 s grace, a prompt box, and an OSC 9 "Task completed" notification.

**e2e: `tests/agents-panel.spec.ts`** (desktop 1440×900, 4174)

1. With a cleared store, the panel is visible.
2. The toolbar button (`:visible`) hides it; after a reload it stays hidden. Show it again through the palette action, then through the shortcut.
3. Drag the sash 120 px to the right: the panel width grows, and the active terminal's column count (from `/api/terminals` `cols`) drops. After a reload the width is kept. A double-click resets it to 240 px.
4. With one needs-you and one done session, "Next" focuses the needs-you session first, then the done one.
5. Seen in context A: open the done session, then in context B (same e2e run cookie, `tests/fixtures.ts:772-784`) reload. The session is no longer unseen.
6. Help and the palette list "Agents panel" and "Next agent".
7. IDE mode: the "Agents" activity view renders the same rows, and `#agents-panel` is hidden.

**e2e: `tests/agents-phone.spec.ts`** (390×844, `hasTouch`, `isMobile`)

1. With a cleared store and one seeded agent session, the chip is visible and its aria text names the counts.
2. Tapping it opens the Sessions sheet sorted needs-you first, with a Next button.
3. Turning the chip off in Settings survives a reload, and the desktop panel setting is unchanged (no cross-class fallback).
4. No sash and no left panel exist in the layout.

**Acceptance** (goal table rows):

- "levy bar s projekty a prehledem": on desktop, an Agents panel on the left lists sessions grouped by project (git repo root, else cwd), sorted needs-you > done-unseen > working > idle, with counts on top and a "Next" button.
- "i v defaultnim view": the panel works in the default desktop view (≥ 768 px, not IDE mode). In IDE mode the same list renders as an activity-bar view "Agents". The phone gets the summary chip and a sorted Sessions sheet.
- "togglovatelny": show/hide from a toolbar button, a palette action, a keyboard shortcut and a Settings toggle. e2e: the choice survives a reload.
- "defaultne zapnuty": with cleared settings for the actor, desktop shows the panel and the phone shows the chip. e2e covers both.
- "resizovatelny tak jak to tu delame": a right-edge sash with the same contract as the IDE sidebar sash. e2e: dragging changes the width and the terminals' column count, the width survives a reload, and a double-click resets it.
- Handoff S2 extras: "Next" visits needs-you first, then done; seen in one browser context is cleared in a second context after reload; Help and the palette list the action; unit tests cover the view model.

## S3. One-tap agent resume

Branch `feat/agent-resume`. Merge only after S0.

**Files**

| File | Change |
| --- | --- |
| `backend/services/foundation-state.ts` | Next migration constant (11 on `530e90e`, after `:64`), adding `agent_name`, `agent_session_id`, `agent_cwd` and `agent_session_updated_at` with `tableColumnExists` guards (pattern `:376-382,416-419`). Helpers `recordAgentSession` and `clearAgentSession`; extend `RecordedTerminalSession` (`:73`). |
| `backend/telemetry.ts` (`:526-545`) | Parse the optional `sid=` field, UUID-validated. The `agent-start` event gains `sessionId?: string`. |
| `backend/shell-integration.ts` (`:33-50`) | The wrapper argument table (design section 6). UUID from `/proc/sys/kernel/random/uuid`. The marker becomes `agent;<name>;start;sid=<uuid>` when an id is known. |
| `backend/server.ts` | On `agent-start` and `agent-done` (`:836-845` loop), record or clear the row. Add `resume` to ended rows in `GET /api/terminals` (`:8226-8320`). Add `POST /api/terminals/:id/resume` with `dryRun`, built on the existing create path and the deferred Enter (`:7590-7606`). |
| `web/session-actions.js`, `web/workspace-launcher.js`, `web/app.js` | "Resume" and "Resume (pick)" buttons in the Sessions sheet rows, the launcher and the Agents panel's "Resume" group. Add a feature-guide line. |

**Tests**

- `backend/shell-integration.test.ts` (existing): run the generated rc in `bash` with stub `claude` and `codex` functions that print their arguments. Cover every row of the argument table, plus a missing `/proc` UUID source.
- `backend/telemetry.test.ts`: `sid` accepted only as a UUID; the forged `agent;claude;start;sid=x;$(id)` gives no id.
- `backend/foundation-agent-resume.test.ts` (new, foundation-bearing, **its own chained `bun test` invocation** in `test:unit`):
  - the migration on a fresh and an existing database;
  - record and clear;
  - an ended row with an agent becomes resumable;
  - `dryRun` builds `claude --resume <id>`, `codex resume --last` and the pick variants;
  - a tampered stored id is refused;
  - another actor's row is refused.

  Pin `DECKTERM_STATE_DIR` and clear `DECKTERM_PUBLISH_MODE` and `DECKTERM_LEGACY_NO_BOOTSTRAP` in setup.
- `web/session-actions.test.js`: the resume row action.

**e2e: `tests/agent-resume.spec.ts`** (4174)

- Seed an ended row with agent metadata through a test-only path the slice defines. For example, a session whose fake agent marker carries a sid, then deleting its tmux session.
- Assert that the Sessions sheet shows "Resume", and that the `dryRun` response names the same cwd and command.
- Never let e2e type a real `claude` or `codex` command: that would start a paid session.

**Acceptance** (handoff, S3):

- Unit tests cover the wrapper argument table, the forged-marker case and the migration.
- On dev:
  1. Start Claude (`--model claude-haiku-5-5`, scratch folder) in a session.
  2. Restart the dev tmux server under the pile-up rule: list it first, and record the listing in Progress.
  3. Tap Resume. The same conversation opens in the same cwd.
- Production is untouched.

## Integration

- Merge in an integration worktree from `dev`, in slice order.
- After each merge: `bun x tsc --noEmit`, `bun run test:unit`, `bun run test:push`, `bun run test:census`.
- Then:
  1. fast-forward `dev` and push `origin/dev`;
  2. restart `deckterm-dev.service` and check `/api/health`;
  3. run `bun run test:e2e:smoke`, then the full suite (`cd tests && PW_BASE_URL=http://localhost:4174 npx playwright test`).
- Visual QA at desktop and 390×844: the default view with the panel, the panel hidden, a resized panel, IDE mode with the Agents view, the phone chip and the sorted sheet. Screenshots showing host details are never committed.
- Record gate counts, measured detection delays and the synthetic-fixture count in the handoff's Progress section.
