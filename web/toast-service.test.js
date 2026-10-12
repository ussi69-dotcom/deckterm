import { describe, expect, test } from "bun:test";
import {
  TOAST_ACTION_MIN_TIMEOUT_MS,
  TOAST_DEFAULT_TIMEOUT_MS,
  TOAST_MAX_ACTIONS,
  TOAST_MAX_VISIBLE,
  createToastTimer,
  normalizeToast,
  planToastStack,
} from "./toast-service.js";

const noop = () => {};

describe("normalizeToast", () => {
  test("needs a title or a body", () => {
    expect(normalizeToast({})).toBeNull();
    expect(normalizeToast({ title: "   " })).toBeNull();
    expect(normalizeToast(null)).toBeNull();
    // A body alone is promoted to the title.
    const promoted = normalizeToast({ body: "Only a body" });
    expect(promoted.title).toBe("Only a body");
    expect(promoted.body).toBe("");
  });

  test("unknown kinds fall back to info", () => {
    expect(normalizeToast({ title: "x", kind: "pending" }).kind).toBe("info");
    for (const kind of ["info", "success", "warning", "error"]) {
      expect(normalizeToast({ title: "x", kind }).kind).toBe(kind);
    }
  });

  test("keeps at most two valid actions", () => {
    const toast = normalizeToast({
      title: "x",
      actions: [
        { label: "Undo", run: noop },
        { label: "", run: noop },
        { label: "Broken" },
        { label: "Open", run: noop, dismiss: false },
        { label: "Third", run: noop },
      ],
    });
    expect(TOAST_MAX_ACTIONS).toBe(2);
    expect(toast.actions.map((action) => action.label)).toEqual([
      "Undo",
      "Open",
    ]);
    expect(toast.actions[0].dismiss).toBe(true);
    expect(toast.actions[1].dismiss).toBe(false);
  });

  test("timeouts: kind default, raised with actions, explicit, or sticky", () => {
    expect(normalizeToast({ title: "x", kind: "success" }).timeoutMs).toBe(
      TOAST_DEFAULT_TIMEOUT_MS.success,
    );
    expect(
      normalizeToast({
        title: "x",
        kind: "success",
        actions: [{ label: "Undo", run: noop }],
      }).timeoutMs,
    ).toBe(TOAST_ACTION_MIN_TIMEOUT_MS);
    expect(normalizeToast({ title: "x", timeoutMs: 1234 }).timeoutMs).toBe(
      1234,
    );
    expect(normalizeToast({ title: "x", timeoutMs: null }).timeoutMs).toBe(
      null,
    );
    expect(normalizeToast({ title: "x", timeoutMs: 0 }).timeoutMs).toBe(null);
  });

  test("clips long text and trims keys", () => {
    const toast = normalizeToast({
      title: "t".repeat(500),
      body: "b".repeat(2000),
      key: "  clipboard  ",
    });
    expect(Array.from(toast.title).length).toBe(200);
    expect(toast.title.endsWith("…")).toBe(true);
    expect(Array.from(toast.body).length).toBe(600);
    expect(toast.key).toBe("clipboard");
    expect(normalizeToast({ title: "x", key: "  " }).key).toBeNull();
  });

  test("dismissible unless explicitly disabled; keeps an element id", () => {
    expect(normalizeToast({ title: "x" }).dismissible).toBe(true);
    expect(normalizeToast({ title: "x", dismissible: false }).dismissible).toBe(
      false,
    );
    expect(
      normalizeToast({ title: "x", id: "session-close-toast" }).elementId,
    ).toBe("session-close-toast");
  });
});

describe("planToastStack", () => {
  const toast = (name, { key = null, actions = [] } = {}) => ({
    name,
    key,
    actions,
  });
  const names = (entries) => entries.map((entry) => entry.name);

  test("appends below the limit", () => {
    const plan = planToastStack([toast("a")], toast("b"));
    expect(names(plan.entries)).toEqual(["a", "b"]);
    expect(plan.replaced).toBeNull();
    expect(plan.evicted).toEqual([]);
  });

  test("the same key replaces in place instead of stacking", () => {
    const first = toast("a", { key: "clipboard" });
    const plan = planToastStack(
      [first, toast("b")],
      toast("a2", { key: "clipboard" }),
    );
    expect(names(plan.entries)).toEqual(["a2", "b"]);
    expect(plan.replaced).toBe(first);
  });

  test("shows at most three: the oldest toast without actions goes first", () => {
    expect(TOAST_MAX_VISIBLE).toBe(3);
    const undo = toast("undo", { actions: [{ label: "Undo" }] });
    const plan = planToastStack(
      [undo, toast("copied"), toast("saved")],
      toast("new"),
    );
    expect(names(plan.entries)).toEqual(["undo", "saved", "new"]);
    expect(names(plan.evicted)).toEqual(["copied"]);
  });

  test("when every older toast has actions, the oldest goes", () => {
    const withAction = (name) => toast(name, { actions: [{ label: "Open" }] });
    const plan = planToastStack(
      [withAction("a"), withAction("b"), withAction("c")],
      toast("d"),
    );
    expect(names(plan.entries)).toEqual(["b", "c", "d"]);
    expect(names(plan.evicted)).toEqual(["a"]);
  });

  test("does not mutate the input list", () => {
    const entries = [toast("a"), toast("b"), toast("c")];
    planToastStack(entries, toast("d"));
    expect(names(entries)).toEqual(["a", "b", "c"]);
  });
});

describe("createToastTimer", () => {
  function makeClock() {
    const clock = { now: 0, timers: [] };
    clock.fn = () => clock.now;
    clock.setTimer = (fn, ms) => {
      const timer = { fn, at: clock.now + ms, cleared: false };
      clock.timers.push(timer);
      return timer;
    };
    clock.clearTimer = (timer) => {
      timer.cleared = true;
    };
    clock.advance = (ms) => {
      clock.now += ms;
      for (const timer of [...clock.timers]) {
        if (!timer.cleared && !timer.fired && timer.at <= clock.now) {
          timer.fired = true;
          timer.fn();
        }
      }
    };
    return clock;
  }

  const makeTimer = (clock, durationMs, onExpire) =>
    createToastTimer({
      durationMs,
      onExpire,
      now: clock.fn,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

  test("expires after its duration", () => {
    const clock = makeClock();
    let expired = 0;
    const timer = makeTimer(clock, 1000, () => expired++);
    clock.advance(999);
    expect(expired).toBe(0);
    clock.advance(1);
    expect(expired).toBe(1);
    expect(timer.isDone()).toBe(true);
  });

  test("hover pauses the countdown and resume continues from the remainder", () => {
    const clock = makeClock();
    let expired = 0;
    const timer = makeTimer(clock, 1000, () => expired++);
    clock.advance(400);
    timer.pause("hover");
    expect(timer.isPaused()).toBe(true);
    expect(timer.remainingMs()).toBe(600);
    clock.advance(5000);
    expect(expired).toBe(0);
    timer.resume("hover");
    clock.advance(599);
    expect(expired).toBe(0);
    clock.advance(1);
    expect(expired).toBe(1);
  });

  test("stays paused until every reason is released", () => {
    const clock = makeClock();
    let expired = 0;
    const timer = makeTimer(clock, 1000, () => expired++);
    timer.pause("hover");
    timer.pause("focus");
    timer.resume("hover");
    clock.advance(2000);
    expect(expired).toBe(0);
    expect(timer.isPaused()).toBe(true);
    timer.resume("focus");
    clock.advance(1000);
    expect(expired).toBe(1);
  });

  test("cancel stops it for good", () => {
    const clock = makeClock();
    let expired = 0;
    const timer = makeTimer(clock, 1000, () => expired++);
    timer.cancel();
    timer.resume("hover");
    clock.advance(5000);
    expect(expired).toBe(0);
  });
});
