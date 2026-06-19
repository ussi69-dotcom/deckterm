// App-level settings runtime: the central place that *applies* setting values
// as side effects (CSS vars, terminal options, etc.), independent of whether
// the settings window is ever opened. The schema owns metadata + coercion; this
// runtime owns "when key K changes to value V, do the thing". Consumers read
// canonical settings at their creation boundaries; live changes flow through
// here via apply()/applyAll(), and onChange() subscribers observe every change.
//
// Pure & injectable: the store, schema, and side-effect map are all passed in,
// so tests can register fake side effects and assert apply/subscription fire
// with coerced values. (Task 3 registers the real consumers; this module just
// provides the mechanism.)

// Unique const name: classic <script> tags share global scope and several
// settings-* files resolve the schema module, so a shared `const Schema`
// identifier would collide (redeclaration error) and silently abort this file.
const RuntimeSchema =
  typeof require === "function"
    ? require("./settings-schema.js")
    : typeof window !== "undefined"
      ? window.SettingsSchema
      : null;

function createSettingsRuntime({ store, schema, sideEffects = {} } = {}) {
  const list = schema || RuntimeSchema?.SETTINGS_SCHEMA || [];
  const byKey = new Map();
  for (const def of list) {
    if (def && typeof def.key === "string") byKey.set(def.key, def);
  }

  const effects = new Map();
  for (const [key, fn] of Object.entries(sideEffects || {})) {
    if (typeof fn === "function") effects.set(key, fn);
  }

  const subscribers = new Set();
  const coerce = RuntimeSchema?.coerceValue || ((_def, raw) => raw);

  function register(key, fn) {
    if (typeof key === "string" && typeof fn === "function") {
      effects.set(key, fn);
    }
  }

  function onChange(fn) {
    if (typeof fn !== "function") return () => {};
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  // Coerce raw -> typed for a known key, run its side effect, notify subscribers.
  // Does NOT persist (used internally by applyAll where the store already holds
  // the value).
  function dispatch(key, raw) {
    const def = byKey.get(key);
    if (!def) return undefined;
    const value = coerce(def, raw);
    const fn = effects.get(key);
    if (fn) {
      try {
        fn(value, def);
      } catch {
        // A misbehaving side effect must not break other settings.
      }
    }
    for (const sub of subscribers) {
      try {
        sub(key, value, def);
      } catch {
        // Subscribers are observers; isolate their failures.
      }
    }
    return value;
  }

  // Public: coerce, persist to the store, then apply the side effect + notify.
  function apply(key, raw) {
    const def = byKey.get(key);
    if (!def) return undefined;
    const value = coerce(def, raw);
    if (store && typeof store.set === "function") {
      store.set(key, value);
    }
    return dispatch(key, value);
  }

  // Apply every known setting from the current store state (or schema default
  // when absent). Runs on startup so side effects take hold even if the window
  // is never opened.
  function applyAll() {
    for (const def of list) {
      if (!def || typeof def.key !== "string") continue;
      const stored =
        store && typeof store.get === "function"
          ? store.get(def.key, def.default)
          : def.default;
      dispatch(def.key, stored);
    }
  }

  return { apply, applyAll, register, onChange };
}

const SettingsRuntime = { createSettingsRuntime };

if (typeof window !== "undefined") {
  window.SettingsRuntime = SettingsRuntime;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = SettingsRuntime;
}
