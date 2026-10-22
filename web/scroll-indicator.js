// Scroll position indicator for terminals on touch layouts.
//
// While a tmux pane is scrolled back (copy-mode), the server sends
// {type:"scroll-position", seq, inMode, position, total, rows, altScreen,
// mouseApp} to sockets that opted in with `scroll=1`. `position` counts lines
// up from the live bottom (0 = latest output) and `total` is the oldest
// reachable line. The page shows a handle on the right edge of the tile and a
// "Jump to latest" pill. This file holds the pure parts: frame validation,
// the per-terminal scroll state, handle geometry, the drag-to-position
// mapping and the latest-wins throttle for {type:"scroll-to"}.
//
// Pure (no DOM; timers are injected) so it can be unit-tested in Bun. app.js
// consumes it at runtime via window.ScrollIndicator.

(function () {
  // Touch target for the handle (WCAG / Apple HIG minimum).
  const MIN_HANDLE_PX = 44;
  // At most one scroll-to message per 60 ms while the handle is dragged.
  const SCROLL_TO_INTERVAL_MS = 60;
  // After the page leaves scrollback itself (typing, Jump to latest), frames
  // that still say inMode are ones the server sent before it handled the
  // exit. Ignore them until the server confirms or this grace runs out.
  const EXIT_GRACE_MS = 1500;

  // A "terminal reply" is input the browser terminal generates by itself in
  // answer to pane output, not user typing: cursor position reports
  // (ESC [ n ; n R), device attribute replies (ESC [ ? ... c, ESC [ > ... c),
  // status reports (ESC [ 0 n, ESC [ 3 n), focus reports (ESC [ I, ESC [ O),
  // OSC replies (ESC ] ... BEL or ESC \) and DCS replies (ESC P ... ESC \),
  // or any run made only of these. A reply must never pull a reader out of
  // the history. The server uses the same definition for its input barrier.
  const TERMINAL_REPLY_RE =
    /^(?:\x1b\[\d+;\d+R|\x1b\[\?[\d;]*c|\x1b\[>[\d;]*c|\x1b\[[03]n|\x1b\[[IO]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\)+$/;

  function isTerminalReply(data) {
    return (
      typeof data === "string" &&
      data.length > 0 &&
      TERMINAL_REPLY_RE.test(data)
    );
  }

  // Whether input `data` must first take the pane back to the latest output:
  // the pane is (or may be) scrolled back and the input is real typing.
  function shouldLeaveScrollbackForInput(state, data) {
    if (!state || !state.maybeScrolledBack) return false;
    return (
      typeof data === "string" && data.length > 0 && !isTerminalReply(data)
    );
  }

  const nonNegativeInt = (value) =>
    Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;

  // A server frame as the page uses it, or null when it is malformed.
  function normalizeScrollPositionFrame(frame) {
    if (!frame || typeof frame !== "object") return null;
    if (frame.type !== undefined && frame.type !== "scroll-position") {
      return null;
    }
    if (!Number.isFinite(frame.seq)) return null;
    if (typeof frame.inMode !== "boolean") return null;
    const total = nonNegativeInt(frame.total);
    const position = nonNegativeInt(frame.position);
    const rows = nonNegativeInt(frame.rows);
    if (total === null || position === null || rows === null) return null;
    return {
      seq: frame.seq,
      inMode: frame.inMode,
      position: Math.min(position, total),
      total,
      rows,
      altScreen: frame.altScreen === true,
      mouseApp: frame.mouseApp === true,
    };
  }

  // Per-terminal state on the page. `seq` strictly increases per terminal on
  // one transport, so an older frame is dropped; a new transport resets it.
  function createScrollPositionState({
    now = () => Date.now(),
    exitGraceMs = EXIT_GRACE_MS,
  } = {}) {
    let lastSeq = null;
    let current = {
      inMode: false,
      position: 0,
      total: 0,
      rows: 0,
      altScreen: false,
      mouseApp: false,
    };
    let exitPendingSince = null;
    // A touch-scroll or scroll-to was sent after the last frame that said
    // inMode=false: tmux may already be in copy-mode although no frame has
    // said so yet.
    let scrollRequested = false;

    const snapshot = () => ({ ...current });

    return {
      get inMode() {
        return current.inMode;
      },

      // Scrolled back as far as the page knows: a frame said so, or a scroll
      // request went out that no inMode=false frame has answered yet.
      get maybeScrolledBack() {
        return current.inMode || scrollRequested;
      },

      snapshot,

      // Returns the new snapshot, or null when the frame was dropped.
      apply(frame) {
        const next = normalizeScrollPositionFrame(frame);
        if (!next) return null;
        if (lastSeq !== null && next.seq <= lastSeq) return null;
        lastSeq = next.seq;
        if (exitPendingSince !== null) {
          if (!next.inMode || now() - exitPendingSince >= exitGraceMs) {
            exitPendingSince = null;
          } else {
            return null;
          }
        }
        const { seq: _seq, ...state } = next;
        current = state;
        if (!state.inMode) scrollRequested = false;
        return snapshot();
      },

      // New WebSocket transport: the server's seq may start over.
      resetSequence() {
        lastSeq = null;
      },

      // The page asked the server to leave scrollback (scroll-latest).
      markLeft() {
        current = { ...current, inMode: false, position: 0 };
        exitPendingSince = now();
        scrollRequested = false;
        return snapshot();
      },

      // The user scrolls again: frames saying inMode are wanted once more.
      // `mayEnter` is false for a request that can only leave scrollback
      // (scroll-to 0); anything else may put the pane into copy-mode.
      markScrollIntent({ mayEnter = true } = {}) {
        exitPendingSince = null;
        if (mayEnter) scrollRequested = true;
      },
    };
  }

  // Handle size and offset on a track `trackPx` tall. The top of the track is
  // the oldest line (position = total), the bottom is the latest output.
  function computeIndicatorGeometry({
    position = 0,
    total = 0,
    rows = 0,
    trackPx = 0,
    minHandlePx = MIN_HANDLE_PX,
  } = {}) {
    const track = Math.max(0, Number.isFinite(trackPx) ? trackPx : 0);
    const safeTotal = Math.max(0, Number.isFinite(total) ? total : 0);
    const safeRows = Math.max(1, Number.isFinite(rows) ? rows : 1);
    const safePosition = Math.max(
      0,
      Math.min(safeTotal, Number.isFinite(position) ? position : 0),
    );
    const proportional = (track * safeRows) / (safeTotal + safeRows);
    const handlePx = Math.min(track, Math.max(minHandlePx, proportional));
    const travelPx = Math.max(0, track - handlePx);
    const fraction = safeTotal > 0 ? safePosition / safeTotal : 0;
    return {
      handlePx,
      travelPx,
      // Distance of the handle's top edge from the top of the track.
      offsetPx: travelPx * (1 - fraction),
      fraction,
    };
  }

  // Dragging the handle down by deltaPx moves toward the latest output.
  function positionFromHandleDrag({
    startPosition = 0,
    deltaPx = 0,
    total = 0,
    travelPx = 0,
  } = {}) {
    const safeTotal = Math.max(0, Number.isFinite(total) ? total : 0);
    if (!(travelPx > 0) || safeTotal === 0) {
      return Math.max(0, Math.min(safeTotal, Math.round(startPosition || 0)));
    }
    const linesPerPx = safeTotal / travelPx;
    const next = Math.round(
      (Number.isFinite(startPosition) ? startPosition : 0) -
        (Number.isFinite(deltaPx) ? deltaPx : 0) * linesPerPx,
    );
    return Math.max(0, Math.min(safeTotal, next));
  }

  // Sends at most one value per interval: the first push goes out at once,
  // later pushes inside the interval collapse into one trailing send of the
  // latest value.
  function createLatestWinsThrottle({
    send,
    intervalMs = SCROLL_TO_INTERVAL_MS,
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
  } = {}) {
    let lastSentAt = -Infinity;
    let pending = undefined;
    let hasPending = false;
    let timer = null;

    const fire = () => {
      timer = null;
      if (!hasPending) return;
      const value = pending;
      hasPending = false;
      pending = undefined;
      lastSentAt = now();
      send?.(value);
    };

    return {
      push(value) {
        pending = value;
        hasPending = true;
        const wait = lastSentAt + intervalMs - now();
        if (wait <= 0 && timer === null) {
          fire();
          return;
        }
        if (timer === null) timer = setTimer(fire, Math.max(0, wait));
      },
      // Send a waiting value now (drag released).
      flush() {
        if (timer !== null) {
          clearTimer(timer);
          timer = null;
        }
        fire();
      },
      cancel() {
        if (timer !== null) clearTimer(timer);
        timer = null;
        hasPending = false;
        pending = undefined;
      },
    };
  }

  const ScrollIndicator = {
    MIN_HANDLE_PX,
    SCROLL_TO_INTERVAL_MS,
    EXIT_GRACE_MS,
    isTerminalReply,
    shouldLeaveScrollbackForInput,
    normalizeScrollPositionFrame,
    createScrollPositionState,
    computeIndicatorGeometry,
    positionFromHandleDrag,
    createLatestWinsThrottle,
  };

  if (typeof window !== "undefined") {
    window.ScrollIndicator = ScrollIndicator;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = ScrollIndicator;
  }
})();
