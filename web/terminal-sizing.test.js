import { expect, test } from "bun:test";
import {
  clampPanelHeightPercent,
  estimateTerminalGrid,
  minPanelHeightPx,
  normalizeTerminalGrid,
  predictInitialTilePixels,
} from "./terminal-sizing";

test("predictInitialTilePixels uses full container size for a fresh workspace", () => {
  expect(
    predictInitialTilePixels({
      containerWidth: 1440,
      containerHeight: 900,
      split: false,
    }),
  ).toEqual({ width: 1440, height: 900 });
});

test("predictInitialTilePixels halves width when splitting a wide tile", () => {
  expect(
    predictInitialTilePixels({
      containerWidth: 1440,
      containerHeight: 900,
      split: true,
      activeTileWidth: 1000,
      activeTileHeight: 500,
    }),
  ).toEqual({ width: 500, height: 500 });
});

test("predictInitialTilePixels halves height when splitting a tall tile", () => {
  expect(
    predictInitialTilePixels({
      containerWidth: 1440,
      containerHeight: 900,
      split: true,
      activeTileWidth: 500,
      activeTileHeight: 1000,
    }),
  ).toEqual({ width: 500, height: 500 });
});

test("estimateTerminalGrid converts pixel bounds into terminal columns and rows", () => {
  expect(
    estimateTerminalGrid({
      width: 1400,
      height: 850,
      cellWidth: 8.4,
      cellHeight: 21,
      horizontalPadding: 16,
      verticalPadding: 16,
      fallbackCols: 120,
      fallbackRows: 30,
    }),
  ).toEqual({ cols: 164, rows: 39 });
});

test("estimateTerminalGrid falls back when font metrics are unavailable", () => {
  expect(
    estimateTerminalGrid({
      width: 0,
      height: 0,
      cellWidth: 0,
      cellHeight: 0,
      fallbackCols: 120,
      fallbackRows: 30,
    }),
  ).toEqual({ cols: 120, rows: 30 });
});

test("normalizeTerminalGrid caps oversized desktop terminals", () => {
  expect(
    normalizeTerminalGrid({
      cols: 311,
      rows: 66,
      maxCols: 240,
      maxRows: 60,
    }),
  ).toEqual({ cols: 240, rows: 60 });
});

test("normalizeTerminalGrid preserves smaller mobile terminal sizes", () => {
  expect(
    normalizeTerminalGrid({
      cols: 44,
      rows: 36,
      maxCols: 240,
      maxRows: 60,
    }),
  ).toEqual({ cols: 44, rows: 36 });
});

// --- minPanelHeightPx (bug A3c: IDE terminal panel must fit >= 24 rows) ----

test("minPanelHeightPx computes exact 24-row floor at a real cell height", () => {
  expect(minPanelHeightPx({ cellHeight: 21, minRows: 24, chrome: 0 })).toBe(
    21 * 24,
  );
});

test("minPanelHeightPx adds chrome (borders/padding) on top of the row floor", () => {
  expect(minPanelHeightPx({ cellHeight: 21, minRows: 24, chrome: 17 })).toBe(
    21 * 24 + 17,
  );
});

test("minPanelHeightPx falls back to a conservative cell height when metrics are unavailable", () => {
  expect(
    minPanelHeightPx({
      cellHeight: 0,
      minRows: 24,
      chrome: 0,
      fallbackCellHeight: 20,
    }),
  ).toBe(20 * 24);
});

test("minPanelHeightPx ignores a non-finite/negative cellHeight and uses the fallback", () => {
  expect(
    minPanelHeightPx({
      cellHeight: -5,
      minRows: 24,
      fallbackCellHeight: 18,
    }),
  ).toBe(18 * 24);
  expect(
    minPanelHeightPx({
      cellHeight: NaN,
      minRows: 24,
      fallbackCellHeight: 18,
    }),
  ).toBe(18 * 24);
});

test("minPanelHeightPx defaults minRows to 24 when omitted", () => {
  expect(minPanelHeightPx({ cellHeight: 20 })).toBe(20 * 24);
});

// --- clampPanelHeightPercent (bug A3c: default + drag-min share one clamp) -

test("clampPanelHeightPercent leaves a percentage untouched when it already clears the pixel floor", () => {
  // 60% of 900px = 540px, which already clears the 504px (24-row) floor.
  expect(
    clampPanelHeightPercent({
      pct: 60,
      containerHeightPx: 900,
      minHeightPx: 504, // 24 rows * 21px
    }),
  ).toBe(60);
});

test("clampPanelHeightPercent raises a too-small percentage up to the pixel floor", () => {
  // 504px floor over a 900px column is 56%; the stored 35% default must be
  // raised to it rather than silently under-shooting 24 rows.
  const result = clampPanelHeightPercent({
    pct: 35,
    containerHeightPx: 900,
    minHeightPx: 504,
  });
  expect(result).toBeCloseTo(56, 5);
});

test("clampPanelHeightPercent never exceeds maxPct even when the floor demands more", () => {
  const result = clampPanelHeightPercent({
    pct: 35,
    containerHeightPx: 300,
    minHeightPx: 504, // floor alone would be 168%
    maxPct: 100,
  });
  expect(result).toBe(100);
});

test("clampPanelHeightPercent is a no-op passthrough when container geometry isn't available yet", () => {
  expect(
    clampPanelHeightPercent({
      pct: 35,
      containerHeightPx: 0,
      minHeightPx: 504,
    }),
  ).toBe(35);
});

test("clampPanelHeightPercent is a no-op passthrough when there is no pixel floor to enforce", () => {
  expect(
    clampPanelHeightPercent({
      pct: 35,
      containerHeightPx: 900,
      minHeightPx: 0,
    }),
  ).toBe(35);
});
