import { expect, test } from "bun:test";
import {
  encodeArrowKeys,
  encodeWheelReports,
  isReadOnlyAllowedMessageType,
  isScrollControlMessageType,
  parseScrollControlMessage,
  routeTouchScroll,
  selectScrollSubscribers,
  socketWantsScrollFrames,
  TerminalScrollController,
  type ScrollControlTarget,
} from "./terminal-scroll-control";
import type { TmuxScrollState } from "./tmux-scroll-state";

const SHELL: TmuxScrollState = {
  inMode: false,
  position: 0,
  total: 300,
  rows: 20,
  altScreen: false,
  mouseApp: false,
  mouseSgr: false,
  appCursor: false,
  unseen: false,
};

// --- WS validation ---------------------------------------------------------

test("touch-scroll validation: direction, integer lines 1..100, optional cells >= 1", () => {
  expect(
    parseScrollControlMessage({
      type: "touch-scroll",
      direction: "up",
      lines: 3,
      col: 5,
      row: 7,
      extra: "ignored",
    }),
  ).toEqual({
    type: "touch-scroll",
    direction: "up",
    lines: 3,
    col: 5,
    row: 7,
  });
  expect(
    parseScrollControlMessage({
      type: "touch-scroll",
      direction: "down",
      lines: 100,
    }),
  ).toEqual({ type: "touch-scroll", direction: "down", lines: 100 });

  for (const bad of [
    { type: "touch-scroll", direction: "left", lines: 3 },
    { type: "touch-scroll", lines: 3 },
    { type: "touch-scroll", direction: "up", lines: 0 },
    { type: "touch-scroll", direction: "up", lines: 101 },
    { type: "touch-scroll", direction: "up", lines: 2.5 },
    { type: "touch-scroll", direction: "up", lines: "3" },
    { type: "touch-scroll", direction: "up", lines: Number.NaN },
    { type: "touch-scroll", direction: "up", lines: 3, col: 0 },
    { type: "touch-scroll", direction: "up", lines: 3, row: -1 },
    { type: "touch-scroll", direction: "up", lines: 3, col: 1.5 },
    { type: "touch-scroll", direction: "up", lines: 3, row: "4" },
    { type: "touch-scroll", direction: "up", lines: 3, col: null },
  ]) {
    expect(parseScrollControlMessage(bad)).toBeNull();
  }
});

test("scroll-to / scroll-latest validation", () => {
  expect(parseScrollControlMessage({ type: "scroll-to", position: 0 })).toEqual(
    { type: "scroll-to", position: 0 },
  );
  expect(
    parseScrollControlMessage({ type: "scroll-to", position: 40, x: 1 }),
  ).toEqual({ type: "scroll-to", position: 40 });
  for (const position of [
    -1,
    1.5,
    "40",
    null,
    undefined,
    Infinity,
    Number.NaN,
  ]) {
    expect(
      parseScrollControlMessage({ type: "scroll-to", position }),
    ).toBeNull();
  }
  expect(
    parseScrollControlMessage({ type: "scroll-latest", junk: true }),
  ).toEqual({ type: "scroll-latest" });
  for (const bad of [
    null,
    undefined,
    "scroll-latest",
    7,
    [],
    { type: "input" },
  ]) {
    expect(parseScrollControlMessage(bad)).toBeNull();
  }
});

test("message types: new scroll types are recognised and refused for read-only sockets", () => {
  for (const type of ["touch-scroll", "scroll-to", "scroll-latest"]) {
    expect(isScrollControlMessageType(type)).toBe(true);
    expect(isReadOnlyAllowedMessageType(type)).toBe(false);
  }
  for (const type of ["scrollback", "input", "resize", "ping", 5, null]) {
    expect(isScrollControlMessageType(type)).toBe(false);
  }
  expect(isReadOnlyAllowedMessageType("scrollback")).toBe(false);
  expect(isReadOnlyAllowedMessageType("input")).toBe(false);
  expect(isReadOnlyAllowedMessageType("ping")).toBe(true);
  expect(isReadOnlyAllowedMessageType("resume-ready")).toBe(true);
});

test("scroll-position opt-in is exactly scroll=1 in the socket URL", () => {
  const url = (q: string) => new URL(`http://h/ws/terminals/t1${q}`);
  expect(socketWantsScrollFrames(url("?scroll=1"))).toBe(true);
  expect(socketWantsScrollFrames(url("?clientId=a&scroll=1&protocol=v2"))).toBe(
    true,
  );
  expect(socketWantsScrollFrames(url(""))).toBe(false);
  expect(socketWantsScrollFrames(url("?scroll=0"))).toBe(false);
  expect(socketWantsScrollFrames(url("?scroll=true"))).toBe(false);
});

test("scroll-position frames go only to open scroll=1 sockets not mid-reconnect", () => {
  const sockets = [
    { id: "new", readyState: 1, data: { scroll: true } },
    { id: "old", readyState: 1, data: { scroll: false } },
    { id: "legacy", readyState: 1, data: {} },
    { id: "closed", readyState: 3, data: { scroll: true } },
    { id: "replaying", readyState: 1, data: { scroll: true } },
  ];
  expect(
    selectScrollSubscribers(sockets, (s) => s.id === "replaying").map(
      (s) => s.id,
    ),
  ).toEqual(["new"]);
});

// --- routing table ---------------------------------------------------------

test("routing: plain shell scrolls tmux history", () => {
  expect(routeTouchScroll(SHELL, { direction: "up", lines: 5 })).toEqual({
    kind: "history",
  });
  expect(routeTouchScroll(null, { direction: "up", lines: 5 })).toEqual({
    kind: "history",
  });
});

test("routing: mouse app gets SGR wheel reports, capped at 10, default cell = pane centre", () => {
  const state = { ...SHELL, altScreen: true, mouseApp: true, mouseSgr: true };
  expect(
    routeTouchScroll(state, { direction: "up", lines: 2, col: 5, row: 6 }),
  ).toEqual({ kind: "wheel", bytes: "\x1b[<64;5;6M\x1b[<64;5;6M" });
  const capped = routeTouchScroll(
    state,
    { direction: "down", lines: 50 },
    { cols: 81, rows: 20 },
  );
  expect(capped.kind).toBe("wheel");
  const bytes = (capped as { bytes: string }).bytes;
  expect(bytes).toBe("\x1b[<65;41;10M".repeat(10));
  // A cell outside the pane is clamped into it.
  expect(
    routeTouchScroll(
      state,
      { direction: "up", lines: 1, col: 500, row: 99 },
      { cols: 80, rows: 20 },
    ),
  ).toEqual({ kind: "wheel", bytes: "\x1b[<64;80;20M" });
});

test("routing: legacy mouse encoding is ESC[M + 32+button, 32+col, 32+row (clamped 1..223)", () => {
  const state = { ...SHELL, mouseApp: true, mouseSgr: false };
  expect(
    routeTouchScroll(state, { direction: "up", lines: 1, col: 1, row: 1 }),
  ).toEqual({ kind: "wheel", bytes: "\x1b[M\x60\x21\x21" });
  expect(encodeWheelReports("down", 1, 300, 300, false)).toBe(
    `\x1b[M\x61${String.fromCharCode(32 + 223)}${String.fromCharCode(32 + 223)}`,
  );
  expect(encodeWheelReports("up", 3, 300, 2, true)).toBe(
    "\x1b[<64;300;2M".repeat(3),
  );
});

test("routing: alternate screen without mouse gets arrow keys (AlternateScroll), capped at 10", () => {
  const state = { ...SHELL, altScreen: true };
  expect(routeTouchScroll(state, { direction: "up", lines: 3 })).toEqual({
    kind: "arrows",
    bytes: "\x1b[A\x1b[A\x1b[A",
  });
  expect(
    routeTouchScroll(
      { ...state, appCursor: true },
      { direction: "down", lines: 40 },
    ),
  ).toEqual({ kind: "arrows", bytes: "\x1bOB".repeat(10) });
  expect(encodeArrowKeys("up", 2, true)).toBe("\x1bOA\x1bOA");
});

test("routing: a pane already in copy-mode keeps scrolling history", () => {
  const state = { ...SHELL, inMode: true, mouseApp: true, altScreen: true };
  expect(routeTouchScroll(state, { direction: "down", lines: 3 })).toEqual({
    kind: "history",
  });
});

// --- controller --------------------------------------------------------------

type FakeOptions = { state?: TmuxScrollState | null; opDelayMs?: number };

function fakeTarget(options: FakeOptions = {}) {
  const log: string[] = [];
  const frames: Array<{ sink: string; frame: any }> = [];
  let state: TmuxScrollState | null =
    options.state === undefined ? { ...SHELL } : options.state;
  let reads = 0;
  const delay = () =>
    new Promise((resolve) => setTimeout(resolve, options.opDelayMs ?? 5));
  const subscribers = [
    { send: (f: string) => frames.push({ sink: "sub", frame: JSON.parse(f) }) },
  ];
  let active = true;
  const target: ScrollControlTarget = {
    readState: async () => {
      reads += 1;
      await delay();
      return state ? { ...state } : null;
    },
    scrollHistory: async (direction, lines) => {
      log.push(`history:${direction}:${lines}`);
      await delay();
      if (state && !state.altScreen) {
        const signed = direction === "up" ? lines : -lines;
        const position = Math.max(
          0,
          Math.min(state.total, state.position + signed),
        );
        state = { ...state, inMode: position > 0, position };
      }
      return true;
    },
    scrollToPosition: async (position) => {
      log.push(`goto:${position}`);
      await delay();
      if (state) {
        state = {
          ...state,
          inMode: true,
          position: Math.min(state.total, position),
        };
      }
      return true;
    },
    exitScroll: async () => {
      log.push("exit");
      await delay();
      if (state) state = { ...state, inMode: false, position: 0 };
      return true;
    },
    writeInput: (data) => log.push(`input:${JSON.stringify(data)}`),
    paneSize: () => ({ cols: 80, rows: 20 }),
    subscribers: () => subscribers,
    isActive: () => active,
  };
  return {
    target,
    log,
    frames,
    get reads() {
      return reads;
    },
    setState(next: TmuxScrollState | null) {
      state = next;
    },
    deactivate() {
      active = false;
    },
    subscribers,
  };
}

test("input after a pending scroll-latest waits for the exit; order is kept", async () => {
  const fake = fakeTarget({ state: { ...SHELL, inMode: true, position: 50 } });
  const controller = new TerminalScrollController(fake.target);
  const done = controller.scrollTo(0);
  controller.input("a");
  controller.input("b");
  expect(fake.log).toEqual(["exit"]);
  await done;
  expect(fake.log).toEqual(["exit", 'input:"a"', 'input:"b"']);
  // Nothing pending any more: input goes straight through.
  controller.input("c");
  expect(fake.log.at(-1)).toBe('input:"c"');
});

test("input queued behind an exit stays ahead of later scrolls and later input", async () => {
  const fake = fakeTarget({ state: { ...SHELL, inMode: true, position: 50 } });
  const controller = new TerminalScrollController(fake.target);
  const done = controller.handle({ type: "scroll-latest" });
  controller.input("x");
  void controller.scrollRelative("up", 4);
  controller.input("y");
  // An absolute target replaces only the scrolls queued after the last
  // queued input ("y"), never the exit or the scroll that "y" follows.
  void controller.scrollTo(7);
  await done;
  expect(fake.log).toEqual([
    "exit",
    'input:"x"',
    "history:up:4",
    'input:"y"',
    "goto:7",
  ]);
});

test("without a pending exit, input is written at once (desktop hot path unchanged)", async () => {
  const fake = fakeTarget();
  const controller = new TerminalScrollController(fake.target);
  const scrolling = controller.scrollRelative("up", 10);
  controller.input("k");
  expect(fake.log).toEqual(["history:up:10", 'input:"k"']);
  await scrolling;
});

test("relative scrolls coalesce to ±100 and an absolute target replaces queued ones", async () => {
  const fake = fakeTarget();
  const controller = new TerminalScrollController(fake.target);
  const first = controller.scrollRelative("up", 10);
  void controller.scrollRelative("up", 80);
  void controller.scrollRelative("up", 80);
  await first;
  expect(fake.log).toEqual(["history:up:10", "history:up:100"]);

  fake.log.length = 0;
  const second = controller.scrollRelative("up", 5);
  void controller.scrollRelative("down", 30);
  void controller.scrollTo(40);
  await second;
  expect(fake.log).toEqual(["history:up:5", "goto:40"]);
});

test("touch-scroll routes by live state: shell → history, mouse app → wheel bytes, less → arrows", async () => {
  const fake = fakeTarget();
  const controller = new TerminalScrollController(fake.target);
  await controller.handle({ type: "touch-scroll", direction: "up", lines: 6 });
  expect(fake.log).toEqual(["history:up:6"]);

  fake.log.length = 0;
  fake.setState({ ...SHELL, altScreen: true, mouseApp: true, mouseSgr: true });
  const later = new TerminalScrollController(fake.target);
  await later.handle({
    type: "touch-scroll",
    direction: "up",
    lines: 2,
    col: 3,
    row: 4,
  });
  expect(fake.log).toEqual([
    `input:${JSON.stringify("\x1b[<64;3;4M".repeat(2))}`,
  ]);

  fake.log.length = 0;
  fake.setState({ ...SHELL, altScreen: true, appCursor: true });
  const less = new TerminalScrollController(fake.target);
  await less.handle({ type: "touch-scroll", direction: "down", lines: 3 });
  expect(fake.log).toEqual([`input:${JSON.stringify("\x1bOB".repeat(3))}`]);
});

test("touch routing reuses the pane state for up to 250 ms", async () => {
  let now = 1_000;
  const fake = fakeTarget({ state: { ...SHELL, altScreen: true } });
  const controller = new TerminalScrollController(fake.target, {
    now: () => now,
  });
  await controller.handle({ type: "touch-scroll", direction: "up", lines: 1 });
  await controller.handle({ type: "touch-scroll", direction: "up", lines: 1 });
  expect(fake.reads).toBe(1);
  now += 251;
  await controller.handle({ type: "touch-scroll", direction: "up", lines: 1 });
  expect(fake.reads).toBe(2);
});

test("scroll-position frames: after a drained run, with strictly increasing seq", async () => {
  const fake = fakeTarget();
  const controller = new TerminalScrollController(fake.target);
  const run = controller.scrollRelative("up", 6);
  void controller.scrollRelative("up", 4);
  await run;
  await controller.scrollTo(40);
  await controller.handle({ type: "scroll-latest" });
  expect(fake.frames.map((f) => f.frame)).toEqual([
    {
      type: "scroll-position",
      seq: 1,
      inMode: true,
      position: 10,
      total: 300,
      rows: 20,
      altScreen: false,
      mouseApp: false,
    },
    expect.objectContaining({ seq: 2, inMode: true, position: 40 }),
    expect.objectContaining({ seq: 3, inMode: false, position: 0 }),
  ]);
});

test("no subscribers: no frame and no extra tmux read", async () => {
  const fake = fakeTarget();
  fake.subscribers.length = 0;
  const controller = new TerminalScrollController(fake.target);
  await controller.scrollRelative("up", 6);
  expect(fake.reads).toBe(0);
  expect(fake.frames).toHaveLength(0);
});

test("emit(sink) sends to that one socket only (reconnect before ready)", async () => {
  const fake = fakeTarget({ state: { ...SHELL, inMode: true, position: 9 } });
  const controller = new TerminalScrollController(fake.target);
  const own: string[] = [];
  await controller.emit({ send: (f) => own.push(f) });
  expect(fake.frames).toHaveLength(0);
  expect(JSON.parse(own[0]!)).toMatchObject({
    seq: 1,
    inMode: true,
    position: 9,
  });
});

test("output while in copy-mode refreshes the indicator on a trailing throttle", async () => {
  const fake = fakeTarget({ state: { ...SHELL, inMode: true, position: 9 } });
  const controller = new TerminalScrollController(fake.target, {
    outputThrottleMs: 30,
  });
  // Not known to be in copy-mode yet: output does nothing.
  controller.onOutput();
  await Bun.sleep(60);
  expect(fake.frames).toHaveLength(0);

  await controller.emit();
  expect(fake.frames).toHaveLength(1);
  // Copy-mode ended elsewhere (e.g. `q`): the next throttled frame says so.
  fake.setState({ ...SHELL });
  for (let i = 0; i < 5; i += 1) controller.onOutput();
  await Bun.sleep(80);
  expect(fake.frames.map((f) => [f.frame.seq, f.frame.inMode])).toEqual([
    [1, true],
    [2, false],
  ]);
  // No longer in copy-mode: further output sends nothing.
  controller.onOutput();
  await Bun.sleep(60);
  expect(fake.frames).toHaveLength(2);
});

test("resize sends a frame only while in copy-mode", async () => {
  const fake = fakeTarget();
  const controller = new TerminalScrollController(fake.target);
  await controller.onResize();
  expect(fake.frames).toHaveLength(0);
  await controller.scrollRelative("up", 3);
  await controller.onResize();
  expect(fake.frames.map((f) => f.frame.seq)).toEqual([1, 2]);
});

test("a wedged tmux call cannot strand input behind an exit", async () => {
  const fake = fakeTarget();
  fake.target.exitScroll = () => new Promise(() => {});
  const controller = new TerminalScrollController(fake.target, {
    opTimeoutMs: 30,
  });
  const done = controller.scrollTo(0);
  controller.input("z");
  expect(fake.log).toEqual([]);
  await done;
  expect(fake.log).toEqual(['input:"z"']);
});

test("a closed terminal drops queued work", async () => {
  const fake = fakeTarget();
  const controller = new TerminalScrollController(fake.target);
  fake.deactivate();
  await controller.scrollRelative("up", 3);
  expect(fake.log).toEqual([]);
});
