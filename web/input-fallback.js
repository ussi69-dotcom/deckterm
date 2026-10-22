function shouldUseMobileInputFallback({
  isMobile = false,
  hasTouch = false,
  isVirtualKeyboardOpen = false,
} = {}) {
  return Boolean((isMobile && hasTouch) || isVirtualKeyboardOpen);
}

// One keystroke on a touch layout can be sent by two paths: xterm's own key
// handlers and the beforeinput fallback. xterm sends most printable keys from
// keydown and cancels it, so no beforeinput follows. A-Z, space and keys with
// keyCode < 48 are sent from keypress instead, and xterm does not cancel that
// keypress, so the browser still fires beforeinput insertText for the same
// character (F17: "echo Ab c" arrived as "echo AAb  c"). The arbiter records
// what xterm emitted while it handled the current keypress; the fallback asks
// it before sending a beforeinput's text. Soft keyboards that report keyCode
// 229 (Gboard) fire no keypress, so their text stays with the fallback.
function createKeystrokeArbiter() {
  let recording = false;
  let keypressData = "";
  const reset = () => {
    recording = false;
    keypressData = "";
  };
  return {
    keydown: reset,
    keyup: reset,
    keypress() {
      recording = true;
      keypressData = "";
    },
    xtermData(data) {
      if (recording && data) keypressData += data;
    },
    // True when xterm already sent this keystroke's text from its keypress
    // handler; the caller then cancels the beforeinput without sending.
    takeKeypressEcho() {
      const owned = recording && keypressData.length > 0;
      reset();
      return owned;
    },
  };
}

// Text the fallback sent may come back once more through xterm's onData
// (xterm's composition and keyCode 229 handlers read the helper textarea on a
// zero timeout). The echo arrives within one task; older pending text is
// dropped so it can never swallow later real input.
const FALLBACK_ECHO_TTL_MS = 1000;

function rememberFallbackEcho(state, data, now) {
  if (!state || !data) return;
  if (now - (state.lastFallbackAt || 0) > FALLBACK_ECHO_TTL_MS) {
    state.pendingFallbackEcho = "";
  }
  state.lastFallbackAt = now;
  state.lastFallbackData = data;
  state.pendingFallbackEcho = `${state.pendingFallbackEcho || ""}${data}`.slice(
    -256,
  );
}

function consumeFallbackEcho(state, data, now) {
  if (!state || !data) return data;

  if (now - (state.lastFallbackAt || 0) > FALLBACK_ECHO_TTL_MS) {
    state.pendingFallbackEcho = "";
  }
  let pending = state.pendingFallbackEcho || "";
  let remainingData = data;

  while (pending && remainingData) {
    if (pending.startsWith(remainingData)) {
      state.pendingFallbackEcho = pending.slice(remainingData.length);
      return "";
    }

    if (remainingData.startsWith(pending)) {
      remainingData = remainingData.slice(pending.length);
      pending = "";
      break;
    }

    let overlap = 0;
    const limit = Math.min(pending.length, remainingData.length);
    while (
      overlap < limit &&
      pending.charCodeAt(overlap) === remainingData.charCodeAt(overlap)
    ) {
      overlap += 1;
    }

    if (!overlap) break;

    pending = pending.slice(overlap);
    remainingData = remainingData.slice(overlap);
  }

  state.pendingFallbackEcho = pending;
  return remainingData;
}

// What to send when a composition changes from `sent` to `next`: one DEL per
// character no longer in the composition, then the new characters. The
// composition text of insertCompositionText / compositionend is always the
// whole composed word, so only the difference is new input.
function compositionDelta(sent = "", next = "") {
  const before = Array.from(sent || "");
  const after = Array.from(next || "");
  let common = 0;
  while (
    common < before.length &&
    common < after.length &&
    before[common] === after[common]
  ) {
    common += 1;
  }
  return "\x7f".repeat(before.length - common) + after.slice(common).join("");
}

const InputFallback = {
  shouldUseMobileInputFallback,
  createKeystrokeArbiter,
  FALLBACK_ECHO_TTL_MS,
  rememberFallbackEcho,
  consumeFallbackEcho,
  compositionDelta,
};

if (typeof window !== "undefined") {
  window.InputFallback = InputFallback;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = InputFallback;
}

if (typeof exports !== "undefined") {
  exports.shouldUseMobileInputFallback = shouldUseMobileInputFallback;
  exports.createKeystrokeArbiter = createKeystrokeArbiter;
  exports.FALLBACK_ECHO_TTL_MS = FALLBACK_ECHO_TTL_MS;
  exports.rememberFallbackEcho = rememberFallbackEcho;
  exports.consumeFallbackEcho = consumeFallbackEcho;
  exports.compositionDelta = compositionDelta;
}
