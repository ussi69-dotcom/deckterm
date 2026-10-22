import { expect, test } from "bun:test";
import {
  parseTmuxScrollState,
  TMUX_SCROLL_STATE_FORMAT,
} from "./tmux-scroll-state";

// Field order: pane_in_mode | pane_mode | scroll_position |
// copy_position_limit | history_size | pane_height | alternate_on |
// mouse_any_flag | mouse_sgr_flag | keypad_cursor_flag | pane_unseen_changes

test("format uses a printable separator, never TAB", () => {
  expect(TMUX_SCROLL_STATE_FORMAT).not.toContain("\t");
  expect(TMUX_SCROLL_STATE_FORMAT.split("|")).toHaveLength(11);
  // The broker refuses `#(` (runs a shell) in any format.
  expect(TMUX_SCROLL_STATE_FORMAT).not.toContain("#(");
});

test("tmux 3.8 line in copy-mode uses the frozen copy_position_limit", () => {
  expect(parseTmuxScrollState("1|copy-mode|40|191|222|10|0|0|0|0|1\n")).toEqual(
    {
      inMode: true,
      position: 40,
      total: 191,
      rows: 10,
      altScreen: false,
      mouseApp: false,
      mouseSgr: false,
      appCursor: false,
      unseen: true,
    },
  );
});

test("tmux 3.4 line (empty copy_position_limit) falls back to history_size", () => {
  expect(
    parseTmuxScrollState("1|copy-mode|6||191|10|0|0|0|0|0\n"),
  ).toMatchObject({ inMode: true, position: 6, total: 191, rows: 10 });
});

test("not in copy-mode: position 0 and the live history size", () => {
  expect(parseTmuxScrollState("0||||191|24|0|0|0|0|0\n")).toEqual({
    inMode: false,
    position: 0,
    total: 191,
    rows: 24,
    altScreen: false,
    mouseApp: false,
    mouseSgr: false,
    appCursor: false,
    unseen: false,
  });
});

test("alternate screen with mouse reporting and application cursor keys", () => {
  expect(parseTmuxScrollState("0||||0|30|1|1|1|1|0")).toMatchObject({
    inMode: false,
    altScreen: true,
    mouseApp: true,
    mouseSgr: true,
    appCursor: true,
  });
});

test("another tmux mode is not copy-mode", () => {
  expect(parseTmuxScrollState("1|view-mode|3||50|10|0|0|0|0|0")).toMatchObject({
    inMode: false,
    position: 0,
  });
});

test("position is clamped to 0..total", () => {
  expect(
    parseTmuxScrollState("1|copy-mode|99999|111|140|10|0|0|0|0|0")?.position,
  ).toBe(111);
  expect(
    parseTmuxScrollState("1|copy-mode||111|140|10|0|0|0|0|0")?.position,
  ).toBe(0);
});

test("malformed output is null", () => {
  for (const bad of [
    "",
    "\n",
    "garbage",
    // TAB-separated (or `_` from an unset LANG) never parses.
    "1\tcopy-mode\t6\t\t191\t10\t0\t0\t0\t0\t0",
    "1_copy-mode_6__191_10_0_0_0_0_0",
    // Field count off by one either way.
    "1|copy-mode|6||191|10|0|0|0|0",
    "1|copy-mode|6||191|10|0|0|0|0|0|0",
    // Non-numeric / negative numbers, unknown flag values.
    "1|copy-mode|-3||191|10|0|0|0|0|0",
    "1|copy-mode|6||lots|10|0|0|0|0|0",
    "1|copy-mode|6||191|0|0|0|0|0|0",
    "1|copy-mode|6||191|10|yes|0|0|0|0",
    // Two lines (two panes or noise).
    "0||||191|24|0|0|0|0|0\n0||||191|24|0|0|0|0|0\n",
  ]) {
    expect(parseTmuxScrollState(bad)).toBeNull();
  }
  expect(parseTmuxScrollState(undefined as unknown as string)).toBeNull();
});
