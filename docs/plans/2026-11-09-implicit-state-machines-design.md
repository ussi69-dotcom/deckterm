# Implicit state machines in DeckTerm

Date: 2026-11-09. Status: first target built on `feature/task-state-machine`, not yet merged to `dev`.

An _implicit state machine_ is code where something clearly has states (connecting, running, finished), but the states live in scattered flags or strings and nothing says which moves between them are allowed. The usual symptoms are objects stuck in a state, impossible combinations, and rules copied into several places.

This document lists the ones found in DeckTerm, and describes the fix for the first one. Line numbers refer to `dev` at commit `095a20f` (2026-11-03).

## Verdict on the prompt

The prompt under review was: "Find all of the implicit state machines in my app. Make the best decision that will elevate all three: UX, DX and AX always, without breaking anything."

It points at a real problem, but it works better as a survey than as a change request. "All", "best" and "always" give no scope, no order, and no definition of done or of breaking something. On a 19,000-line `web/app.js` and a 13,000-line `backend/server.ts` that invites a big rewrite. A sharper form:

> In <one module>, find the implicit state machine. List states, transitions and impossible states with file:line. Add one table of allowed transitions. Change behaviour only for transitions proven wrong, each with a test. Keep stored data readable. Done when unit tests, type check and e2e on the dev port pass. List other candidates; do not refactor them.

## What was found

UX is the effect on people using DeckTerm, DX on people changing the code, and AX on agents working in it or driven by it.

| # | Machine | Where | What is implicit | Risk today | Touches live terminals |
|---|---|---|---|---|---|
| 1 | Supervised task lifecycle | `backend/task-runner.ts:24`, writes at `:630-671`, `:824`, `:872`, `:905`, `:946`, `:971`, `:984`, `:1004`; rules copied at `web/app.js:9840`, `web/tasks-view.js:573`, `web/task-signals.js:6`, `web/task-board.js:9` | Ten named statuses, no rule for moving between them | UX: tasks stuck with locked buttons. DX: four copies of "running". AX: the task's agents are started without a server-side check. **Fixed here.** | Only starts them |
| 2 | Terminal connection | `web/app.js:555-1045`, flags at `:561-572`, copy on the terminal record at `:15642`, read at `:11965` and `:17037` | Six flags (`retryCount`, `reconnectTimer`, `intentionallyClosed`, `reconnectGeneration`, `openedOnce`, `awaitingReconnectReady`) and nine status strings. `awaitingReconnectReady` exists twice, and being correct depends on `onLifecycle` running before `markConnectionReady` (`:652-658`) | UX: highest; a wrong state means a dead-looking terminal or lost typing. DX: hard to change safely. AX: low | **Yes, high risk** |
| 3 | Agent activity on tabs | `web/app.js:8190-8211`, `:11991`, `:12254`, `web/terminal-colors.js:166` | The server has a clean machine (`backend/agent-status.ts`). The browser still mixes it with the older `agentState`; the pane label at `:11991` reads only the older one | UX: labels can disagree (the fix in `04b675e` was this kind). DX: medium. AX: a wrong "working" or "needs you" misleads whoever is supervising | Display only |
| 4 | Server terminal lifecycle | `backend/server.ts:6258` (`closeAndRemoveTerminal`), `backend/services/tmux-reattach-policy.ts`, `backend/services/session-reaper-policy.ts` | Exit, detach, re-attach and tear-down are decided by checks in sequence | The rules are written down and tested (`attach-exit-liveness`); a mistake kills live sessions | **Yes, high risk. Leave alone** |
| 5 | First-time setup | `backend/services/foundation-state.ts:24` | `bootstrapped` and `mode` can in theory disagree | Low; set in one place at startup. Security code | No |
| 6 | Update prompt | `web/release-watch.js:43-47` | Five closure variables | Low; small and unit-tested | No |

Checked and not worth changing: `web/input-queue.js` and `web/reconnect-classify.js` (pure, tested), `web/live-cwd.js` and `web/mobile-layout.js` (pure decisions, no lifecycle), the single `dirty` flag in `web/file-editor.js:200` and the single `isOpen` flag in `web/surface-windows.js:291`.

## First target: the task lifecycle

Chosen because the defects are concrete, the code is separate from the terminal attach path, and it already had over 60 tests.

### Defects confirmed in the code

1. `runChecks` ran without the per-task lock and saved a copy loaded before the commands started. Anything done during the run (pause, rename, delete) was overwritten; a deleted task came back.
2. A server restart during checks left the task on `checks-running` forever. All three buttons stay locked and the screen offers no pause or reset.
3. A check command that could not start threw, with the same result.
4. Only the browser refused a second start. Two tabs or an API caller could launch two workers.
5. `PATCH /api/tasks/:id` accepted any string as a status, including a running status nothing would ever finish.

### Design

`backend/task-status.ts` is a pure table: event, allowed source statuses, target status. Every status write in `task-runner.ts` goes through it.

| Event | From | To |
|---|---|---|
| `start-worker` | any settled status except `complete` | `worker-running` |
| `start-checks`, `start-judge` | any settled status | `checks-running`, `judge-running` |
| `checks-passed` | `checks-running` | `needs-judge` |
| `checks-failed`, `checks-interrupted` | `checks-running` | `needs-user` |
| `worker-exited` | `worker-running` | `needs-user` |
| `judge-exited`, `judge-no-verdict`, `verdict-blocked`, `verdict-rounds-exhausted` | `judge-running` | `needs-user` |
| `verdict-pass` | `judge-running` | `complete` |
| `verdict-next-round` | `judge-running` | `ready` |

"Settled" means every status except the three running ones. These sets match what the buttons already allowed, so nothing a user could do from the screen is newly refused.

Decisions:

- **Pause, reset and manual edits stay free**, except that they may not set a running status. Unknown statuses return 400.
- **Checks hold the lock only to claim and to finish.** Commands can take minutes, and holding the lock would block pause and messages. A run id on the task (`activeCheckRunId`) says which run owns the phase, so a run overtaken by a pause or reset records its result but does not change the status.
- **Recovery happens when a task is read, not at startup.** The runner keeps the check runs alive in its own process. A task on `checks-running` whose run is not among them goes to `needs-user`. This needs no startup hook, and a deployment candidate that shares the state directory and serves no task traffic cannot disturb a run that is still going. Worker and judge phases are not touched: they live in tmux and survive restarts.
- **Starting a phase is one locked step** (`launchWorker`, `launchJudge`): check, create the terminal, record. Two concurrent starts cannot both launch, and a refused start creates no terminal.
- **Stored data stays readable.** The new field is optional, and a stored status outside the table reads as `needs-user`.
- **`markWorkerStarted` and `markJudgeStarted` stay unchecked** for the golden tests, which deliberately build states the routes cannot reach. Routes no longer use them.

The browser has no build step, so it cannot import the table. `taskActionAvailability` in `web/task-signals.js` is the single browser copy, and `backend/task-status.test.ts` fails if it, the running list or the board columns drift from the table.

`draft` and `failed` are kept although the server never sets them on its own: stored tasks or manual edits may hold them, and the UI already renders them.

## Later

In order of value: connection state (item 2, as its own slice with reconnect e2e tests), then the agent label (item 3). A reset button on the task screen would give people a way out of a worker or judge status whose terminal exit was missed; it was left out to keep this slice small.
