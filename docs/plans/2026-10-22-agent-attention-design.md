# Agent attention: design (2026-10-22)

**What changes for the owner**

1. DeckTerm reads each agent's screen, so a Claude question or a Codex approval shows as "needs your answer" within about 4 s and sends one generic push that opens that session.
2. On desktop, an **Agents panel** on the left of the default view lists every session by project, the ones that need you first, with a "Next" button. It is on by default, can be hidden, and is resized by dragging its right edge.
3. On the phone, a small chip in the top bar ("1 needs you · 2 done") opens the Sessions sheet in the same order.
4. After a reboot or a tmux crash, a "Resume" button reopens the agent conversation in its old folder. One tap, never automatic.

Implementation plan: [2026-10-22-agent-attention.md](./2026-10-22-agent-attention.md). Run plan: `docs/handoffs/2026-10-22-herdr-adoption-operator.md`. Research: `docs/research/2026-10-22-herdr-feature-review.md`.

This document is the contract that the code slices build against. Where it fixes a name, a value or a limit, the code uses exactly that.

## Words used here

- **herdr**: an open-source (Apache-2.0) terminal workspace manager for AI agents. DeckTerm ports its screen rules, release v0.9.5, commit `2ecf19a` (all herdr paths below are at that commit).
- **Slices**: the run's work packages. **S0** strips service secrets from the terminal environment. **S1a** reads Codex's "Action Required" window title. **S1** adds screen-rule agent state. **S2** adds the Agents panel and phone chip. **S3** adds one-tap resume.
- **Agent**: Claude Code or Codex running in a DeckTerm terminal.
- **Attention**: DeckTerm's existing per-session flag `needs-input | done | error | info` with a sequence number `seq` (`backend/telemetry.ts:757,781-787`).
- **agentState**: DeckTerm's existing `thinking | responding` value, which only says whether output is flowing (`backend/telemetry.ts:26`).
- **Pipe pump**: the server timer that reads each tmux pane's raw output log every 2 s, so alerts work with no browser open (`backend/server.ts:5477-5500,11839-11843`).
- **Screen rule**: herdr's term for one text-matching rule over part of the visible screen or the window title. A **manifest** is one TOML file of rules per agent.
- **Hysteresis**: deliberate delay before a state change counts, so a flicker does not cause an alert.
- **Actor**: the signed-in identity a request resolves to. Settings are stored per actor.
- **Surface windows**: the floating Files, Git, Tasks and Editor windows on desktop (`web/surface-windows.js:1-12`).
- **Sessions dock**: the desktop mode that docks the terminals to the bottom of the workspace area, with surface windows above them (`web/styles.css:8282-8296`).
- **Sash**: a thin drag handle on a panel edge that resizes it.
- **Device class**: `desktop` or `touch`. Touch is `platformDetector.isMobile`, so a touch tablet counts as touch (`web/extra-keys-visibility.js:1-31`).
- **Fixture**: a saved screen capture that a test feeds to the rules.

## Where DeckTerm stands today

- Agent state is two values. New output after the user typed means `responding`; quiet means `thinking` (`backend/telemetry.ts:181-211`, `backend/server.ts:440-447,913-932`). Working, waiting for you and finished all look alike.
- "Needs input" exists only when the agent prints its own notification (OSC 9/777/99) and the text matches a pattern (`backend/telemetry.ts:828-871`, `backend/server.ts:887-911`).
- DeckTerm reads Codex's window title only to see the spinner and the end of a turn (`backend/telemetry.ts:109-110,116-124,187`).
- The push payload always opens `/` (`backend/services/push-notifications.ts:185`). The service worker focuses any open DeckTerm window and navigates it there (`web/service-worker.js:35-54`).
- "Seen" lives per browser in localStorage under `deckterm.attention.seen.v1` (`web/task-signals.js:66`, `web/app.js:12368-12421`), so the phone and the desktop disagree.
- The Sessions list ranks only unseen `needs-input` above running sessions (`web/task-signals.js:193-220`).
- Every unknown JSON frame on a terminal WebSocket is written into the terminal as output (`web/app.js:603-662`). A new frame type would print as text in any tab still running the old page.

## 1. The `agentStatus` contract

### 1.1 Fields

S1 adds these fields to the live terminal object (`backend/server.ts:297-348`) and to every row of `GET /api/terminals` through `serializeTerminal` (`backend/server.ts:4668-4695`).

| Field | Type | Meaning |
| --- | --- | --- |
| `agentStatus` | `"working" \| "blocked" \| "idle" \| null` | The committed screen-rule status. `null` when no agent runs, during the 3 s start grace, on the raw (non-tmux) backend, and on recorded rows that are not live (`backend/server.ts:4708-4740`). |
| `agentStatusRule` | `string \| null` | Id of the rule that produced the committed status, for example `live_blocked_form` or `osc_title_blocked` (herdr ids, kept unchanged). DeckTerm's own id `no_match` means "agent known, no rule matched, so idle". `null` exactly when `agentStatus` is `null`. |
| `agentStatusChangedAt` | `number \| null` | Milliseconds since the epoch when `agentStatus` last changed value. Same unit as `agentTurnCompletedAt`. |
| `agentRulesVersion` | `string \| null` | The vendored manifest version used, for example `claude@2026.10.11.1`. For the tooltip only. |

The existing `attention` object (`backend/telemetry.ts:781-787`) gains two optional fields:

- `source`: `"notification"` (printed by the agent, today's only source), `"screen"` (S1) or `"title"` (S1a);
- `rule`: the rule id when `source` is `screen` or `title`, else absent.

`agentState`, `agentName`, `agentTurnCompletedAt`, `attention` and `progress` keep their meaning and values. Nothing reads `agentStatus` to decide a Task Runner transition, an authorization or a persisted event.

### 1.2 How the status is computed

- **When.** In the pipe pump (`backend/server.ts:5484-5500`), for each tmux-backed terminal whose `agentName` is set: after the pipe delta is processed, take a visible-only capture and evaluate the rules. Skip the capture when the delta was empty and no hold or grace timer is pending; an unchanged screen cannot change the result. The `/api/terminals` poll path does not evaluate; it reports the last committed values.
- **Screen input.** `capture-pane -p -t <session>`: visible rows only, plain text, wrapped lines kept as separate rows, no `-e`, no `-S`. It goes through a new `captureVisible(sessionName)` on the terminal backend interface (`backend/services/terminal-backend.ts:71` has today's `capture`), implemented for tmux and the brokered backend. Today's 10,000-line capture (`backend/services/tmux-terminal-backend.ts:259-267`) is unchanged.
- **Title input.** The latest OSC 0 or OSC 2 title from the same raw source as notifications: the pipe log for tmux, the live stream for raw PTYs (the rule at `backend/server.ts:883-893`). It is sanitized, capped at 256 characters and stored as `term.agentOscTitle`. It is cleared when the agent changes.
- **Progress input.** The latest OSC 9;4 payload rebuilt as `4;<state>[;<percent>]` from the existing progress parser (`backend/telemetry.ts:886-920`), for herdr's `osc_progress` region.
- **Rules.** The agent's manifest from `backend/agent-rules/{claude,codex}.toml` (section 7). Every rule is evaluated over its region; the highest priority match wins and ties go to the earlier rule. No match means `idle` with rule `no_match`. A match whose rule has `skip_state_update` keeps the previous status and rule unchanged (herdr `src/detect/manifest.rs:431-516`).
- **Matchers**, as herdr defines them (`src/detect/manifest.rs:1200-1274`): `contains` compares lower-cased text; `regex` must match the region; `line_regex` must match at least one line; `all`, `any` and `not` nest.
- **Regions.** Only the ones the vendored rules use, ported from herdr `src/detect/manifest.rs:1276-1420`. Claude uses `osc_title`, `osc_progress`, `whole_recent`, `bottom_non_empty_lines(N)`, `after_last_horizontal_rule`, `prompt_box_body` and `last_non_empty_above_prompt_box`. Codex uses `osc_title`, `top_non_empty_lines(N)`, `bottom_non_empty_lines(N)`, `after_last_prompt_marker`, `before_current_prompt_marker` and `whole_recent_without_current_prompt_marker`. The loader rejects any other region name, so a re-sync that adds one fails a test instead of silently never matching.
- **Regex dialect.** The loader translates Rust syntax to JavaScript:
  - `\x{…}` becomes `\u{…}`, and every pattern compiles with the `u` flag;
  - leading `(?i)`, `(?m)` and `(?s)` become flags;
  - `\A` becomes `(?<![\s\S])` and `\z` becomes `(?![\s\S])`.

  An inline flag anywhere else is a load error. A unit test compiles every vendored pattern.
- **Raw backend.** It has no screen to capture, so `agentStatus` stays `null` there and everything falls back to today's behaviour. Deployed instances run the tmux backend.

### 1.3 Hysteresis

Copied from herdr `src/pane/agent_detection.rs:5-13,42-79` and `src/pane.rs:3084-3157`, adapted to DeckTerm's 2 s tick:

- **Start grace, 3 s.** When `agentName` goes from `null` (or another agent) to an agent, DeckTerm sets `agentStatus = null` and evaluates nothing until 3 s have passed. The first evaluation runs on the first pump tick after that, so typically within 4 s.
- **Working→idle hold, 700 ms.** If the committed status is `working` and the new result is `idle` from a rule that is not `visible_idle` (including `no_match`), the change is not committed. A single re-check runs 700 ms later with a fresh capture. If it is still `idle`, it commits. Otherwise the hold is dropped.
- **No other hold.** `idle` from a `visible_idle` rule (`live_prompt_box`, `osc_title_idle`), any change into `blocked`, `blocked`→`idle` and `idle`→`working` commit at once.
- **Agent leaves.** When `agentName` becomes `null`, the status, rule, holds and grace are cleared, and no `done` is raised; the existing "command finished" path covers the returned prompt (`backend/server.ts:828-834`).

The pure state machine lives in `backend/agent-status.ts` with an injected clock, so tests drive it without timers.

### 1.4 How it merges with attention and agentState

| Event | Attention | Push |
| --- | --- | --- |
| Status commits to `blocked` | Raise `needs-input` with `source: "screen"` (or `"title"`, S1a) and `rule`, through the existing tracker | One `input` push per blocked episode (1.6) |
| Status commits to `idle` from `working` or `blocked` | Raise `done` with `source: "screen"` | One `agent` push through the existing 5 s dedupe (`backend/server.ts:1580-1594`), only if the working stretch before it lasted at least `AGENT_DONE_PUSH_MIN_WORK_MS` = 15 s (decision 1 below) |
| Agent prints a notification | Today's path, unchanged, `source: "notification"` | Today's path, except the episode guard in 1.6 |
| Status commits to `working` | Nothing | Nothing |

- Screen-raised attention goes through one new pure function next to `applyTerminalNotificationEvents` (`backend/telemetry.ts:1143-1186`). It keeps the same `seq` rule (wall clock, strictly increasing) and the same 2 s priority window (`backend/telemetry.ts:805,816-821`). Its `title` and `body` stay empty, so toasts and pushes use their generic text.
- **`agentStatus` wins over attention** when it is not `null`. Only `blocked` means "needs you". An unseen `needs-input` attention whose status has since moved to `working` or `idle` is stale; for example, the user answered on another device. The client then ranks it by its status (2.4).
- `agentState` stays as it is. Clients use it only when `agentStatus` is `null`.

### 1.5 Done

"Done" is not a fourth status. It is `idle` reached from `working` or `blocked`, which raises an attention `done` with a new `seq`. "Unseen" stays a client decision: `attention.seq` is greater than the seen value for that session, and the session is not the active, visible one (`web/task-signals.js:73-80`). Seen moves to the server (section 3), so viewing a finished session on the phone also clears it on the desktop.

### 1.6 Push: once per blocked episode, with a deep link

- A **blocked episode** runs from the commit of `blocked` to the commit of any other status. The terminal keeps `blockedEpisode = { startedAt, pushed }` and `lastInputPushAt`.
- Entering `blocked` sends an `input` push unless an `input` push for this terminal went out in the last 10 s. That earlier push would be the agent's own notification for the same prompt, which can arrive before the 2 s tick.
- A notification `needs-input` sends today's push, unless the terminal is in a blocked episode that already pushed.
- **Deep link.** The payload's `data.url` becomes `/?session=<terminalId>` (today `/`, `backend/services/push-notifications.ts:185`). The payload is encrypted end to end. The `topic` header, which the push service can read, stays a hash (`push-notifications.ts:184,214`). The text stays generic (owner decision 3).
- **Service worker.** On click, it focuses an open DeckTerm window and posts `{ type: "deckterm-open-session", terminalId }` to it instead of navigating, which avoids a reload. With no window open, it opens `/?session=<id>`. It accepts only a same-origin path, as today (`web/service-worker.js:21-26`).
- **App.** On that message, or on a boot URL with `session`, the app checks that the id is a UUID and is in the actor's own `/api/terminals` list. It then focuses or attaches that session and removes the parameter with `history.replaceState`. An unknown id is ignored.

### 1.7 Codex "Action Required" (S1a)

S1a ships first, before the rule engine. When the latest Codex title changes from one without `Action Required` to one with it, DeckTerm raises `needs-input` with `source: "title"` and `rule: "osc_title_blocked"`, and sends the `input` push. This is herdr's highest-priority Codex rule (`src/detect/manifests/codex.toml:6-12`). Quick replies follow through the attention path (`web/quick-replies.js:81-112`). S1 then retires the S1a code path, because the vendored `codex.toml` contains the same rule. S1a's unit test stays and runs against the evaluator.

### 1.8 Live updates to open pages

- `agentStatus` is **not** added to the `terminal_state` frame. That payload is appended to the persisted event log (`backend/server.ts:715-735`), and screen-derived data is untrusted.
- Instead, on every committed change the server sends `{ "type": "agents_changed" }` to the owner's terminal sockets. The frame has no content and is coalesced to at most one per 500 ms per owner. The page then refetches `/api/terminals` at once (`queueTelemetryRefresh(0)`, `web/app.js:11820-11826`).
- Only sockets whose URL carries `agents=1` get the frame. The server stores the flag next to `protocol` and `clientId` (`backend/server.ts:11347-11398`). Old pages never opt in, so they never print the frame as terminal text (see "Where DeckTerm stands today").
- Pages without an open terminal socket keep the 5 s poll (30 s when hidden, `web/app.js:123-124,11792-11817`).

### 1.9 Diagnostics

The rule id and manifest version are in the API (1.1). The Agents panel rows, Sessions rows and tab tooltips show `Needs your answer · rule live_blocked_form (claude@2026.10.11.1)`. No screen text, evidence preview or capture leaves the server: captures are held only in memory for one evaluation and are never logged or persisted.

### 1.10 Trust boundary

Any program in a pane can print text that looks like a dialog. The worst result is a false "needs your answer" and one generic push, the same exposure today's notification parsing already accepts (`backend/server.ts:333-337`). `agentStatus` never feeds authorization, Task Runner transitions or the persisted event log.

## 2. The Agents panel

### 2.1 Desktop, default view

- **When it shows:** device class `desktop`, window at least 768 px wide, not IDE mode, and `agents.panelVisible` true. In any other case the element is `hidden` and takes no space.
- **Where it docks.** Today `#workspace-area` is a direct child of `#app` (`web/index.html:617-628`, `web/styles.css:45-51`). S2 wraps it in a new row, `#workspace-row` (`display: flex; flex: 1; min-height: 0`), which holds:
  - `#agents-panel`, width `var(--agents-panel-width, 240px)`;
  - `#agents-panel-sash`, 5 px wide;
  - the unchanged `#workspace-area` (`flex: 1; min-width: 0`).
- **The work area is `#workspace-area`'s box.** Everything that lays out inside it already measures against it:
  - the terminal container and its tiles;
  - the surface-window layer (`position: absolute; inset: 0`, `web/styles.css:7918-7923`), whose window bounds and snap zones are percentages of that layer (`web/surface-windows.js:7-9,72-95`);
  - the sessions dock (`web/styles.css:8282-8296`);
  - the dock placeholder (`web/styles.css:8320-8330`).

  So none of them can overlap the panel, and none needs code changes for it. Saved window percentages scale with the narrower layer, as they do today when the dock opens.
- **When the panel appears, disappears or changes width,** dispatch `resize` and refit every visible terminal, exactly as the IDE sash does at drag end (`web/app.js:13178-13192`).
- **Breakpoint.** The 768 px threshold is the existing surface-window one (`web/surface-windows.js:24-28`).

### 2.2 Resize: the IDE sidebar sash contract

Same behaviour as `web/app.js:13144-13202`:

- the sash sits on the panel's right edge, and dragging sets the width to `pointerX - panelLeft`;
- width is clamped to 180 px .. `min(640, floor(50 % of window width))`, as in `clampIdeSidebarWidth` (`web/app.js:13148-13151`). The clamp is a pure helper in `web/agent-overview.js` with a unit test;
- double-click resets to the CSS default (240 px) by storing `null`;
- the width is written once, at drag end, as `agents.panelWidth` through `this.settingsStore`;
- at drag end, every visible terminal is refit with `performReconnectLayoutSync(id, { forceResize: true })`;
- the CSS variable `--agents-panel-width` is set on `:root`, the same as `--ide-sidebar-width`;
- on window resize, the applied width is re-clamped (but not saved), so the panel never exceeds half of a shrunken window.

### 2.3 Content

- **Counts summary** on top, for example `1 needs you · 2 done · 1 working`. Zero counts are left out. With agents but nothing to report: `All agents idle`. Without agents: `No agents running`.
- **"Next" button.** Goes to the first session in sort order whose tier is 0 or 1 (2.4), skipping the active, visible one. It is disabled, with the tooltip "Nothing needs you", when there is none. Visiting a `done` session marks it seen, so the next press moves on.
- **Grouped list.**
  - Groups use `projectRoot` (the git top level, new field, S2) or else `cwd`. A group is labelled with the last path segment, and the full path is in the tooltip.
  - Groups are ordered by their best row; rows inside a group by 2.4.
  - A row shows a status icon with a word label, the session title (`sessionDisplayTitle`, `web/task-signals.js:162-171`), the agent name and the age (`formatActivityAge`, `:173-182`). The tooltip carries the rule (1.9).
  - Clicking a row focuses that tab, or attaches it through the existing session row action (`planSessionRowAction`, `web/app.js:7948-7953`).
- **Which sessions:** live and detached (attachable) rows. Ended rows are left out, except resumable ones, which S3 adds in a "Resume" group at the bottom.
- **`projectRoot`** (`string | null`) is computed server-side next to `isWorktree` (`backend/telemetry.ts:428-468`). It uses `git rev-parse --show-toplevel` through the hardened read-only git helper (`backend/git-readonly.ts:37-61`). It runs only for a cwd that resolves inside the allowed roots, and is cached per cwd for 60 s. The git branch per row is optional (tier 2) and would use the same cache.

### 2.4 Status tiers and sort

One pure view model, `web/agent-overview.js`, used by the panel, the IDE view, the phone chip and the Sessions sheet.

| Tier | Name | When (`agentStatus` not null) | Fallback when `agentStatus` is null |
| --- | --- | --- | --- |
| 0 | needs you | `blocked` | unseen attention `needs-input` |
| 1 | done (unseen) | `idle` with any unseen attention `done`, `error` or `needs-input` | unseen attention `done` or `error` |
| 2 | working | `working` | `running`, or `agentState` is `thinking` or `responding` (today's rank, `web/task-signals.js:193-209`) |
| 3 | idle | `idle`, nothing unseen | agent present, nothing else |
| 4 | no agent | `agentName` is null | same |
| 5 | resumable | ended row with resume data (S3) | same |

- Ties go to the most recent change: `agentStatusChangedAt`, then `attention.at`, then `lastActivityAt`.
- The active, visible session is never "unseen".
- The existing `orderSessionsForPanel` (`web/task-signals.js:211-220`) delegates to this comparator, which also fixes the Sessions ranking so unseen `done` and `error` rank above plain running sessions.

### 2.5 IDE mode

`#agents-panel` is hidden in IDE mode. The same list renders as an activity-bar view registered through `ideShell.addView({ id: "agents", icon: "bot", title: "Agents", mount, unmount, resize })` (`web/ide-shell.js:446-477,502-513`; the app registers views at `web/app.js:13476-13524`). It uses the IDE sidebar and its width, `ide.sidebarWidth`. `agents.panelVisible` does not affect it. On leaving IDE mode, the panel returns according to its setting.

### 2.6 Phone and touch

- A summary chip `#agents-summary-chip` in the top toolbar row next to the Sessions button (`web/index.html:62-66`).
- It shows when the device class is `touch`, `agents.summaryVisibleTouch` is true, and at least one session has an agent. It uses symbols and counts (`● 1 · ✓ 2 · ◐ 1`), with the full words in its `aria-label` and `title`.
- Tapping it opens the Sessions sheet, sorted by 2.4 as a flat list, with a "Next" button at the top and a status icon on each row.
- Nothing on the phone is resizable, and there is no left panel on a touch device at any width.
- A desktop-class window narrower than 768 px shows neither panel nor chip. "Next" stays available from the palette.

### 2.7 Toggle surfaces

| Surface | Id or key |
| --- | --- |
| Toolbar button (desktop, pinned by default) | action `agents`, added first to `desktopPrimary` and to `overflow` in `web/navigation-surface.js:9-25`. Saved custom layouts keep their pins; the action stays in More. |
| Palette and action registry | `agents` ("Show or hide the Agents panel") and `next-agent` ("Go to the next agent that needs you") |
| Keyboard | `Ctrl+Shift+L` toggles the panel; `Ctrl+Shift+X` is Next. Both are new rows in `web/keyboard-shortcuts.js:40-193`, with `actionId`, so Help and the palette list them. S2 checks that Chromium and Firefox deliver both to the page; if not, it picks another free `Ctrl+Shift+letter` and updates the rows. |
| Settings | `agents.panelVisible` (desktop), `agents.summaryVisibleTouch` (touch) |
| Feature guide | one line each for `agents`, `next-agent` and the phone chip in `web/feature-guide.js:23-61` |

## 3. Settings keys

| Key | Value | Default | Device class | In Settings UI |
| --- | --- | --- | --- | --- |
| `agents.panelVisible` | boolean | `true` | `desktop` | yes, category "Agents" |
| `agents.summaryVisibleTouch` | boolean | `true` | `touch` | yes, category "Agents" |
| `agents.panelWidth` | number (px) or absent | absent = CSS default 240 px | desktop only by use | no (like `ide.sidebarWidth`, `web/app.js:13079-13085`) |
| `attention.seen` | object `{ "<terminalId>": <seq> }` | absent = `{}` | both (that is the point) | no |

- **Declaration.** The two toggles are schema entries with `deviceClass` (`web/settings-schema.js:10-14`), modelled on `terminal.extraKeysVisible` and `terminal.extraKeysVisibleTouch` (`:65-92`). The Settings UI shows only the current device's entry (`schemaForDevice`, `:334-338`).
- **Never fall back across device classes.** A desktop reads only `agents.panelVisible`, a touch device only `agents.summaryVisibleTouch`. Each falls back only to its own default, never to the other device's value, following `web/extra-keys-visibility.js:40-51`.
- **Defaults survive a cleared store.** Every reader passes its default to `store.get(key, default)`, so an e2e run with an empty store (`tests/fixtures.ts:772-784`) shows the panel on desktop and the chip on the phone. A stored `agents.panelWidth` that is not a finite positive number counts as absent.
- **`agents.panelWidth = null`** deletes the key (`web/settings-store.js:135-155`), which means the CSS default.
- **The seen store, `attention.seen`.**
  - It replaces localStorage `deckterm.attention.seen.v1` (`web/task-signals.js:66`). The value shape is today's (`parseSeenMap`, `web/task-signals.js:119-136`): terminal UUID to the highest `seq` seen.
  - **Bound:** at most 200 entries. One entry is about 55 bytes, so the value stays near 11 KB, under the server's 16 KB per-value limit (`backend/server.ts:582-584`).
  - **Server merge rule.** For this key only, `PUT /api/settings` (`backend/server.ts:9750-9784`) merges per id with `max(stored, incoming)`. It drops entries that are not a finite positive number, then keeps the 200 highest `seq` values. `null` still deletes the whole key. A stale page therefore cannot undo another device's "seen". The merge is a pure helper, `backend/services/attention-seen.ts`, with a test.
  - **Client.** On first load, the page merges any legacy localStorage map into the key once, then removes the local key. When the page becomes visible again, it refetches `GET /api/settings` and merges `attention.seen` by max into its cache.

## 4. Fixture policy (S1)

The fixture suite is the main quality gate, because herdr ships no real Claude or Codex screens.

- **Where:** `backend/fixtures/agent-screens/`.
- **File name:** `<agent>-<version>-<state>-<shape>[-synthetic].txt`, for example:
  - `claude-2.1.308-blocked-question-form.txt`
  - `claude-2.1.308-blocked-plan-approval.txt`
  - `claude-2.1.308-blocked-bash-permission.txt`
  - `claude-2.1.308-working-spinner.txt`
  - `claude-2.1.308-idle-prompt.txt`
  - `codex-0.163-working-timer.txt`, `codex-0.163-idle-composer.txt`, `codex-0.163-blocked-approval.txt`, `codex-0.163-blocked-trust-dialog.txt`
- **Required set:**
  - Claude 2.1.308: working, idle, question form, plan approval, and a Bash permission prompt in a non-bypass session;
  - Codex 0.163: working, idle, approval prompt and trust dialog.
- **Format.** A header between two `---` lines, then the capture byte for byte. Header keys, one per line:
  - `agent`: `claude` or `codex`;
  - `version`: from `claude --version` or `codex --version`;
  - `state`: the expected `agentStatus`;
  - `rule`: the expected rule id (optional);
  - `title`: the pane title at capture time (`tmux display -p '#{pane_title}'`), redacted;
  - `size`: columns×rows of the pane;
  - `capture`: the exact command used;
  - `date`: ISO date;
  - `synthetic`: `yes` or `no`;
  - `redactions`: a short list of what was replaced;
  - `notes`: optional.
- **Capture command.** `tmux -S <socket> capture-pane -p -t <session>`: the same visible-only, plain-text capture the server runs (1.2), so fixtures match runtime input exactly. On dev, the socket is `~/.deckterm-dev/tmux/deckterm_deckterm.sock` and the binary is `/home/deploy/opt/tmux-3.8/bin/tmux`.
- **Where captures come from.** A DeckTerm terminal on dev (4174) or on a private instance (ports 4281-4299), so the real rcfile wrapper applies, including Codex's `--no-alt-screen` (`backend/shell-integration.ts:46`). The working directory is a scratch folder under `/tmp/claude-1001/agent-fixtures/`.
- **Claude.** Run `claude --model claude-haiku-5-5`, never with `--dangerously-skip-permissions`. The owner's settings (fullscreen TUI, notifications) apply as they are; `~/.claude` is not changed.
  - Question form: ask it to ask you a multiple-choice question with its question tool.
  - Plan approval: add `--permission-mode plan` and ask for a plan to create one file.
  - Bash permission prompt: add `--permission-mode default`, in case the settings default to bypass, and ask it to run `ls`.
  - Working: capture during a reply.
  - Idle: capture the empty prompt after a reply.
- **Codex.** Only if `codex login status` reports logged in. Use the cheapest model the account offers and record it in `notes`.
  - Trust dialog: the first start in a fresh scratch folder.
  - Approval prompt: `-a untrusted` and a request to create a file.
  - Working and idle: as for Claude.
  - If not logged in, write synthetic fixtures and report the gap.
- **Budget.** At most about 15 short sessions in total, prompts short and harmless, each session quit when done (handoff, Authority).
- **Redaction before commit.** Replace:
  - the host name with `host`;
  - `/home/deploy` with `/home/user`;
  - the scratch path with `/tmp/scratch`;
  - the user name with `user`;
  - e-mail addresses, organisation and account names (Claude's welcome box shows them), IP addresses and git remote URLs.

  Inside a box-drawn line, pad or trim the replacement to keep the line's character count, so box edges stay where the rules expect them. Read every file in full before committing it. This applies to fixtures only; host names in handoffs stay (owner decision 5).
- **Synthetic fixtures.** Any hand-made or edited-beyond-redaction screen has `synthetic: yes` and the `-synthetic` file-name suffix. The test runner prints the count of synthetic fixtures. A required state covered only synthetically is reported as a gap (tier 2).
- **The test.** `backend/agent-screen-fixtures.test.ts` loads every file, parses the header, runs the evaluator with the screen and the `title`, and asserts `state` (and `rule` when given).

## 5. Terminal environment deny-list (S0)

The list of service-only variables removed from terminal environments is recorded here by slice S0 (the operator fills it).

## 6. One-tap resume (S3)

- **Migration.** The next free foundation migration (11 on `530e90e`; the latest is `PUSH_SUBSCRIPTIONS_MIGRATION = 10`, `backend/services/foundation-state.ts:64`). It adds four nullable `TEXT` columns to `terminal_sessions` (`:188-202`):
  - `agent_name`;
  - `agent_session_id`;
  - `agent_cwd`;
  - `agent_session_updated_at`.

  It follows the `exec_kind` and `termination_scheduled_at` pattern (`:378-381,418`). `agent_cwd` is needed because Claude finds a conversation by project folder, which can differ from the session's creation cwd.
- **When it is written.**
  - On an `agent-start` event: the agent name, the validated id if any, `term.cwd` at that moment, and the time.
  - On an `agent-done` event: all four are cleared, because an agent that exited normally has nothing to resume.

  So an ended row with `agent_name` set is one whose agent was alive when the session ended, for example after a tmux crash or reboot (`backend/server.ts:1150-1166`).
- **The wrapper** `__deckterm_run_agent` (`backend/shell-integration.ts:33-50`):

  | User's `claude` arguments | Wrapper adds | Reported in the start marker |
  | --- | --- | --- |
  | none, or the first argument starts with `-` and none below applies | `--session-id <new uuid>` | that uuid |
  | contains `--session-id <u>` | nothing | `<u>` if it is a UUID |
  | contains `-r <u>`, `--resume <u>` or `--resume=<u>` | nothing | `<u>` if it is a UUID |
  | contains `-r`/`--resume` without an id, `-c`/`--continue`, `--fork-session`, `--from-pr`, `--cloud`, `--desktop`, `--bg` | nothing | nothing (pick) |
  | contains `-p`/`--print`, `-h`/`--help`, `-v`/`--version` | nothing | no start record |
  | the first argument does not start with `-` (a prompt or a subcommand such as `mcp`) | nothing | nothing (pick) |

  - The UUID comes from `/proc/sys/kernel/random/uuid`. When that is unreadable, nothing is added.
  - For `codex`: `resume <u>` reports `<u>`. `resume --last`, `resume` and a plain start report nothing. `exec`, `review` and other subcommands record nothing.
- **Marker.** `agent;<name>;start;sid=<uuid>`. The parser (`backend/telemetry.ts:526-545`) accepts exactly one extra field, `sid=`, and only when it matches `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`. Anything else is dropped, the start event itself still counts, and no id is recorded. The marker travels in pane output, so any program can forge it. A forged `sid=x;$(id)` leaves no resumable id.
- **Resume modes.** The server computes them for ended rows as `resume: { agent, mode, cwd } | null` in `/api/terminals`:
  - `exact`: `claude --resume <id>` or `codex resume <id>`;
  - `last` (Codex without an id): `codex resume --last`;
  - `pick`: `claude --resume` or `codex resume`, which open the agent's own picker. It is used without a Claude id, and for Codex when another resumable or live Codex row shares the same `agent_cwd`, because `--last` would pick the same conversation for both.
- **Action.** `POST /api/terminals/:id/resume`:
  - checks the actor owns the ended row and validates the stored id again;
  - creates a terminal in `agent_cwd` through the normal create path, so root checks, capability grants and rate limits apply;
  - types the command built only from the validated values, then a separate deferred Enter, as Task Runner does (`backend/server.ts:7590-7606`, delay `:7494`).

  With `{ "dryRun": true }` it returns `{ command, cwd, mode }` and creates nothing; tests use that. The command goes through the shell functions, so Codex still gets `--no-alt-screen` and the new run reports its id again.
- **Never automatic.** Nothing runs at boot or on reconnect. "Resume" buttons sit in the Sessions sheet, the zero-terminal launcher and the Agents panel's "Resume" group. No transcript is read, and nothing under `~/.claude` or `~/.codex` is touched.
- **Ship order.** S3 merges after S0. A one-tap relaunch of an agent must not inherit the Web Push private key (report, item 3).

## 7. herdr attribution

- S1 adds a `herdrdev/herdr` section to `THIRD_PARTY_NOTICES.md`, after the traycer section (`THIRD_PARTY_NOTICES.md:8-29`), with the Apache-2.0 notice block. It says:
  - the rule data in `backend/agent-rules/{claude,codex}.toml` is derived from herdr `src/detect/manifests/{claude,codex}.toml` at commit `2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01` (v0.9.5), modified;
  - the region and matcher semantics in `backend/agent-screen-rules.ts` and the hysteresis constants are ported from `src/detect/manifest.rs` and `src/pane/agent_detection.rs`;
  - the copyright holder is "herdr contributors", because herdr ships no NOTICE file and its copyright line is the unfilled template.
- Each vendored TOML starts with a comment naming the source path, commit, upstream manifest version, licence and "modified by DeckTerm" with a list of edits.
- The herdr name is not used for DeckTerm features.

## 8. Rule maintenance (manual re-sync)

**One line:** at every Claude or Codex upgrade, diff herdr's two manifests and DeckTerm's copies, re-capture fixtures, and update by a reviewed commit. Never fetch rules automatically.

- DeckTerm never downloads rules at runtime or in CI. herdr's own updater (`src/detect/manifest_update.rs`) is not ported.
- The procedure runs by hand:
  1. In a herdr clone that a person updated on purpose, read as data only (never run its scripts or build), compare `git diff 2ecf19a <new tag> -- src/detect/manifests/claude.toml src/detect/manifests/codex.toml src/detect/manifest.rs`.
  2. Apply the relevant changes to `backend/agent-rules/*.toml`, and update the header's commit and version.
  3. Run the regex-compile test and the fixture suite.
  4. Capture new fixtures for the agent version that changed (section 4).
  5. Update the commit in `THIRD_PARTY_NOTICES.md`, and commit with the upstream commit in the message.

## 9. Risks

- **Agent UI drift.** Claude and Codex change their screens often. Mitigations: the fixture suite, the re-sync procedure, and the rule id in every alert. A missed rule costs a missed alert, not a false one, because "no match" means idle.
- **Different screens from herdr's.** herdr tunes its rules on its own emulator. DeckTerm reads tmux captures of fullscreen Claude and inline Codex (`--no-alt-screen`). Only real captures prove the port.
- **Regex dialect.** Rust's `\d` and `\b` are Unicode-aware; JavaScript's are ASCII. The fixtures catch differences that matter.
- **False "blocked" from forged text.** See 1.10: generic push, no authority.
- **Cost.** One extra `capture-pane` per agent pane per 2 s tick, only when the pane printed something.
- **Narrow desktop windows.** At 768 px, the default 240 px panel leaves about 528 px for terminals (decision 2 below).
- **Brokered (per-user) terminals.** `captureVisible` needs the broker's tmux schema to allow it (`backend/broker-tmux-schema.test.ts`). If that is not a small change, such terminals keep `agentStatus = null`, and S1 reports it.
- **Shortcut collisions.** Covered in 2.7.

## 10. Out of scope

- Approving agent prompts from a push; push text stays generic (owner decision 3, `docs/plans/2026-10-12-qol-modernization.md:114`).
- Automatic resume at boot (owner decision 4).
- Any change to `~/myclaude`, `~/.claude` or `~/.codex`, including the SessionStart-hook variant of resume (owner decision 6).
- Removing host names from handoffs (owner decision 5); fixtures are still redacted.
- From the report: herdr's tabs and workspaces, plugins, socket API, multi-machine view, remote rule updates, sounds, saved scrollback and hook-based state.
- Task Runner reading `agentStatus`.
- Upgrading the vendored xterm.js.
- Reclassifying Claude's own "waiting for your input" notification.

## Decisions taken by the operator (2026-10-22, reported to the owner)

1. `AGENT_DONE_PUSH_MIN_WORK_MS = 15 s`: a short back-and-forth does not push "finished" for every Claude turn. It can be tuned after the dogfood week, or set to 0 to push every turn end.
2. The panel stays on at every desktop width, as the owner asked ("defaultne zapnuty"). Below about 1024 px the owner can hide it with the toggle; it does not hide itself.
3. One opt-in mechanism for new server-to-client WebSocket frames: a flag in the socket URL, stored next to `protocol` and `clientId`. The phone repair slice (M0) adds `scroll=1` for `scroll-position` frames; S2 adds `agents=1` for `agents_changed`.
