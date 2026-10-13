# QoL and modernization pass — delivery record (2026-10-12)

Design and decisions: [2026-10-12-qol-modernization-design.md](./2026-10-12-qol-modernization-design.md).
Scope: built and tested on dev (4174, branch `dev`); promoted to production on 2026-10-13 (see
[Promotion](#promotion-2026-10-13)).

## Result

| Gate | Before (`b001e23`) | After |
| --- | --- | --- |
| `bun run test:unit` | 1291 pass / 0 fail | 1638 pass / 0 fail |
| `bun run test:push` | 13–14 pass | 14 pass |
| `bun x tsc --noEmit` | clean | clean |
| Full Playwright suite on 4174 | not run at baseline | 184 pass / 0 fail, no retries (8.8 min) |

The change set is about 20,000 added lines in roughly 100 files (`git diff --stat b001e23..`), delivered as
22 parallel slices in four waves, each in its own git worktree from the then-current `dev`, merged by the
operator session, gated, and deployed to dev four times (each restart preserved and recovered the live tmux
session).

## What changed for a user

**Reliability**

- Keystrokes typed while the terminal socket connects or reconnects are queued (bounded: 8 KB, 15 s) instead
  of silently dropped; extra keys, palette commands, paste fallback and compose use the same queue.
- A tmux attach client that exits while its session lives is now a detach: the catalog row stays active, the
  browser gets no exit frame, and the server re-attaches with backoff. Only a tmux session proven missing ends
  the row; an unreachable tmux server ("unknown") no longer ends live rows at startup. This closes the
  mechanism behind the 2026-07-19 false-ended catalog incident (root cause reproduced: the old deploy
  candidate shared production's state and tmux namespace and wrote through this path; the 2026-09-06
  ownership lock already closed that trigger). Test: `backend/attach-exit-liveness.test.ts` (10 cases, RED on
  the old code).
- Resizes go through one latest-wins queue per terminal that keeps the tmux window at least as large as the
  client, so tmux `│···` fill frames no longer stick in the terminal after a window resize (a pre-existing bug).
- The client follows the live tmux pane directory: tab labels update after `cd`, and the Git panel no longer
  says "Not a git repository" inside a repository. Files and Git follow only while they are visible and only
  inside allowed roots, and an out-of-root directory is never saved as the default.

**Performance**

- Static web files are revalidated with ETags (304 on reload) and gzip-compressed; versioned `/assets/*` files
  are immutable. API and HTML stay `no-store`. A reload used to refetch about 2 MB.
- `GET /api/terminals` shares one tmux sync per terminal for 2 s and one `ps` snapshot per request; hidden
  tabs poll every 30 s instead of 5 s; `/api/stats` reports real CPU load (delta, not since-boot average).
- Open tabs show "DeckTerm was updated — Reload" when the served web files change.

**Agent work**

- Standard terminal notifications (OSC 9, OSC 777, OSC 99) and OSC 9;4 progress from Claude Code, Codex and
  other tools are parsed on the server, mapped to needs-input / done / error, shown as an unseen-attention dot
  on the tab, ordered first in the Sessions list, counted on the app icon badge, and routed to the existing
  push/toast alerts (push text stays generic so terminal content never leaves the host).
- Phone: quick-reply chips (1, 2, 3, Enter, Esc, ⇧Tab, Ctrl+C) while an agent waits for input, and a compose
  sheet with a real text area that sends through the safe bracketed-paste + deferred-Enter path and keeps the
  text when the terminal is not connected.
- The agent badge clears once the agent process is gone.

**Look and feel**

- Desktop: Setup/Sessions/More open above floating windows; one ghost toolbar button style with labelled load
  chips that collapse at narrow widths; calm blue "Running" state (red only for errors); centred tab labels and
  stable tab numbers and order; a launcher instead of a black canvas with no terminals; one stacked toast
  service with Undo/Reload actions; distinct active search match; a Help list generated from one shortcut
  registry (also used for palette hints); a flat, icon-based command palette with highlighted matches and
  file search scoped to the active project; a lucide-icon explorer; a reworked Git panel (pinned close,
  overflow menu, compact rows with directory hints, calm not-a-repository state).
- Phone and tablet: the on-screen keyboard really shrinks the terminal (visual-viewport app height, Android
  `resizes-content` detection, 3-row floor with the keyboard up); compact chrome in landscape with the pinned
  actions moved into the toolbar; 44 px touch targets; opaque sheets; safe-area insets; dark status bar; a
  top-anchored palette with a Cancel button; shrinkable tabs; tablet windows stay above the bottom bars.

**Security hardening found on the way**

- Read-only git calls (status, diff, log, ls-files, show, rev-parse) run with `core.fsmonitor=false`,
  `core.hooksPath=/dev/null`, `GIT_OPTIONAL_LOCKS=0`, and the UI no longer runs git automatically in a
  directory the user merely `cd`-ed into (repo-local config could otherwise run code).
- Root denials name the rejected path and the governing setting without becoming an existence oracle for
  paths outside the allowed roots.

## How it was verified

- Every slice: tests first for pure logic, targeted tests, `tsc`, and a live check on a private instance
  (own state dir, own tmux socket, own port) with before/after screenshots.
- Integration: full `test:unit` + `test:push` + `tsc` after every merge; full Playwright suite on 4174
  (wave 1: 174 pass / 9 fail → 184/184 after fixing three product regressions and six stale specs; wave 2
  and review fixes: 183/184, the one failure being five tabs wrapping at 1400 px, fixed in the polish wave;
  after the polish wave: 168/184, all 16 failures in `git-panel.spec.ts` clicking a hidden phone-landscape
  copy of the Git button, spec fixed in `a684417`; final run on `a684417`: 184/184, no retries).
- An adversarial review (five area finders, one refuting verifier per finding) confirmed 12 findings and
  refuted none; all 12 plus 5 unverified minor ones were fixed. The Codex cross-review could not run: the
  Codex login had expired.
- Before/after visual QA on dev at 1440, 1920, 1400 (desktop) and iPhone, Android, landscape and iPad
  emulation. Screenshots stay out of this public repository (they show host details).

## Not done here (owner decisions or own slices)

| Item | Recommendation |
| --- | --- |
| xterm.js 5.3 → 6.0 | Own slice later; its main gain (synchronized output) needs tmux ≥ 3.7, and it rewrites the viewport the mobile scrolling depends on. |
| tmux 3.4 → 3.8 on the host | Owner decision; the binary is shared with production. |
| OSC 133 command blocks (jump to prompt, copy last output) | Needs its own design: tmux 3.4 does not forward OSC 133 to the browser. |
| Approve agent permission prompts from a push notification | Owner decision; new security-relevant action path. |
| Light/system theme; Setup, Sessions, More and Clipboard as desktop windows; iPad tablet tier | Product-shape decisions. |
| WebGL glyphs drawn too large at device scale factor 2–3 | Seen only in headless emulation; check on a real phone. |
| Short commands (< about 2 s) may not show "running" or a completion alert under tmux | Accepted trade-off of the 2 s sync cache. |

## Owner decisions (2026-10-13)

The owner accepted every recommendation above:

- xterm.js 6: later, as its own slice, after the tmux upgrade.
- tmux 3.8: yes, as its own planned action — [2026-10-13-tmux-3.8-upgrade.md](./2026-10-13-tmux-3.8-upgrade.md).
- Approving agent prompts from a push notification: no. Push text stays generic.
- Product shape: Setup and Sessions become desktop windows first (built 2026-10-13 on dev).
- WebGL glyph size at device scale factor 2–3: the owner checks on a real device.
- Production `idle-timeout.conf` drop-in: remove at the next production promotion.
- Promotion: after a day or two of use on dev, through a `dev` → `main` pull request.

The owner also said they had never used Compose, Tasks or the command palette and did not know what
they are for, so the 2026-10-13 follow-up adds one-line descriptions to every action (tooltips, palette,
More sheet), a "What's what" section in Help and short tips on the empty-workspace launcher.
A live look at dev also showed that turning the extra-keys bar on with a phone showed it on the desktop
too (one setting per account); phones/tablets and desktop now remember it separately.

## Promotion (2026-10-13)

The owner approved the promotion on 2026-10-13 ("vypada ok, nasad na prod"). Pull request #43 promoted
`dev` (tree identical to the tested `3c6631e`; `6493574` only merged the README badge commits that `main` already
had) to `main` as `b04c791`. Its PR checks (unit, smoke-e2e, isolation-e2e) were green, and so was the
`Deploy Main` run 38377043778 (verify-and-package, deploy).

Checked on the host after the deploy:

- `prod/current` points at `releases/b04c791…` and `previous` points at `c9be750…`. The service main process
  runs from the new release, and the candidate port 4273 is free again.
- The production tmux server kept its process across the restart. The journal shows `[shutdown] SIGTERM:
  detaching 1 terminal(s) (tmux sessions preserved)`, `[tmux] Recovered 1 session(s)`, and the open tab
  reconnecting its WebSocket.
- Before the merge, the `deckterm.service.d/idle-timeout.conf` drop-in (24 h idle / 72 h detached) was
  removed, as the owner decided. The journal now shows `[reaper] policy idle=never detached=never`, which
  matches the 2026-08-30 "only an explicit close ends a session" decision. Both the old and the new code
  default to "never", so a rollback would not have brought the reapers back.
- Production keeps the system tmux 3.4. The 3.8 switch ends every production session once, so it waits for a
  moment the owner picks ([tmux plan](./2026-10-13-tmux-3.8-upgrade.md), step 3).
- `Deploy Main` deploys to a single host (the `DEPLOY_HOST` secret, this OVH host). The owner's separate
  dedicated server runs its own git checkout under a system-level unit, so this deploy did not touch it.

## Follow-ups noticed

- The interactive review agents found remaining polish: Settings has a single Appearance option, the IDE
  bottom terminal has no panel header, the explorer is a flat list rather than a tree, IDE search groups lack
  paths and match highlighting.
