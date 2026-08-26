import { describe, expect, test } from "bun:test";
import {
  effectiveActivityAt,
  idleMsSince,
  resolveReaperDefaults,
} from "./session-idle";

describe("session-idle activity accounting", () => {
  test("falls back to lastActivityAt when no output has been seen", () => {
    expect(effectiveActivityAt({ lastActivityAt: 1000 })).toBe(1000);
    expect(effectiveActivityAt({ lastActivityAt: 1000, lastOutputAt: 0 })).toBe(
      1000,
    );
  });

  test("live output newer than input counts as activity", () => {
    // The overnight-job case: no keystrokes for hours, but output kept flowing.
    expect(
      effectiveActivityAt({ lastActivityAt: 1000, lastOutputAt: 9000 }),
    ).toBe(9000);
  });

  test("user input newer than output counts as activity", () => {
    expect(
      effectiveActivityAt({ lastActivityAt: 9000, lastOutputAt: 1000 }),
    ).toBe(9000);
  });

  test("idleMsSince measures from the later of input/output", () => {
    const now = 10_000;
    // Output at t=9000 keeps the session alive → only 1s idle, not 9s.
    expect(idleMsSince({ lastActivityAt: 1000, lastOutputAt: 9000 }, now)).toBe(
      1000,
    );
    // No output → idle measured from stale input.
    expect(idleMsSince({ lastActivityAt: 1000 }, now)).toBe(9000);
  });

  test("a session producing output is not idle past a 2h window", () => {
    const now = 3 * 60 * 60 * 1000; // 3h
    const twoHours = 2 * 60 * 60 * 1000;
    // Last input 3h ago, but output 1min ago → well under the idle window.
    const lastOutputAt = now - 60_000;
    expect(idleMsSince({ lastActivityAt: 0, lastOutputAt }, now)).toBeLessThan(
      twoHours,
    );
    // Same session with no output would be reaped (idle > window).
    expect(idleMsSince({ lastActivityAt: 0 }, now)).toBeGreaterThan(twoHours);
  });
});

describe("reaper defaults", () => {
  test("are 24h idle / 72h detached when env is unset", () => {
    const policy = resolveReaperDefaults({});
    expect(policy.idleTimeoutMs).toBe(24 * 60 * 60 * 1000);
    expect(policy.detachedTtlMs).toBe(72 * 60 * 60 * 1000);
  });

  test("honor explicit env overrides", () => {
    const policy = resolveReaperDefaults({
      TERMINAL_IDLE_TIMEOUT_MS: "7200000",
      DECKTERM_ORPHAN_TTL_HOURS: "8",
    });
    expect(policy.idleTimeoutMs).toBe(7_200_000);
    expect(policy.detachedTtlMs).toBe(8 * 60 * 60 * 1000);
  });

  test("ignore garbage or non-positive env values", () => {
    const policy = resolveReaperDefaults({
      TERMINAL_IDLE_TIMEOUT_MS: "soon",
      DECKTERM_ORPHAN_TTL_HOURS: "-3",
    });
    expect(policy.idleTimeoutMs).toBe(24 * 60 * 60 * 1000);
    expect(policy.detachedTtlMs).toBe(72 * 60 * 60 * 1000);
  });
});
