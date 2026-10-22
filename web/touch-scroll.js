// One-finger touch scrolling for terminals on touch layouts (phones, touch
// tablets).
//
// The browser never decides where a vertical drag goes: it only turns finger
// movement into whole lines and sends {type:"touch-scroll"} to the server,
// which routes it from tmux's live pane state (tmux history, wheel reports
// for a mouse app, or arrow keys for a full-screen app). This file holds the
// gesture maths only: axis lock, pixels to lines, release momentum and the
// message shape. The DOM wiring is attachTouchScrollGesture in app.js.
//
// Pure (no DOM, no timers) so it can be unit-tested in Bun. app.js consumes
// it at runtime via window.TouchScroll (loaded as a <script> before app.js).

(function () {
  const TOUCH_SCROLL_DEFAULTS = Object.freeze({
    // Movement before the gesture picks an axis; below it a touch is a tap.
    slopPx: 10,
    // Vertical wins only when |dy| > axisRatio * |dx|; anything else is a
    // sideways swipe (session switching) and is left alone.
    axisRatio: 1.5,
    // Release velocity is measured over the last ~100 ms of movement.
    velocityWindowMs: 100,
    // Momentum: velocity decays x0.95 per 16 ms frame, stops below
    // minVelocity (px/ms) or after maxMomentumMs.
    decayPerFrame: 0.95,
    frameMs: 16,
    minVelocity: 0.05,
    maxMomentumMs: 2000,
  });

  // The server accepts 1..100 lines per touch-scroll message.
  const MAX_LINES_PER_MESSAGE = 100;

  function finite(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
  }

  // Tracks one finger. Every result carries `linesDelta`: whole terminal rows
  // crossed since the previous result, positive when the finger moved DOWN
  // (the content follows the finger, so older output comes into view; that
  // is the "up" scroll direction), negative when it moved up.
  function createTouchScrollTracker(options = {}) {
    const config = { ...TOUCH_SCROLL_DEFAULTS, ...options };
    let phase = "idle";
    let startX = 0;
    let startY = 0;
    let lastY = 0;
    let rowHeight = 16;
    let accPx = 0;
    let samples = [];
    let momentum = null;

    const result = (linesDelta = 0) => ({ phase, linesDelta });

    // Move the remainder accumulator by px and return the whole rows crossed.
    const takeLines = (px) => {
      accPx += px;
      const lines = Math.trunc(accPx / rowHeight);
      accPx -= lines * rowHeight;
      return lines;
    };

    const pruneSamples = (now) => {
      const cutoff = now - config.velocityWindowMs;
      samples = samples.filter((sample) => sample.t >= cutoff);
    };

    return {
      get phase() {
        return phase;
      },

      // A new touch also stops any momentum still running.
      start({ x, y, t = 0, rowHeight: height } = {}) {
        momentum = null;
        phase = "pending";
        startX = finite(x, 0);
        startY = finite(y, 0);
        lastY = startY;
        rowHeight = Math.max(1, finite(height, 16));
        accPx = 0;
        samples = [{ y: startY, t: finite(t, 0) }];
        return result();
      },

      move({ x, y, t = 0 } = {}) {
        if (phase !== "pending" && phase !== "vertical") return result();
        const px = finite(x, startX);
        const py = finite(y, lastY);
        const now = finite(t, 0);
        if (phase === "pending") {
          const dx = px - startX;
          const dy = py - startY;
          if (Math.hypot(dx, dy) < config.slopPx) return result();
          if (Math.abs(dy) > config.axisRatio * Math.abs(dx)) {
            phase = "vertical";
            // Count the slop too, so the content tracks the finger 1:1.
            lastY = py;
            samples.push({ y: py, t: now });
            pruneSamples(now);
            return result(takeLines(dy));
          }
          phase = "horizontal";
          return result();
        }
        const delta = py - lastY;
        lastY = py;
        samples.push({ y: py, t: now });
        pruneSamples(now);
        return result(takeLines(delta));
      },

      // Second finger, touchcancel or anything else that ends the gesture
      // without a fling.
      cancel() {
        phase = "cancelled";
        momentum = null;
        return result();
      },

      // Finger lifted. Starts momentum when a vertical drag was still moving.
      end({ t = 0 } = {}) {
        const now = finite(t, 0);
        const wasVertical = phase === "vertical";
        phase = "idle";
        momentum = null;
        if (!wasVertical) return { phase: "idle", momentum: false };
        const recent = samples.filter(
          (sample) => sample.t >= now - config.velocityWindowMs,
        );
        let velocity = 0;
        if (recent.length >= 2) {
          const first = recent[0];
          const last = recent[recent.length - 1];
          const dt = last.t - first.t;
          if (dt > 0) velocity = (last.y - first.y) / dt;
        }
        if (Math.abs(velocity) < config.minVelocity) {
          return { phase: "idle", momentum: false };
        }
        momentum = { velocity, startedAt: now, lastT: now };
        return { phase: "idle", momentum: true };
      },

      isMomentumActive() {
        return momentum !== null;
      },

      stopMomentum() {
        momentum = null;
      },

      // Advance the fling to time t (one call per animation frame).
      stepMomentum(t = 0) {
        if (!momentum) return { linesDelta: 0, done: true };
        const now = finite(t, momentum.lastT);
        const dt = now - momentum.lastT;
        if (dt <= 0) return { linesDelta: 0, done: false };
        const frames = dt / config.frameMs;
        const decay = config.decayPerFrame;
        // Sum of v * frameMs * decay^i over the elapsed (fractional) frames.
        const px =
          decay === 1
            ? momentum.velocity * dt
            : (momentum.velocity *
                config.frameMs *
                (1 - Math.pow(decay, frames))) /
              (1 - decay);
        momentum.velocity *= Math.pow(decay, frames);
        momentum.lastT = now;
        const linesDelta = takeLines(px);
        const done =
          Math.abs(momentum.velocity) < config.minVelocity ||
          now - momentum.startedAt >= config.maxMomentumMs;
        if (done) momentum = null;
        return { linesDelta, done };
      },
    };
  }

  // Finger down (positive lines) shows older output: tmux's "up".
  function directionForLines(lines) {
    return lines > 0 ? "up" : "down";
  }

  // The 1-based terminal cell under a point, clamped to the grid. Used as the
  // position of wheel reports the server sends to a mouse app.
  function cellFromPoint({ x, y, rect, cols, rows } = {}) {
    if (
      !rect ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !(rect.width > 0) ||
      !(rect.height > 0) ||
      !(cols >= 1) ||
      !(rows >= 1)
    ) {
      return null;
    }
    const clamp = (value, max) => Math.max(1, Math.min(max, value));
    const col = Math.floor(((x - rect.left) / rect.width) * cols) + 1;
    const row = Math.floor(((y - rect.top) / rect.height) * rows) + 1;
    return { col: clamp(col, Math.floor(cols)), row: clamp(row, Math.floor(rows)) };
  }

  // Turn the lines batched during one animation frame into one message.
  // Anything above the per-message cap stays in `rest` for the next frame.
  function takeTouchScrollMessage(pendingLines, cell = null) {
    const lines = Math.trunc(finite(pendingLines, 0));
    if (!lines) return { message: null, rest: 0 };
    const count = Math.min(MAX_LINES_PER_MESSAGE, Math.abs(lines));
    const message = {
      type: "touch-scroll",
      direction: directionForLines(lines),
      lines: count,
    };
    if (cell && cell.col >= 1 && cell.row >= 1) {
      message.col = Math.floor(cell.col);
      message.row = Math.floor(cell.row);
    }
    return { message, rest: lines - Math.sign(lines) * count };
  }

  // Turns tracker output into touch-scroll messages over animation frames:
  // lines from a drag or a fling are batched per frame and sent as one
  // message (at most 100 lines each, the rest goes next frame). halt() is the
  // one way to stop everything still in flight: the fling, the lines not yet
  // sent and the frame that would send them. The page calls it before it
  // jumps (Jump to latest, handle drag, scroll-to), before typing leaves
  // scrollback and when the server says the pane is no longer scrolled back,
  // so a late batch can never take the pane back into the history.
  // Frames and the clock are injected so the logic is testable.
  function createTouchScrollPump({
    tracker,
    send,
    getCell = () => null,
    requestFrame,
    cancelFrame,
    now = () => 0,
  } = {}) {
    let pendingLines = 0;
    let flushFrame = 0;
    let momentumFrame = 0;

    const flush = () => {
      flushFrame = 0;
      const { message, rest } = takeTouchScrollMessage(pendingLines, getCell());
      pendingLines = rest;
      if (message) send?.(message);
      if (pendingLines && !flushFrame) flushFrame = requestFrame(flush);
    };

    const queue = (lines) => {
      if (!lines) return;
      pendingLines += lines;
      if (!flushFrame) flushFrame = requestFrame(flush);
    };

    const stopMomentum = () => {
      tracker?.stopMomentum();
      if (momentumFrame) cancelFrame(momentumFrame);
      momentumFrame = 0;
    };

    const runMomentum = () => {
      momentumFrame = 0;
      const step = tracker.stepMomentum(now());
      queue(step.linesDelta);
      if (!step.done) momentumFrame = requestFrame(runMomentum);
    };

    return {
      queue,
      stopMomentum,
      // Finger lifted with momentum: advance it one frame at a time.
      startMomentum() {
        if (momentumFrame) cancelFrame(momentumFrame);
        momentumFrame = requestFrame(runMomentum);
      },
      halt() {
        stopMomentum();
        pendingLines = 0;
        if (flushFrame) cancelFrame(flushFrame);
        flushFrame = 0;
      },
      get pendingLines() {
        return pendingLines;
      },
      // Anything that could still send a touch-scroll message.
      isBusy() {
        return Boolean(flushFrame || momentumFrame || pendingLines);
      },
    };
  }

  const TouchScroll = {
    TOUCH_SCROLL_DEFAULTS,
    MAX_LINES_PER_MESSAGE,
    createTouchScrollTracker,
    directionForLines,
    cellFromPoint,
    takeTouchScrollMessage,
    createTouchScrollPump,
  };

  if (typeof window !== "undefined") {
    window.TouchScroll = TouchScroll;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = TouchScroll;
  }
})();
