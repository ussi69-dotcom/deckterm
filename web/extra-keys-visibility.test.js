const { test, expect, describe } = require("bun:test");
const {
  EXTRA_KEYS_VISIBLE_KEYS,
  EXTRA_KEYS_VISIBLE_DEFAULTS,
  deviceClassFor,
  visibleKeyFor,
  readVisible,
  persistVisible,
  createSideEffects,
} = require("./extra-keys-visibility.js");
const { SETTINGS_SCHEMA, defaultsOf } = require("./settings-schema.js");
const { createSettingsRuntime } = require("./settings-runtime.js");

const DESKTOP_KEY = "terminal.extraKeysVisible";
const TOUCH_KEY = "terminal.extraKeysVisibleTouch";

function fakeStore(initial = {}) {
  const cache = { ...initial };
  return {
    cache,
    get(key, fallback) {
      return Object.prototype.hasOwnProperty.call(cache, key)
        ? cache[key]
        : fallback;
    },
    set(key, value) {
      cache[key] = value;
    },
  };
}

// The real runtime + real schema + the module's own side effects, wired the
// way app.js wires them. `applied` records every visibility the bar is told
// to take.
function harness(deviceClass, initial = {}) {
  const store = fakeStore(initial);
  const applied = [];
  const runtime = createSettingsRuntime({
    store,
    schema: SETTINGS_SCHEMA,
    sideEffects: createSideEffects({
      getDeviceClass: () => deviceClass,
      applyVisibility: (visible) => applied.push(visible),
    }),
  });
  return { store, runtime, applied };
}

describe("device-class keys", () => {
  test("desktop keeps the existing key; touch has its own key", () => {
    expect(EXTRA_KEYS_VISIBLE_KEYS.desktop).toBe(DESKTOP_KEY);
    expect(EXTRA_KEYS_VISIBLE_KEYS.touch).toBe(TOUCH_KEY);
    expect(visibleKeyFor("desktop")).toBe(DESKTOP_KEY);
    expect(visibleKeyFor("touch")).toBe(TOUCH_KEY);
  });

  test("deviceClassFor maps platformDetector.isMobile", () => {
    expect(deviceClassFor(true)).toBe("touch");
    expect(deviceClassFor(false)).toBe("desktop");
  });

  test("both keys are in the schema with the device defaults", () => {
    const defaults = defaultsOf(SETTINGS_SCHEMA);
    expect(defaults[DESKTOP_KEY]).toBe(false);
    expect(defaults[TOUCH_KEY]).toBe(true);
    expect(EXTRA_KEYS_VISIBLE_DEFAULTS.desktop).toBe(defaults[DESKTOP_KEY]);
    expect(EXTRA_KEYS_VISIBLE_DEFAULTS.touch).toBe(defaults[TOUCH_KEY]);
  });
});

describe("readVisible", () => {
  test("desktop default is hidden when unset", () => {
    expect(readVisible(fakeStore(), "desktop")).toBe(false);
  });

  test("touch default is visible when unset", () => {
    expect(readVisible(fakeStore(), "touch")).toBe(true);
  });

  test("touch does NOT fall back to the desktop key", () => {
    expect(readVisible(fakeStore({ [DESKTOP_KEY]: false }), "touch")).toBe(
      true,
    );
    expect(readVisible(fakeStore({ [DESKTOP_KEY]: true }), "touch")).toBe(true);
  });

  test("desktop does NOT read the touch key", () => {
    expect(readVisible(fakeStore({ [TOUCH_KEY]: true }), "desktop")).toBe(
      false,
    );
  });

  test("each device reads its own stored value", () => {
    const store = fakeStore({ [DESKTOP_KEY]: true, [TOUCH_KEY]: false });
    expect(readVisible(store, "desktop")).toBe(true);
    expect(readVisible(store, "touch")).toBe(false);
  });

  test("no store resolves to the device default", () => {
    expect(readVisible(null, "desktop")).toBe(false);
    expect(readVisible(null, "touch")).toBe(true);
  });
});

describe("persistVisible", () => {
  test("toggling on touch writes only the touch key", () => {
    const { store, runtime, applied } = harness("touch", {
      [DESKTOP_KEY]: false,
    });
    persistVisible({ runtime, store, deviceClass: "touch" }, false);
    expect(store.cache[TOUCH_KEY]).toBe(false);
    expect(store.cache[DESKTOP_KEY]).toBe(false);
    persistVisible({ runtime, store, deviceClass: "touch" }, true);
    expect(store.cache[TOUCH_KEY]).toBe(true);
    expect(store.cache[DESKTOP_KEY]).toBe(false);
    expect(applied).toEqual([false, true]);
  });

  test("toggling on desktop writes only the desktop key", () => {
    const { store, runtime, applied } = harness("desktop");
    persistVisible({ runtime, store, deviceClass: "desktop" }, true);
    expect(store.cache[DESKTOP_KEY]).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(store.cache, TOUCH_KEY)).toBe(
      false,
    );
    expect(applied).toEqual([true]);
  });

  test("without a runtime it writes the device key to the store", () => {
    const store = fakeStore();
    expect(persistVisible({ store, deviceClass: "touch" }, false)).toBe(
      TOUCH_KEY,
    );
    expect(store.cache).toEqual({ [TOUCH_KEY]: false });
  });
});

describe("side effects", () => {
  test("applyAll on a fresh touch session shows the bar (never hides it)", () => {
    const { runtime, applied } = harness("touch");
    runtime.applyAll();
    expect(applied).toEqual([true]);
  });

  test("applyAll on a touch session ignores a stored desktop 'hidden'", () => {
    const { runtime, applied } = harness("touch", { [DESKTOP_KEY]: false });
    runtime.applyAll();
    expect(applied).toEqual([true]);
  });

  test("applyAll on touch honours an explicit touch 'hidden'", () => {
    const { runtime, applied } = harness("touch", {
      [DESKTOP_KEY]: true,
      [TOUCH_KEY]: false,
    });
    runtime.applyAll();
    expect(applied).toEqual([false]);
  });

  test("applyAll on a fresh desktop session keeps the bar hidden", () => {
    const { runtime, applied } = harness("desktop");
    runtime.applyAll();
    expect(applied).toEqual([false]);
  });

  test("applyAll on desktop ignores a stored touch 'visible'", () => {
    const { runtime, applied } = harness("desktop", { [TOUCH_KEY]: true });
    runtime.applyAll();
    expect(applied).toEqual([false]);
  });

  test("a change to the other device's key never touches this bar", () => {
    const desktop = harness("desktop");
    desktop.runtime.apply(TOUCH_KEY, true);
    expect(desktop.applied).toEqual([]);
    const touch = harness("touch");
    touch.runtime.apply(DESKTOP_KEY, false);
    expect(touch.applied).toEqual([]);
  });

  test("device class is read at apply time", () => {
    let deviceClass = "desktop";
    const applied = [];
    const effects = createSideEffects({
      getDeviceClass: () => deviceClass,
      applyVisibility: (v) => applied.push(v),
    });
    effects[TOUCH_KEY](true);
    deviceClass = "touch";
    effects[TOUCH_KEY](true);
    expect(applied).toEqual([true]);
  });
});
