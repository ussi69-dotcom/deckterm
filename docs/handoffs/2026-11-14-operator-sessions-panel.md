# Handoff: operator sessions in the Agents panel (2026-11-14)

**Status:** done on `dev` (merged fast-forward from `feature/operator-sessions-panel`), validated on the dev instance
(4174). Not in production: promotion `dev` → `main` is the owner's step. PR 50 (`promote/hono-security`) was left
untouched.

## What it is

The owner asked (14 Nov 2026): "neslo by do decktermu dodelat, ze se tyhle aktivni operatorske session budou
objevovat v panelu agents?". Operators are long-lived Claude Code sessions started with `operator-tmux` outside
DeckTerm (own systemd unit, own system-tmux 3.4 server `op-<name>` in `/tmp/tmux-<uid>`). DeckTerm now lists them in
the Agents panel, the IDE Agents view, the phone chip and the Sessions sheet (name, folder, needs-you / working / idle
from the screen rules, an "operator" badge), and a click opens a terminal that is an attached tmux client (argv, no
shell, no pipe-pane transcript). Closing it only detaches. DeckTerm never starts, stops or types into an operator.

- Brief: `/home/deploy/.local/state/upkeep/deckterm-operators-panel/brief.md`.
- Design: `docs/plans/2026-11-14-operator-sessions-panel-design.md` (sections 2-3 are the security contract).
- Plan / what was built where: `docs/plans/2026-11-14-operator-sessions-panel.md`.

## Verification

- `bun run test:unit` green (run with `PATH=/home/deploy/opt/tmux-3.8/bin:$PATH`; with only the system tmux 3.4 the
  pre-existing `foundation-c1-multisession` reconcile test fails, baseline before this work), `bun x tsc --noEmit`
  green.
- Playwright on 4174: `operators-panel.spec.ts` (new, 5) plus `agents-panel.spec.ts` and `agents-phone.spec.ts`
  (regression), 20/20.
- Dev by hand: `GET /api/operators` listed the three real operators with the right folders and states; an attached
  view opened on the building session itself (one 200x50 client), a second attach returned the same view, closing it
  left the operator running with no client; an unknown name gave 404 `operator_not_available`.
- Real authorization path: `backend/foundation-operators.test.ts` runs a child server WITHOUT the bootstrap bypass
  (before bootstrap: refused; owner: list polls write no audit rows, one attach writes exactly the create path's rows
  plus one `terminal.operator_attach`; member: refused, also with root grants).
- A real WebSocket on an attached view of the building session streamed its screen; clients went 1 → 0 on close.
- CI on `dev` green (unit, isolation-e2e, smoke-e2e) for the first merge; Slack milestone note sent to the owner.
- Review: one independent Claude subagent (Opus, high) reviewed the diff; its three medium findings (socket trust on
  attach, auth order and folder leak, folding a hand-typed attach that keeps a transcript) and the minor ones were
  fixed. A second, narrow re-check of that fix found a timing leak before the permission check; fixed by making
  operators owner/admin-only, decided quietly before any socket is touched (design section 7). Codex was not used: its
  weekly limit was spent and every call would have drawn paid credits.

## Open / possible next steps (none started)

- "Done (unseen)" tier and push notifications for operators (needs a per-operator attention record and a pump).
- Operators are owner/admin-only (design section 7). If a member should ever see one, that is the owner's decision.
- Not tested: an operator ending in the instant between probe and attach (covered by construction). Known gaps are
  listed at the end of design section 6.
- After promotion, a quick look on production (4173 is never tested from here): the list should show the same
  operators, since the folder and tmux binary are the defaults (`DECKTERM_OPERATOR_TMUX_DIR`,
  `DECKTERM_OPERATOR_TMUX_BIN`).
