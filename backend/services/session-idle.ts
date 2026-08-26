// Session idle accounting for the terminal reapers.
//
// The idle/detached reapers in server.ts used to measure liveness purely from
// `lastActivityAt`, which is only bumped on *user input* (a WS `input` frame).
// That treats an unattended-but-working session — an agent or batch job that
// streams output for hours without any keystrokes — as "idle", so the reapers
// killed long-running overnight jobs. Live PTY output is a genuine liveness
// signal too, so we fold `lastOutputAt` in here and reap only when there has
// been neither input NOR output for the configured window.

export interface SessionActivity {
  /** Last user input (keystroke) timestamp, epoch ms. */
  lastActivityAt: number;
  /** Last live PTY output timestamp, epoch ms; undefined before any output. */
  lastOutputAt?: number;
}

/**
 * Effective "last alive" timestamp: the later of the last user input and the
 * last live PTY output. A session actively producing output is never treated
 * as idle by the reapers, regardless of whether a browser is attached.
 */
export function effectiveActivityAt(term: SessionActivity): number {
  return Math.max(term.lastActivityAt, term.lastOutputAt ?? 0);
}

/** Milliseconds since the session was last alive (input or output). */
export function idleMsSince(term: SessionActivity, now: number): number {
  return now - effectiveActivityAt(term);
}

// Reaper ceilings. The defaults are the values proven on the tuned production
// host — they used to live only in a systemd drop-in there, so every fresh
// install silently ran with 2h/8h and "regularly lost sessions". 24h keeps an
// unattended overnight job alive; 72h bounds a shell nobody comes back to.
export const DEFAULT_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_DETACHED_TTL_HOURS = 72;

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface ReaperDefaults {
  /** Attached-but-idle terminals are closed after this many ms. */
  idleTimeoutMs: number;
  /** Detached terminals with neither input nor output are reaped after this. */
  detachedTtlMs: number;
}

export function resolveReaperDefaults(
  env: Record<string, string | undefined>,
): ReaperDefaults {
  return {
    idleTimeoutMs: positiveInt(
      env.TERMINAL_IDLE_TIMEOUT_MS,
      DEFAULT_IDLE_TIMEOUT_MS,
    ),
    detachedTtlMs:
      positiveInt(env.DECKTERM_ORPHAN_TTL_HOURS, DEFAULT_DETACHED_TTL_HOURS) *
      60 *
      60 *
      1000,
  };
}
