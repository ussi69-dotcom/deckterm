import { describe, expect, test } from "bun:test";
import {
  collectProcessTreeArgs,
  createLazyOnce,
  createSingleFlightCache,
  parseProcessTable,
} from "./runtime-sync-cache";

const PS_OUTPUT = [
  "    1     0 /sbin/init",
  "  100     1 tmux new-session -d",
  "  200   100 -bash",
  "  300   200 node /usr/bin/claude --resume",
  "  301   300 rg pattern",
  "  250   100 -bash",
  "  400     1 sshd: deploy",
  "garbage line",
  "  500   200    ",
].join("\n");

describe("process table snapshot", () => {
  test("parses pid/ppid/args and walks a subtree depth-first in ps order", () => {
    const snapshot = parseProcessTable(PS_OUTPUT);
    expect(collectProcessTreeArgs(snapshot, 200)).toEqual([
      "-bash",
      "node /usr/bin/claude --resume",
      "rg pattern",
    ]);
    expect(collectProcessTreeArgs(snapshot, 100)).toEqual([
      "tmux new-session -d",
      "-bash",
      "node /usr/bin/claude --resume",
      "rg pattern",
      "-bash",
    ]);
  });

  test("one snapshot serves many roots without re-parsing", () => {
    const snapshot = parseProcessTable(PS_OUTPUT);
    expect(collectProcessTreeArgs(snapshot, 250)).toEqual(["-bash"]);
    expect(collectProcessTreeArgs(snapshot, 400)).toEqual(["sshd: deploy"]);
    expect(collectProcessTreeArgs(snapshot, 999)).toEqual([]);
  });

  test("invalid roots yield an empty tree", () => {
    const snapshot = parseProcessTable(PS_OUTPUT);
    expect(collectProcessTreeArgs(snapshot, 0)).toEqual([]);
    expect(collectProcessTreeArgs(snapshot, -1)).toEqual([]);
    expect(collectProcessTreeArgs(snapshot, 1.5)).toEqual([]);
  });

  test("a ppid cycle does not loop forever", () => {
    const snapshot = parseProcessTable("  10 11 a\n  11 10 b\n");
    expect(collectProcessTreeArgs(snapshot, 10)).toEqual(["a", "b"]);
  });
});

describe("createLazyOnce", () => {
  test("runs the factory at most once and only when asked", async () => {
    let calls = 0;
    const get = createLazyOnce(async () => {
      calls += 1;
      return calls;
    });
    expect(calls).toBe(0);
    const [a, b] = await Promise.all([get(), get()]);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(await get()).toBe(1);
    expect(calls).toBe(1);
  });
});

describe("createSingleFlightCache", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  test("concurrent callers for the same key share one in-flight run", async () => {
    const cache = createSingleFlightCache<object, number>({ ttlMs: 2000 });
    const key = {};
    const gate = deferred<number>();
    let calls = 0;
    const run = () => {
      calls += 1;
      return gate.promise;
    };
    const first = cache.run(key, run);
    const second = cache.run(key, run);
    gate.resolve(7);
    expect(await first).toBe(7);
    expect(await second).toBe(7);
    expect(calls).toBe(1);
  });

  test("a settled result is reused within the TTL and refreshed after it", async () => {
    let clock = 0;
    const cache = createSingleFlightCache<object, number>({
      ttlMs: 2000,
      now: () => clock,
    });
    const key = {};
    let calls = 0;
    const run = async () => ++calls;

    expect(await cache.run(key, run)).toBe(1);
    clock = 1999;
    expect(await cache.run(key, run)).toBe(1);
    clock = 2000;
    expect(await cache.run(key, run)).toBe(2);
    expect(calls).toBe(2);
  });

  test("the TTL counts from when the run settled, not when it started", async () => {
    let clock = 0;
    const cache = createSingleFlightCache<object, number>({
      ttlMs: 2000,
      now: () => clock,
    });
    const key = {};
    const gate = deferred<number>();
    const pending = cache.run(key, () => gate.promise);
    clock = 5000; // slow tmux/ps
    gate.resolve(1);
    await pending;
    clock = 6500;
    let calls = 0;
    expect(await cache.run(key, async () => ++calls)).toBe(1);
    expect(calls).toBe(0);
  });

  test("different keys do not share results", async () => {
    const cache = createSingleFlightCache<object, string>({ ttlMs: 2000 });
    const a = {};
    const b = {};
    expect(await cache.run(a, async () => "a")).toBe("a");
    expect(await cache.run(b, async () => "b")).toBe("b");
  });

  test("failures reach every waiter and are not cached", async () => {
    const cache = createSingleFlightCache<object, number>({ ttlMs: 2000 });
    const key = {};
    const gate = deferred<number>();
    const first = cache.run(key, () => gate.promise);
    const second = cache.run(key, () => gate.promise);
    gate.reject(new Error("tmux gone"));
    await expect(first).rejects.toThrow("tmux gone");
    await expect(second).rejects.toThrow("tmux gone");
    expect(await cache.run(key, async () => 3)).toBe(3);
  });

  test("synchronous throws become rejections and are not cached", async () => {
    const cache = createSingleFlightCache<object, number>({ ttlMs: 2000 });
    const key = {};
    await expect(
      cache.run(key, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await cache.run(key, async () => 4)).toBe(4);
  });

  test("invalidate forces the next call to run again", async () => {
    const cache = createSingleFlightCache<object, number>({ ttlMs: 2000 });
    const key = {};
    let calls = 0;
    const run = async () => ++calls;
    await cache.run(key, run);
    cache.invalidate(key);
    expect(await cache.run(key, run)).toBe(2);
  });
});
