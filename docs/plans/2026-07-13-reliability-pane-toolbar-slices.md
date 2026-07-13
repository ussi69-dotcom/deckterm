# Reliability, Pane Accessibility, and Toolbar Ergonomics

Date: 2026-07-13
Target: development branch and live development service on port 4174 only
Production: out of scope

## Outcome

Deliver the three owner-approved slices in order:

1. Give every Playwright context a server-enforced terminal owner namespace so tests can coexist with real development sessions.
2. Add reliable pane traversal, pane-owned connection/activity detail, coarse-pointer controls, and stale-WebSocket generation guards.
3. Compact the session lifecycle controls and replace separate Font minus/plus surface actions with one Font-size stepper.

The current live development terminal must survive the service restart and remain absent from every test catalog.

## Global invariants

- Every browser test remains on loopback HTTP port 4174. Port 4173 is never used by Playwright.
- Production is not restarted, deployed, or probed beyond any existing read-only fingerprint check.
- Existing Cloudflare and non-development actor behavior remains unchanged.
- Existing terminal rate limits, capability checks, tmux persistence, reconnect, pane detach, pane-owned paste, action layout, palette commands, and Ctrl plus/minus shortcuts remain intact.
- TDD per slice: add the focused regression first, observe the expected failure where practical, implement, then run the focused and integrated gates.
- Asset cache keys are bumped once after both frontend slices are integrated.

## Slice 1 — Structural test actor/run namespace

### Design

Use the existing owner boundary rather than adding a terminal-session column.

The Playwright fixture creates a unique 32-hex run ID per BrowserContext and installs it as an HttpOnly SameSite=Strict cookie before the first request. The server accepts that cookie only when all conditions hold:

- URL is loopback HTTP port 4174;
- runtime is explicitly development/dev;
- DECKTERM_LEGACY_NO_BOOTSTRAP is enabled;
- the resolved actor is legacy_dev;
- the cookie value is strictly valid.

A valid run is represented as a synthetic actor ID. Existing in-memory terminal ownership, terminal_sessions.actor_user_id, list scoping, settings, task ownership, per-owner limits, linked-view authorization, delete/resize authorization, and audit attribution then use the existing exact-owner seams.

Malformed or context-invalid namespace cookies return 403. Cross-boundary terminal IDs return 404 before restore or mutation when only one side is test-scoped or the run IDs differ.

WebSocket upgrade must mirror the HTTP legacy-bypass rule. It must use the raw synthetic actor ID under bypass and inspect a recorded session owner before attempting tmux restoration.

### Files

- backend/services/foundation-actors.ts
- backend/foundation-actors.test.ts
- backend/server.ts
- backend/e2e-run-namespace.test.ts
- tests/fixtures.ts
- tests/e2e-guard.spec.ts
- tests/playwright.config.ts
- package.json

### Acceptance

- Pure namespace and cross-boundary matrix tests.
- HTTP create/list/delete/resize isolation for an unscoped actor and two run actors.
- Route-level linked-view and WebSocket isolation: a foreign run returns 404
  before tmux restore, session recording, linked-client spawn, resize, or kill.
- Fixture verifies its synthetic actor through foundation status before navigation.
- Browser test proves an unscoped live terminal is invisible and immutable from the run, and the run terminal is invisible and immutable from the unscoped actor.
- Own WebSocket attach remains green.
- Namespace-cookie failures preserve their resolver status through every shared
  auth wrapper: malformed or context-invalid cookies remain 403, not 401.
- A pre-existing real dev terminal remains live after the focused E2E.

## Slice 2 — Pane traversal and truthful pane status

### Design

Treat DeckTerm application connectionStatus as authoritative. Raw WebSocket readyState is only an initialization fallback and must never mark a pane connected while reconnect replay is pending.

ReconnectingWebSocket captures the socket generation created by connect. Open/message/close callbacks, classification continuations, reconnect timers, and heartbeat timeouts ignore stale generations and never address a later this.ws instance.

Add next/previous pane traversal within only the active workspace:

- Alt+Shift+ArrowDown: next pane
- Alt+Shift+ArrowUp: previous pane
- stable TileManager workspace order with wraparound
- existing switchTo remains the sole activation/focus/resize path
- matching contextual command-palette actions appear only for multi-pane workspaces

Every tile receives a compact pane status overlay. It reports that terminal's own folder, normalized connection state, and highest-priority activity (agent responding/thinking, running, idle). It is persistent in multi-pane workspaces and visible for single-pane attention states. The visual text is aria-hidden to avoid noisy announcements; the tile receives a complete accessible label and title.

Desktop detach/close controls remain 24 by 24 pixels. Coarse-pointer controls and confirmation buttons are at least 44 by 44 pixels. Hidden desktop controls do not intercept pointer input.

### Files

- web/app.js
- web/styles.css
- web/index.html
- tests/workspace-pane-ux.spec.ts
- tests/reconnect-tab-status.spec.ts
- tests/mobile-regressions.spec.ts

### Acceptance

- Next/previous/wrap traversal changes only the active pane, retains the workspace tab, and focuses the selected xterm.
- A single-pane shortcut is not consumed.
- Palette pane actions are contextual.
- Each merged pane renders its own cwd, activity, and connection label.
- Switching to a reconnecting pane whose transport is OPEN keeps the global status reconnecting.
- Late events from an old socket generation cannot affect the current socket.
- Desktop controls remain compact; coarse-pointer targets meet 44 pixels.
- Existing click/paste ownership, detach without PTY restart, tab aggregation, and mobile layout tests stay green.

## Slice 3 — Compact lifecycle group and Font stepper

### Design

Render New and Sessions as two independent controls inside one semantic session-actions group. Sessions is an icon-only 36-pixel desktop control, not a split/dropdown variant of New. Coarse/mobile targets are at least 44 pixels and New becomes icon-only in mobile chrome.

Sessions receives dialog semantics and lifecycle:

- aria-haspopup, aria-controls, and live aria-expanded;
- focus enters the dialog on open;
- Escape closes;
- Tab stays within the modal;
- close/backdrop/Escape restore focus to the trigger;
- activating a session closes without stealing focus back from the selected terminal.

The optional badge is derived only from the existing actor-scoped terminal telemetry response and counts live sessions not represented in the current TerminalManager. It is hidden at zero and never repeats the tab count.

Replace the two surface-layout Font actions with one fixed More-sheet group:

Font size [minus] current-value [plus]

The group stays open while stepping, exposes the current value, disables at 8/32, and is not independently pinnable. Existing command-palette Increase/Decrease actions and Ctrl plus/minus shortcuts remain separate. Legacy saved Font action IDs are dropped safely while preserving other pins.

### Files

- web/index.html
- web/styles.css
- web/app.js
- web/navigation-surface.js
- web/navigation-surface.test.js
- tests/sessions-attach.spec.ts
- tests/navigation-surface.spec.ts
- tests/mobile-regressions.spec.ts

### Acceptance

- Sessions has no visible text label, is independently clickable, and has complete dialog focus/ARIA behavior.
- The badge counts only unopened live sessions and disappears at zero.
- More contains exactly one Font-size group and no standalone Font minus/plus tiles.
- Repeated stepping updates the output, manager state, xterm option, persistence, and disabled bounds without closing More.
- Palette and keyboard Font commands remain functional.
- Layout editor cannot pin separate Font actions.
- Portrait mobile, 844 by 390 landscape, 1024 desktop, and 1440 desktop have no overlap or horizontal overflow.

## Integration and deployment gate

1. Focused unit tests for each slice.
2. bun run test:unit
3. bun x tsc --noEmit
4. node --check web/app.js
5. git diff --check
6. Run fresh-eyes integrated diff review plus the requested bounded Fable
   review; resolve every material finding and rerun affected static/unit gates.
7. Record dev service PID, terminal catalog, and production service fingerprint.
8. Commit and push exact reviewed commits to origin/dev.
9. Restart only deckterm-dev.service; confirm health release=dev and the pre-existing terminal is recovered.
10. Run focused E2E on 4174, then the full Playwright suite with one worker.
11. Capture deterministic screenshots at the required responsive sizes and perform visual review.
12. If post-deploy test or visual findings change the diff, repeat the relevant
    review and static gates before the final dev push/restart.
13. Sync OpenKnowledge status, plan, logs, backlog, and Codex memory.

## Non-goals

- No production promotion.
- No database schema migration.
- No second E2E port.
- No broad action-catalog refactor or Learn/onboarding implementation.
- No permission-bypass launcher or unattended task execution.
- No new pane titlebar that reduces terminal rows.
