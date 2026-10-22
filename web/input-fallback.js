function shouldUseMobileInputFallback({
  isMobile = false,
  hasTouch = false,
  isVirtualKeyboardOpen = false,
} = {}) {
  return Boolean((isMobile && hasTouch) || isVirtualKeyboardOpen);
}

// One keystroke on a touch layout can be sent by two paths: xterm's own key
// handlers and the beforeinput/input fallback. xterm sends most printable
// keys from keydown and cancels it, so no beforeinput follows. A-Z, space and
// keys with keyCode < 48 are sent from keypress instead, and xterm does not
// cancel that keypress, so the browser still fires beforeinput insertText for
// the same character (F17: "echo Ab c" arrived as "echo AAb  c"). xterm can
// also forward an insertText from its own input listener.
//
// The arbiter records what xterm forwarded while it handled one DOM event: a
// keypress (claimed by that keystroke's beforeinput) or an input event
// (claimed by the fallback's own listener for the same event). A claim lives
// only until the event that owns it is answered or the next key goes down,
// so it can never suppress a later, unrelated character. Soft keyboards that
// report keyCode 229 (Gboard) fire no keypress; their text stays with the
// fallback.
function createKeystrokeArbiter() {
  let open = null; // "keypress" | "input" | null
  let forwarded = "";
  const reset = () => {
    open = null;
    forwarded = "";
  };
  const take = (kind) => {
    const owned = open === kind && forwarded.length > 0;
    reset();
    return owned;
  };
  return {
    keydown: reset,
    keyup: reset,
    keypress() {
      open = "keypress";
      forwarded = "";
    },
    inputEvent() {
      open = "input";
      forwarded = "";
    },
    // Called with the data xterm's onData actually forwarded to the server.
    xtermData(data) {
      if (open && data) forwarded += data;
    },
    // True when xterm already sent this keystroke's text from its keypress
    // handler; the caller cancels the beforeinput without sending.
    takeKeypressEcho: () => take("keypress"),
    // True when xterm already sent this input event's text.
    takeInputEcho: () => take("input"),
  };
}

// IME compositions (Gboard with suggestions, glide typing, CJK, accents) are
// not streamed: the composing text stays local, shown by xterm's composition
// view, and only the committed text is sent, once. Streaming would need one
// DEL per changed character, and a terminal line editor does not promise
// that one DEL removes exactly one code point (readline may erase a base
// letter together with its combining mark).
//
// A commit can be reported twice: compositionend plus WebKit's
// insertFromComposition (in either order), or a browser that repeats the
// committed text as insertText. After a commit, the same composition's
// confirmation is swallowed until the next key goes down or the next
// composition starts.
function createCompositionTracker() {
  let active = false;
  let text = "";
  let committed = null; // text sent for the active composition
  let confirm = null; // text sent for the composition that just ended

  const begin = () => {
    active = true;
    text = "";
    committed = null;
    confirm = null;
  };
  const close = (sentText) => {
    active = false;
    text = "";
    committed = null;
    confirm = sentText;
  };

  return {
    get active() {
      return active;
    },
    start: begin,
    // insertCompositionText: the whole composing text so far. Never sent.
    update(data) {
      if (!active) begin();
      text = typeof data === "string" ? data : "";
    },
    // insertFromComposition (WebKit). Returns the text to send.
    commitFromInput(data) {
      const value = typeof data === "string" ? data : text;
      if (active) {
        if (committed !== null) return "";
        committed = value;
        return value;
      }
      if (confirm !== null) {
        confirm = null;
        return "";
      }
      return value;
    },
    // compositionend. Returns the text to send.
    end(data) {
      if (active) {
        const value =
          committed !== null ? "" : typeof data === "string" ? data : text;
        close(committed !== null ? committed : value);
        return value;
      }
      if (confirm !== null) return "";
      return typeof data === "string" ? data : "";
    },
    // insertText after a commit: true when it repeats the commit.
    confirmText(data) {
      if (confirm === null || data !== confirm) return false;
      confirm = null;
      return true;
    },
    // A real (non-IME) key during a composition commits what is composed.
    interrupt() {
      if (!active) return "";
      const value = committed !== null ? "" : text;
      close(committed !== null ? committed : value);
      return value;
    },
    // The composition vanished without a commit (no compositionend came).
    abandon() {
      active = false;
      text = "";
      committed = null;
    },
    // A new key went down: an earlier commit can no longer be confirmed.
    boundary() {
      confirm = null;
    },
  };
}

const InputFallback = {
  shouldUseMobileInputFallback,
  createKeystrokeArbiter,
  createCompositionTracker,
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
  exports.createCompositionTracker = createCompositionTracker;
}
