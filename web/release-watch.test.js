import { expect, test } from "bun:test";
import {
  RELEASE_CHECK_INTERVAL_MS,
  createReleaseWatcher,
  isNewBuild,
  normalizeBuild,
  startReleaseWatch,
} from "./release-watch.js";

test("normalizeBuild accepts short fingerprint strings only", () => {
  expect(normalizeBuild("a1b2c3d4e5f6")).toBe("a1b2c3d4e5f6");
  expect(normalizeBuild("  abc  ")).toBe("abc");
  expect(normalizeBuild("")).toBeNull();
  expect(normalizeBuild(null)).toBeNull();
  expect(normalizeBuild(42)).toBeNull();
  expect(normalizeBuild("x".repeat(200))).toBeNull();
});

test("isNewBuild needs a known baseline and a different, undismissed build", () => {
  expect(isNewBuild({ loadedBuild: "a", currentBuild: "b" })).toBe(true);
  expect(isNewBuild({ loadedBuild: "a", currentBuild: "a" })).toBe(false);
  expect(isNewBuild({ loadedBuild: null, currentBuild: "b" })).toBe(false);
  expect(isNewBuild({ loadedBuild: "a", currentBuild: null })).toBe(false);
  expect(
    isNewBuild({ loadedBuild: "a", currentBuild: "b", dismissedBuild: "b" }),
  ).toBe(false);
  expect(
    isNewBuild({ loadedBuild: "a", currentBuild: "c", dismissedBuild: "b" }),
  ).toBe(true);
});

function makeWatcher(builds, extra = {}) {
  let clock = 0;
  const updates = [];
  let index = 0;
  const watcher = createReleaseWatcher({
    fetchBuild: async () => {
      const next = builds[Math.min(index, builds.length - 1)];
      index += 1;
      if (next instanceof Error) throw next;
      return next;
    },
    onUpdate: (build) => updates.push(build),
    now: () => clock,
    minGapMs: 30_000,
    ...extra,
  });
  return {
    watcher,
    updates,
    fetches: () => index,
    advance: (ms) => {
      clock += ms;
    },
  };
}

test("the first successful check sets the baseline without notifying", async () => {
  const { watcher, updates } = makeWatcher(["aaa"]);
  await watcher.check({ force: true });
  expect(watcher.getState().loadedBuild).toBe("aaa");
  expect(updates).toEqual([]);
});

test("a changed build notifies once; the same build does not re-notify", async () => {
  const { watcher, updates, advance } = makeWatcher(["aaa", "bbb", "bbb"]);
  await watcher.check({ force: true });
  advance(60_000);
  await watcher.check();
  expect(updates).toEqual(["bbb"]);
  advance(60_000);
  await watcher.check();
  expect(updates).toEqual(["bbb"]);
});

test("dismissing hides that build but a newer one notifies again", async () => {
  const { watcher, updates, advance } = makeWatcher([
    "aaa",
    "bbb",
    "bbb",
    "ccc",
  ]);
  await watcher.check({ force: true });
  advance(60_000);
  await watcher.check();
  watcher.dismiss();
  advance(60_000);
  await watcher.check();
  expect(updates).toEqual(["bbb"]);
  advance(60_000);
  await watcher.check();
  expect(updates).toEqual(["bbb", "ccc"]);
});

test("checks are throttled unless forced, and share one in-flight request", async () => {
  const { watcher, fetches, advance } = makeWatcher(["aaa"]);
  await watcher.check({ force: true });
  expect(fetches()).toBe(1);
  advance(10_000);
  await watcher.check(); // inside the 30 s gap → skipped
  expect(fetches()).toBe(1);
  await watcher.check({ force: true });
  expect(fetches()).toBe(2);
  advance(30_000);
  await Promise.all([watcher.check(), watcher.check()]);
  expect(fetches()).toBe(3);
});

test("a failed or empty fetch neither notifies nor sets the baseline", async () => {
  const { watcher, updates, advance } = makeWatcher([
    new Error("offline"),
    null,
    "aaa",
    "bbb",
  ]);
  await watcher.check({ force: true });
  await watcher.check({ force: true });
  expect(watcher.getState().loadedBuild).toBeNull();
  await watcher.check({ force: true });
  expect(watcher.getState().loadedBuild).toBe("aaa");
  advance(60_000);
  await watcher.check();
  expect(updates).toEqual(["bbb"]);
});

function fakeEnvironment({ hidden = false } = {}) {
  const listeners = { window: {}, document: {} };
  const timers = [];
  const add = (bucket) => (type, fn) => {
    (listeners[bucket][type] ||= []).push(fn);
  };
  const doc = { hidden, addEventListener: add("document") };
  const win = { addEventListener: add("window") };
  return {
    doc,
    win,
    timers,
    setIntervalFn: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    fire: (bucket, type) =>
      (listeners[bucket][type] || []).forEach((fn) => fn()),
  };
}

test("startReleaseWatch checks at start, on visible, on online, and every 10 minutes while visible", async () => {
  const env = fakeEnvironment();
  const calls = [];
  const watcher = {
    check: (options = {}) => {
      calls.push(options.force ? "force" : "check");
      return Promise.resolve();
    },
  };
  startReleaseWatch({
    watcher,
    document: env.doc,
    window: env.win,
    setIntervalFn: env.setIntervalFn,
  });
  expect(calls).toEqual(["force"]);
  expect(env.timers).toHaveLength(1);
  expect(env.timers[0].ms).toBe(RELEASE_CHECK_INTERVAL_MS);
  expect(RELEASE_CHECK_INTERVAL_MS).toBe(10 * 60 * 1000);

  env.timers[0].fn();
  expect(calls).toEqual(["force", "check"]);

  env.doc.hidden = true;
  env.timers[0].fn(); // hidden → skipped
  env.fire("document", "visibilitychange"); // still hidden → skipped
  expect(calls).toEqual(["force", "check"]);

  env.doc.hidden = false;
  env.fire("document", "visibilitychange");
  expect(calls).toEqual(["force", "check", "check"]);

  env.fire("window", "online");
  expect(calls).toEqual(["force", "check", "check", "check"]);
});
