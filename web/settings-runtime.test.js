const { test, expect } = require("bun:test");
const { createSettingsRuntime } = require("./settings-runtime.js");

const SCHEMA = [
  {
    key: "appearance.accent",
    category: "Appearance",
    label: "Accent",
    type: "select",
    default: "blue",
    options: [
      { value: "blue", label: "Blue" },
      { value: "green", label: "Green" },
    ],
  },
  {
    key: "terminal.fontSize",
    category: "Terminal",
    label: "Font size",
    type: "number",
    default: 14,
    min: 8,
    max: 32,
  },
  {
    key: "terminal.wrapLines",
    category: "Terminal",
    label: "Wrap",
    type: "toggle",
    default: true,
  },
];

function fakeStore(initial = {}) {
  const cache = { ...initial };
  return {
    get(key, fallback) {
      return Object.prototype.hasOwnProperty.call(cache, key)
        ? cache[key]
        : fallback;
    },
    set(key, value) {
      cache[key] = value;
    },
    _cache: cache,
  };
}

test("applyAll invokes each registered side effect with the coerced stored value", () => {
  const store = fakeStore({ "terminal.fontSize": "20" });
  const seen = {};
  const runtime = createSettingsRuntime({
    store,
    schema: SCHEMA,
    sideEffects: {
      "terminal.fontSize": (v) => {
        seen.fontSize = v;
      },
      "terminal.wrapLines": (v) => {
        seen.wrap = v;
      },
    },
  });

  runtime.applyAll();

  // Stored "20" coerced to number 20.
  expect(seen.fontSize).toBe(20);
  // Missing key falls back to schema default true.
  expect(seen.wrap).toBe(true);
});

test("apply(key,value) coerces, persists to the store, and fires the side effect", () => {
  const store = fakeStore();
  let applied = null;
  const runtime = createSettingsRuntime({
    store,
    schema: SCHEMA,
    sideEffects: {
      "terminal.fontSize": (v) => {
        applied = v;
      },
    },
  });

  runtime.apply("terminal.fontSize", "99");

  // Clamped to max 32 then stored + applied.
  expect(applied).toBe(32);
  expect(store.get("terminal.fontSize")).toBe(32);
});

test("apply tolerates a key with no registered side effect", () => {
  const store = fakeStore();
  const runtime = createSettingsRuntime({ store, schema: SCHEMA });
  expect(() => runtime.apply("terminal.wrapLines", false)).not.toThrow();
  expect(store.get("terminal.wrapLines")).toBe(false);
});

test("onChange subscribers receive the coerced value for every apply", () => {
  const store = fakeStore();
  const events = [];
  const runtime = createSettingsRuntime({ store, schema: SCHEMA });
  const unsubscribe = runtime.onChange((key, value) => {
    events.push([key, value]);
  });

  runtime.apply("appearance.accent", "green");
  runtime.apply("appearance.accent", "not-an-option"); // -> default "blue"

  expect(events).toEqual([
    ["appearance.accent", "green"],
    ["appearance.accent", "blue"],
  ]);

  unsubscribe();
  runtime.apply("appearance.accent", "blue");
  // No further events after unsubscribe.
  expect(events.length).toBe(2);
});

test("register adds a side effect that fires on the next apply", () => {
  const store = fakeStore();
  let last = null;
  const runtime = createSettingsRuntime({ store, schema: SCHEMA });
  runtime.register("terminal.wrapLines", (v) => {
    last = v;
  });
  runtime.apply("terminal.wrapLines", "false");
  expect(last).toBe(false);
});

test("apply ignores unknown schema keys", () => {
  const store = fakeStore();
  const runtime = createSettingsRuntime({ store, schema: SCHEMA });
  runtime.apply("nope.unknown", "x");
  expect(store.get("nope.unknown", "absent")).toBe("absent");
});
