# Session lifetime defaults — implementation

**Date:** 2026-08-30
**Design:** `docs/plans/2026-08-30-session-lifetime-defaults-design.md`

Only an explicit tab close (✕) ends a terminal session. The two time-based
reapers are off unless a deployment configures a window.

## Changes

**`backend/services/session-reaper-policy.ts` (new)** — parses both windows from
an environment. Anything that is not a positive finite number resolves to `0`,
and `isReaperEnabled()` reports `0` as "never reap". Pure and env-injected, so
its tests are unaffected by the service environment a DeckTerm terminal inherits.
The file carries the incident that motivated it; read it before widening the
defaults again.

**`backend/server.ts`**

- `TERMINAL_IDLE_TIMEOUT_MS` / `DECKTERM_ORPHAN_TTL_MS_DEFAULT` now come from
  `resolveReaperWindows(process.env)` instead of `parseInt` with a 2 h / 8 h
  fallback. Both default to `0`.
- `cleanupIdleTerminals` and `reapDetachedSessions` each `continue` when the
  window resolved for that owner is not enabled. The check is deliberately on
  the per-owner value from `resolveSessionPolicy()`, not on the module constant,
  so C3's per-user policy store works without moving it again.
- `reapScheduledTerminalClosures` (the ✕ path) is untouched, including its
  15-minute restore window and the "another client still has it open" guard.

**`backend/services/session-idle.ts`** — `resolveReaperDefaults()` and its tests
are removed. `dev` added them in `f0dfe71` to ship 24h/72h ceilings as code
defaults; `session-reaper-policy.ts` now owns that question. See the design doc
for what is kept from that work.

**`package.json`** — the union of both branches' test lists: `dev`'s new
`deploy-artifacts`, `service-lifecycle`, `service-lifecycle-doctor`,
`setup-bootstrap` and `format-bytes` entries, plus `session-reaper-policy.test.ts`
and the two files commit 971c5fb added without ever listing —
`tmux-server-launch.test.ts` and `services/tmux-server-requirement.test.ts`. CI
was silently skipping those two.

**`.env.example`, `README.md`** — new defaults, `0` documented as "never", and
`DECKTERM_ORPHAN_TTL_HOURS` / `DECKTERM_TAB_CLOSE_GRACE_MS` documented for the
first time.

## What an operator sees

| Action | Result |
|---|---|
| Leave a tab open, walk away for a day | Session survives |
| Close the browser, laptop asleep overnight | Session survives |
| Close the tab with ✕, reopen within 15 min | Session restored |
| Close the tab with ✕, walk away | `[close-later] Ending terminal …` after 15 min |
| Restart `deckterm.service` | **Still destroys everything** until `deckterm-tmux.service` is installed — commit 971c5fb, `deploy/README.md` |

Restoring the old behaviour on one deployment, without a code change:

```
TERMINAL_IDLE_TIMEOUT_MS=7200000
DECKTERM_ORPHAN_TTL_HOURS=8
```

## Verification

- `bun test ./backend/services/session-reaper-policy.test.ts` — 46 pass with the
  neighbouring lifecycle suites.
- `bun run test:unit` — green, 0 fail.
- `bun x tsc --noEmit` — exit 0.

## Not done here

The settings surface. `resolveSessionPolicy()` remains the seam and the `policy.`
prefix remains reserved; the design doc states the shape and the two constraints
(admin-scoped, env as the default floor) for the C3 slice.
