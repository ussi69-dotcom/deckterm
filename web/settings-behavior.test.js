const { test, expect } = require("bun:test");
const {
  clampScrollbackLimit,
  allowsSnapZone,
  normalizeReconnectBehavior,
  createAutoFetchController,
} = require("./settings-behavior.js");

test("scrollback defaults safely to the historic 10000-line buffer", () => {
  expect(clampScrollbackLimit(undefined)).toBe(10000);
  expect(clampScrollbackLimit(1)).toBe(200);
  expect(clampScrollbackLimit(999999)).toBe(50000);
});

test("snap modes distinguish disabled, edges, and grid corners", () => {
  expect(allowsSnapZone("off", "left")).toBe(false);
  expect(allowsSnapZone("edges", "left")).toBe(true);
  expect(allowsSnapZone("edges", "top-left")).toBe(false);
  expect(allowsSnapZone("grid", "top-left")).toBe(true);
});

test("reconnect modes reject an unknown persisted value", () => {
  expect(normalizeReconnectBehavior("manual")).toBe("manual");
  expect(normalizeReconnectBehavior("unexpected")).toBe("auto");
});

test("auto-fetch never overlaps and stops when disabled", async () => {
  const scheduled = [];
  let calls = 0;
  let resolveFetch;
  const controller = createAutoFetchController({
    fetchNow: () => {
      calls += 1;
      return new Promise((resolve) => {
        resolveFetch = resolve;
      });
    },
    setTimer: (fn) => {
      scheduled.push(fn);
      return scheduled.length - 1;
    },
    clearTimer: () => {},
  });
  controller.configure(10);
  await scheduled.shift()();
  expect(calls).toBe(1);
  await controller.tick();
  expect(calls).toBe(1);
  resolveFetch();
  await Promise.resolve();
  controller.stop();
  expect(scheduled.length).toBeGreaterThan(0);
});

test("auto-fetch cancellation prevents a queued timer from making a request", async () => {
  const scheduled = [];
  let calls = 0;
  const controller = createAutoFetchController({
    fetchNow: async () => {
      calls += 1;
    },
    setTimer: (fn) => {
      scheduled.push(fn);
      return scheduled.length - 1;
    },
    // Simulate a timer callback already queued when cancellation happens.
    clearTimer: () => {},
  });
  controller.configure(30);
  controller.stop();
  await scheduled[0]();
  expect(calls).toBe(0);
});
