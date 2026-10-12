// Server-side re-attach after a tmux attach client died while its session
// lives on (detachDeadAttach). Without it, a session nobody's browser is
// watching drops out of the in-memory terminal map, and with it out of the
// pipe pump (agent notifications, the task runner's agent-done trigger) and
// the close-later / idle reapers.
//
// Retries back off and are capped, so an attach that keeps dying right away
// cannot loop hot. An attach that stayed up for a while earns a fresh budget.

export const TMUX_REATTACH_BACKOFF_MS: readonly number[] = [1_000, 5_000, 30_000];
export const TMUX_REATTACH_STABLE_MS = 60_000;

export type TmuxReattachPlan = { attempt: number; delayMs: number };

/**
 * The next re-attach attempt, or null when the budget is spent.
 * `previousAttempts` counts attempts already scheduled since the last stable
 * attach; `attachLivedMs` is how long the attach that just died stayed up
 * (0 when a scheduled restore itself came back empty).
 */
export function planTmuxReattach(
  previousAttempts: number,
  attachLivedMs: number,
  {
    backoffMs = TMUX_REATTACH_BACKOFF_MS,
    stableMs = TMUX_REATTACH_STABLE_MS,
  }: { backoffMs?: readonly number[]; stableMs?: number } = {},
): TmuxReattachPlan | null {
  const used = attachLivedMs >= stableMs ? 0 : Math.max(0, previousAttempts);
  if (used >= backoffMs.length) return null;
  return { attempt: used + 1, delayMs: backoffMs[used] };
}
