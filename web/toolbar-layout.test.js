import { describe, expect, test } from "bun:test";
import {
  TOOLBAR_DENSITY_TIERS,
  getDesktopTabReserveWidth,
  sumTierWidths,
} from "./toolbar-layout";

describe("getDesktopTabReserveWidth", () => {
  test("reserves nothing without tabs", () => {
    expect(getDesktopTabReserveWidth(0)).toBe(0);
    expect(getDesktopTabReserveWidth(undefined)).toBe(0);
  });

  test("keeps four comfortable 144px tabs", () => {
    expect(getDesktopTabReserveWidth(1)).toBe(144);
    expect(getDesktopTabReserveWidth(4)).toBe(4 * 144 + 3 * 4);
  });

  // The single-row/wrap decision (getDesktopTabLayoutByWidth) wraps when a
  // tab would drop under 118px. The reserve that picks the action density
  // must therefore cover five 118px tabs, or the toolbar keeps wider action
  // labels while the fifth tab already wraps.
  test("reserves at least the single-row wrap threshold for five tabs", () => {
    expect(getDesktopTabReserveWidth(5)).toBeGreaterThanOrEqual(
      5 * 118 + 4 * 4,
    );
  });

  test("never shrinks as tabs are added", () => {
    let previous = 0;
    for (let count = 1; count <= 12; count += 1) {
      const width = getDesktopTabReserveWidth(count);
      expect(width).toBeGreaterThanOrEqual(previous);
      previous = width;
    }
  });
});

describe("sumTierWidths", () => {
  test("adds the per-tier widths of every elastic toolbar group", () => {
    const actions = { normal: 344, compact: 300, tight: 250, "icon-only": 148 };
    const stats = { normal: 205, compact: 205, tight: 120, "icon-only": 111 };
    expect(sumTierWidths([actions, stats])).toEqual({
      normal: 549,
      compact: 505,
      tight: 370,
      "icon-only": 259,
    });
  });

  test("skips missing groups and non-numeric entries", () => {
    const actions = { normal: 10, compact: 8, tight: 6, "icon-only": 4 };
    expect(sumTierWidths([actions, null, undefined, { normal: "x" }])).toEqual(
      actions,
    );
  });

  test("lists the tiers from roomiest to tightest", () => {
    expect(TOOLBAR_DENSITY_TIERS).toEqual([
      "normal",
      "compact",
      "tight",
      "icon-only",
    ]);
  });
});
