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
// beforeinput/input fallback. The arbiter records what xterm forwarded while
// it handled one DOM event (the keypress, or the input event) so the fallback
// does not send that event's text again. A claim never outlives its event.

import { createCompositionTracker, createKeystrokeArbiter } from "./input-fallback";

// Replays a device event sequence. `xterm` is what xterm 5.3 forwards from
// its handler for that event (see web/vendor/xterm.min.js _keyDown /
// _keyPress / _inputEvent). Returns what the fallback sends.
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
    } else if (step.type === "input") {
      arbiter.inputEvent();
      if (step.xterm) arbiter.xtermData(step.xterm);
      if (!arbiter.takeInputEcho()) fallbackSent.push(step.data);
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

test("Gboard A then a physical A: each is sent exactly once", () => {
  // The Gboard A goes through the fallback (xterm forwards nothing); the
  // physical A goes through xterm's keypress and its beforeinput is claimed.
  expect(
    replay([
      { type: "keydown" },
      { type: "beforeinput", data: "A" },
      { type: "keyup" },
      { type: "keydown" },
      { type: "keypress", xterm: "A" },
      { type: "beforeinput", data: "A" },
      { type: "keyup" },
    ]),
  ).toEqual(["A"]);
});

test("a beforeinput without a keystroke (soft keyboard commit) is sent", () => {
  expect(replay([{ type: "beforeinput", data: "x" }])).toEqual(["x"]);
});

test("a keypress xterm ignores (it forwarded nothing) leaves the text to the fallback", () => {
  expect(
    replay([
      { type: "keydown" },
      { type: "keypress" },
      { type: "beforeinput", data: "é" },
    ]),
  ).toEqual(["é"]);
});

test("xterm data from keydown or outside an event does not claim a later beforeinput", () => {
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

test("an input event xterm already forwarded is not sent again; the next one is", () => {
  expect(
    replay([
      { type: "input", data: "x", xterm: "x" },
      { type: "input", data: "x" },
    ]),
  ).toEqual(["x"]);
});

// --- Compositions are sent once, at commit -----------------------------------
//
// The composing text stays local (xterm's composition view shows it); only
// the committed text is sent, once, with no DELs. Events are named as the
// page sees them: start = compositionstart, update = input
// insertCompositionText, fromComposition = input insertFromComposition,
// end = compositionend, text = beforeinput/input insertText,
// keydown = a keydown ({ keyCode, isComposing }), edit = any other edit.
function compose(steps) {
  const tracker = createCompositionTracker();
  const sent = [];
  const push = (text) => {
    if (text) sent.push(text);
  };
  for (const [type, data] of steps) {
    if (type === "start") tracker.start();
    else if (type === "update") tracker.update(data);
    else if (type === "fromComposition") push(tracker.commitFromInput(data));
    else if (type === "end") push(tracker.end(data));
    else if (type === "text") {
      if (!tracker.confirmText(data)) push(data);
    } else if (type === "keydown") push(tracker.keydown(data));
    else if (type === "edit") tracker.edit();
  }
  return { sent, active: tracker.active };
}

test("a composed word is sent once at compositionend, nothing while composing", () => {
  expect(
    compose([
      ["start"],
      ["update", "H"],
      ["update", "He"],
      ["update", "Hel"],
      ["update", "He"],
      ["update", "Help"],
      ["end", "Help"],
    ]),
  ).toEqual({ sent: ["Help"], active: false });
});

test("a corrected word, a suggestion and a combining mark are sent as committed", () => {
  expect(compose([["start"], ["update", "teh"], ["end", "the"]]).sent).toEqual([
    "the",
  ]);
  expect(
    compose([["start"], ["update", "hel"], ["end", "hello "]]).sent,
  ).toEqual(["hello "]);
  expect(
    compose([["start"], ["update", "e"], ["update", "é"], ["end", "é"]])
      .sent,
  ).toEqual(["é"]);
});

test("a cancelled composition sends nothing", () => {
  expect(compose([["start"], ["update", "x"], ["update", ""], ["end", ""]]).sent).toEqual(
    [],
  );
});

test("Safari: insertFromComposition before compositionend is the one commit", () => {
  expect(
    compose([
      ["start"],
      ["update", "e"],
      ["update", "é"],
      ["fromComposition", "é"],
      ["end", "é"],
    ]),
  ).toEqual({ sent: ["é"], active: false });
});

test("Safari: insertFromComposition after compositionend confirms it, never starts a new one", () => {
  expect(
    compose([
      ["start"],
      ["update", "e"],
      ["update", "é"],
      ["end", "é"],
      ["fromComposition", "é"],
    ]),
  ).toEqual({ sent: ["é"], active: false });
});

test("an insertText repeating the commit confirms it; a new keystroke ends that window", () => {
  expect(
    compose([["start"], ["update", "ab"], ["end", "ab"], ["text", "ab"]]).sent,
  ).toEqual(["ab"]);
  expect(
    compose([
      ["start"],
      ["update", "ab"],
      ["end", "ab"],
      ["keydown", { keyCode: 65 }],
      ["text", "ab"],
    ]).sent,
  ).toEqual(["ab", "ab"]);
});

test("a commit with no composition around it is sent", () => {
  expect(compose([["fromComposition", "語"]]).sent).toEqual(["語"]);
  expect(compose([["end", "語"]]).sent).toEqual(["語"]);
});

test("a real key during a composition commits its text once", () => {
  expect(
    compose([
      ["start"],
      ["update", "ab"],
      ["keydown", { keyCode: 13 }],
      ["end", "ab"],
    ]),
  ).toEqual({ sent: ["ab"], active: false });
});

test("an IME keydown (229 or isComposing) keeps the confirmation window open", () => {
  expect(
    compose([
      ["start"],
      ["update", "é"],
      ["end", "é"],
      ["keydown", { keyCode: 229 }],
      ["fromComposition", "é"],
    ]).sent,
  ).toEqual(["é"]);
  expect(
    compose([
      ["start"],
      ["update", "ab"],
      ["end", "ab"],
      ["keydown", { keyCode: 65, isComposing: true }],
      ["text", "ab"],
    ]).sent,
  ).toEqual(["ab"]);
});

test("an IME keydown does not interrupt a composition", () => {
  expect(
    compose([
      ["start"],
      ["update", "a"],
      ["keydown", { keyCode: 229 }],
      ["update", "ab"],
      ["end", "ab"],
    ]),
  ).toEqual({ sent: ["ab"], active: false });
});

test("a different text ends the confirmation window: a, then b, a arrive as aba", () => {
  expect(
    compose([
      ["start"],
      ["update", "a"],
      ["end", "a"],
      ["text", "b"],
      ["text", "a"],
    ]).sent,
  ).toEqual(["a", "b", "a"]);
});

test("any other edit ends the confirmation window", () => {
  expect(
    compose([["start"], ["update", "a"], ["end", "a"], ["edit"], ["text", "a"]])
      .sent,
  ).toEqual(["a", "a"]);
});

test("matchesConfirmation only peeks", () => {
  const tracker = createCompositionTracker();
  tracker.start();
  tracker.update("ab");
  expect(tracker.end("ab")).toBe("ab");
  expect(tracker.matchesConfirmation("ab")).toBe(true);
  expect(tracker.matchesConfirmation("ab")).toBe(true);
  expect(tracker.confirmText("ab")).toBe(true);
  expect(tracker.matchesConfirmation("ab")).toBe(false);
});
