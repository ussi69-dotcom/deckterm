import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ScrollIndicator from "./scroll-indicator.js";
import { InputQueue } from "./input-queue.js";

const {
  MIN_HANDLE_PX,
  SCROLL_TO_INTERVAL_MS,
  normalizeScrollPositionFrame,
  createScrollPositionState,
  computeIndicatorGeometry,
  positionFromHandleDrag,
  createLatestWinsThrottle,
} = ScrollIndicator;

const frame = (overrides = {}) => ({
  type: "scroll-position",
  seq: 1,
  inMode: true,
  position: 10,
  total: 300,
  rows: 40,
  altScreen: false,
  mouseApp: false,
  ...overrides,
});

// ── frames ────────────────────────────────────────────────────────────────

test("a valid frame is normalized", () => {
  expect(normalizeScrollPositionFrame(frame())).toEqual({
    seq: 1,
    inMode: true,
    position: 10,
    total: 300,
    rows: 40,
    altScreen: false,
    mouseApp: false,
  });
});

test("position is clamped to total; extra fields are ignored", () => {
  const out = normalizeScrollPositionFrame(
    frame({ position: 999, unseen: true, extra: "x" }),
  );
  expect(out.position).toBe(300);
  expect(out).not.toHaveProperty("extra");
});

test("malformed frames are rejected", () => {
  expect(normalizeScrollPositionFrame(null)).toBe(null);
  expect(normalizeScrollPositionFrame(frame({ type: "terminal_state" }))).toBe(
    null,
  );
  expect(normalizeScrollPositionFrame(frame({ seq: undefined }))).toBe(null);
  expect(normalizeScrollPositionFrame(frame({ inMode: 1 }))).toBe(null);
  expect(normalizeScrollPositionFrame(frame({ position: -1 }))).toBe(null);
  expect(normalizeScrollPositionFrame(frame({ total: "300" }))).toBe(null);
  expect(normalizeScrollPositionFrame(frame({ rows: Number.NaN }))).toBe(null);
});

// ── per-terminal state ────────────────────────────────────────────────────

test("frames with an old seq are dropped; a new transport resets seq", () => {
  const state = createScrollPositionState();
  expect(state.apply(frame({ seq: 5, position: 20 })).position).toBe(20);
  expect(state.apply(frame({ seq: 5, position: 30 }))).toBe(null);
  expect(state.apply(frame({ seq: 4, position: 30 }))).toBe(null);
  expect(state.snapshot().position).toBe(20);
  state.resetSequence();
  expect(state.apply(frame({ seq: 1, position: 7 })).position).toBe(7);
  expect(state.inMode).toBe(true);
});

test("after the page leaves scrollback, stale inMode frames are ignored", () => {
  let now = 1000;
  const state = createScrollPositionState({ now: () => now });
  state.apply(frame({ seq: 1 }));
  expect(state.markLeft()).toMatchObject({ inMode: false, position: 0 });
  expect(state.inMode).toBe(false);
  // Sent by the server before it handled scroll-latest.
  expect(state.apply(frame({ seq: 2, inMode: true }))).toBe(null);
  expect(state.inMode).toBe(false);
  // The server confirms the exit.
  expect(state.apply(frame({ seq: 3, inMode: false, position: 0 }))).toEqual(
    expect.objectContaining({ inMode: false }),
  );
  // From now on inMode frames count again.
  expect(state.apply(frame({ seq: 4, inMode: true })).inMode).toBe(true);
});

test("the exit grace runs out, and a new scroll ends it at once", () => {
  let now = 0;
  const state = createScrollPositionState({ now: () => now, exitGraceMs: 1500 });
  state.markLeft();
  now = 1600;
  expect(state.apply(frame({ seq: 1, inMode: true })).inMode).toBe(true);

  state.markLeft();
  state.markScrollIntent();
  expect(state.apply(frame({ seq: 2, inMode: true })).inMode).toBe(true);
});

// ── geometry ──────────────────────────────────────────────────────────────

test("the handle is at least 44 px and proportional otherwise", () => {
  expect(MIN_HANDLE_PX).toBe(44);
  const tiny = computeIndicatorGeometry({
    position: 0,
    total: 10000,
    rows: 40,
    trackPx: 600,
  });
  expect(tiny.handlePx).toBe(44);
  const big = computeIndicatorGeometry({
    position: 0,
    total: 40,
    rows: 40,
    trackPx: 600,
  });
  expect(big.handlePx).toBe(300);
});

test("position 0 sits at the bottom, total at the top", () => {
  const bottom = computeIndicatorGeometry({
    position: 0,
    total: 360,
    rows: 40,
    trackPx: 640,
  });
  expect(bottom.handlePx).toBe(64);
  expect(bottom.travelPx).toBe(576);
  expect(bottom.offsetPx).toBe(576);
  const top = computeIndicatorGeometry({
    position: 360,
    total: 360,
    rows: 40,
    trackPx: 640,
  });
  expect(top.offsetPx).toBe(0);
  const middle = computeIndicatorGeometry({
    position: 180,
    total: 360,
    rows: 40,
    trackPx: 640,
  });
  expect(middle.offsetPx).toBe(288);
});

test("geometry survives zero or junk input", () => {
  const out = computeIndicatorGeometry({
    position: Number.NaN,
    total: 0,
    rows: 0,
    trackPx: 0,
  });
  expect(out.handlePx).toBe(0);
  expect(out.offsetPx).toBe(0);
  const noHistory = computeIndicatorGeometry({
    position: 5,
    total: 0,
    rows: 40,
    trackPx: 500,
  });
  expect(noHistory.fraction).toBe(0);
  expect(noHistory.offsetPx).toBe(noHistory.travelPx);
});

test("dragging the handle maps pixels to positions and clamps", () => {
  // 576 px of travel for 360 lines: 1.6 px per line.
  const base = { startPosition: 100, total: 360, travelPx: 576 };
  expect(positionFromHandleDrag({ ...base, deltaPx: -160 })).toBe(200);
  expect(positionFromHandleDrag({ ...base, deltaPx: 80 })).toBe(50);
  expect(positionFromHandleDrag({ ...base, deltaPx: 5000 })).toBe(0);
  expect(positionFromHandleDrag({ ...base, deltaPx: -5000 })).toBe(360);
  expect(
    positionFromHandleDrag({ ...base, travelPx: 0, deltaPx: -100 }),
  ).toBe(100);
});

// ── scroll-to throttle ────────────────────────────────────────────────────

function fakeClock() {
  let now = 0;
  const timers = new Map();
  let nextId = 1;
  return {
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
  };
}

test("scroll-to is throttled to one per 60 ms, latest wins", () => {
  expect(SCROLL_TO_INTERVAL_MS).toBe(60);
  const clock = fakeClock();
  const sent = [];
  const throttle = createLatestWinsThrottle({
    send: (value) => sent.push([clock.now(), value]),
    ...clock,
  });
  throttle.push(10);
  throttle.push(11);
  throttle.push(12);
  expect(sent).toEqual([[0, 10]]);
  clock.advance(30);
  throttle.push(13);
  clock.advance(30);
  expect(sent).toEqual([
    [0, 10],
    [60, 13],
  ]);
  clock.advance(100);
  throttle.push(20);
  expect(sent.at(-1)).toEqual([160, 20]);
});

test("flush sends the waiting value now; cancel drops it", () => {
  const clock = fakeClock();
  const sent = [];
  const throttle = createLatestWinsThrottle({
    send: (value) => sent.push(value),
    ...clock,
  });
  throttle.push(1);
  throttle.push(2);
  throttle.flush();
  expect(sent).toEqual([1, 2]);
  clock.advance(10);
  throttle.push(3);
  throttle.cancel();
  clock.advance(200);
  expect(sent).toEqual([1, 2]);
});

// ── ReconnectingWebSocket (app.js) with a mock socket ────────────────────
//
// The class is evaluated from app.js source with browser stubs, so the test
// checks the real code: the scroll=1 opt-in, the scroll-position branch and
// the input hook that leaves scrollback before typing.

const appSource = readFileSync(join(import.meta.dir, "app.js"), "utf8");

function reconnectingWebSocketClass() {
  const start = appSource.indexOf("class ReconnectingWebSocket {");
  const end = appSource.indexOf("\nclass ", start + 1);
  return appSource.slice(start, end);
}

class MockSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = MockSocket.CONNECTING;
    this.sent = [];
    MockSocket.instances.push(this);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = MockSocket.CLOSED;
  }
  open() {
    this.readyState = MockSocket.OPEN;
    this.onopen?.();
  }
  receive(message) {
    this.onmessage?.({
      data: typeof message === "string" ? message : JSON.stringify(message),
    });
  }
}

function makeSocket(url) {
  MockSocket.instances = [];
  const windowStub = { InputQueue, ScrollIndicator };
  const Rws = new Function(
    "window",
    "WebSocket",
    `${reconnectingWebSocketClass()}\nreturn ReconnectingWebSocket;`,
  )(windowStub, MockSocket);
  const events = { scroll: [], text: [] };
  const rws = new Rws(url, "t1", {
    onMessage: (data) => events.text.push(data),
    onStatusChange: () => {},
    onScrollPosition: (state) => events.scroll.push(state),
  });
  rws.stopHeartbeat?.();
  rws.startHeartbeat = () => {};
  return { rws, socket: MockSocket.instances[0], events };
}

const TOUCH_URL = "ws://h/ws/terminals/t1?clientId=c&scroll=1";
const DESKTOP_URL = "ws://h/ws/terminals/t1?clientId=c";

test("only a scroll=1 socket keeps scroll state", () => {
  expect(makeSocket(TOUCH_URL).rws.scrollState).not.toBe(null);
  expect(makeSocket(DESKTOP_URL).rws.scrollState).toBe(null);
  expect(
    makeSocket("ws://h/ws/terminals/t1?clientId=c&scroll=10").rws.scrollState,
  ).toBe(null);
});

test("scroll-position frames reach the indicator and are never terminal text", () => {
  const { socket, events } = makeSocket(TOUCH_URL);
  socket.open();
  socket.receive(frame({ seq: 1, position: 12 }));
  socket.receive(frame({ seq: 1, position: 99 })); // stale
  socket.receive("plain output");
  expect(events.scroll).toHaveLength(1);
  expect(events.scroll[0]).toMatchObject({ inMode: true, position: 12 });
  expect(events.text).toEqual(["plain output"]);
});

test("a desktop socket swallows a stray scroll-position frame", () => {
  const { socket, events } = makeSocket(DESKTOP_URL);
  socket.open();
  socket.receive(frame());
  expect(events.scroll).toEqual([]);
  expect(events.text).toEqual([]);
});

test("typing while scrolled back sends scroll-latest once, before the input", () => {
  const { rws, socket, events } = makeSocket(TOUCH_URL);
  socket.open();
  socket.receive(frame({ seq: 1, inMode: true }));
  rws.sendInput("l");
  rws.sendInput("s");
  expect(socket.sent).toEqual([
    { type: "scroll-latest" },
    { type: "input", data: "l" },
    { type: "input", data: "s" },
  ]);
  expect(events.scroll.at(-1)).toMatchObject({ inMode: false, position: 0 });
});

test("typing at the live bottom sends input only", () => {
  const { rws, socket } = makeSocket(TOUCH_URL);
  socket.open();
  socket.receive(frame({ seq: 1, inMode: false, position: 0 }));
  rws.sendInput("x");
  expect(socket.sent).toEqual([{ type: "input", data: "x" }]);
});

test("desktop sockets never send scroll messages before input", () => {
  const { rws, socket } = makeSocket(DESKTOP_URL);
  socket.open();
  socket.receive(frame({ seq: 1, inMode: true }));
  rws.sendInput("x");
  expect(socket.sent).toEqual([{ type: "input", data: "x" }]);
});

test("input queued during a reconnect leaves scrollback first on flush", () => {
  const { rws, socket } = makeSocket(TOUCH_URL);
  socket.open();
  socket.receive(frame({ seq: 9, inMode: true }));
  // Transport drops; the user keeps typing.
  socket.readyState = MockSocket.CLOSED;
  expect(rws.sendInput("a")).toBe(true);
  expect(socket.sent).toEqual([]);
  rws.connect();
  const next = MockSocket.instances.at(-1);
  expect(next).not.toBe(socket);
  next.open();
  expect(next.sent).toEqual([
    { type: "scroll-latest" },
    { type: "input", data: "a" },
  ]);
  // The new transport accepts a fresh sequence from the server.
  next.receive(frame({ seq: 1, inMode: false, position: 0 }));
  expect(rws.scrollState.snapshot().inMode).toBe(false);
});

test("scroll controls go out as given; scroll-latest also hides the indicator", () => {
  const { rws, socket, events } = makeSocket(TOUCH_URL);
  socket.open();
  socket.receive(frame({ seq: 1, inMode: true }));
  expect(
    rws.sendScrollControl({
      type: "touch-scroll",
      direction: "up",
      lines: 3,
      col: 4,
      row: 5,
    }),
  ).toBe(true);
  expect(rws.sendScrollControl({ type: "scroll-to", position: 40 })).toBe(true);
  expect(rws.sendScrollControl({ type: "scroll-latest" })).toBe(true);
  expect(socket.sent).toEqual([
    { type: "touch-scroll", direction: "up", lines: 3, col: 4, row: 5 },
    { type: "scroll-to", position: 40 },
    { type: "scroll-latest" },
  ]);
  expect(events.scroll.at(-1)).toMatchObject({ inMode: false });
  // A closed socket does not queue scroll gestures.
  socket.readyState = MockSocket.CLOSED;
  expect(rws.sendScrollControl({ type: "scroll-to", position: 1 })).toBe(
    false,
  );
});
