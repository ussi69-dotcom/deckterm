import { expect, test } from "bun:test";
import {
  getTmuxScrollRequestFromKey,
  getTmuxScrollRequestFromWheel,
  shouldRouteScrollToTmux,
  shouldScrollToPromptForKey,
} from "./extra-keys-scroll.js";
import { getSelectionEdgeProxyY } from "./terminal-selection.js";

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

test("tmux scroll routing applies when the pane app did not take the mouse", () => {
  expect(shouldRouteScrollToTmux("tmux", "none")).toBe(true);
});

test("tmux scroll routing yields to apps that enabled mouse tracking", () => {
  expect(shouldRouteScrollToTmux("tmux", "vt200")).toBe(false);
  expect(shouldRouteScrollToTmux("tmux", "any")).toBe(false);
  expect(shouldRouteScrollToTmux("tmux", "drag")).toBe(false);
  expect(shouldRouteScrollToTmux("tmux", "x10")).toBe(false);
});

test("tmux scroll routing skips non-tmux backends entirely", () => {
  expect(shouldRouteScrollToTmux("raw", "none")).toBe(false);
  expect(shouldRouteScrollToTmux(null, "none")).toBe(false);
});

test("tmux scroll routing defaults to tmux history when mouse mode is unknown", () => {
  expect(shouldRouteScrollToTmux("tmux", undefined)).toBe(true);
});

test("selection edge proxy stays inactive in the terminal middle", () => {
  expect(getSelectionEdgeProxyY(250, { top: 100, bottom: 400 })).toBeNull();
});

test("selection edge proxy maps the inner top and bottom zones outside", () => {
  const rect = { top: 100, bottom: 400 };
  expect(getSelectionEdgeProxyY(123, rect)).toBe(99);
  expect(getSelectionEdgeProxyY(100, rect)).toBe(94);
  expect(getSelectionEdgeProxyY(377, rect)).toBe(401);
  expect(getSelectionEdgeProxyY(400, rect)).toBe(406);
});

test("selection edge proxy yields to xterm once the pointer is outside", () => {
  const rect = { top: 100, bottom: 400 };
  expect(getSelectionEdgeProxyY(99, rect)).toBeNull();
  expect(getSelectionEdgeProxyY(401, rect)).toBeNull();
});
