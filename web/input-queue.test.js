import { expect, test } from "bun:test";
import {
  INPUT_QUEUE_MAX_AGE_MS,
  INPUT_QUEUE_MAX_BYTES,
  InputQueue,
  measureInputBytes,
} from "./input-queue.js";

function makeClock(start = 1000) {
  const clock = { now: start };
  clock.fn = () => clock.now;
  return clock;
}

test("defaults bound the queue to 8 KB and 15 s", () => {
  expect(INPUT_QUEUE_MAX_BYTES).toBe(8 * 1024);
  expect(INPUT_QUEUE_MAX_AGE_MS).toBe(15000);
});

test("measureInputBytes counts UTF-8 bytes, not UTF-16 units", () => {
  expect(measureInputBytes("abc")).toBe(3);
  expect(measureInputBytes("č")).toBe(2);
  expect(measureInputBytes("")).toBe(0);
});

test("drain returns queued input in order and empties the queue", () => {
  const clock = makeClock();
  const queue = new InputQueue({ now: clock.fn });
  expect(queue.push("ls")).toBe(0);
  expect(queue.push(" -la")).toBe(0);
  expect(queue.push("\r")).toBe(0);
  expect(queue.length).toBe(3);
  expect(queue.bytes).toBe(7);

  const { items, dropped } = queue.drain();
  expect(items).toEqual(["ls", " -la", "\r"]);
  expect(dropped).toBe(0);
  expect(queue.length).toBe(0);
  expect(queue.bytes).toBe(0);
});

test("ignores empty and non-string input", () => {
  const queue = new InputQueue();
  expect(queue.push("")).toBe(0);
  expect(queue.push(null)).toBe(0);
  expect(queue.length).toBe(0);
});

test("evicts the oldest input when the byte budget is exceeded", () => {
  const clock = makeClock();
  const queue = new InputQueue({ maxBytes: 10, now: clock.fn });
  queue.push("aaaa");
  queue.push("bbbb");
  // 4 + 4 + 4 = 12 > 10 → the oldest entry goes.
  expect(queue.push("cccc")).toBe(1);
  expect(queue.drain().items).toEqual(["bbbb", "cccc"]);
});

test("a single input larger than the budget is dropped, keeping older input", () => {
  const queue = new InputQueue({ maxBytes: 4 });
  queue.push("ab");
  expect(queue.push("0123456789")).toBe(1);
  expect(queue.drain().items).toEqual(["ab"]);
});

test("input older than the age limit is dropped on drain and reported", () => {
  const clock = makeClock();
  const queue = new InputQueue({ maxAgeMs: 15000, now: clock.fn });
  queue.push("old");
  clock.now += 10000;
  queue.push("new");
  clock.now += 6000; // "old" is now 16 s old, "new" 6 s
  const { items, dropped } = queue.drain();
  expect(items).toEqual(["new"]);
  expect(dropped).toBe(1);
});

test("push prunes expired input first and reports it as dropped", () => {
  const clock = makeClock();
  const queue = new InputQueue({ maxAgeMs: 1000, now: clock.fn });
  queue.push("stale");
  clock.now += 1001;
  expect(queue.push("fresh")).toBe(1);
  expect(queue.drain().items).toEqual(["fresh"]);
});

test("prune drops only expired input", () => {
  const clock = makeClock();
  const queue = new InputQueue({ maxAgeMs: 1000, now: clock.fn });
  queue.push("a");
  clock.now += 600;
  queue.push("b");
  clock.now += 500;
  expect(queue.prune()).toBe(1);
  expect(queue.length).toBe(1);
  expect(queue.msUntilNextExpiry()).toBe(500);
});

test("msUntilNextExpiry is null for an empty queue", () => {
  expect(new InputQueue().msUntilNextExpiry()).toBeNull();
});

test("clear discards everything and returns how much was discarded", () => {
  const queue = new InputQueue();
  queue.push("a");
  queue.push("b");
  expect(queue.clear()).toBe(2);
  expect(queue.length).toBe(0);
  expect(queue.bytes).toBe(0);
  expect(queue.clear()).toBe(0);
});
