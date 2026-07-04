/**
 * B7 — per-owner terminal-create rate limiter with a global backstop (plan
 * docs/plans/2026-07-04-b6-b7-retention-limits.md, D-B7-1).
 *
 * ownerId MUST be the server-side resolved actor id — never client input —
 * and unauthenticated requests must be rejected before any limiter check.
 * The sweep drops owners with no timestamp inside the window, so owner
 * cardinality cannot grow memory unboundedly (Codex #6).
 */

export type RateLimitVerdict = "ok" | "user_limit" | "global_limit";

export type TerminalRateLimiter = {
  canCreate(ownerId: string): RateLimitVerdict;
  record(ownerId: string): void;
};

export function createTerminalRateLimiter(options: {
  windowMs: number;
  perUserMax: number;
  globalMax: number;
  now?: () => number;
}): TerminalRateLimiter {
  const windowMs = Math.max(1_000, options.windowMs);
  const perUserMax = Math.max(1, options.perUserMax);
  const globalMax = Math.max(perUserMax, options.globalMax);
  const now = options.now ?? Date.now;
  const buckets = new Map<string, number[]>();

  const sweep = () => {
    const t = now();
    for (const [owner, timestamps] of buckets) {
      const kept = timestamps.filter((ts) => t - ts < windowMs);
      if (kept.length === 0) {
        buckets.delete(owner);
      } else {
        buckets.set(owner, kept);
      }
    }
  };

  return {
    canCreate(ownerId: string): RateLimitVerdict {
      sweep();
      let total = 0;
      for (const timestamps of buckets.values()) total += timestamps.length;
      if (total >= globalMax) return "global_limit";
      const own = buckets.get(ownerId)?.length ?? 0;
      if (own >= perUserMax) return "user_limit";
      return "ok";
    },
    record(ownerId: string) {
      const bucket = buckets.get(ownerId) ?? [];
      bucket.push(now());
      buckets.set(ownerId, bucket);
    },
  };
}
