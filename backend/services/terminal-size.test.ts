import { describe, expect, test } from "bun:test";
import {
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  normalizeTerminalDimension,
  normalizeTerminalSize,
  resolveTerminalSize,
} from "./terminal-size";

describe("terminal sizes from clients", () => {
  test("whole numbers of at least 1, clamped to the maximum", () => {
    expect(normalizeTerminalSize(120, 30)).toEqual({ cols: 120, rows: 30 });
    expect(normalizeTerminalSize(80.9, 24.2)).toEqual({ cols: 80, rows: 24 });
    expect(normalizeTerminalSize(1, 1)).toEqual({ cols: 1, rows: 1 });
    expect(normalizeTerminalSize(100_000, 100_000)).toEqual({
      cols: MAX_TERMINAL_COLS,
      rows: MAX_TERMINAL_ROWS,
    });
    expect(normalizeTerminalSize(1e308, Infinity)).toBe(null);
    expect(normalizeTerminalSize("132", "40")).toEqual({ cols: 132, rows: 40 });
  });

  test("anything else is refused (the WS path ignores that resize)", () => {
    for (const bad of [
      0,
      -5,
      0.5,
      Number.NaN,
      "",
      " ",
      "x",
      null,
      undefined,
      {},
      [],
      true,
    ]) {
      expect(normalizeTerminalDimension(bad, 100)).toBe(null);
      expect(normalizeTerminalSize(bad, 24)).toBe(null);
      expect(normalizeTerminalSize(80, bad)).toBe(null);
    }
  });

  test("create and HTTP resize fall back per dimension", () => {
    expect(resolveTerminalSize(undefined, undefined)).toEqual({
      cols: 120,
      rows: 30,
    });
    expect(resolveTerminalSize(-1, 5000)).toEqual({
      cols: 120,
      rows: MAX_TERMINAL_ROWS,
    });
    expect(resolveTerminalSize(5000, "x", { cols: 80, rows: 24 })).toEqual({
      cols: MAX_TERMINAL_COLS,
      rows: 24,
    });
  });
});
