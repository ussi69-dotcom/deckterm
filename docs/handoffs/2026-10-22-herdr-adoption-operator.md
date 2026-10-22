---
status: consumed
updated: 2026-10-22
next: Run done on dev (nothing on main or production). Open owner items only - the phone checklist answer (Slack thread 1792678234.328939; a reported failure becomes a new fix/mobile-* slice with a test), promotion of dev to main, and the VAPID key rotation decision. See "Final state".
---

# Operator state: DeckTerm phone repair, then herdr adoption (agent state, Agents panel, resume)

This file is both the handoff and the operator's **state file**. The operator rewrites it at each milestone and re-reads it after every compaction.

## START HERE

- **How this run starts.** The owner works from a phone and cannot copy long prompts. The owner opens a new Claude Code session in `/home/deploy/deckterm_dev` and says only "zahaj praci na upgrade deckterm dle planu" ("start work on the DeckTerm upgrade according to the plan"), or something close to it. That sentence is the launch. This file is the whole plan; a project memory note points at it.
  - Begin at once with the STOP check "Hosted on dev" and the Baseline, then follow this file. Do not ask the owner to confirm the plan.
  - Recommended settings: Opus 5.5 at effort xhigh with ultracode on, and an auto-compact window of about 600k. If your session differs, tell the owner in one line (`/model claude-opus-5-5`, `/effort` → xhigh plus ultracode) and carry on without waiting. Without ultracode use Agent subagents instead of workflows.
  - Ask open question Q1 once in your first message, without waiting for the answer.
  - Keep every message to the owner short and in Czech: the owner reads them on a phone.
- **Role.** You are the **operator** of an autonomous run (load the global skill `autonomous-orchestrator`). You work in an interactive Claude Code session that the owner may watch.
  - You decide, delegate bounded work, repair your own faults, merge into `dev`, deploy and test on dev, and report outcomes.
  - You do not ask for ordinary steps. Classify every decision by the skill's tiers: act / act and report back / ask and keep working.
- **What to build, in this order.**
  1. **First: make the current DeckTerm usable on a phone** (slice M0). The owner's latest instruction puts the review and repair of the current version ahead of everything else ("hlavne", owner decision 7).
  2. **Then:** the recommendations of the research report `docs/research/2026-10-22-herdr-feature-review.md` (read it first), changed by the owner decisions below.
  - **herdr** is an open-source terminal workspace manager for AI agents. The report compared it with DeckTerm and recommends porting its screen-based agent detection plus two features built on it.
- **Host and repository.**
  - Host `OVH-PL-LAB-01`, user `deploy`. Repository `/home/deploy/deckterm_dev`.
  - At handover the checkout is on branch `docs/herdr-feature-review` at the commit that added this file. That branch is `dev` (`8beed479171c5f08f4a3dda7cdb7d1a9ba740320`, equal to `origin/dev`) plus two docs-only commits: `b6d4f6e` (the report with its assets and the consumed review handoff) and the commit that added this file and the report's owner-decision note.
  - `origin/main` = `b04c791748af1718806b26f1e90d698a1a66ed93`.
  - Production runs release `/home/deploy/apps/deckterm/prod/releases/b04c791748af1718806b26f1e90d698a1a66ed93` through `prod/current`.
  - The only untracked path is `.omo/`. Leave it alone.
- **Services.**
  - Production: `deckterm.service` on `127.0.0.1:4173`, state `~/.deckterm`. **Never touch it.**
  - Development: `deckterm-dev.service` on `127.0.0.1:4174`, state `~/.deckterm-dev`, tmux socket `~/.deckterm-dev/tmux/deckterm_deckterm.sock`.
  - **The dev service runs from this checkout.** Whatever branch is checked out is what dev serves after a restart, and files under `web/` are served from disk immediately.
- **Repo rules.** `CLAUDE.md` and `AGENTS.md` in this repository. Highlights: tests run only against 4174; `bun x tsc --noEmit` is a hard gate; new test files must be added to `test:unit` in `package.json`; foundation-bearing tests run in their own `bun test` invocation; never edit `web/vendor/`.
- **Routing.**
  - Diffs get one independent review from Codex through `~/.claude/bin/codex-caller` (probe it first; its auth expired once on 2026-10-12). If it does not answer, use an Opus adversarial-review subagent or workflow and say so in the report.
  - The advisor tool is for you only, before consequential decisions and before declaring done.

## Goal in the owner's words (each with its check)

Owner, 2026-10-22, verbatim:

- Analysis request that led to the report: "chci aby to jeste jednou analyzoval, jestli nam neprospeje vic veci treba ty zalozky a levy bar s projekty a prehledem, nebo jesli nema lepsi sledovani aktivity agentu atp."
- This run's mandate: "priprav handoff na implementaci pres interactive orchestrator, at to autonome nasadi a otestuje na dev, jo IDE rezim nakonec moc nepouzivam, tak by ty funkce meli byt i v defaultnim view ale togglovatelny, defaultne zapnuty a resizovatelny tak jak to tu delame"
- About this branch: "pushni větev, hostnames v handoffu nech"
- Priority change, after reading the launch card: "hlavne se ale zamer i na review a opravu soucasne verze. na mobilu je to porad dost nepouzitelne, porad mi oskakuje nekam focuc kdyz pisu naskakuje virtual keyboard, neda se v sessions scrollovat nahoru posuvnik se neda chytit, touch to scrol vubec nejde. zamer se i v jinych software nebo v tom herderu jak to maj resene, jestli bychom nemohli neco ptevzit a pak otestovat pro mobilni device i"
  - In plain words: above all, review and fix the current version. On a phone it is still close to unusable: focus keeps jumping while typing as the on-screen keyboard appears, sessions cannot be scrolled up, the scrollbar cannot be grabbed, and touch scrolling does not work at all. Look at how other software and herdr solve this, adopt what fits, and then test on mobile devices.

| Goal phrase | Check that shows it is met |
| --- | --- |
| "hlavne ... review a opravu soucasne verze" (above all, review and fix the current version) | M0 is the first code slice merged into `dev`. The review note `docs/audits/2026-10-22-mobile-usability-review.md` lists every phone problem found, each marked fixed, or deferred with a reason. |
| "oskakuje nekam focus kdyz pisu, naskakuje virtual keyboard" (focus jumps while typing as the keyboard appears) | Touch e2e: with the terminal input focused and the keyboard simulated (see M0), typing 40 characters with viewport changes in between leaves focus on the terminal input. The page and container scroll positions do not move. The terminal snaps to the prompt only when the keyboard opens or the user types, never while the user reads history. |
| "neda se v sessions scrollovat nahoru", "touch to scrol vubec nejde" (sessions cannot be scrolled up; touch scrolling does nothing) | Touch e2e with real touch events (CDP, see M0) on a tmux shell holding 400 lines: a one-finger upward drag shows earlier lines and a downward drag returns. A drag over an app with mouse reporting reaches the app as wheel input. A sideways swipe still switches sessions. A drag never opens the keyboard. |
| "posuvnik se neda chytit" (the scrollbar cannot be grabbed) | Touch layouts, while scrolled back: a position indicator with a draggable handle (touch target at least 44 px) and a "jump to latest" button. e2e drags the handle and the view moves; tapping "jump to latest" returns to the prompt. |
| "zamer se i v jinych software nebo v tom herderu" (look at other software and herdr) | A section of at most half a page in the review note: what herdr, xterm.js-based web terminals and phone terminal apps do, what DeckTerm adopted and what it rejected, with links. |
| "a pak otestovat pro mobilni device" (then test on mobile devices) | The M0 touch specs run at 390×844 (phone) and 820×1180 (tablet). Phone screenshots are reviewed. The owner gets the dev URL and the phone checklist (M0) once, and the answer is recorded in Progress. |
| "lepsi sledovani aktivity agentu" (better agent-activity tracking) | S1 fixture suite of real tmux captures is green. On dev, a Claude question form and a Codex approval prompt each show "needs your answer" within about 4 s and send the generic push. `/api/terminals` carries `agentStatus` and `agentStatusRule`. |
| "levy bar s projekty a prehledem" (left bar with projects and an overview) | Desktop: an Agents panel on the left lists sessions grouped by project (git repo root, else cwd), sorted needs-you > done-unseen > working > idle, with counts on top and a "Next" button. |
| "i v defaultnim view" (also in the default view, not only IDE mode) | The panel works in the default desktop view (≥ 768 px, not IDE mode). In IDE mode the same list renders as an activity-bar view "Agents". Phone gets the summary chip and a sorted Sessions sheet. |
| "togglovatelny" (toggleable) | Show/hide from a toolbar button, a palette action, a keyboard shortcut and a Settings toggle. e2e: the choice survives a reload. |
| "defaultne zapnuty" (on by default) | With cleared settings for the actor, desktop shows the panel and phone shows the chip. e2e covers both. |
| "resizovatelny tak jak to tu delame" (resizable the way we do it here) | A right-edge sash on the panel with the same contract as the IDE sidebar sash (`web/app.js:13144-13200`, see S2). e2e: dragging changes the width and the terminals' column count, the width survives a reload, and a double-click resets it. |
| "at to autonome nasadi a otestuje na dev" (deploy and test on dev on its own) | All slices merged into `dev`, `dev` pushed to `origin/dev`, `deckterm-dev.service` restarted, `/api/health` ok, full e2e green on 4174, desktop and phone screenshots reviewed by you as a first-time reader. M0 went through this whole cycle on its own before the herdr slices. |

## Owner decisions in force

1. **The default view comes first.** The owner rarely uses IDE mode. Every new UI must work in the default view; IDE mode reuses it. This overrides the report's "no permanent left sidebar in the classic layout". The report's "Owner decisions" section records the change.
2. **The report's recommendations are accepted** as the scope: its top three, the Codex-title first step, explain/diagnostics, the push deep link, and the Web Push key hygiene. The owner asked to implement them, with the change in decision 1.
3. **Push text stays generic.** Approving agent prompts from a push is a no (`docs/plans/2026-10-12-qol-modernization.md:114`).
4. **Resume is one tap and never automatic** (report, item 3).
5. **Host names in handoffs stay** ("hostnames v handoffu nech").
6. **No changes to `~/myclaude`, `~/.claude` or `~/.codex`.** The report's optional SessionStart-hook variant of resume is out of scope (global `CLAUDE.md`: hooks live in `~/myclaude`).
7. **The phone repair comes first** (owner's "hlavne" message above). M0 is merged, deployed and tested on dev before any herdr slice merges. Only the docs slice D and the small backend slice S0 may run alongside it.

## Open owner questions

- **Q1. Which phone and browser?** iPhone in Safari, iPhone as a Home Screen app, Android in Chrome, or other. The conductor asked on 2026-10-22. If the answer is not recorded here, ask once in the terminal at the start, without waiting for it. It matters for M0: iOS ignores `interactive-widget=resizes-content`, lays the keyboard over the page and pans the page while typing. Until answered, cover Android Chrome by emulation and iOS through the owner's phone checklist.
  - Answer: (not yet)

## Slices

Order: M0 first; D and S0 may run alongside it. After M0 is on dev: S1a, then S1 and S2 in parallel (S2 builds against the `agentStatus` contract from the design doc), then S3, then integration, gates, deploy, e2e, visual QA and fixes.

Run at most two code slices at once: the `dev` checkout and the e2e run on 4174 are serial resources.

### M0. Phone review and repair (first code slice, owner's priority)

Branch `fix/mobile-*`. Every change is gated on `isTouchLayout()` (`web/app.js`), so desktop behaviour stays as it is. Never fall back across device classes (the `terminal.extraKeysVisible` / `terminal.extraKeysVisibleTouch` precedent).

**Step 1. Reproduce before fixing (red first).**

- **Why tests first.** No spec in `tests/` sends a real touch drag today (checked on 2026-10-22: no `Input.dispatchTouchEvent`, no `TouchEvent`). That is why these phone problems keep coming back.
- **Context.** Playwright Chromium with `hasTouch: true, isMobile: true`, at 390×844 and 820×1180.
- **Drags.** Playwright's `page.touchscreen` only taps. Send drags through CDP: `page.context().newCDPSession(page)`, then `Input.dispatchTouchEvent` with `touchStart`, several `touchMove` steps and `touchEnd`.
- **Keyboard.** The on-screen keyboard cannot be emulated. Simulate it: focus the terminal's helper textarea, then shrink the viewport height with `page.setViewportSize` by about 45 %. That drives the same `visualViewport` resize path that `web/mobile-layout.js` uses to detect a keyboard.
- **Instrument the focus problem first.** In the touch context, record while typing:
  - `focusin` / `focusout` targets;
  - `visualViewport` resize and scroll, `window.scrollY` and the tile container's scroll position;
  - xterm `onScroll`.

  Put the trace in the review note. "Focus jumps" can be three different faults with three different fixes: the page pans, focus leaves the textarea, or the terminal snaps to the bottom.
- **Browsers.** Only Chromium is installed for Playwright on this host (`~/.cache/ms-playwright`). You may try `cd tests && npx playwright install webkit` (tier 2; no `sudo`, no system packages); if it cannot launch, skip it. Desktop WebKit is not iOS Safari anyway: iOS keyboard behaviour can only be checked on a real iPhone, through the owner's phone checklist below.

**Step 2. What the code shows today.** These are hypotheses with locations, from reading the code on 2026-10-22. Confirm each with the Step 1 probe before fixing it.

1. **Touch scrolling does nothing.**
   - Under the tmux backend the browser terminal (xterm.js 5.3.0, vendored in `web/vendor/`) always stays on its alternate screen buffer. The tmux client draws the screen; the history lives in tmux, not in xterm.js. See the comment at `shouldRouteScrollToTmux` in `web/extra-keys-scroll.js`.
   - So xterm.js's own touch scrolling has nothing to scroll. It also ignores touches completely when an app has turned on mouse reporting (Claude Code in fullscreen mode, Codex).
   - The only bridge to tmux history is the mouse-wheel handler `attachTmuxScrollbackWheel` (`web/app.js:15253`). It sends `{type:"scrollback"}` to the server, which runs tmux copy-mode (`scrollHistory`, `backend/services/tmux-terminal-backend.ts:387`).
   - One-finger touches are used only by the sideways session swipe (`setupMobileSwipe`, `web/app.js:14475`), two-finger touches by the container pan (`setupTouchGestures`, `web/app.js:1516`). Nothing turns a vertical finger drag into scrolling.
2. **"Sessions cannot be scrolled up"** is the same root cause: a phone has no wheel. Also note that `scrollHistory` refuses alternate-screen panes, so an app like `less` without mouse reporting gets nothing.
3. **The scrollbar cannot be grabbed.** In the alternate buffer xterm's scrollbar has no range, so there is nothing to grab. Phone browsers also draw overlay scrollbars that cannot be dragged. A thicker xterm scrollbar will not help. A DeckTerm-drawn position indicator fed from tmux (`#{history_size}`, `#{scroll_position}`) will.
4. **Focus and position jump while typing.**
   - `handleViewportResize` (`web/app.js:17294`) runs on every `visualViewport` resize and scroll and on every `focusin` / `focusout` (`setupViewportResizeHandling`, `web/app.js:6481`).
   - Its "nothing changed" guard compares a key that includes `appTop`, the visual viewport's offset. That changes whenever the phone pans the page, so the guard rarely holds.
   - Each pass then calls `focusTerminal` (`web/app.js:11611`). That calls `ensureTileVisible` (`web/app.js:1506`, a smooth `scrollIntoView`), then `terminal.focus()` before the `preventScroll` focus, then `scrollToBottom` on every touch device (`scrollToPrompt = layout.keyboardOpen || platformDetector.hasTouch`, `web/app.js:17363`).
   - Candidates to verify: act only when the keyboard opens or closes, never re-focus from a viewport event, `preventScroll` on every focus, no `scrollIntoView` on touch, and scroll to the prompt only when the user types or taps "jump to latest".

**Step 3. What to build.** You decide the details; record the choices in the review note and report them.

- **A touch gesture layer over each terminal**, touch layouts only:
  - Axis lock after a small slop (about 8-10 px). Sideways keeps the session swipe; vertical scrolls.
  - Route vertical scrolling the way herdr routes wheel input (Step 0):
    - app with mouse reporting → wheel events to the app (SGR mouse encoding);
    - tmux pane on the normal screen → tmux history (the existing `scrollback` message);
    - alternate-screen pane without mouse reporting (`less`, `man`) → Up/Down arrow keys. herdr calls this "AlternateScroll". Add it only if a test proves it.
  - First check whether dispatching synthetic `WheelEvent`s on xterm's element gives both existing paths for free: DeckTerm's capture handler and xterm's own mouse reporting.
  - Momentum after release (a decaying velocity), stopped by a new touch.
  - A tap without movement focuses the terminal and may open the keyboard. A drag never does. A long press keeps today's selection behaviour.
- **A scroll position indicator on touch layouts**, shown while scrolled back and hidden at the bottom: a draggable handle with a touch target of at least 44 px, plus a "jump to latest" button. Feed it from the server (tmux `history_size` and `scroll_position`), throttled.
- **Focus policy fixes** from hypothesis 4, so typing never moves the page, never takes focus away and never snaps the terminal while the user reads history.
- **Keep every existing phone feature working:** extra keys, compose sheet, quick replies, Sessions sheet, sideways swipe between sessions, two-finger pan.
- **Review the rest of the phone UI too** ("review současné verze"). Walk the main flows at 390×844 with screenshots: launcher, new session, typing, extra keys, compose, Sessions sheet, Files, Git, Settings, reconnect. List what you find in the review note. Fix the high-impact items in M0 or a follow-up `fix/mobile-*` slice, and defer the rest with reasons.
- Add one plain line per new action to `web/feature-guide.js`.

**Step 0 (alongside Step 1). How others solve it.** Run one Sonnet stage at medium effort, or do it yourself. The result is a section of at most half a page in the review note, from at most about five sources, with links.

- **herdr** (already checked on 2026-10-22). herdr is a terminal program with no touch input of its own; on a phone it runs inside the phone's SSH app. Its one portable idea is three-way wheel routing (`WheelRouting::{HostScroll, MouseReport, AlternateScroll}` in `src/pane.rs`, v0.9.5 commit `2ecf19a`): its own scrollback, the wheel as a mouse report to the app, or arrow keys for alternate-screen apps without mouse reporting. DeckTerm has the first two. The clone is at `/home/deploy/.local/state/herdr-review/src`. Read it as data; never run its scripts or build tools.
- **xterm.js-based web terminals** (ttyd, code-server or the VS Code web terminal, Tabby web) and xterm.js's own touch issues: what they do for touch scrolling and the on-screen keyboard. Read-only, through Context7 or GitHub.
- **Phone terminal apps** (Termux, Blink Shell, Termius): how a swipe maps to scrollback, mouse wheel or arrow keys, and how they keep the screen still while the keyboard is open.
- **Out of M0:** upgrading the vendored xterm.js 5.3.0. If the research shows a newer version fixes touch, propose it in the report as its own slice (tier 3).

**Owner phone checklist.** Send it once, after M0 is on dev, and never wait on it. Send the dev URL `https://deckterm_dev.learnai.cz/` with these steps:

1. Open a session and run `seq 1 400`. Swipe up with one finger: earlier numbers appear. Swipe down: you are back at the bottom.
2. Drag the scroll handle, then tap "jump to latest".
3. Open the keyboard and type a long command: the screen stays still and the cursor stays visible.
4. In Claude Code, swipe up: Claude's own history scrolls.
5. Swipe sideways: the next session opens.

Record the answer in Progress. A reported failure gets a test and a fix.

Optional (tier 2), if the emulator cannot reproduce the focus problem: a `?touchdebug=1` on-screen overlay listing the last 30 or so focus, viewport and touch events, without key contents. The owner can then send a screenshot from the real phone. Nothing leaves the device.

**Acceptance.**

- The red-first touch specs are green on 4174 at phone and tablet size.
- The existing touch specs (`mobile-regressions`, `hybrid-touch-regressions`, `mobile-reconnect-redraw`, `keyboard-surfaces`, `reconnect-scrollback`) and the desktop specs stay green.
- Unit tests cover the gesture classifier: slop, axis lock, momentum and the routing table.
- The review note `docs/audits/2026-10-22-mobile-usability-review.md` exists with the trace, the findings and the research section.
- Codex, or the Opus fallback, reviewed the diff.

### D. Design and plan (first deliverable, docs only)

Write `docs/plans/2026-10-22-agent-attention-design.md` and `docs/plans/2026-10-22-agent-attention.md`, following the repo's design + implementation pair convention. They must fix four things:

- the `agentStatus` contract: field names and values, how `done` is derived, and the merge with the existing attention flag;
- the Agents panel layout in the default view, including the work area that surface windows and the sessions dock may use;
- the settings keys;
- the fixture policy.

Commit them on `dev` before code.

### S0. Terminal environment hygiene (security, small, first)

- **Why.** Shells inherit the service environment, Web Push private key included. This is the backlog finding in `docs/handoffs/2026-10-12-qol-modernization-operator.md:4`. Terminals are spawned with `...this.baseEnv` (= `process.env`) in `backend/services/tmux-terminal-backend.ts:196-200` and `backend/services/raw-terminal-backend.ts:68-72`.
- **Change.** Remove service-only variables from the terminal environment through one explicit, tested deny-list:
  - at least `DECKTERM_VAPID_*` and the Cloudflare Access secrets or audience values;
  - audit the rest of the service unit's environment and record the list in the design doc.
  - Do not strip `PATH`, `HOME`, `LANG` or `SHELL`.
- **Existing tmux servers.** A running tmux server keeps the old global environment. On dev, after deploy, remove the variables with `tmux set-environment -g -u` on the dev socket (tmux 3.8 binary) or let the next dev tmux restart do it. Production gets it only through a later promotion, which is an owner step.
- **Not your call.** Key rotation is tier 3 for the owner: rotating the VAPID key invalidates every existing push subscription.
- **Acceptance.** A unit test shows the spawn environment lacks the denied variables. On dev, a new terminal's `env | grep -c '^DECKTERM_VAPID'` prints `0`.

### S1a. Codex "Action Required" title means needs-input (S, parallel with S0)

- DeckTerm already reads Codex's window title (`backend/telemetry.ts:109-110,187`).
- Port herdr's rule `osc_title_blocked`: a title containing `Action Required` means blocked (herdr `src/detect/manifests/codex.toml:6-12` at commit `2ecf19a`).
- Raise attention `needs-input` from it, so push and quick replies follow.
- **Acceptance.** A unit test using a captured Codex approval title passes.

### S1. Screen-rule agent state (M): report, top item 1

Build it as the report's design sketch describes. Summary:

- **Evaluator.** `backend/agent-screen-rules.ts` with its tests implements the subset of herdr's manifest format that the Claude and Codex rules use.
  - Rules are vendored as data in `backend/agent-rules/{claude,codex}.toml`, copied from herdr `2ecf19a` with a header naming the source and commit.
  - Use Bun's built-in TOML import. **No new runtime dependency.**
  - A loader translates Rust regex syntax to JavaScript, and a test proves every vendored regex compiles.
- **Input.** A visible-only `capture-pane -p` for panes with an agent, run in the existing 2-second pipe pump (`backend/server.ts:5476-5500,11839-11843`), so detection works with no browser open. Add the latest OSC 0/2 title per terminal.
- **Output.**
  - `agentStatus` (`working | blocked | idle | null`) and `agentStatusRule` on the terminal and in `/api/terminals`. `agentState` stays for compatibility.
  - `done` = idle reached from working or blocked while unseen, through the existing attention `done` path.
  - Blocked raises attention `needs-input`. Push fires once per blocked episode, and the push opens the session (deep link) instead of `/`.
- **Hysteresis.** Copy herdr's: hold working→idle for up to 700 ms, and wait 3 s after an agent appears.
- **Attribution.** A `herdrdev/herdr` section in `THIRD_PARTY_NOTICES.md` (Apache-2.0, "rule data derived from … at 2ecf19a, modified", attributed to herdr contributors).
- **Maintenance.** Record the manual re-sync procedure in the design doc. Never fetch rules over the network.
- **Fixtures.** These are the main quality gate, because herdr ships none for Claude or Codex. They are real tmux captures from dev sessions, saved under `backend/fixtures/agent-screens/`, with host names and paths replaced. Required: at least one per state for:
  - Claude 2.1.308: working, idle, question form, plan approval, Bash permission prompt in a non-bypass session;
  - Codex 0.163: working, idle, approval prompt, trust dialog.

  See "Real-agent fixture capture" under Authority for how. If an agent cannot be run, label hand-made fixtures `synthetic` and report the gap (tier 2).
- **Acceptance.** The fixture suite is green. A dev live check meets the goal-table row for "lepsi sledovani aktivity agentu". A one-line maintenance note exists in the design doc.

### S2. Agents overview in the default view (M): report, top item 2, changed by owner decision 1

- **One view model.** `web/agent-overview.js` with a test, from the `/api/terminals` rows.
  - It uses `agentStatus` from S1 and falls back to today's attention plus `agentState`.
  - Sort with herdr's priority, ties by most recent change. Group by git repo root, else cwd. The git branch per row is optional (tier 2), cached per cwd server-side, behind root checks.
  - Fix the Sessions-panel ranking so unseen `done` and `error` rank above plain running sessions (`web/task-signals.js:193-210`).
- **Desktop, default view (≥ 768 px, not IDE mode).** A left **Agents panel** docked beside the workspace.
  - Content: the counts summary on top ("1 needs you · 2 done · 1 working"), a "Next" button, and the grouped list. Clicking a row focuses or attaches that session.
  - Surface windows (Files, Git, Tasks, Editor), snapping and the sessions dock must treat the panel as outside their work area.
- **Toggle** (on by default):
  - Settings toggle `agents.panelVisible` (default `true`, device class `desktop`), declared in `web/settings-schema.js`;
  - toolbar button, palette action and shortcut, registered in the action registry and `web/keyboard-shortcuts.js`;
  - one plain line in `web/feature-guide.js`.
- **Resize** "the way we do it here" = the IDE sidebar sash contract (`web/app.js:13144-13200`):
  - a sash on the right edge; dragging sets the width, clamped like `clampIdeSidebarWidth` (180 px to min(640 px, 50 % of the window));
  - a double-click resets it to the CSS default;
  - the width is persisted in actor settings under its own key (`agents.panelWidth`, px, `null` = default) through `this.settingsStore`;
  - at drag end, refit every visible terminal with `performReconnectLayoutSync(id, { forceResize: true })`.
- **IDE mode.** The same list renders as an activity-bar view "Agents" (`web/ide-shell.js` `addView`), using the existing `ide.sidebarWidth`.
- **Phone and touch (< 768 px).**
  - A summary chip in the phone top bar: Settings toggle `agents.summaryVisibleTouch`, default `true`, device class `touch`, the same split as `terminal.extraKeysVisible` / `terminal.extraKeysVisibleTouch`.
  - Tapping it opens the Sessions sheet sorted by the same priority, with a "Next" button.
  - Nothing is resizable on the phone. Never fall back across device classes.
- **"Seen" moves to the server.** Store it per actor through the existing `GET/PUT /api/settings` store instead of localStorage (`web/task-signals.js:66`), so phone and desktop agree.
- **Acceptance.** New e2e spec(s) on 4174 at desktop size and at a 390×844 phone viewport check:
  - the panel and chip are on by default;
  - the toggle persists across a reload;
  - dragging the sash changes the width and the terminal column count, the width persists, and a double-click resets it;
  - "Next" visits needs-you first, then done;
  - seen in one browser context is cleared in a second context after reload;
  - Help and the palette list the action.

  Unit tests cover the view model.

### S3. One-tap agent resume (M): report, top item 3

Build it as the report describes:

- a foundation-state migration adding nullable `agent_name`, `agent_session_id` and `agent_session_updated_at` (or a side table);
- the bash wrapper `__deckterm_run_agent` (`backend/shell-integration.ts:33-50`) adds `--session-id <uuid>` to `claude` when the arguments do not already choose a session, and reports the id in the start marker;
- **the id is validated** against the UUID pattern before it is recorded and again on Resume, because a forged marker must be ignored;
- Codex resumes with `codex resume --last` in the saved cwd, or "Resume (pick)" when two Codex sessions shared that cwd;
- a "Resume" action in the Sessions sheet, the launcher and the Agents panel row. It creates a terminal in the saved cwd and types the command with the deferred Enter. Never automatic.
- No transcript reading. No changes to `~/.claude`.

**Acceptance.**
- Unit tests cover the wrapper argument table, the forged-marker case and the migration.
- On dev: start Claude (cheap model, see Authority) in a session, restart the dev tmux server under the pile-up rule in Authority, then tap Resume. The same conversation opens in the same cwd.

### Integration, deploy and test

- M0 runs this whole cycle by itself first: merge, gates, deploy, the full e2e run, phone screenshots and the owner phone checklist. The herdr slices follow in a second cycle.
- Merge slices in an integration worktree created from `dev`. Run `bun x tsc --noEmit` and `bun run test:unit` there. Then fast-forward `dev`, push `origin/dev`, restart `deckterm-dev.service`, and check `/api/health`.
- Run `bun run test:e2e:smoke`, then the full suite (`cd tests && PW_BASE_URL=http://localhost:4174 npx playwright test`).
- Visual QA: desktop and 390×844 phone screenshots of the default view, the panel, the chip, the sheet and IDE mode. Use the `visual-qa` or `playwright-cli` skill. **Never commit screenshots that show host details.**
- Fix what QA finds, then repeat the gates.
- End with the OpenKnowledge sync through `ok-project-sync`, the project convention.

## Authority

**Act, record, report after (tiers 1 and 2):**

- **Worktrees and branches.** Create worktrees by hand from `dev` and verify the base sha; workflow worktrees have branched from stale commits here before. Branches are named `feat/agent-*`.
- **Private instances.** Ports 4281-4299. Start them with `env -i` and explicit values, and keep their state dirs short under `/tmp/claude-1001/<x>`.
- **Dev branch and service.** Commit design docs on `dev`, merge into `dev`, push `dev` and `feat/agent-*` branches to `origin`, and restart `deckterm-dev.service`. Revert with `git revert`, never by rewriting pushed history.
- **Dev tmux.** Inspect it with `/home/deploy/opt/tmux-3.8/bin/tmux -S ~/.deckterm-dev/tmux/deckterm_deckterm.sock` (the system tmux 3.4 cannot talk to a 3.8 server).
  - If the e2e pile-up hits the `MAX_TERMINALS` cap, end the e2e-created sessions first.
  - Kill the dev tmux server only after listing it and finding no non-test session, and record the listing in "Progress".
  - On 2026-10-22 dev had 0 terminals.
- **e2e on dev.** Playwright runs only against 4174, and only while this session is not hosted on dev (see STOP).
- **Real-agent fixture capture**, for screen fixtures and the S3 check:
  - Claude: `claude --model claude-haiku-5-5`, in a scratch directory under `/tmp/claude-1001/`, without `--dangerously-skip-permissions`.
  - Codex: only if `codex login status` reports logged in, otherwise synthetic fixtures (tier 2).
  - Prompts are short and harmless, for example asking it to ask you a question, or to run `ls` so a permission prompt appears.
  - At most about 15 short sessions in total. Quit each session when done.
- **Subagents and workflows.** Follow `workflow-model-tiering`. Workflows only if ultracode is on in this session; otherwise use Agent subagents. End every agent prompt with "Do not call the advisor tool."
- **OpenKnowledge.** Sync at the end through `ok-project-sync` (project docs live in `~/openknowledge/projects/deckterm/`).

**Ask the owner, and keep working on everything independent (tier 3):**

- Anything on `main` or production: a PR to `main`, promotion, `deckterm.service`, the production tmux socket, production drop-ins, VAPID key rotation.
- Changes to `~/myclaude`, `~/.claude` or `~/.codex`.
- A new runtime dependency in `package.json`.
- Anything outward-facing: Slack, public posts, a new external service.

**STOP conditions:**

- **Hosted on dev.** At start, check your own environment. If `$TMUX` points under `~/.deckterm-dev`, this session is hosted on dev and the e2e helper `resetAppState` would delete it. Do no e2e; tell the owner to relaunch from a production DeckTerm terminal or a plain SSH shell.
- **Production in reach.** A step would touch port 4173, `~/.deckterm`, the production tmux socket or the production systemd unit: stop that step.
- **Red gate.** If `dev` is red after a merge and cannot be fixed in the run, revert that merge on `dev`, keep `dev` green, and report.

## Baseline (record before the first change)

- `git rev-parse dev origin/dev origin/main docs/herdr-feature-review` and `git status --short` (expect only `.omo/` untracked).
- `systemctl --user is-active deckterm-dev.service` and `curl -s http://localhost:4174/api/health`.
- `bun x tsc --noEmit` and `bun run test:unit`: record the pass/fail counts here.
- `bun run test:e2e:smoke`: record the result.
- `~/.claude/bin/codex-caller` reachability; `codex login status`; `owner-decisions doctor`. On 2026-10-22 `owner-decisions` was not on PATH, which means terminal-only owner messages.

## Progress

(The operator fills this: slices, merges, gate results with counts, deploy times, e2e results, review findings, decisions taken for the owner.)

### 2026-10-22, operator session 4884127a (Opus 5.5, xhigh, ultracode on), started 12:27 UTC

- **STOP check.** `$TMUX` = `~/.deckterm/tmux/...` (production DeckTerm), not dev, so e2e on 4174 is allowed. The e2e harness now runs in its own actor namespace (`deckterm_e2e_run` cookie, `tests/fixtures.ts`), so it no longer deletes non-test sessions.
- **Dev sessions at start (not test sessions, keep them):** `15c617b9…` (claude at a trust prompt in `/home/deploy`) and `ddd3b7ae…` (the conductor Claude that wrote this file), both created 12:19-12:20 UTC.
- **Baseline.** `dev` fast-forwarded to `530e90e` (= `docs/herdr-feature-review`); `origin/dev` = `8beed47`; `origin/main` = `b04c791`. Dev service active, health ok (build `d99c4347f020`). `tsc` 0 errors. `test:unit` 1686 pass / 0 fail. `test:e2e:smoke` 32/32 pass (56.9 s). `codex-caller` answers (profile deep); `codex login status` = logged in. `owner-decisions doctor` passes (`~/.claude/bin/owner-decisions`, channel #ovh-operator), so milestones go to Slack as well as the terminal (tier 2: the handoff assumed terminal-only because the tool was not on PATH).
- **Q1** asked in the terminal and as Slack question `1660e2db` (expires 2026-10-25 12:34 UTC). Background `owner-decisions wait` armed.
- **13:20 UTC. M0 understanding done** (workflow `wf_49dbb4ab-fa5`; results in the session scratchpad `m0/*.json`, phone screenshots under `/tmp/claude-1001/m0w-walk/shots/`). Measured: the browser xterm is on the NORMAL buffer (tmux's `?1049h` is dropped before the socket exists), so local scrollback is junk and tmux copy-mode is the only real history; no touch path reaches it (F1); focus returns 3-9 ms after the keyboard is dismissed (F2); every viewport change snaps to the bottom on touch (F3); keys typed in copy-mode are eaten (F8). Port 4281 is held by an unrelated `ok-public-shim` process: private instances use 4291-4299. A private instance needs `LANG=C.UTF-8`, or tmux prints `_` for TAB in `-F` output and the client-size sync breaks (F15).
- **M0 contract:** `/tmp/claude-1001/m0-contract.md` (copy in the session scratchpad). The server routes touch scrolling from tmux's live pane state (mouse app → wheel reports, alt screen → arrow keys, else copy-mode history); scroll-position frames to sockets whose URL has `scroll=1`; touch-only scroll handle and "Jump to latest"; the focus policy from H3. Decided for the owner (tier 2): a key tap with the keyboard closed does not open it; reconnect and viewport changes keep the reader's position; typing while scrolled back returns to the latest output first; F6, F7, F9, F10, F13, F14 and F15 deferred with reasons; the DPR 2-3 WebGL text-size artifact goes on the owner's checklist.
- **D committed** on `dev` as `c86ea9d` (open questions settled as operator decisions: done push only after 15 s of work; panel stays on at every desktop width; one URL-flag opt-in for new socket frames).
- **S0** commit `74b47db` (deny-list: `DECKTERM_` prefix, `CF_ACCESS_` prefix, PORT, HOST, TRUSTED_ORIGINS, ALLOWED_FILE_ROOTS, TMUX_BACKEND, TMUX_SESSION_NAMESPACE, TMUX_REQUIRE_EXTERNAL_SERVER, MAX_TERMINALS_PER_USER, TERMINAL_IDLE_TIMEOUT_MS, `TERMINAL_RATE_LIMIT_`, `SCROLLBACK_MAX_`, `OPENCODE_WEB_`, the two responding-idle timings; unit 1703/0). Codex security review: P1 scrub failure must not pass silently, P2 scrub per-session environments too, P3 tests must use an empty tmux config. Fix agent running in the S0 worktree.
- **13:23 UTC. S0 merged into `dev`** (`7f9434f`; branch commits `74b47db`, `011aab6`, `0624fbf`). Codex round 1: P1 silent scrub failure, P2 per-session env, P3 test config; all fixed in `011aab6`. Re-check: two gaps in the new guard (verification not tied to the server identity; sessions addressed by name), fixed in `0624fbf` (repair loop stops here: not spend-booking code). Gate on merged `dev`: tsc 0; test:unit 1509 + 211 pass, 1 timeout in `retention.test.ts` under host load (8.5 s vs 5 s; passes 4/4 alone). Dev restarted 13:22:55 UTC under the e2e lock. A new dev terminal (isolated e2e namespace, deleted afterwards): `DECKTERM_VAPID*` 0, denied names 0, PATH/HOME/LANG kept; tmux global env clean. Out of scope, recorded: `BrokeredTmuxBackend` (OS isolation off on dev and prod). Side effect to report: `scripts/backup-state.sh` run by hand from a dev shell now defaults to the production state dir.
- **The owner's two dev sessions ended at 12:35 and 12:36 UTC** through the 15-minute "close later" window (journal `[close-later] Ending terminal …`). Both already had `terminationScheduledAt` set at 12:29, so the owner closed them. With no session left, the dev tmux server exited. Not caused by this run.
- **Q1 answered 13:24 UTC (Slack): Android, Chrome.** Chrome on Android honours `interactive-widget=resizes-content`, so the emulated keyboard (viewport shrink) matches the owner's phone; iOS is not the target.
- **M0 built** (workflow `wf_f492f400-14e`): `fix/mobile-m0-be` `233f492`, `fix/mobile-m0-scroll` `82716b1`, `fix/mobile-m0-focus` `f833d6d`. Red first on unfixed dev: scroll spec 5 fail / 2 pass, focus spec 12 fail / 8 pass (traces in the agents' results). Merged in integration worktree `/home/deploy/deckterm-work/m0-int` (`fix/mobile-m0`; conflicts only in package.json and the end of styles.css), plus `ed752bc` (retention test timeout 30 s: it ran 6-9 s on the loaded disk and stopped the test:unit chain). Gate: tsc 0, test:unit 1801/0.
- **13:27 UTC. `dev` fast-forwarded to `ed752bc` (local, NOT pushed yet), dev restarted** (build `d068b6612874`). New M0 specs on 4174: 27/27 pass. Full e2e: **215 passed, 0 failed, 0 flaky (10.4 min)**.
- **Reviews of M0** (`reviews/codex-m0.md`, `reviews/adv-m0.json` in the scratchpad). Codex: P1 input before a scroll is confirmed can land in copy-mode; P1 a failed exit releases held input; P1 unbounded per-terminal queue; P2 timeouts do not stop the tmux command; P2 momentum continues after Latest/typing; P2 brokered backend advertises what it cannot do; P2 legacy X10 report not byte-safe above col 95; P3 desktop `ensureTileVisible` changed to `auto`. Adversarial (4 finders, 3 Opus refuters): confirmed X10 encoding (P2), momentum (P3), missing e2e for typing while scrolled back (P2); unverified P3s: unclamped col/row, terminal replies (DA/CPR/focus) trigger leaving scrollback, a fixed 500 ms sleep, a copy-mode test scanning the whole buffer. Fix workflow `wf_97db59f8-a89`: `fix/mobile-m0-fixbe` (server barrier for `scroll=1` sockets, confirmed exit, bounds, killing timeouts, SGR always, clamps, brokered capability) and `fix/mobile-m0-fixfe` (client unconfirmed-scroll state, terminal-reply filter, halt momentum, desktop `smooth` restored, new e2e) in `/home/deploy/deckterm-work/m0-fix{be,fe}` from `ed752bc`; private ports 4295/4296.
- **M0 review fixes merged** (`fix/mobile-m0-fixbe` `47f5541`, `fix/mobile-m0-fixfe` `c6401cd`+`b359577`; gate tsc 0, unit 1842/0). **`dev` = `43f5fc3` "Merge slice M0"**, dev restarted (build `a70120381daa`), full e2e **217/217, 0 retries (10.5 min)**. Codex re-check: fixed = queue bounds, brokered capability, SGR, desktop smooth; partly = barrier race, unreadable-state exit, killed tmux client, CPR/Shift+F3. Repair loop stops (not spend code). Operator decisions: keep "unreadable state writes the input" (dropping typed keys is worse; pre-M0 behaviour), accept the killed-client and Shift+F3 residuals; fix the barrier race, an absolute 2 s exit deadline and adjacent-only coalescing in `fix/mobile-m0-fixbe2` (agent running, worktree `/home/deploy/deckterm-work/m0-fixbe2`).
- **Review note** `docs/audits/2026-10-22-mobile-usability-review.md` and contract `docs/plans/2026-10-22-mobile-touch-repair-design.md` committed (`7a86d6b`); stale buffer comment in `web/extra-keys-scroll.js` corrected. **`dev` pushed: `origin/dev` = `7a86d6b`.**
- **Visual QA (phone 390x844, build `d068b6612874`)**: drag shows tmux history (`[15/372]`, `[43/372]`), handle and "↓ Latest" pill visible, keyboard typing keeps focus, keyboard close leaves focus on BODY. New findings: **F17** touch typing doubles uppercase letters and spaces (pre-existing, also on pre-M0 code; likely hardware/BT keyboards, probably not Gboard) and **F18** thin handle: agent running on `fix/mobile-input-doubling` (`/home/deploy/deckterm-work/m0-input`).
- **Owner phone checklist sent** 14:57 UTC (terminal + Slack thread `1792678234.328939`), 6 steps incl. the text-size question. Answer: (not yet).
- **S1a + S1 running**: workflow `deckterm-s1-screen-rules` (`wf_562e0c1b-540`), worktree `/home/deploy/deckterm-work/s1` (`feat/agent-s1-screen-rules` from `43f5fc3`), private instance port 4291 (state `/tmp/claude-1001/s1cap`); stage 1 captures real Claude (haiku) / Codex fixtures, stage 2 builds the engine.
- **15:10 UTC.** `fix/mobile-m0-fixbe2` `c6c0d2e` merged as `a8abf58` (unit 1847/0; M0 specs + smoke + reconnect 62/62 on 4174), pushed. **S1a+S1 built** (`bd875fb` 12 real fixtures, 0 synthetic; `6a53aa4` S1a; `4734da3` S1; unit 1909/0; live on 4291: Claude question form blocked in 1.5 s, Codex approval in 0.6 s; added DeckTerm rule `deckterm_blocked_form_wrapped` for the 44-column Claude form; Codex flag `-a untrusted` does not exist in 0.163, captures used `-s read-only -a on-request`). Accepted (tier 1/2): the wrapped-form rule, the design-doc section 4 edits, done threshold = working time across the turn excluding blocked time. Reviews running: Codex `reviews/codex-s1.md`, workflow `wf_25f8d5de-7a6`. **F17 fixed** on `fix/mobile-input-doubling` (`6c56022` keypress claim + composition diffs, `6f5eb50` visible thumb pill; unit 1853/0; new spec `tests/mobile-input-once.spec.ts` 7/9 red on dev, 9/9 green routed; 90/90 routed regression); Codex review running (`reviews/codex-f17.md`). **S2 started**: worktree `/home/deploy/deckterm-work/s2` (`feat/agent-overview` on top of `4734da3`), private port 4298.
- **16:20 UTC. F17 merged** as `357b6f3` (`fix/mobile-input-doubling`: `6c56022`, `6f5eb50`, `7c1d511`, `681eee0`; Codex review + re-check, one extra round accepted because it is the owner's main input path). Gate: tsc 0, unit 1869/0; full e2e **238/238 (11.1 min)**. Pushed: `origin/dev` = `357b6f3`. Behaviour change to report: with a composing keyboard (Gboard suggestions, glide) a word appears underlined and reaches the shell when the keyboard commits it.
- **S1 review fixes** (`44e1410` linear rules + region caps + perf test, `6492162` service worker, `b88c7a9` capture pool off the pump / dirty flag / episode across re-attach / size clamps, `429f087` e2e spec): unit 1939/0, push 23/0. Codex re-check running (`reviews/codex-s1-recheck.md`). The deep-link page code is S2's (as briefed).
- **17:30 UTC. S1+S2 on dev.** S1 review fixes + Codex re-check (all six originals fixed; new P2 line-cut false match fixed by the operator in `292502e`: lines cut only beyond 2048 chars, cut lines end in U+2026). S2 built (`586de00`, `b6efee8`, `823ddec`) + operator fix `8b343db` (only agent sessions count as "working"). Integrated in `/home/deploy/deckterm-work/int2` (`int/herdr-s1-s2`), operator fixes `3dfc29e` (exit-deadline vs unreadable race, a flaky unit test under load), `3758663` (blocked -> idle done bypasses the 2 s window; a flaky agent-status e2e), `b18babf` (exact toolbar button names in 3 specs; Agents panel rows collided with getByRole name "Git"). Gate: unit 2025/0, push 23/0, census ok. Full e2e 249/250, the 1 failure fixed and re-run green (4/4). **`origin/dev` = `b18babf`.** Visual QA on dev: desktop panel "1 needs you" with Needs-you row and toast for a fake Claude form (`agentStatus` blocked, rule `live_blocked_form`), phone chip "● 1" opening the sorted Sessions sheet.
- **S2 reviews:** adversarial 0 confirmed; Codex (full range) P2 chip hidden for non-agent unseen attention, P2 panel re-render drops keyboard focus, P2 quick replies with `agentStatus` null (rejected: follows the plan), P3 test waits. Fix agent running on `fix/agent-overview-review` (`/home/deploy/deckterm-work/s2fix`, from `3758663`). **S3 building** (`/home/deploy/deckterm-work/s3`, `feat/agent-s3-resume` from `3758663`, private port 4299, live check with Claude haiku there instead of restarting the dev tmux server).
- **18:05 UTC. S2 review fixes merged** (`6b16f8f`, merge `719ab12`; unit 2032/0; agent specs + smoke + git 48/48), pushed. **S3 built** (`9264013` backend, `faeeef6` frontend, `9aeadd6` e2e; unit 2069/0, push 23/0). Live check on private 4299: Claude haiku `--session-id` recorded, tmux server killed, one resume call reopened the same conversation in the same folder (answered PELICAN); Codex `resume --last` answered FALCON; 4 agent sessions.
- **Incident (S3 live check, 16:11 UTC):** the private instance rewrote the shared fixed path `/tmp/deckterm-bash-integration.rc`, which dev and PRODUCTION shells read when they start. The agent restored the original at 16:11:50. Verified by the operator: the file's sha256 `8a0cda8e…` (1396 B) equals the content generated by the production release code and by dev's pre-S3 code; dev and prod write it only once per process, so it stays. Production journal shows no shell creation in the window (only broker contract tests run from this session, which lives in the production tmux server's cgroup). Exposure if a shell had started: S3's wrapper (adds `--session-id`), no secrets. Fixed in S3: the rc file name now carries a hash of its content, written via rename, so instances with different code never share a file. Production keeps the fixed name until a promotion.
- **S3 decisions (tier 2):** an explicit close (DELETE, "close later" expiry) clears resume data (resume is for crashes and reboots only); resumable rows are listed beyond the 10-row ended limit (cap 50); Codex `--last` may pick a newer normally-exited run in the same folder (documented limitation). Agent implementing 1-2 now.
- **19:20 UTC (local 21:20). All slices on dev.** S3 Codex security review (P1 double resume; P2 clear-before-Enter, capped same-folder check, late marker after user close, Codex options before the subcommand; P3 audit) fixed in `68914ab`, `2d27b80`; re-check: four fixed, two partly (stale-reservation takeover across processes; same-folder gap during hand-over) closed by the operator in `f5cde99` (owner token on reservations; in-flight Codex hand-overs keep the folder on the picker; red-then-green route test). Merge conflict in `web/agent-overview.test.js` resolved in `int/s3` (`017fc9c` + brace fix). Gate: unit 2092/0, push 23/0, census ok. **`dev` = `origin/dev` = `f5cde99`**, dev restarted 19:01 UTC (build `a0d6177d5567`), **final full e2e 256/256, 0 retries (12.7 min)**.
- **Dev acceptance (17:16-17:17 UTC host clock, isolated e2e actor, so no push to the owner's devices):** dev tmux listing before: no server (no owner session). Real `claude --model claude-haiku-5-5` question form -> `agentStatus` blocked, rule `live_blocked_form`, 6 s after the prompt was sent (includes Claude's own reply time); answered -> idle `live_prompt_box`. Dev tmux server killed by its own PID (crash) and the service restarted -> ended row `resume {claude, exact}`; dry run `claude --resume 4b986251…`; real resume typed it in the same folder and Claude answered HERON. The shell used the hashed rc `/tmp/deckterm-bash-integration-2ec498398db92842.rc`. Both terminals deleted; dev tmux afterwards: no server.
- **M0 build:** worktrees `/home/deploy/deckterm-work/m0-{be,scroll,focus}` on `fix/mobile-m0-{be,scroll,focus}` from `c86ea9d`; private ports 4292 (be), 4293 (scroll), 4294 (focus); e2e on 4174 only under `flock /tmp/claude-1001/e2e-4174.lock`.
- **Earlier runs.** Workflow `deckterm-m0-understand` (run `wf_49dbb4ab-fa5`): three Opus verifiers for the M0 hypotheses, an e2e touch recipe, xterm.js 5.3.0 internals, research on other terminals, and a phone UI walk on private instance port 4281 (state `/tmp/claude-1001/m0w`). Workflow `deckterm-d-s0` (run `wf_f376dfb5-621`): D docs written uncommitted into `docs/plans/2026-10-22-agent-attention{,-design}.md`; S0 in worktree `/home/deploy/deckterm-work/s0-env` on `feat/agent-s0-env-hygiene` from `530e90e`.

## Final state (2026-10-22, 19:35 UTC)

- **Where things are.** `dev` = `origin/dev` (last code commit `a6c2f12`, docs after it); the dev service runs it (build `a0d6177d5567` plus docs). CI on `origin/dev` green (unit, smoke-e2e, isolation-e2e, run `39821816456`). Nothing on `main` or production. All run worktrees and `fix/mobile-*`, `feat/agent-*`, `int/*` branches removed after checking each was merged into `dev` and clean; private state dirs under `/tmp/claude-1001/` removed (screenshots kept in `m0w-walk/`, `p42xx-probe/`).
- **Goal table, checked.** Phone repair first and reviewed (review note F1-F18, statuses filled); focus while typing (mobile-focus spec, phone + tablet); touch scrolling incl. mouse apps, sideways swipe, no keyboard on drag (mobile-touch-scroll spec); grabbable handle + Jump to latest (spec, 44 px target); research section (review note §5); tested at 390x844 and 820x1180, phone screenshots reviewed, owner checklist sent; agent-activity tracking (12 real fixtures green; on dev a real Claude question form read blocked; `/api/terminals` carries `agentStatus` and `agentStatusRule`); Agents panel left, default view, IDE view, phone chip, toggle persists, on by default, sash resize persists and resets (agents-panel / agents-phone specs); deployed and tested on dev (full e2e 256/256, 0 retries).
- **Gaps, stated plainly.** Codex approval "needs your answer" was verified on a private instance (0.6 s), not on dev. Push delivery to a real device was not observed (the isolated test actor has no subscriptions; only the dispatch path and `test:push` ran). iOS was not tested (owner uses Android Chrome). The DPR 2-3 text-size artifact and the F17 composition change need a real-phone check (checklist steps 3 and 6).
- **Owner decisions open (tier 3, Slack questions `44a35f00` promotion and `321c58d9` VAPID rotation, recommended "after the phone test" and "rotate at promotion"):** promotion of `dev` to `main` (it would bring: a one-time tmux env scrub of the production tmux server, DB migration 11 with two columns and an index, the content-hashed rc file name with the old `/tmp/deckterm-bash-integration.rc` left behind, push deep links); VAPID key rotation (recommended at promotion: the private key was readable by every DeckTerm shell until S0; every phone must re-subscribe).
- **Disclosed side effects.** The 16:11 UTC rc-file incident (above). Claude Code wrote folder-trust entries for three scratch folders when the capture and acceptance sessions accepted its trust prompt (Claude's own write, not DeckTerm's). The S2 agent installed Firefox (~100 MB) into `~/.cache/ms-playwright`, and Chromium 1228 was deleted and reinstalled. 15 short agent sessions used (Claude haiku, Codex gpt-5.6-luna low), the plan's ceiling.
- **Measurements.** About 7 h wall time. API-equivalent cost from `agent_cost.py --since 2026-10-22T12:27:00Z`: 194 USD (Opus 91 %, Fable advisor 5 %, Sonnet 3 %); 2 advisor calls; 0 compactions. Codex reviews: 13 (S0 2, M0 2, F17 2, S1 2, S2 2, S3 2, plus one partial S2 run), every P1 fixed or rejected with written reasons. Review rework after merge: M0 (two fix rounds), S1 (one), S2 (one), S3 (one), F17 (two).

## Traps

- **Wrong checkout.** The dev service serves this checkout. A wrong branch here is a wrong dev. Check `git branch --show-current` before every commit and restart.
- **Stale worktrees.** Workflow or agent `isolation: 'worktree'` branched from stale commits here. Create worktrees yourself from `dev`.
- **Production environment.** Your environment carries production values (`DECKTERM_PUBLISH_MODE`, `TMUX_SESSION_NAMESPACE`, …). Child servers and foundation tests must pin `DECKTERM_STATE_DIR` and clear or pin `DECKTERM_PUBLISH_MODE` and `DECKTERM_LEGACY_NO_BOOTSTRAP`. Bun's `.env` auto-load back-fills missing variables.
- **Batched foundation tests.** Running several foundation-bearing test files in one `bun test` gives phantom failures. Use `test:unit`, or run each file alone.
- **Unix socket length.** The path limit is 108 bytes, so private state dirs must be short.
- **tmux kill-server is blocked.** Stop a private tmux server by killing the PID whose arguments contain its socket path.
- **WebGL terminals.** `.xterm-rows` is empty, so e2e must read terminal text through the `readActiveTerminalText` fixture.
- **Pinned actions render three times.** e2e must click `[data-action=…]:visible`.
- **Touch e2e.** `page.touchscreen` only taps; drags need CDP `Input.dispatchTouchEvent`. The keyboard is simulated by shrinking the viewport while the helper textarea is focused, so a green emulator run does not prove iOS behaviour. Say so in the report, and rely on the owner's phone checklist for iOS.
- **Phone layout path.** Touch-only code must be gated on `isTouchLayout()`. Phone versus tablet chrome is decided by `PlatformDetector` (`web/app.js:1347`): `isMobile` is "coarse pointer and no hover" or "touch and width under 768 px". So a touch context at tablet width can still get the phone chrome. Assert which chrome a test context really gets (the tablet cases in `tests/hybrid-touch-regressions.spec.ts` show how) instead of assuming it from the viewport size.
- **Persisted `layout.activeView`.** Clicking the already-active activity icon collapses the IDE sidebar. Guard IDE specs.
- **Settings key-value store.** A stale `files.defaultCwd` once broke every e2e `beforeEach`. Let `resetAppState` clear the store, and give your new keys defaults that work after a clear.
- **Agent screen shapes.** The owner's Claude runs with `"tui": "fullscreen"`, and DeckTerm starts Codex with `--no-alt-screen` (`backend/shell-integration.ts:46`). Herdr tuned its rules against its own emulator, so verify them on DeckTerm's real captures. In bypass mode Claude's usual blocked screens are question forms and plan approvals, not permission prompts.
- **Short commands.** Under tmux, commands shorter than about 2 s may never show "running", because of the 2-second sync cache. This is a known trade-off, not a regression.
- **Static caching.** `/assets/*` files with a version in their name are immutable. Add a new versioned name instead of changing one in place.
- **Vendored code.** Never hand-edit `web/vendor/`. `vendor/codemirror.js` is regenerated by `scripts/build-codemirror-vendor.js`.

## Relaunch (after a crash or host restart)

From a production DeckTerm terminal or a plain SSH shell:

```bash
cd /home/deploy/deckterm_dev && ccsk --model claude-opus-5-5 --effort xhigh --autocompact 600000
```

Then turn ultracode on with `/effort` and say the start sentence again ("zahaj praci na upgrade deckterm dle planu"), or paste the continuation prompt below. The new session first re-reads this file, takes its state from "Progress", and re-checks running jobs from their PIDs and logs before the next action.

**When the run ends** (all slices done, or the owner stops it): set `status: consumed` in the header, and delete the project memory note `deckterm-upgrade-run.md` and its line in `MEMORY.md` under `/home/deploy/.claude/projects/-home-deploy-deckterm-dev/memory/`, so the start sentence no longer launches this run.

## Continuation prompt

```text
You are the DeckTerm operator for the phone-repair and herdr-adoption run (skill autonomous-orchestrator). Owner: "hlavne se ale zamer i na review a opravu soucasne verze … at to autonome nasadi a otestuje na dev".
Your mandate, authority, STOP conditions and state are in /home/deploy/deckterm_dev/docs/handoffs/2026-10-22-herdr-adoption-operator.md; start there and keep it current as your state file.
```
