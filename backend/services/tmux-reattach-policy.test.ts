import { describe, expect, test } from "bun:test";
import {
  TMUX_REATTACH_BACKOFF_MS,
  TMUX_REATTACH_STABLE_MS,
  planTmuxReattach,
} from "./tmux-reattach-policy";

describe("planTmuxReattach", () => {
  test("backs off 1 s, 5 s, 30 s, then gives up", () => {
    expect(TMUX_REATTACH_BACKOFF_MS).toEqual([1_000, 5_000, 30_000]);
    expect(planTmuxReattach(0, 10)).toEqual({ attempt: 1, delayMs: 1_000 });
    expect(planTmuxReattach(1, 10)).toEqual({ attempt: 2, delayMs: 5_000 });
    expect(planTmuxReattach(2, 10)).toEqual({ attempt: 3, delayMs: 30_000 });
    expect(planTmuxReattach(3, 10)).toBeNull();
    expect(planTmuxReattach(99, 0)).toBeNull();
  });

  test("an attach that stayed up long enough earns a fresh budget", () => {
    expect(planTmuxReattach(3, TMUX_REATTACH_STABLE_MS)).toEqual({
      attempt: 1,
      delayMs: 1_000,
    });
    expect(planTmuxReattach(3, TMUX_REATTACH_STABLE_MS - 1)).toBeNull();
  });

  test("custom schedules and nonsense counts", () => {
    const opts = { backoffMs: [5, 10], stableMs: 100 };
    expect(planTmuxReattach(-4, 0, opts)).toEqual({ attempt: 1, delayMs: 5 });
    expect(planTmuxReattach(1, 0, opts)).toEqual({ attempt: 2, delayMs: 10 });
    expect(planTmuxReattach(2, 0, opts)).toBeNull();
    expect(planTmuxReattach(2, 100, opts)).toEqual({ attempt: 1, delayMs: 5 });
  });
});
