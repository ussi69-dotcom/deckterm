import { expect, test } from "bun:test";
import {
  getTmuxScrollRequestFromKey,
  getTmuxScrollRequestFromWheel,
  shouldRouteScrollToTmux,
  shouldScrollToPromptForKey,
} from "./extra-keys-scroll.js";

test("shouldScrollToPromptForKey returns false for PGUP (scrollback key)", () => {
  expect(shouldScrollToPromptForKey("PGUP")).toBe(false);
});

test("shouldScrollToPromptForKey returns false for PGDN (scrollback key)", () => {
  expect(shouldScrollToPromptForKey("PGDN")).toBe(false);
});

test("shouldScrollToPromptForKey returns true for TAB (normal key)", () => {
  expect(shouldScrollToPromptForKey("TAB")).toBe(true);
});

test("shouldScrollToPromptForKey returns true for ESC (normal key)", () => {
  expect(shouldScrollToPromptForKey("ESC")).toBe(true);
});

test("shouldScrollToPromptForKey returns true for Enter (normal key)", () => {
  expect(shouldScrollToPromptForKey("Enter")).toBe(true);
});

test("shouldScrollToPromptForKey returns true for arrow keys (UP/DOWN/LEFT/RIGHT)", () => {
  expect(shouldScrollToPromptForKey("UP")).toBe(true);
  expect(shouldScrollToPromptForKey("DOWN")).toBe(true);
  expect(shouldScrollToPromptForKey("LEFT")).toBe(true);
  expect(shouldScrollToPromptForKey("RIGHT")).toBe(true);
});

test("shouldScrollToPromptForKey returns true for DEL and INS", () => {
  expect(shouldScrollToPromptForKey("DEL")).toBe(true);
  expect(shouldScrollToPromptForKey("INS")).toBe(true);
});

test("tmux wheel requests preserve direction and normalize browser units", () => {
  expect(getTmuxScrollRequestFromWheel(-64, 0)).toEqual({
    direction: "up",
    lines: 2,
  });
  expect(getTmuxScrollRequestFromWheel(3, 1)).toEqual({
    direction: "down",
    lines: 3,
  });
  expect(getTmuxScrollRequestFromWheel(-1, 2)).toEqual({
    direction: "up",
    lines: 24,
  });
  expect(getTmuxScrollRequestFromWheel(0, 0)).toBeNull();
});

test("tmux PageUp and PageDown requests move one page", () => {
  expect(getTmuxScrollRequestFromKey("PageUp")).toEqual({
    direction: "up",
    lines: 24,
  });
  expect(getTmuxScrollRequestFromKey("PGDN")).toEqual({
    direction: "down",
    lines: 24,
  });
  expect(getTmuxScrollRequestFromKey("Enter")).toBeNull();
});

test("tmux scroll routing applies to tmux panes on the normal buffer", () => {
  expect(shouldRouteScrollToTmux("tmux", "normal")).toBe(true);
});

test("tmux scroll routing skips alternate-screen apps so they scroll themselves", () => {
  expect(shouldRouteScrollToTmux("tmux", "alternate")).toBe(false);
});

test("tmux scroll routing skips non-tmux backends entirely", () => {
  expect(shouldRouteScrollToTmux("raw", "normal")).toBe(false);
  expect(shouldRouteScrollToTmux(null, "normal")).toBe(false);
});

test("tmux scroll routing defaults to tmux history when buffer type is unknown", () => {
  expect(shouldRouteScrollToTmux("tmux", undefined)).toBe(true);
});
