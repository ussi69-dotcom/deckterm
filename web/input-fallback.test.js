import { expect, test } from "bun:test";
import { shouldUseMobileInputFallback } from "./input-fallback";

test("uses the fallback on mobile touch layouts", () => {
  expect(
    shouldUseMobileInputFallback({
      isMobile: true,
      hasTouch: true,
      isVirtualKeyboardOpen: false,
    }),
  ).toBe(true);
});

test("skips the fallback on hybrid touch desktops with hardware keyboards", () => {
  expect(
    shouldUseMobileInputFallback({
      isMobile: false,
      hasTouch: true,
      isVirtualKeyboardOpen: false,
    }),
  ).toBe(false);
});

test("allows the fallback again when a desktop touch device opens a virtual keyboard", () => {
  expect(
    shouldUseMobileInputFallback({
      isMobile: false,
      hasTouch: true,
      isVirtualKeyboardOpen: true,
    }),
  ).toBe(true);
});

// --- F17: a keystroke reaches the shell once -------------------------------
//
// On touch layouts two paths can send one keystroke: xterm's key handlers
// (keydown, or keypress for A-Z, space and keys with keyCode < 48) and the
// beforeinput fallback. The arbiter records what xterm emitted while handling
// the keystroke's keypress so the beforeinput that follows is not sent again.

import {
  compositionDelta,
  consumeFallbackEcho,
  createKeystrokeArbiter,
  FALLBACK_ECHO_TTL_MS,
  rememberFallbackEcho,
} from "./input-fallback";

// Replays a device event sequence. `xterm` lists what xterm 5.3 emits from
// its keydown / keypress handler for that keystroke (see web/vendor/xterm.min.js
// _keyDown / _keyPress). Returns what the beforeinput fallback sends.
function replay(steps) {
  const arbiter = createKeystrokeArbiter();
  const fallbackSent = [];
  for (const step of steps) {
    if (step.type === "keydown") {
      arbiter.keydown();
      if (step.xterm) arbiter.xtermData(step.xterm);
    } else if (step.type === "keypress") {
      arbiter.keypress();
      if (step.xterm) arbiter.xtermData(step.xterm);
    } else if (step.type === "beforeinput") {
      if (!arbiter.takeKeypressEcho()) fallbackSent.push(step.data);
    } else if (step.type === "keyup") {
      arbiter.keyup();
    } else if (step.type === "xterm") {
      arbiter.xtermData(step.data);
    }
  }
  return fallbackSent;
}

test("hardware keyboard capital: xterm sends it from keypress, the fallback does not", () => {
  expect(
    replay([
      { type: "keydown" },
      { type: "keypress", xterm: "A" },
      { type: "beforeinput", data: "A" },
      { type: "keyup" },
    ]),
  ).toEqual([]);
});

test("hardware keyboard space: xterm sends it from keypress, the fallback does not", () => {
  expect(
    replay([
      { type: "keydown" },
      { type: "keypress", xterm: " " },
      { type: "beforeinput", data: " " },
      { type: "keyup" },
    ]),
  ).toEqual([]);
});

test("Gboard keyCode 229: xterm sends nothing, the fallback sends the text", () => {
  expect(
    replay([
      { type: "keydown" },
      { type: "beforeinput", data: "a" },
      { type: "keyup" },
      { type: "keydown" },
      { type: "beforeinput", data: "B" },
      { type: "keyup" },
    ]),
  ).toEqual(["a", "B"]);
});

test("a beforeinput without a keystroke (soft keyboard commit) is sent", () => {
  expect(replay([{ type: "beforeinput", data: "x" }])).toEqual(["x"]);
});

test("a keypress xterm ignores (it emitted nothing) leaves the text to the fallback", () => {
  expect(
    replay([
      { type: "keydown" },
      { type: "keypress" },
      { type: "beforeinput", data: "é" },
    ]),
  ).toEqual(["é"]);
});

test("xterm data from keydown or outside a keypress does not claim a later beforeinput", () => {
  expect(
    replay([
      { type: "keydown", xterm: "a" },
      { type: "keyup" },
      { type: "xterm", data: "\x1b[I" },
      { type: "beforeinput", data: "b" },
    ]),
  ).toEqual(["b"]);
});

test("a keystroke whose beforeinput never came does not swallow the next one", () => {
  expect(
    replay([
      { type: "keydown" },
      { type: "keypress", xterm: "A" },
      { type: "keyup" },
      { type: "keydown" },
      { type: "beforeinput", data: "A" },
    ]),
  ).toEqual(["A"]);
});

test("an xterm echo of fallback text is consumed once", () => {
  const state = {};
  rememberFallbackEcho(state, "ab", 1000);
  expect(consumeFallbackEcho(state, "ab", 1010)).toBe("");
  expect(consumeFallbackEcho(state, "ab", 1020)).toBe("ab");
});

test("an echo that overlaps fallback text only passes the new part", () => {
  const state = {};
  rememberFallbackEcho(state, "ab", 1000);
  expect(consumeFallbackEcho(state, "abc", 1010)).toBe("c");
});

test("stale fallback text never swallows later real input", () => {
  const state = {};
  rememberFallbackEcho(state, " ", 1000);
  expect(consumeFallbackEcho(state, "a", 1005)).toBe("a");
  expect(consumeFallbackEcho(state, " ", 1000 + FALLBACK_ECHO_TTL_MS + 1)).toBe(
    " ",
  );
});

test("composition updates stream only what changed", () => {
  expect(compositionDelta("", "H")).toBe("H");
  expect(compositionDelta("H", "He")).toBe("e");
  expect(compositionDelta("Hel", "He")).toBe("\x7f");
  expect(compositionDelta("teh", "the")).toBe("\x7f\x7fhe");
  expect(compositionDelta("Help", "Help")).toBe("");
  expect(compositionDelta("x", "")).toBe("\x7f");
  expect(compositionDelta("日本", "日本語")).toBe("語");
  expect(compositionDelta("😀a", "😀")).toBe("\x7f");
});
