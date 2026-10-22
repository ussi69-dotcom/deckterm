import { expect, test } from "bun:test";
import {
  TOUCH_SCROLL_DEFAULTS,
  MAX_LINES_PER_MESSAGE,
  createTouchScrollTracker,
  directionForLines,
  cellFromPoint,
  takeTouchScrollMessage,
} from "./touch-scroll.js";

const sumLines = (results) =>
  results.reduce((sum, result) => sum + result.linesDelta, 0);

test("defaults match the M0 contract", () => {
  expect(TOUCH_SCROLL_DEFAULTS.slopPx).toBe(10);
  expect(TOUCH_SCROLL_DEFAULTS.axisRatio).toBe(1.5);
  expect(TOUCH_SCROLL_DEFAULTS.decayPerFrame).toBe(0.95);
  expect(TOUCH_SCROLL_DEFAULTS.frameMs).toBe(16);
  expect(TOUCH_SCROLL_DEFAULTS.maxMomentumMs).toBe(2000);
  expect(MAX_LINES_PER_MESSAGE).toBe(100);
});

test("movement inside the slop stays pending (a tap)", () => {
  const tracker = createTouchScrollTracker();
  expect(tracker.start({ x: 100, y: 100, t: 0, rowHeight: 20 })).toEqual({
    phase: "pending",
    linesDelta: 0,
  });
  expect(tracker.move({ x: 104, y: 106, t: 16 })).toEqual({
    phase: "pending",
    linesDelta: 0,
  });
  expect(tracker.end({ t: 40 })).toEqual({ phase: "idle", momentum: false });
});

test("a mostly vertical move locks vertical and counts the slop", () => {
  const tracker = createTouchScrollTracker();
  tracker.start({ x: 100, y: 100, t: 0, rowHeight: 10 });
  const first = tracker.move({ x: 103, y: 125, t: 16 });
  expect(first.phase).toBe("vertical");
  expect(first.linesDelta).toBe(2); // 25 px over 10 px rows, 5 px kept
  // The kept remainder adds up: 5 + 5 = one more row.
  expect(tracker.move({ x: 140, y: 130, t: 32 })).toEqual({
    phase: "vertical",
    linesDelta: 1,
  });
});

test("finger down gives positive lines (older output), finger up negative", () => {
  const down = createTouchScrollTracker();
  down.start({ x: 0, y: 0, t: 0, rowHeight: 20 });
  expect(down.move({ x: 0, y: 60, t: 16 }).linesDelta).toBe(3);
  expect(directionForLines(3)).toBe("up");

  const up = createTouchScrollTracker();
  up.start({ x: 0, y: 200, t: 0, rowHeight: 20 });
  expect(up.move({ x: 0, y: 140, t: 16 }).linesDelta).toBe(-3);
  expect(directionForLines(-3)).toBe("down");
});

test("one line per row crossed; the remainder is never lost", () => {
  const tracker = createTouchScrollTracker();
  tracker.start({ x: 0, y: 0, t: 0, rowHeight: 17 });
  const results = [];
  let y = 0;
  for (let i = 1; i <= 50; i++) {
    y += 7;
    results.push(tracker.move({ x: 0, y, t: i * 16 }));
  }
  expect(sumLines(results)).toBe(Math.trunc(350 / 17));
  // Back up by the same distance: net zero rows.
  for (let i = 51; i <= 100; i++) {
    y -= 7;
    results.push(tracker.move({ x: 0, y, t: i * 16 }));
  }
  expect(sumLines(results)).toBe(0);
});

test("a mostly horizontal move locks horizontal and never produces lines", () => {
  const tracker = createTouchScrollTracker();
  tracker.start({ x: 100, y: 100, t: 0, rowHeight: 10 });
  expect(tracker.move({ x: 130, y: 110, t: 16 })).toEqual({
    phase: "horizontal",
    linesDelta: 0,
  });
  // Later vertical movement does not switch axis.
  expect(tracker.move({ x: 130, y: 300, t: 32 })).toEqual({
    phase: "horizontal",
    linesDelta: 0,
  });
  expect(tracker.end({ t: 48 }).momentum).toBe(false);
});

test("a diagonal at exactly 1.5x is not vertical", () => {
  const tracker = createTouchScrollTracker();
  tracker.start({ x: 0, y: 0, t: 0, rowHeight: 10 });
  expect(tracker.move({ x: 20, y: 30, t: 16 }).phase).toBe("horizontal");
  const steeper = createTouchScrollTracker();
  steeper.start({ x: 0, y: 0, t: 0, rowHeight: 10 });
  expect(steeper.move({ x: 20, y: 31, t: 16 }).phase).toBe("vertical");
});

test("cancel (second finger) stops lines and momentum", () => {
  const tracker = createTouchScrollTracker();
  tracker.start({ x: 0, y: 0, t: 0, rowHeight: 10 });
  tracker.move({ x: 0, y: 40, t: 16 });
  expect(tracker.cancel()).toEqual({ phase: "cancelled", linesDelta: 0 });
  expect(tracker.move({ x: 0, y: 200, t: 32 })).toEqual({
    phase: "cancelled",
    linesDelta: 0,
  });
  expect(tracker.end({ t: 40 }).momentum).toBe(false);
  expect(tracker.isMomentumActive()).toBe(false);
});

test("a fast release starts momentum that decays and stops", () => {
  const tracker = createTouchScrollTracker();
  tracker.start({ x: 0, y: 0, t: 0, rowHeight: 10 });
  // 2 px/ms downward for the last 100 ms.
  for (let t = 16; t <= 160; t += 16) tracker.move({ x: 0, y: t * 2, t });
  expect(tracker.end({ t: 165 })).toEqual({ phase: "idle", momentum: true });
  expect(tracker.isMomentumActive()).toBe(true);

  let total = 0;
  let previous = Infinity;
  let t = 165;
  let frames = 0;
  for (; frames < 500; frames++) {
    t += 16;
    const step = tracker.stepMomentum(t);
    expect(step.linesDelta).toBeGreaterThanOrEqual(0);
    total += step.linesDelta;
    if (step.done) break;
    expect(step.linesDelta).toBeLessThanOrEqual(previous + 1);
    previous = step.linesDelta;
  }
  expect(tracker.isMomentumActive()).toBe(false);
  // Geometric series: 2 px/ms * 16 ms / (1 - 0.95) = 640 px at most.
  expect(total).toBeGreaterThan(20);
  expect(total).toBeLessThanOrEqual(64);
  // Stops within the 2 s cap.
  expect(t - 165).toBeLessThanOrEqual(2000 + 16);
});

test("momentum honours the 2 s cap", () => {
  const tracker = createTouchScrollTracker({ minVelocity: 0.0001 });
  tracker.start({ x: 0, y: 0, t: 0, rowHeight: 10 });
  for (let t = 16; t <= 96; t += 16) tracker.move({ x: 0, y: t * 3, t });
  tracker.end({ t: 100 });
  let done = false;
  let t = 100;
  while (!done && t < 10000) {
    t += 16;
    done = tracker.stepMomentum(t).done;
  }
  expect(t - 100).toBeLessThanOrEqual(2016);
});

test("finger resting before release: no momentum", () => {
  const tracker = createTouchScrollTracker();
  tracker.start({ x: 0, y: 0, t: 0, rowHeight: 10 });
  tracker.move({ x: 0, y: 100, t: 50 });
  expect(tracker.end({ t: 400 }).momentum).toBe(false);
});

test("a new touch stops momentum", () => {
  const tracker = createTouchScrollTracker();
  tracker.start({ x: 0, y: 0, t: 0, rowHeight: 10 });
  for (let t = 16; t <= 96; t += 16) tracker.move({ x: 0, y: -t * 2, t });
  expect(tracker.end({ t: 100 }).momentum).toBe(true);
  tracker.start({ x: 0, y: 0, t: 120, rowHeight: 10 });
  expect(tracker.isMomentumActive()).toBe(false);
  expect(tracker.stepMomentum(140)).toEqual({ linesDelta: 0, done: true });
});

test("upward fling produces negative lines", () => {
  const tracker = createTouchScrollTracker();
  tracker.start({ x: 0, y: 500, t: 0, rowHeight: 10 });
  for (let t = 16; t <= 96; t += 16) tracker.move({ x: 0, y: 500 - t * 2, t });
  tracker.end({ t: 100 });
  const step = tracker.stepMomentum(150);
  expect(step.linesDelta).toBeLessThan(0);
});

test("cellFromPoint maps to 1-based cells and clamps to the grid", () => {
  const rect = { left: 10, top: 20, width: 400, height: 200 };
  expect(cellFromPoint({ x: 10, y: 20, rect, cols: 80, rows: 20 })).toEqual({
    col: 1,
    row: 1,
  });
  expect(cellFromPoint({ x: 210, y: 120, rect, cols: 80, rows: 20 })).toEqual({
    col: 41,
    row: 11,
  });
  expect(cellFromPoint({ x: 9999, y: -50, rect, cols: 80, rows: 20 })).toEqual(
    { col: 80, row: 1 },
  );
  expect(cellFromPoint({ x: 1, y: 1, rect: null, cols: 80, rows: 20 })).toBe(
    null,
  );
  expect(
    cellFromPoint({ x: 1, y: 1, rect: { ...rect, width: 0 }, cols: 80, rows: 20 }),
  ).toBe(null);
  expect(cellFromPoint({ x: 1, y: 1, rect, cols: 0, rows: 20 })).toBe(null);
});

test("takeTouchScrollMessage builds the contract shape", () => {
  expect(takeTouchScrollMessage(0)).toEqual({ message: null, rest: 0 });
  expect(takeTouchScrollMessage(3, { col: 5, row: 7 })).toEqual({
    message: { type: "touch-scroll", direction: "up", lines: 3, col: 5, row: 7 },
    rest: 0,
  });
  expect(takeTouchScrollMessage(-4)).toEqual({
    message: { type: "touch-scroll", direction: "down", lines: 4 },
    rest: 0,
  });
});

test("takeTouchScrollMessage caps at 100 lines and carries the rest", () => {
  expect(takeTouchScrollMessage(250, null)).toEqual({
    message: { type: "touch-scroll", direction: "up", lines: 100 },
    rest: 150,
  });
  expect(takeTouchScrollMessage(-130, null)).toEqual({
    message: { type: "touch-scroll", direction: "down", lines: 100 },
    rest: -30,
  });
  expect(takeTouchScrollMessage(Number.NaN)).toEqual({
    message: null,
    rest: 0,
  });
});
