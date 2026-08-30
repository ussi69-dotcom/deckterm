import { expect, test, describe } from "bun:test";
import {
  REAPER_DISABLED,
  isReaperEnabled,
  parseReaperWindowMs,
  resolveReaperWindows,
} from "./session-reaper-policy";

// These tests read an environment passed in as an argument, never process.env,
// so they are unaffected by the DeckTerm service environment a terminal running
// them inherits.

const HOUR_MS = 60 * 60 * 1000;

describe("parseReaperWindowMs", () => {
  test("an unset variable disables the reaper", () => {
    expect(parseReaperWindowMs(undefined, 1)).toBe(REAPER_DISABLED);
  });

  test("an empty or whitespace value disables the reaper", () => {
    expect(parseReaperWindowMs("", 1)).toBe(REAPER_DISABLED);
    expect(parseReaperWindowMs("   ", 1)).toBe(REAPER_DISABLED);
  });

  // The behaviour change worth pinning: "0" used to parse to a zero window,
  // and `idle > 0` is true for every session, so it meant "reap on the next
  // sweep" — the opposite of what an operator typing 0 intends.
  test("zero disables the reaper rather than reaping everything", () => {
    expect(parseReaperWindowMs("0", 1)).toBe(REAPER_DISABLED);
    expect(parseReaperWindowMs("0", HOUR_MS)).toBe(REAPER_DISABLED);
  });

  test("a negative value disables the reaper", () => {
    expect(parseReaperWindowMs("-1", 1)).toBe(REAPER_DISABLED);
    expect(parseReaperWindowMs("-7200000", 1)).toBe(REAPER_DISABLED);
  });

  test("garbage disables the reaper instead of producing NaN", () => {
    expect(parseReaperWindowMs("abc", 1)).toBe(REAPER_DISABLED);
    expect(parseReaperWindowMs("2 hours", 1)).toBe(REAPER_DISABLED);
    expect(parseReaperWindowMs("Infinity", 1)).toBe(REAPER_DISABLED);
  });

  test("a positive value keeps its previous meaning, scaled by the unit", () => {
    expect(parseReaperWindowMs("7200000", 1)).toBe(2 * HOUR_MS);
    expect(parseReaperWindowMs("8", HOUR_MS)).toBe(8 * HOUR_MS);
    expect(parseReaperWindowMs(" 8 ", HOUR_MS)).toBe(8 * HOUR_MS);
  });
});

describe("resolveReaperWindows", () => {
  test("both reapers are disabled by default", () => {
    const windows = resolveReaperWindows({});
    expect(windows.idleTimeoutMs).toBe(REAPER_DISABLED);
    expect(windows.detachedTtlMs).toBe(REAPER_DISABLED);
    expect(isReaperEnabled(windows.idleTimeoutMs)).toBe(false);
    expect(isReaperEnabled(windows.detachedTtlMs)).toBe(false);
  });

  test("an explicit window restores the old behaviour", () => {
    const windows = resolveReaperWindows({
      TERMINAL_IDLE_TIMEOUT_MS: "7200000",
      DECKTERM_ORPHAN_TTL_HOURS: "8",
    });
    expect(windows.idleTimeoutMs).toBe(2 * HOUR_MS);
    expect(windows.detachedTtlMs).toBe(8 * HOUR_MS);
    expect(isReaperEnabled(windows.idleTimeoutMs)).toBe(true);
    expect(isReaperEnabled(windows.detachedTtlMs)).toBe(true);
  });

  test("the two windows are independent", () => {
    const windows = resolveReaperWindows({
      DECKTERM_ORPHAN_TTL_HOURS: "12",
    });
    expect(windows.idleTimeoutMs).toBe(REAPER_DISABLED);
    expect(windows.detachedTtlMs).toBe(12 * HOUR_MS);
  });

  test("a misconfigured value disables that reaper without touching the other", () => {
    const windows = resolveReaperWindows({
      TERMINAL_IDLE_TIMEOUT_MS: "off",
      DECKTERM_ORPHAN_TTL_HOURS: "8",
    });
    expect(windows.idleTimeoutMs).toBe(REAPER_DISABLED);
    expect(windows.detachedTtlMs).toBe(8 * HOUR_MS);
  });
});

describe("isReaperEnabled", () => {
  test("only a positive finite window reaps", () => {
    expect(isReaperEnabled(1)).toBe(true);
    expect(isReaperEnabled(0)).toBe(false);
    expect(isReaperEnabled(-1)).toBe(false);
    expect(isReaperEnabled(Number.NaN)).toBe(false);
    expect(isReaperEnabled(Number.POSITIVE_INFINITY)).toBe(false);
  });
});
