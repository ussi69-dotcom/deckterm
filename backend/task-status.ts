// The task lifecycle as one table: which event may move a supervised task from
// which status, and where it lands. Every status write in task-runner.ts goes
// through this table, so "can this happen?" has one answer.
//
// Design: docs/plans/2026-11-09-implicit-state-machines-design.md
// The browser's button rules live in web/task-signals.js (no build step, so it
// cannot import this file); backend/task-status.test.ts keeps the two in step.

export const TASK_STATUSES = [
  "draft",
  "ready",
  "worker-running",
  "checks-running",
  "needs-judge",
  "judge-running",
  "needs-user",
  "complete",
  "failed",
  "paused",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** A process or terminal is doing this phase right now. */
export const RUNNING_TASK_STATUSES = [
  "worker-running",
  "checks-running",
  "judge-running",
] as const satisfies readonly TaskStatus[];

const SETTLED: readonly TaskStatus[] = TASK_STATUSES.filter(
  (status) => !isRunningTaskStatus(status),
);
const SETTLED_NOT_COMPLETE: readonly TaskStatus[] = SETTLED.filter(
  (status) => status !== "complete",
);

export const TASK_TRANSITIONS = {
  // Started by the user.
  "start-worker": { from: SETTLED_NOT_COMPLETE, to: "worker-running" },
  "start-checks": { from: SETTLED, to: "checks-running" },
  "start-judge": { from: SETTLED, to: "judge-running" },
  // Checks finished, or their process no longer exists (server restart).
  "checks-passed": { from: ["checks-running"], to: "needs-judge" },
  "checks-failed": { from: ["checks-running"], to: "needs-user" },
  "checks-interrupted": { from: ["checks-running"], to: "needs-user" },
  // The agent's terminal ended, or the judge finished without a valid verdict.
  "worker-exited": { from: ["worker-running"], to: "needs-user" },
  "judge-exited": { from: ["judge-running"], to: "needs-user" },
  "judge-no-verdict": { from: ["judge-running"], to: "needs-user" },
  // The judge's verdict for the current round.
  "verdict-pass": { from: ["judge-running"], to: "complete" },
  "verdict-blocked": { from: ["judge-running"], to: "needs-user" },
  "verdict-next-round": { from: ["judge-running"], to: "ready" },
  "verdict-rounds-exhausted": { from: ["judge-running"], to: "needs-user" },
} as const satisfies Record<
  string,
  { from: readonly TaskStatus[]; to: TaskStatus }
>;

export type TaskEvent = keyof typeof TASK_TRANSITIONS;

export function isTaskStatus(value: unknown): value is TaskStatus {
  return (TASK_STATUSES as readonly unknown[]).includes(value);
}

export function isRunningTaskStatus(value: unknown): boolean {
  return (RUNNING_TASK_STATUSES as readonly unknown[]).includes(value);
}

/** The status `event` leads to from `status`, or null when it is not allowed. */
export function nextTaskStatus(
  status: TaskStatus,
  event: TaskEvent,
): TaskStatus | null {
  const rule = TASK_TRANSITIONS[event];
  return (rule.from as readonly TaskStatus[]).includes(status) ? rule.to : null;
}

/**
 * Pause, reset and manual edits may leave any status, but may not claim that a
 * phase is running: nothing would ever finish it, and the task's buttons would
 * stay locked.
 */
export function canSetTaskStatusManually(value: unknown): value is TaskStatus {
  return isTaskStatus(value) && !isRunningTaskStatus(value);
}
