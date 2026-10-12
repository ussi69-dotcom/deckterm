import { describe, expect, test } from "bun:test";
import {
  COMPOSE_HISTORY_ENTRY_MAX_CHARS,
  COMPOSE_HISTORY_MAX,
  COMPOSE_HISTORY_STORAGE_KEY,
  COMPOSE_SUBMIT_DELAY_MS,
  COMPOSE_SUBMIT_MAX_WAIT_MS,
  addToComposeHistory,
  clearComposeHistory,
  composeHistoryPreview,
  deliverComposePlan,
  loadComposeHistory,
  parseComposeHistory,
  planComposeSend,
  prepareComposeText,
  purgeLegacyComposeHistory,
  saveComposeHistory,
  scheduleDeferredSubmit,
} from "./compose-sheet.js";

describe("prepareComposeText / planComposeSend", () => {
  test("normalises line endings and drops trailing whitespace", () => {
    expect(prepareComposeText("line one\r\nline two\rthree\n\n  ")).toBe(
      "line one\nline two\nthree",
    );
    expect(prepareComposeText("  keep leading indent")).toBe(
      "  keep leading indent",
    );
  });

  test("blank or non-string text sends nothing", () => {
    expect(prepareComposeText("   \n\t")).toBe("");
    expect(prepareComposeText(null)).toBe("");
    expect(planComposeSend("  \n")).toBeNull();
  });

  test("Send pastes the text and submits with a separate deferred Enter", () => {
    const plan = planComposeSend("fix the tests\n");
    expect(plan).toEqual({
      text: "fix the tests",
      submit: true,
      submitDelayMs: COMPOSE_SUBMIT_DELAY_MS,
    });
    // Never an inline terminator: the Enter is its own keystroke.
    expect(plan.text.endsWith("\n")).toBe(false);
    expect(plan.text.endsWith("\r")).toBe(false);
  });

  test("Insert without Enter pastes only", () => {
    expect(planComposeSend("draft", { submit: false })).toMatchObject({
      text: "draft",
      submit: false,
    });
  });

  test("the submit gap matches the server's verified 300 ms", () => {
    expect(COMPOSE_SUBMIT_DELAY_MS).toBe(300);
    expect(COMPOSE_SUBMIT_MAX_WAIT_MS).toBe(15000);
  });
});

describe("compose history", () => {
  test("newest first, re-sending moves an entry to the top", () => {
    let history = [];
    history = addToComposeHistory(history, "one");
    history = addToComposeHistory(history, "two");
    history = addToComposeHistory(history, "one\n");
    expect(history).toEqual(["one", "two"]);
  });

  test("keeps the last 20", () => {
    expect(COMPOSE_HISTORY_MAX).toBe(20);
    let history = [];
    for (let i = 0; i < 25; i++) history = addToComposeHistory(history, `m${i}`);
    expect(history).toHaveLength(20);
    expect(history[0]).toBe("m24");
    expect(history.at(-1)).toBe("m5");
  });

  test("skips blank and oversized messages", () => {
    expect(addToComposeHistory(["a"], "   ")).toEqual(["a"]);
    expect(
      addToComposeHistory(["a"], "x".repeat(COMPOSE_HISTORY_ENTRY_MAX_CHARS + 1)),
    ).toEqual(["a"]);
  });

  test("parse tolerates garbage", () => {
    expect(parseComposeHistory("not json")).toEqual([]);
    expect(parseComposeHistory('{"a":1}')).toEqual([]);
    expect(parseComposeHistory('["a", 3, null, "a", "  ", "b"]')).toEqual([
      "a",
      "b",
    ]);
    expect(parseComposeHistory(null)).toEqual([]);
  });

  test("load/save round-trip through storage and survive storage errors", () => {
    const store = new Map();
    const storage = {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, value),
    };
    expect(saveComposeHistory(storage, ["b", "a"])).toBe(true);
    expect(JSON.parse(store.get(COMPOSE_HISTORY_STORAGE_KEY))).toEqual([
      "b",
      "a",
    ]);
    expect(loadComposeHistory(storage)).toEqual(["b", "a"]);

    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(loadComposeHistory(broken)).toEqual([]);
    expect(saveComposeHistory(broken, ["a"])).toBe(false);
    expect(loadComposeHistory(null)).toEqual([]);
  });

  test("preview is one line and clipped", () => {
    expect(composeHistoryPreview("a\n  b\tc")).toBe("a b c");
    const preview = composeHistoryPreview("y".repeat(200), 10);
    expect(Array.from(preview)).toHaveLength(10);
    expect(preview.endsWith("…")).toBe(true);
  });
});

describe("scheduleDeferredSubmit", () => {
  function makeTimers() {
    const timers = { queue: [], now: 0 };
    timers.set = (fn, ms) => {
      const timer = { fn, at: timers.now + ms, cleared: false };
      timers.queue.push(timer);
      return timer;
    };
    timers.clear = (timer) => {
      timer.cleared = true;
    };
    timers.advance = (ms) => {
      const target = timers.now + ms;
      for (;;) {
        const next = timers.queue
          .filter((timer) => !timer.cleared && !timer.fired && timer.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers.now = next.at;
        next.fired = true;
        next.fn();
      }
      timers.now = target;
    };
    return timers;
  }

  function run({ readyAtStart, readyAt }) {
    const timers = makeTimers();
    const sent = [];
    let gaveUp = false;
    scheduleDeferredSubmit({
      readyAtStart,
      isReady: () => readyAt(timers.now),
      send: () => sent.push(timers.now),
      onGiveUp: () => {
        gaveUp = true;
      },
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
    return { timers, sent, isGaveUp: () => gaveUp };
  }

  test("a paste sent directly is followed by Enter one delay later", () => {
    const { timers, sent } = run({ readyAtStart: true, readyAt: () => true });
    timers.advance(299);
    expect(sent).toEqual([]);
    timers.advance(1);
    expect(sent).toEqual([300]);
  });

  test("a queued paste: Enter waits a full delay after input became ready", () => {
    // Socket reconnects (queue flushed) at t=1000.
    const { timers, sent } = run({
      readyAtStart: false,
      readyAt: (now) => now >= 1000,
    });
    timers.advance(1200);
    // First ready tick (t=1200) only arms it; the Enter goes on the next.
    expect(sent).toEqual([]);
    timers.advance(300);
    expect(sent).toEqual([1500]);
    expect(sent[0] - 1000).toBeGreaterThanOrEqual(COMPOSE_SUBMIT_DELAY_MS);
  });

  test("readiness lost in between re-arms the wait", () => {
    const states = new Map([
      [300, false],
      [600, true],
      [900, false],
      [1200, true],
      [1500, true],
    ]);
    const { timers, sent } = run({
      readyAtStart: true,
      readyAt: (now) => states.get(now) ?? true,
    });
    timers.advance(1500);
    expect(sent).toEqual([1500]);
  });

  test("gives up when input never becomes ready", () => {
    const { timers, sent, isGaveUp } = run({
      readyAtStart: false,
      readyAt: () => false,
    });
    timers.advance(COMPOSE_SUBMIT_MAX_WAIT_MS + 1000);
    expect(sent).toEqual([]);
    expect(isGaveUp()).toBe(true);
  });

  test("cancel stops a pending Enter", () => {
    const timers = makeTimers();
    const sent = [];
    const handle = scheduleDeferredSubmit({
      readyAtStart: true,
      isReady: () => true,
      send: () => sent.push(timers.now),
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
    handle.cancel();
    timers.advance(5000);
    expect(sent).toEqual([]);
  });
});

describe("deliverComposePlan", () => {
  function setup({ ready = true, pasteResult } = {}) {
    const calls = [];
    return {
      calls,
      args: {
        isReady: () => ready,
        paste: (text) => {
          calls.push(["paste", text]);
          return pasteResult;
        },
        scheduleSubmit: () => calls.push(["submit"]),
      },
    };
  }

  test("ready: pastes, then schedules the deferred Enter for Send", () => {
    const { calls, args } = setup();
    const result = deliverComposePlan({
      plan: planComposeSend("hello"),
      ...args,
    });
    expect(result).toEqual({ accepted: true });
    expect(calls).toEqual([["paste", "hello"], ["submit"]]);
  });

  test("Insert without Enter schedules no Enter", () => {
    const { calls, args } = setup();
    deliverComposePlan({
      plan: planComposeSend("hello", { submit: false }),
      ...args,
    });
    expect(calls).toEqual([["paste", "hello"]]);
  });

  test("not connected: nothing is pasted or submitted, the text is kept", () => {
    const { calls, args } = setup({ ready: false });
    // Larger than the 8 KB reconnect queue: queueing it would lose it.
    const big = "ž".repeat(5000);
    const result = deliverComposePlan({ plan: planComposeSend(big), ...args });
    expect(result).toEqual({ accepted: false, reason: "not-connected" });
    expect(calls).toEqual([]);
  });

  test("a paste the transport refused schedules no lone Enter", () => {
    const { calls, args } = setup({ pasteResult: false });
    const result = deliverComposePlan({
      plan: planComposeSend("hello"),
      ...args,
    });
    expect(result).toEqual({ accepted: false, reason: "refused" });
    expect(calls).toEqual([["paste", "hello"]]);
  });

  test("an empty plan is not accepted", () => {
    const { calls, args } = setup();
    expect(deliverComposePlan({ plan: null, ...args })).toEqual({
      accepted: false,
      reason: "empty",
    });
    expect(calls).toEqual([]);
  });

  test("a readiness probe that throws counts as not connected", () => {
    const { calls, args } = setup();
    const result = deliverComposePlan({
      plan: planComposeSend("hello"),
      ...args,
      isReady: () => {
        throw new Error("gone");
      },
    });
    expect(result).toEqual({ accepted: false, reason: "not-connected" });
    expect(calls).toEqual([]);
  });
});

describe("scheduleDeferredSubmit wall clock", () => {
  test("gives up by elapsed time even when throttled timers fire rarely", () => {
    let clock = 0;
    const pending = [];
    let gaveUp = false;
    const sent = [];
    scheduleDeferredSubmit({
      readyAtStart: false,
      isReady: () => false,
      send: () => sent.push(clock),
      onGiveUp: () => {
        gaveUp = true;
      },
      now: () => clock,
      setTimer: (fn) => {
        pending.push(fn);
        return pending.length;
      },
      clearTimer: () => {},
    });
    // A background tab: the first tick only runs 20 s later.
    clock = 20000;
    pending.shift()();
    expect(gaveUp).toBe(true);
    expect(pending.length).toBe(0);
    expect(sent).toEqual([]);
  });
});

describe("compose history privacy", () => {
  function memoryStorage(initial = {}) {
    const store = new Map(Object.entries(initial));
    return {
      store,
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    };
  }

  test("Clear removes every saved message", () => {
    const storage = memoryStorage();
    saveComposeHistory(storage, ["sudo password", "b"]);
    expect(clearComposeHistory(storage)).toBe(true);
    expect(storage.store.has(COMPOSE_HISTORY_STORAGE_KEY)).toBe(false);
    expect(loadComposeHistory(storage)).toEqual([]);
  });

  test("the old persistent localStorage copy is deleted, not carried over", () => {
    const legacy = memoryStorage({
      [COMPOSE_HISTORY_STORAGE_KEY]: JSON.stringify(["api-key-123"]),
      other: "kept",
    });
    expect(purgeLegacyComposeHistory(legacy)).toBe(true);
    expect(legacy.store.has(COMPOSE_HISTORY_STORAGE_KEY)).toBe(false);
    expect(legacy.store.get("other")).toBe("kept");
  });

  test("clear/purge survive missing or throwing storage", () => {
    const broken = {
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(clearComposeHistory(broken)).toBe(false);
    expect(purgeLegacyComposeHistory(broken)).toBe(false);
    expect(clearComposeHistory(null)).toBe(false);
    expect(purgeLegacyComposeHistory(undefined)).toBe(false);
  });
});
