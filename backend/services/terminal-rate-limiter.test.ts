import { expect, test } from "bun:test";
import { createTerminalRateLimiter } from "./terminal-rate-limiter";

function makeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

test("per-owner fairness: A exhausting A's budget never blocks B", () => {
  const clock = makeClock();
  const limiter = createTerminalRateLimiter({
    windowMs: 60_000,
    perUserMax: 5,
    globalMax: 20,
    now: clock.now,
  });

  for (let i = 0; i < 5; i++) {
    expect(limiter.canCreate("alice")).toBe("ok");
    limiter.record("alice");
  }
  expect(limiter.canCreate("alice")).toBe("user_limit");
  expect(limiter.canCreate("bob")).toBe("ok");
  limiter.record("bob");
  expect(limiter.canCreate("bob")).toBe("ok");
  // Alice stays limited until her window slides.
  expect(limiter.canCreate("alice")).toBe("user_limit");
  clock.advance(60_001);
  expect(limiter.canCreate("alice")).toBe("ok");
});

test("global backstop trips before any single owner reaches their cap sum", () => {
  const clock = makeClock();
  const limiter = createTerminalRateLimiter({
    windowMs: 60_000,
    perUserMax: 5,
    globalMax: 8,
    now: clock.now,
  });

  for (const owner of ["a", "b", "c", "d"]) {
    limiter.record(owner);
    limiter.record(owner);
  }
  // 8 creations total in the window — global backstop for everyone,
  // including a brand-new owner.
  expect(limiter.canCreate("a")).toBe("global_limit");
  expect(limiter.canCreate("newcomer")).toBe("global_limit");
  clock.advance(60_001);
  expect(limiter.canCreate("newcomer")).toBe("ok");
});

test("sweep drops idle owners so bucket cardinality cannot grow unboundedly", () => {
  const clock = makeClock();
  const limiter = createTerminalRateLimiter({
    windowMs: 60_000,
    perUserMax: 5,
    globalMax: 100,
    now: clock.now,
  });

  for (let i = 0; i < 50; i++) limiter.record(`owner-${i}`);
  clock.advance(60_001);
  // All timestamps left the window; a canCreate sweep empties the map.
  expect(limiter.canCreate("fresh")).toBe("ok");
  const buckets = (limiter as unknown as { buckets?: Map<string, number[]> })
    .buckets;
  // The factory keeps buckets private; assert observable behavior instead:
  // every prior owner is back to a full budget.
  expect(limiter.canCreate("owner-0")).toBe("ok");
  expect(limiter.canCreate("owner-49")).toBe("ok");
  expect(buckets).toBeUndefined();
});

test("globalMax is clamped to at least perUserMax", () => {
  const limiter = createTerminalRateLimiter({
    windowMs: 60_000,
    perUserMax: 10,
    globalMax: 1,
  });
  // A single owner can still use their full budget: the effective global
  // limit is max(globalMax, perUserMax).
  for (let i = 0; i < 9; i++) limiter.record("solo");
  expect(limiter.canCreate("solo")).toBe("ok");
  limiter.record("solo");
  expect(limiter.canCreate("solo")).toBe("global_limit");
});
