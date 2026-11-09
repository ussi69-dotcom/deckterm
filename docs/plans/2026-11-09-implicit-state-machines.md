# Task lifecycle table: implementation notes

Design and inventory: [2026-11-09-implicit-state-machines-design.md](2026-11-09-implicit-state-machines-design.md).

## Changes

- `backend/task-status.ts` (new): statuses, transition table, helpers.
- `backend/task-runner.ts`: status writes go through the table; `runChecks` claims and finishes under the lock; `launchWorker` and `launchJudge`; recovery of abandoned checks on read; `updateTask` runs under the lock and validates the status.
- `backend/server.ts`: the start and judge routes use the launch methods. The judge prompt file is now written only after the start is allowed.
- `web/task-signals.js`: `taskActionAvailability`, used by `web/app.js` and `web/tasks-view.js`.
- `backend/task-status.test.ts` (new, in `test:unit`): the table, browser parity, guards, races, restart recovery.

Existing tests were not changed.

## How it was checked

- `bun run test:unit` and `bun x tsc --noEmit`: both pass.
- A private instance from this worktree, with a fake agent on `PATH` and a throwaway `HOME` so no real agent could start, passed 25 of 25 live checks: refused second start with no extra terminal, locked and unlocked buttons in a real browser, checks run from the panel, pause during checks, and a server killed during checks recovering after restart.

## Not yet done

The Playwright suites refuse any port but 4174, which serves the `dev` checkout, so they cannot exercise this branch. After merging to `dev`, run on 4174:

```bash
bun run test:e2e:smoke
cd tests && PW_BASE_URL=http://localhost:4174 npx playwright test task-runner.spec.ts ide-tasks-view-smoke.spec.ts ide-task-board-tab.spec.ts --workers=1
```

The smoke set does not include the task specs, so the second command is needed.
