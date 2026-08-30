# Session lifetime defaults — design

**Date:** 2026-08-30
**Status:** implemented (defaults), proposed (settings surface)
**Related:** `docs/plans/2026-07-16-tmux-restart-lifecycle.md`, `docs/plans/2026-07-04-b6-b7-retention-limits.md`

## The problem

DeckTerm ended terminal sessions on three unrelated timers. Only one of them
expressed something the user actually asked for.

| Sweep | Applies to | Old window | Set by |
|---|---|---|---|
| `cleanupIdleTerminals` | terminals with a live WebSocket (**open in the browser**) | 2 h with no input and no output | `TERMINAL_IDLE_TIMEOUT_MS` |
| `reapDetachedSessions` | terminals with no WebSocket (**browser closed or asleep**) | 8 h with no input and no output | `DECKTERM_ORPHAN_TTL_HOURS` |
| `reapScheduledTerminalClosures` | terminals the user closed with the **✕** | 15 min restore window | `DECKTERM_TAB_CLOSE_GRACE_MS` |

The first two guess at intent from silence. On a long-running remote workspace
that guess is wrong often enough to be destructive, because the most valuable
sessions are the quietest ones: an agent that has finished a step and is waiting
at a prompt for the operator to answer produces neither a keystroke nor a byte
of output. It is indistinguishable, by this measure, from an abandoned shell.

Observed on the R9700 deployment on 2026-08-30, in one day, on sessions the
operator was still using:

```
13:47:24  [cleanup] Closing idle active terminal 4401bc0f… (idle: 123min, owner: …)
17:02:24  [cleanup] Closing idle active terminal 269bc834… (idle: 124min, owner: …)
17:32:24  [cleanup] Closing idle active terminal c635d31d… (idle: 122min, owner: …)
```

Each of those also ran `killTmuxSessionIfLast`, so the tmux session — the whole
point of the tmux backend — went with it. The service itself had not restarted
(`NRestarts=0`, up four days) and there was no OOM kill: the product did this to
itself, on a terminal that was open on screen at the time.

Note the second row of the table is the same defect with a longer fuse. A closed
laptop lid is not a closed session. An 8-hour detached TTL ends an overnight
session that happens to be waiting rather than printing.

## The decision

**Only an explicit close ends a session.** The ✕ is how a user says they are
done; `reapScheduledTerminalClosures` already implements exactly that, with a
15-minute window in which reopening the tab cancels it. That sweep is unchanged.

Both time-based sweeps are **disabled by default**. They remain in the code and
remain configurable, because a shared or resource-constrained deployment may
legitimately want them; a positive value restores the previous behaviour
precisely. What changes is what an unconfigured DeckTerm does.

### Why not a longer window instead of off

A longer window only moves the failure. Any finite timer eventually ends a live
session that looked quiet, and the failure mode is silent and unrecoverable —
the operator finds a dead tab and no explanation. The property worth having is
categorical: *a session I did not close is still there*. Capacity pressure is
better answered by the caps that already exist (`MAX_TERMINALS_PER_USER`,
`OPENCODE_WEB_MAX_TERMINALS`), which refuse a new session rather than silently
destroying an old one.

### `0` now means "never", not "immediately"

Previously `TERMINAL_IDLE_TIMEOUT_MS=0` parsed to a zero window, and the sweeps
compare `idle > window` — every idle time is greater than zero, so it meant *reap
on the next sweep*, five minutes later, for every session. `DECKTERM_ORPHAN_TTL_HOURS=0`
behaved the same way. An operator typing `0` means "off"; a typo that quietly
ends every live session is the worst outcome this configuration can produce.
Anything that is not a positive finite number — unset, empty, `0`, negative, or
garbage — now disables that sweep. Positive values are unaffected.

## Supersedes the 24h/72h ceilings

`dev` reached the same seam first. Commit `f0dfe71` (2026-08-26) moved the
windows out of a host-only systemd drop-in and into code as **24 h attached /
72 h detached**, on the correct observation that a fresh install was silently
running 2 h/8 h and losing sessions. That fixed the parity problem and made the
failure a day slower.

It does not fix the failure. A ceiling still ends a live session that merely
looked quiet — the R9700 sessions above were killed at ~2 h, and the same
operator waiting overnight for an agent's question hits 24 h the same way, with
the same absence of any signal that it is about to happen. The operator's
decision on 2026-08-30, after living with it, was that only an explicit close
should end a session.

So this supersedes `f0dfe71`: `resolveReaperDefaults()` in `session-idle.ts` is
removed along with its tests, and `session-reaper-policy.ts` is the single
answer to "how long may a session live". Two modules resolving the same
environment variables to different defaults is how the next collision happens.

What is *kept* from that line of work, because it is complementary rather than
competing:

- `KillMode=process` and the `Environment=PATH=` line in the shipped unit
  template, plus `deploy/needrestart/deckterm.conf` (`65b5ec3`). These protect a
  host that has not adopted `deckterm-tmux.service` yet.
- The startup policy log line, adapted to print `never` rather than `0h`, and to
  name the tab-close window that does still end sessions.
- The service-lifecycle self-check and the doctor's `KillMode` check.

## Trade-offs, accepted

- **`MAX_TERMINALS_PER_USER` (10) becomes the only backstop against
  accumulation.** A user who never closes tabs will reach the cap and be told to
  close something. That is a visible, recoverable limit, which is the point.
- **`/tmp/deckterm-tmux-pipes/*.log` grows for as long as a session lives.**
  Already true for any long session; longer-lived sessions make it more
  noticeable. Bounded by reboot today. If it becomes a real constraint, rotate
  the pipe logs — that is a separate slice and should not be paid for by ending
  sessions.

## Proposal: move this onto the settings surface

Not implemented here. Recorded so the next slice does not re-derive it.

`resolveSessionPolicy(ownerId)` already exists as the per-owner seam (B7,
D-B7-2) and both sweeps read their window through it. Track C3 is the slice that
puts an admin-managed per-user policy store behind that seam. The two windows in
this document are the natural first entries:

| Key | Meaning | Default |
|---|---|---|
| `policy.idleTimeoutMs` | attached-terminal reap window | `0` (never) |
| `policy.detachedTtlMs` | detached-terminal reap window | `0` (never) |

Two constraints on that slice:

1. **Admin-scoped, not actor self-service.** The `policy.` prefix is already
   rejected by `PUT /api/settings` for this reason: a user must not be able to
   extend their own limits on a shared host. The settings *UI* for these belongs
   in the admin surface next to the user store, not in per-user preferences.
   Users may read the effective policy; only an admin may set it.
2. **The env values stay the floor.** A deployment sets the default; the store
   overrides per owner. The disabled check must stay on the resolved per-owner
   value inside each sweep (`isReaperEnabled(...)`), not on the module-level
   constant, or a per-user window will silently never fire.

## Verification

- `backend/services/session-reaper-policy.test.ts` — default-off, `0` off,
  negative off, garbage off, positive restores the old windows, the two windows
  independent.
- `bun x tsc --noEmit` green; `bun run test:unit` green.
- Behaviour on the deployment is confirmed by the absence of `[cleanup]` and
  `[reaper]` lines in the journal for a session that stays open, and by
  `[close-later]` still appearing when a tab is closed with the ✕.
