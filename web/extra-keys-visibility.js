// Extra-keys bar visibility, remembered per device class.
//
// Phones/tablets ("touch", i.e. platformDetector.isMobile) and desktops each
// keep their own setting, so turning the bar on with a phone no longer shows
// it on the desktop (where it costs two terminal rows), and vice versa.
//   desktop → terminal.extraKeysVisible       (default hidden; existing key,
//                                              so stored values keep meaning)
//   touch   → terminal.extraKeysVisibleTouch  (default visible)
// A device never falls back to the other device's key: that fallback is the
// coupling this module removes.
//
// Pure & injectable: the store, runtime, device class and the "show/hide the
// bar" callback are passed in, so bun tests can drive it with the real
// settings schema + runtime and no DOM.

const EXTRA_KEYS_VISIBLE_KEYS = Object.freeze({
  desktop: "terminal.extraKeysVisible",
  touch: "terminal.extraKeysVisibleTouch",
});

// Mirrors the schema defaults (asserted by extra-keys-visibility.test.js).
const EXTRA_KEYS_VISIBLE_DEFAULTS = Object.freeze({
  desktop: false,
  touch: true,
});

function deviceClassFor(isMobile) {
  return isMobile ? "touch" : "desktop";
}

function normalizeDeviceClass(deviceClass) {
  return deviceClass === "touch" ? "touch" : "desktop";
}

function visibleKeyFor(deviceClass) {
  return EXTRA_KEYS_VISIBLE_KEYS[normalizeDeviceClass(deviceClass)];
}

// The bar's visibility for this device: its own stored value, else its own
// default. Never the other device's value.
function readVisible(store, deviceClass) {
  const cls = normalizeDeviceClass(deviceClass);
  const fallback = EXTRA_KEYS_VISIBLE_DEFAULTS[cls];
  if (!store || typeof store.get !== "function") return fallback;
  const value = store.get(EXTRA_KEYS_VISIBLE_KEYS[cls], fallback);
  return Boolean(value ?? fallback);
}

// Persist a toggle under this device's key. With a settings runtime the write
// goes through runtime.apply (which also runs the side effect); without one
// the caller applies the visibility itself. Returns the key written.
function persistVisible({ runtime, store, deviceClass } = {}, visible) {
  const key = visibleKeyFor(deviceClass);
  const value = Boolean(visible);
  if (runtime && typeof runtime.apply === "function") {
    runtime.apply(key, value);
  } else if (store && typeof store.set === "function") {
    store.set(key, value);
  }
  return key;
}

// Settings-runtime side effects for both keys. Each one only acts when the
// current device class owns that key, so the startup applyAll() sweep (which
// dispatches every schema key, unset ones at their schema default) can never
// hide a phone's bar via the desktop default, nor show a desktop's bar via
// the touch default. The device class is read at apply time.
function createSideEffects({ getDeviceClass, applyVisibility } = {}) {
  const effects = {};
  for (const cls of Object.keys(EXTRA_KEYS_VISIBLE_KEYS)) {
    effects[EXTRA_KEYS_VISIBLE_KEYS[cls]] = (value) => {
      if (typeof applyVisibility !== "function") return;
      const current = normalizeDeviceClass(
        typeof getDeviceClass === "function" ? getDeviceClass() : "desktop",
      );
      if (current !== cls) return;
      applyVisibility(Boolean(value));
    };
  }
  return effects;
}

const ExtraKeysVisibility = {
  EXTRA_KEYS_VISIBLE_KEYS,
  EXTRA_KEYS_VISIBLE_DEFAULTS,
  deviceClassFor,
  visibleKeyFor,
  readVisible,
  persistVisible,
  createSideEffects,
};

if (typeof window !== "undefined") {
  window.ExtraKeysVisibility = ExtraKeysVisibility;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = ExtraKeysVisibility;
}
