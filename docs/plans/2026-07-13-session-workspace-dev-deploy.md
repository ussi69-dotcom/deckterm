# Session-workspace UX: dev deployment plan

Date: 2026-07-13 · Target: `dev` only · Runtime: port 4174 / `deckterm-dev.service`

## Scope and invariants

- Deploy the reviewed session-workspace candidate from `fix/session-workspace-ux` to
  the integration branch `dev` and the live development service.
- Production branch `main`, port 4173, `deckterm.service`, and the production release
  tree are out of scope.
- Preserve the dev state directory (`/home/deploy/.deckterm-dev`) and tmux sessions.
  The service's `KillMode=process` contract remains unchanged.
- Never run browser tests while a user-owned live dev terminal exists. The preflight
  must report zero live terminals; the E2E fixture then owns and cleans up only the
  IDs it creates.
- Rollback removes only the release commit, never resets or rewrites unrelated history.

## Pre-deploy evidence

- Full Playwright suite: 142/142 passed against port 4174 with one worker.
- Full `bun run test:unit`, `bun x tsc --noEmit`, `node --check web/app.js`, and
  `git diff --check`: passed.
- Desktop merged/detached and mobile-orientation screenshots inspected.
- Fresh-eyes integrated diff review and strict Fable review: no blocking finding.
- Live preflight: `deckterm-dev.service` healthy, isolated dev state configured,
  and zero live terminals. The currently running process predates the backend change,
  so a restart is required.
- Ref baseline: `origin/dev` is `7fe43f6`; the candidate is based on `fffbd58`
  (`origin/main`). The fast-forward therefore also brings six commits already present
  on `origin/main` into the integration branch before the new release commit. This is
  intentional convergence, not a force-push.

## Rollout

1. Record the exact `origin/dev` pre-SHA, dev-service PID/start time, and a read-only
   `deckterm.service` PID/state fingerprint. Re-fetch `origin/dev`; prove it is an
   ancestor of the candidate and the worktree contains only the intended release scope.
2. Create one intentional release commit containing implementation, regression tests,
   cache-busts, fixture hardening, and this plan.
3. Push that exact commit as a non-force, fast-forward update to `origin/dev`. Do not
   push `main`; reject the rollout if the fetched `origin/dev` pre-SHA changed.
4. Wait for the CI run attached to that exact `dev` commit. Required jobs are unit,
   smoke E2E, and Alice/Bob isolation E2E.
5. After CI succeeds, move the local `dev` branch to the exact deployed commit, switch
   the checkout to `dev`, and run exactly
   `systemctl --user restart deckterm-dev.service` (never a system-level restart).
6. Prove a new service PID/start time, `release: "dev"`, healthy port 4174, and zero
   unexpected live terminals.
7. Run the focused post-restart Playwright gate:
   `e2e-guard.spec.ts` + `workspace-pane-ux.spec.ts`, one worker, no retries.
8. Re-read `/api/terminals` and require zero live terminals after the focused gate.
   Inspect the service journal for startup/reconciliation errors, confirm the final
   worktree is clean and `HEAD == origin/dev`, and prove the read-only production
   service fingerprint did not change.

## Rollback

If CI fails, do not restart the service; fix forward on the feature branch. If the live
post-restart gate fails:

1. `git revert` the single session-workspace release commit on `dev` (no reset/force).
2. Run `systemctl --user restart deckterm-dev.service` and recheck port 4174 health.
3. Push the revert to `origin/dev` and record the failure evidence.

This rollback removes only the new release commit and returns its code paths to the
`fffbd58` candidate base. It deliberately does not move `dev` back to its old `7fe43f6`
tip or discard the six already-`main` convergence commits.

The health endpoint returns `release: "dev"` for a checkout deployment, so release
identity is proved by the exact Git HEAD, new systemd PID/start time, focused browser
gate, and the GitHub CI run for that SHA.
