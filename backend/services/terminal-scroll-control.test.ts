import { expect, test } from "bun:test";
import {
  encodeArrowKeys,
  encodeWheelReports,
  isReadOnlyAllowedMessageType,
  isTerminalReply,
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

test("routing: wheel reports are always SGR, even for a legacy-mouse pane (tmux re-encodes)", () => {
  const legacy = { ...SHELL, mouseApp: true, mouseSgr: false };
  expect(
    routeTouchScroll(legacy, { direction: "up", lines: 1, col: 1, row: 1 }),
  ).toEqual({ kind: "wheel", bytes: "\x1b[<64;1;1M" });
  // col >= 96 broke the old one-byte legacy encoding (UTF-8 on the way in).
  const wide = routeTouchScroll(
    legacy,
    { direction: "down", lines: 2, col: 100, row: 12 },
    { cols: 120, rows: 30 },
  ) as { kind: string; bytes: string };
  expect(wide).toEqual({ kind: "wheel", bytes: "\x1b[<65;100;12M".repeat(2) });
  expect(/^[\x00-\x7f]*$/.test(wide.bytes)).toBe(true);
  expect(encodeWheelReports("up", 3, 300, 2)).toBe("\x1b[<64;300;2M".repeat(3));
});

test("routing: cells and pane sizes are clamped to sane integers (bogus resize)", () => {
  const state = { ...SHELL, mouseApp: true, mouseSgr: true, rows: 0 };
  // term.cols from an unvalidated client resize: never a malformed report.
  for (const cols of [1e308, Number.NaN, -5, Infinity, "80" as any]) {
    const route = routeTouchScroll(
      state,
      { direction: "up", lines: 1 },
      { cols, rows: Number.NaN },
    ) as { bytes: string };
    expect(route.bytes).toMatch(/^\x1b\[<64;\d{1,4};\d{1,4}M$/);
  }
  expect(
    routeTouchScroll(state, { direction: "up", lines: 1 }, { cols: 1e308, rows: 50 }),
  ).toEqual({ kind: "wheel", bytes: "\x1b[<64;500;25M" });
  expect(encodeWheelReports("up", 1, Number.NaN, 1e12)).toBe("\x1b[<64;1;1000M");
  // Parsed cells above 1000 are clamped, non-integers refused.
  expect(
    parseScrollControlMessage({
      type: "touch-scroll",
      direction: "up",
      lines: 1,
      col: 5000,
      row: 2,
    }),
  ).toEqual({ type: "touch-scroll", direction: "up", lines: 1, col: 1000, row: 2 });
});

test("terminal replies: CPR, DA, DSR, focus, OSC and DCS replies and their concatenations", () => {
  for (const reply of [
    "\x1b[12;40R",
    "\x1b[?1;2c",
    "\x1b[?62;22c",
    "\x1b[>0;276;0c",
    "\x1b[>c",
    "\x1b[0n",
    "\x1b[3n",
    "\x1b[I",
    "\x1b[O",
    "\x1b]11;rgb:0000/0000/0000\x07",
    "\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
    "\x1bP1$r0m\x1b\\",
    "\x1b[I\x1b[12;1R\x1b[?1;2c\x1b]11;rgb:0/0/0\x07",
  ]) {
    expect(isTerminalReply(reply)).toBe(true);
  }
  for (const typed of [
    "",
    "a",
    "ls\r",
    "\x1b[A",
    "\x1bOA",
    "\x1b",
    "\x1b[5~",
    "\x1b[I x",
    "x\x1b[I",
    "\x1b[1n",
    "\x1b]11;unterminated",
    "\x1b[200~paste\x1b[201~",
  ]) {
    expect(isTerminalReply(typed)).toBe(false);
  }
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

type FakeOptions = {
  state?: TmuxScrollState | null;
  opDelayMs?: number;
  /** exitScroll and cancelScroll leave the pane in copy-mode. */
  exitStuck?: boolean;
};

function fakeTarget(options: FakeOptions = {}) {
  const log: string[] = [];
  const frames: Array<{ sink: string; frame: any }> = [];
  let state: TmuxScrollState | null =
    options.state === undefined ? { ...SHELL } : options.state;
  let reads = 0;
  // Settles early when the controller aborts the call (a killed tmux client).
  const delay = (signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, options.opDelayMs ?? 5);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  const subscribers = [
    { send: (f: string) => frames.push({ sink: "sub", frame: JSON.parse(f) }) },
  ];
  let active = true;
  const target: ScrollControlTarget = {
    readState: async (signal) => {
      reads += 1;
      await delay(signal);
      return state ? { ...state } : null;
    },
    scrollHistory: async (direction, lines, signal) => {
      log.push(`history:${direction}:${lines}`);
      await delay(signal);
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
    scrollToPosition: async (position, signal) => {
      log.push(`goto:${position}`);
      await delay(signal);
      if (state) {
        state = {
          ...state,
          inMode: true,
          position: Math.min(state.total, position),
        };
      }
      return true;
    },
    exitScroll: async (signal) => {
      log.push("exit");
      await delay(signal);
      if (state && !options.exitStuck) {
        state = { ...state, inMode: false, position: 0 };
      }
      return true;
    },
    cancelScroll: async (signal) => {
      log.push("cancel");
      await delay(signal);
      if (state && !options.exitStuck) {
        state = { ...state, inMode: false, position: 0 };
      }
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
  // Held input is written in one piece, in order.
  expect(fake.log).toEqual(["exit", 'input:"ab"']);
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

test("a hanging exit is not a success: input held behind it is dropped, not typed into copy-mode", async () => {
  const fake = fakeTarget({ state: { ...SHELL, inMode: true, position: 30 } });
  // copy-mode -q hangs until the deadline kills it; the pane stays in mode.
  fake.target.exitScroll = (signal) =>
    new Promise((resolve) =>
      signal.addEventListener("abort", () => resolve(false)),
    );
  fake.target.cancelScroll = async () => false;
  const notes: string[] = [];
  const controller = new TerminalScrollController(fake.target, {
    opTimeoutMs: 20,
    exitRetryMs: 5,
    exitGiveUpMs: 20,
    log: (m) => notes.push(m),
  });
  const done = controller.scrollTo(0);
  controller.input("z");
  await done;
  await controller.emit();
  expect(fake.log).toEqual([]);
  expect(notes.join("\n")).toContain("dropped 1 held input bytes");
  // No content in the log, only counts.
  expect(notes.join("\n")).not.toContain('"z"');
  // The scroll=1 sockets learn the pane is still scrolled back.
  expect(fake.frames.at(-1)?.frame).toMatchObject({ inMode: true });
  expect(controller.mayBeScrolledBack).toBe(true);
});

test("a closed terminal drops queued work", async () => {
  const fake = fakeTarget();
  const controller = new TerminalScrollController(fake.target);
  fake.deactivate();
  await controller.scrollRelative("up", 3);
  expect(fake.log).toEqual([]);
});

// --- A: server barrier for scroll=1 (touch) sockets --------------------------

test("barrier: touch input after a history scroll gets a confirmed exit first, without any scroll-latest", async () => {
  const fake = fakeTarget();
  const controller = new TerminalScrollController(fake.target);
  await controller.handle({ type: "touch-scroll", direction: "up", lines: 6 });
  expect(controller.mayBeScrolledBack).toBe(true);
  fake.log.length = 0;

  controller.input("ls\r", { scroll: true });
  expect(fake.log).toEqual(["exit"]);
  await Bun.sleep(40);
  expect(fake.log).toEqual(["exit", 'input:"ls\\r"']);
  expect(controller.mayBeScrolledBack).toBe(false);

  // Out of copy-mode (confirmed): the next keys go straight through.
  controller.input("x", { scroll: true });
  expect(fake.log.at(-1)).toBe('input:"x"');
});

test("barrier: a touch scroll still queued or in flight also holds touch input behind an exit", async () => {
  const fake = fakeTarget();
  const controller = new TerminalScrollController(fake.target);
  // The client's inMode is still false here: the frame has not arrived.
  const scrolling = controller.handle({
    type: "touch-scroll",
    direction: "up",
    lines: 3,
  });
  controller.input("a", { scroll: true });
  controller.input("b", { scroll: true });
  await scrolling;
  expect(fake.log).toEqual(["history:up:3", "exit", 'input:"ab"']);
});

test("barrier: desktop input (no scroll=1) is written at once, exactly as before", async () => {
  const fake = fakeTarget();
  const controller = new TerminalScrollController(fake.target);
  await controller.scrollRelative("up", 5);
  fake.log.length = 0;
  controller.input("k");
  controller.input("j", { scroll: false });
  expect(fake.log).toEqual(['input:"k"', 'input:"j"']);
});

test("barrier: a terminal reply on a touch socket never leaves scrollback", async () => {
  const fake = fakeTarget();
  const controller = new TerminalScrollController(fake.target);
  await controller.handle({ type: "touch-scroll", direction: "up", lines: 4 });
  fake.log.length = 0;
  controller.input("\x1b[5;1R\x1b[I", { scroll: true });
  expect(fake.log).toEqual([`input:${JSON.stringify("\x1b[5;1R\x1b[I")}`]);
  expect(controller.mayBeScrolledBack).toBe(true);
});

test("barrier flag: set by a state read that sees copy-mode, cleared by one that does not", async () => {
  const fake = fakeTarget({ state: { ...SHELL, inMode: true, position: 12 } });
  const controller = new TerminalScrollController(fake.target);
  expect(controller.mayBeScrolledBack).toBe(false);
  // e.g. the reconnect frame of a phone whose pane was left scrolled back.
  await controller.emit();
  expect(controller.mayBeScrolledBack).toBe(true);
  fake.setState({ ...SHELL });
  await controller.emit();
  expect(controller.mayBeScrolledBack).toBe(false);
  controller.input("q", { scroll: true });
  expect(fake.log).toEqual(['input:"q"']);
});

test("barrier flag: a read that raced a scroll cannot clear it", async () => {
  const fake = fakeTarget({ opDelayMs: 20 });
  const controller = new TerminalScrollController(fake.target);
  // The read starts first and sees the pane out of copy-mode...
  const emitting = controller.emit();
  // ...while a scroll enters copy-mode before the read returns.
  const scrolling = controller.scrollRelative("up", 3);
  await Promise.all([emitting, scrolling]);
  expect(controller.mayBeScrolledBack).toBe(true);
});

test("barrier flag: a read that ran while a scroll was in flight (before it reached copy-mode) cannot clear it", async () => {
  const fake = fakeTarget();
  fake.subscribers.length = 0; // no frame read after the run re-raises it
  let started!: () => void;
  const mutationStarted = new Promise<void>((resolve) => (started = resolve));
  let enterCopyMode!: () => void;
  fake.target.scrollHistory = (direction, lines) =>
    new Promise((resolve) => {
      fake.log.push(`history:${direction}:${lines}`);
      started();
      enterCopyMode = () => {
        fake.setState({ ...SHELL, inMode: true, position: lines });
        resolve(true);
      };
    });
  fake.target.readState = async () => ({ ...SHELL }); // instant, out of mode
  const controller = new TerminalScrollController(fake.target);
  const scrolling = controller.scrollRelative("up", 3);
  await mutationStarted;
  // The read starts after the scroll started but before tmux entered
  // copy-mode, and returns "not in copy-mode" while the scroll is in flight.
  const seen: string[] = [];
  await controller.emit({ send: (f) => seen.push(f) });
  expect(JSON.parse(seen[0]!)).toMatchObject({ inMode: false });
  expect(controller.mayBeScrolledBack).toBe(true);
  enterCopyMode();
  await scrolling;
  // The scroll settled: the barrier is still up, and typing leaves first.
  expect(controller.mayBeScrolledBack).toBe(true);
  fake.log.length = 0;
  fake.target.readState = async () => ({ ...SHELL, inMode: false });
  controller.input("x", { scroll: true });
  expect(fake.log).toEqual(["exit"]);
  await Bun.sleep(30);
  expect(fake.log).toEqual(["exit", 'input:"x"']);
});

test("barrier flag: a read that started during a scroll and returned after it settled cannot clear it", async () => {
  const fake = fakeTarget();
  fake.subscribers.length = 0;
  let started!: () => void;
  const mutationStarted = new Promise<void>((resolve) => (started = resolve));
  let enterCopyMode!: () => void;
  fake.target.scrollHistory = (direction, lines) =>
    new Promise((resolve) => {
      fake.log.push(`history:${direction}:${lines}`);
      started();
      enterCopyMode = () => {
        fake.setState({ ...SHELL, inMode: true, position: lines });
        resolve(true);
      };
    });
  // The read snapshots the pane when it starts, returns when told to.
  let returnRead!: () => void;
  fake.target.readState = () => {
    const snapshot = { ...SHELL };
    return new Promise((resolve) => (returnRead = () => resolve(snapshot)));
  };
  const controller = new TerminalScrollController(fake.target);
  const scrolling = controller.scrollRelative("up", 3);
  await mutationStarted;
  const emitting = controller.emit({ send: () => {} });
  await Bun.sleep(1);
  enterCopyMode();
  // The scroll settles (the drain then waits for the frame read behind ours).
  await Bun.sleep(5);
  expect((controller as any).inFlight).toBeNull();
  returnRead(); // the stale "not in copy-mode" arrives after the scroll
  await Promise.all([emitting, scrolling]);
  expect(controller.mayBeScrolledBack).toBe(true);
});

test("barrier: scroll-latest from the page plus the typed keys queue a single exit", async () => {
  const fake = fakeTarget({ state: { ...SHELL, inMode: true, position: 40 } });
  const controller = new TerminalScrollController(fake.target);
  await controller.scrollTo(40);
  fake.log.length = 0;
  const done = controller.handle({ type: "scroll-latest" });
  controller.input("h", { scroll: true });
  void controller.handle({ type: "scroll-latest" });
  controller.input("i", { scroll: true });
  await done;
  await Bun.sleep(30);
  expect(fake.log).toEqual(["exit", 'input:"hi"']);
});

test("scroll control off (brokered/raw): touch is plain history, scroll-to/latest ignored, no frames, no barrier", async () => {
  const fake = fakeTarget();
  const controller = new TerminalScrollController(fake.target, {
    scrollControl: false,
  });
  await controller.handle({
    type: "touch-scroll",
    direction: "up",
    lines: 7,
    col: 3,
    row: 3,
  });
  await controller.handle({ type: "scroll-to", position: 40 });
  await controller.handle({ type: "scroll-latest" });
  controller.input("x", { scroll: true });
  await controller.emit();
  await controller.onResize();
  expect(fake.log).toEqual(["history:up:7", 'input:"x"']);
  expect(fake.reads).toBe(0);
  expect(fake.frames).toHaveLength(0);
});

// --- B: confirmed exit -------------------------------------------------------

test("confirmed exit: copy-mode -q that does not leave is followed by send -X cancel", async () => {
  const fake = fakeTarget({ state: { ...SHELL, inMode: true, position: 9 } });
  fake.target.exitScroll = async () => {
    fake.log.push("exit");
    return true; // rc 0 but still in copy-mode
  };
  const controller = new TerminalScrollController(fake.target);
  await controller.scrollTo(5);
  fake.log.length = 0;
  const done = controller.scrollTo(0);
  controller.input("y", { scroll: true });
  await done;
  expect(fake.log).toEqual(["exit", "cancel", 'input:"y"']);
});

test("confirmed exit: retries every exitRetryMs, and input waits while a retry succeeds", async () => {
  let stuckReads = 3;
  const fake = fakeTarget({ state: { ...SHELL, inMode: true, position: 9 } });
  const readState = fake.target.readState;
  fake.target.exitScroll = async () => {
    fake.log.push("exit");
    return true;
  };
  fake.target.cancelScroll = async () => {
    fake.log.push("cancel");
    return true;
  };
  fake.target.readState = async (signal) => {
    const state = await readState(signal);
    if (stuckReads > 0) {
      stuckReads -= 1;
      return state;
    }
    return state ? { ...state, inMode: false, position: 0 } : state;
  };
  const controller = new TerminalScrollController(fake.target, {
    exitRetryMs: 10,
    exitGiveUpMs: 100,
  });
  const done = controller.scrollTo(0);
  controller.input("w", { scroll: true });
  await done;
  expect(fake.log).toEqual(["exit", "cancel", "exit", "cancel", 'input:"w"']);
});

test("confirmed exit: a pane that stays in copy-mode drops the held input after the give-up time and logs counts only", async () => {
  const fake = fakeTarget({
    state: { ...SHELL, inMode: true, position: 9 },
    exitStuck: true,
  });
  const notes: string[] = [];
  const controller = new TerminalScrollController(fake.target, {
    exitRetryMs: 10,
    exitGiveUpMs: 40,
    log: (m) => notes.push(m),
  });
  await controller.scrollTo(9);
  fake.log.length = 0;
  fake.frames.length = 0;
  const started = performance.now();
  controller.input("secret-password\r", { scroll: true });
  await Bun.sleep(5);
  // A later scroll op is kept; only the input behind the stuck exit goes.
  void controller.scrollRelative("down", 2);
  await Bun.sleep(400);
  expect(performance.now() - started).toBeGreaterThanOrEqual(40);
  // Retried while time was left (the count depends on call durations).
  expect(fake.log.filter((l) => l === "exit").length).toBeGreaterThanOrEqual(2);
  expect(fake.log.some((l) => l.startsWith("input:"))).toBe(false);
  expect(fake.log.at(-1)).toBe("history:down:2");
  expect(notes.join("\n")).toContain("dropped 16 held input bytes");
  expect(notes.join("\n")).not.toContain("secret");
  expect(fake.frames.some((f) => f.frame.inMode === true)).toBe(true);
});

test("confirmed exit: one absolute deadline covers slow tmux calls, not a retry count", async () => {
  const fake = fakeTarget({
    state: { ...SHELL, inMode: true, position: 9 },
    exitStuck: true,
    opDelayMs: 30, // every tmux call takes 30 ms; the pane never leaves
  });
  const notes: Array<{ at: number; note: string }> = [];
  const controller = new TerminalScrollController(fake.target, {
    exitRetryMs: 10,
    exitGiveUpMs: 100,
    log: (note) => notes.push({ at: performance.now(), note }),
  });
  await controller.scrollTo(9);
  fake.log.length = 0;
  const started = performance.now();
  const done = controller.scrollTo(0);
  controller.input("pw\r", { scroll: true });
  await done;
  const dropped = notes.find((n) => n.note.includes("dropped 3 held input bytes"));
  expect(dropped).toBeDefined();
  // A retry count (100 / 10 = 10 more attempts of 4 calls x 30 ms) would
  // take over a second; the deadline ends it at 100 ms plus a small margin.
  const elapsed = dropped!.at - started;
  expect(elapsed).toBeGreaterThanOrEqual(95);
  expect(elapsed).toBeLessThan(250);
  expect(fake.log.some((l) => l.startsWith("input:"))).toBe(false);
});

test("confirmed exit: a call hanging past the deadline is cut at the time left, not at opTimeoutMs", async () => {
  const fake = fakeTarget({ state: { ...SHELL, inMode: true, position: 9 } });
  fake.subscribers.length = 0;
  const timeouts: number[] = [];
  // copy-mode -q hangs until it is aborted (killed).
  fake.target.exitScroll = (signal) => {
    const at = performance.now();
    return new Promise((resolve) =>
      signal.addEventListener("abort", () => {
        timeouts.push(performance.now() - at);
        resolve(false);
      }),
    );
  };
  const notes: string[] = [];
  const controller = new TerminalScrollController(fake.target, {
    opTimeoutMs: 3_000,
    exitGiveUpMs: 80,
    log: (m) => notes.push(m),
  });
  const started = performance.now();
  const done = controller.scrollTo(0);
  controller.input("q", { scroll: true });
  await done;
  expect(performance.now() - started).toBeLessThan(80 + 150);
  expect(timeouts).toHaveLength(1);
  expect(timeouts[0]!).toBeLessThan(80 + 150);
  expect(notes.join("\n")).toContain("dropped 1 held input bytes");
  expect(fake.log).toEqual([]);
  // The killed exit may still have reached tmux: the barrier stays up.
  expect(controller.mayBeScrolledBack).toBe(true);
});

test("confirmed exit: an unreadable state writes the input (pre-M0 behaviour) and logs it", async () => {
  const fake = fakeTarget({ state: { ...SHELL, inMode: true, position: 9 } });
  const notes: string[] = [];
  const controller = new TerminalScrollController(fake.target, {
    log: (m) => notes.push(m),
  });
  await controller.scrollTo(9);
  fake.setState(null);
  fake.log.length = 0;
  const done = controller.scrollTo(0);
  controller.input("ok", { scroll: true });
  await done;
  expect(fake.log).toEqual(["exit", 'input:"ok"']);
  expect(notes.join("\n")).toContain("unreadable");
  expect(notes.join("\n")).toContain("2 held input bytes");
});

// --- C: bounds -----------------------------------------------------------------

test("bounds: at most maxQueuedOps queued ops; further scrolls are dropped and logged once per burst", async () => {
  const fake = fakeTarget({ opDelayMs: 1 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const history = fake.target.scrollHistory;
  fake.target.scrollHistory = async (direction, lines, signal) => {
    await gate;
    return history(direction, lines, signal);
  };
  const notes: string[] = [];
  const controller = new TerminalScrollController(fake.target, {
    maxQueuedOps: 8,
    log: (m) => notes.push(m),
  });
  const first = controller.scrollRelative("up", 1); // in flight, blocked
  // Each absolute target replaces queued scrolls, so build distinct ops by
  // putting touch input (each with its barrier exit) between them.
  for (let i = 0; i < 30; i += 1) {
    void controller.scrollRelative("up", 1);
    controller.input(String(i % 10), { scroll: true });
    void controller.scrollTo(10 + i);
  }
  const queued = (controller as any).queue as unknown[];
  // The bound plus at most one barrier exit and its input.
  expect(queued.length).toBeLessThanOrEqual(10);
  expect(notes.filter((n) => n.includes("scroll queue full"))).toHaveLength(1);
  release();
  await first;
  await Bun.sleep(50);
  expect(notes.some((n) => /\d+ scroll requests were dropped/.test(n))).toBe(
    true,
  );
});

test("bounds: alternating touch-scroll and scrollback do not merge across each other; the op cap bounds them", async () => {
  const fake = fakeTarget();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const history = fake.target.scrollHistory;
  fake.target.scrollHistory = async (direction, lines, signal) => {
    await gate;
    return history(direction, lines, signal);
  };
  const notes: string[] = [];
  const controller = new TerminalScrollController(fake.target, {
    log: (m) => notes.push(m),
  });
  const first = controller.scrollRelative("up", 1);
  for (let i = 0; i < 500; i += 1) {
    void controller.handle({ type: "touch-scroll", direction: "up", lines: 1 });
    void controller.scrollRelative("up", 1);
  }
  const queued = (controller as any).queue as Array<{ kind: string }>;
  expect(queued).toHaveLength(128);
  queued.forEach((op, i) =>
    expect(op.kind).toBe(i % 2 === 0 ? "touch" : "relative"),
  );
  expect(notes.filter((n) => n.includes("scroll queue full"))).toHaveLength(1);
  // Once full, the touches in between are dropped, so the later relatives
  // are adjacent to the queued tail and coalesce into it (clamped to 100).
  expect(queued.at(-1) as unknown).toEqual({ kind: "relative", lines: 100 });
  // Do not run 128 ops: a closed terminal drops the queue.
  fake.deactivate();
  release();
  await first;
  expect(fake.log).toEqual(["history:up:1"]);
});

test("ordering: touch up, relative up, touch up stay in that order for a mouse app", async () => {
  const MOUSE_APP = { ...SHELL, altScreen: true, mouseApp: true, mouseSgr: true };
  const fake = fakeTarget({ state: { ...MOUSE_APP } });
  fake.subscribers.length = 0;
  // Hold the queue behind a confirmed exit so all three scrolls queue up.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const exit = fake.target.exitScroll;
  fake.target.exitScroll = async (signal) => {
    await gate;
    return exit(signal);
  };
  // Real tmux: a history scroll opens copy-mode on the alternate screen too.
  fake.target.scrollHistory = async (direction, lines) => {
    fake.log.push(`history:${direction}:${lines}`);
    fake.setState({ ...MOUSE_APP, inMode: true, position: lines });
    return true;
  };
  const controller = new TerminalScrollController(fake.target);
  const done = controller.scrollTo(0);
  const touch = { type: "touch-scroll", direction: "up", lines: 1, col: 2, row: 3 } as const;
  void controller.handle(touch);
  void controller.scrollRelative("up", 1);
  void controller.handle(touch);
  const queued = (controller as any).queue as Array<{ kind: string }>;
  expect(queued.map((op) => op.kind)).toEqual(["touch", "relative", "touch"]);
  release();
  await done;
  // First touch: one wheel turn to the app. Relative: copy-mode opens.
  // Second touch: the pane is in copy-mode now, so it scrolls history.
  expect(fake.log).toEqual([
    "exit",
    `input:${JSON.stringify("\x1b[<64;2;3M")}`,
    "history:up:1",
    "history:up:1",
  ]);
});

test("bounds: held input stops at maxHeldInputBytes; the rest is dropped with a count-only log", async () => {
  const fake = fakeTarget({ state: { ...SHELL, inMode: true, position: 9 } });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const exit = fake.target.exitScroll;
  fake.target.exitScroll = async (signal) => {
    await gate;
    return exit(signal);
  };
  const notes: string[] = [];
  const controller = new TerminalScrollController(fake.target, {
    maxHeldInputBytes: 1024,
    opTimeoutMs: 60_000,
    log: (m) => notes.push(m),
  });
  const done = controller.scrollTo(0);
  const chunk = "x".repeat(100);
  for (let i = 0; i < 50; i += 1) controller.input(chunk, { scroll: true });
  expect((controller as any).heldBytes).toBeLessThanOrEqual(1024);
  release();
  await done;
  const written = fake.log
    .filter((l) => l.startsWith("input:"))
    .map((l) => JSON.parse(l.slice("input:".length)) as string)
    .join("");
  expect(written).toBe(chunk.repeat(10));
  expect(notes.join("\n")).toContain("dropping 100 bytes");
  expect(notes.join("\n")).toContain("4000 bytes of input were dropped");
  expect(notes.join("\n")).not.toContain("xxx");
  expect((controller as any).heldBytes).toBe(0);
});

// --- D: timeouts really end the op -------------------------------------------------

test("timeout: a slow op is aborted and the queue waits until it settled; order is kept", async () => {
  const fake = fakeTarget();
  const events: string[] = [];
  fake.target.scrollToPosition = (position, signal) =>
    new Promise((resolve) => {
      events.push(`goto-start:${position}`);
      const timer = setTimeout(() => {
        events.push("goto-done");
        resolve(true);
      }, 500);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        // The kill takes a moment to land; the queue must still wait.
        setTimeout(() => {
          events.push("goto-killed");
          resolve(false);
        }, 30);
      });
    });
  fake.target.exitScroll = async () => {
    events.push("exit");
    return true;
  };
  const controller = new TerminalScrollController(fake.target, {
    opTimeoutMs: 20,
  });
  const done = controller.scrollTo(40);
  await Bun.sleep(1);
  void controller.handle({ type: "scroll-latest" });
  controller.input("k", { scroll: true });
  await done;
  await Bun.sleep(80);
  expect(events).toEqual(["goto-start:40", "goto-killed", "exit"]);
  expect(fake.log).toEqual(['input:"k"']);
});

test("timeout: an op that ignores the abort still finishes before the next op starts", async () => {
  const fake = fakeTarget();
  const events: string[] = [];
  fake.target.scrollToPosition = () =>
    new Promise((resolve) =>
      setTimeout(() => {
        events.push("goto-done");
        resolve(true);
      }, 60),
    );
  fake.target.exitScroll = async () => {
    events.push("exit");
    return true;
  };
  const controller = new TerminalScrollController(fake.target, {
    opTimeoutMs: 10,
  });
  void controller.scrollTo(40);
  await Bun.sleep(1);
  const done = controller.handle({ type: "scroll-latest" });
  await done;
  expect(events).toEqual(["goto-done", "exit"]);
  // The confirmed exit read the pane back out of copy-mode.
  expect(controller.mayBeScrolledBack).toBe(false);
});

test("timeout: a mutating call past its deadline leaves the barrier up (it may still have reached tmux)", async () => {
  const fake = fakeTarget();
  fake.subscribers.length = 0; // no frame read after the run
  fake.target.scrollHistory = (_direction, _lines, signal) =>
    new Promise((resolve) =>
      signal.addEventListener("abort", () => resolve(false)),
    );
  const controller = new TerminalScrollController(fake.target, {
    opTimeoutMs: 10,
  });
  await controller.scrollRelative("up", 3);
  expect(controller.mayBeScrolledBack).toBe(true);
  fake.log.length = 0;
  controller.input("v", { scroll: true });
  await Bun.sleep(30);
  expect(fake.log).toEqual(["exit", 'input:"v"']);
});
