// How long a terminal session may live before a reaper ends it — and, by
// default, that it may live indefinitely.
//
// DeckTerm used to end sessions on three unrelated timers:
//
//   1. an *attached* terminal with no keystroke and no PTY output for 2 hours,
//   2. a *detached* terminal (browser gone) inactive for 8 hours,
//   3. a terminal whose tab the user closed with the ✕, after a 15-minute
//      restore window.
//
// Only the third one expresses an intention. The first two guess, and on a
// long-running remote workspace they guess wrong: an agent waiting at a prompt
// for the operator to answer produces neither input nor output, and looks
// exactly like an abandoned shell. Observed on the R9700 box on 2026-08-30,
// where the idle sweep ended three attached sessions the operator was still
// using (`[cleanup] Closing idle active terminal … (idle: 122min)`), each time
// killing the tmux session with it. A terminal workspace whose whole premise is
// that sessions survive is not allowed to do that.
//
// So both time-based reapers now default to *disabled*, and closing the tab
// stays the way a session ends. The windows remain configurable for a shared or
// resource-constrained deployment that does want them; a positive value
// restores exactly the previous behaviour.
//
// The values feed resolveSessionPolicy() in server.ts, which is the per-owner
// B7 seam — C3 replaces the process-wide default below with an admin-managed
// per-user policy on that same seam. Keep the disabled check on the resolved
// per-owner value, not on the module-level constant, or that will not work.

/** A reaper window in milliseconds; 0 means "never reap". */
export const REAPER_DISABLED = 0;

/**
 * Parses a reaper window from the environment.
 *
 * Anything that is not a positive finite number disables the reaper — an unset
 * variable, `0`, a negative value, or garbage. That is deliberate and it is a
 * change: `TERMINAL_IDLE_TIMEOUT_MS=0` previously meant *reap on the next
 * sweep*, because the sweeps compare `idle > timeout` and every idle time is
 * greater than zero. An operator typing `0` means "off", never "kill everything
 * every five minutes", and a typo that silently ends live sessions is the worst
 * failure this file can have. Positive values keep their old meaning exactly.
 *
 * @param raw the raw environment value, or undefined when unset
 * @param unitMs multiplier for the unit the variable is expressed in
 *   (1 for a milliseconds variable, 3_600_000 for an hours one)
 */
export function parseReaperWindowMs(
  raw: string | undefined,
  unitMs: number,
): number {
  if (raw === undefined || raw === null || raw.trim() === "") {
    return REAPER_DISABLED;
  }
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return REAPER_DISABLED;
  }
  return parsed * unitMs;
}

export type ReaperWindows = {
  /** Attached terminal with no input and no output for this long. */
  idleTimeoutMs: number;
  /** Detached terminal (no browser) with no input and no output for this long. */
  detachedTtlMs: number;
};

/**
 * Resolves both time-based reaper windows from an environment.
 *
 * Both default to disabled. `TERMINAL_IDLE_TIMEOUT_MS` is in milliseconds and
 * `DECKTERM_ORPHAN_TTL_HOURS` in hours, matching the names that shipped.
 */
export function resolveReaperWindows(
  env: Record<string, string | undefined>,
): ReaperWindows {
  return {
    idleTimeoutMs: parseReaperWindowMs(env.TERMINAL_IDLE_TIMEOUT_MS, 1),
    detachedTtlMs: parseReaperWindowMs(
      env.DECKTERM_ORPHAN_TTL_HOURS,
      60 * 60 * 1000,
    ),
  };
}

/** True when a resolved window actually ends sessions. */
export function isReaperEnabled(windowMs: number): boolean {
  return Number.isFinite(windowMs) && windowMs > 0;
}
