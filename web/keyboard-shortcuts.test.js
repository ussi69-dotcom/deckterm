import { test, expect } from "bun:test";
import {
  KEYBOARD_SHORTCUTS,
  SHORTCUT_SECTIONS,
  buildHelpSections,
  listedCombos,
  shortcutForAction,
  isHelpShortcut,
  formatCombo,
  compactCombos,
} from "./keyboard-shortcuts";

test("no key combination is listed twice", () => {
  const combos = listedCombos();
  expect(new Set(combos).size).toBe(combos.length);
});

test("every shortcut has an id, a section, a label and keys or a gesture", () => {
  const ids = new Set();
  for (const shortcut of KEYBOARD_SHORTCUTS) {
    expect(typeof shortcut.id).toBe("string");
    expect(ids.has(shortcut.id)).toBe(false);
    ids.add(shortcut.id);
    expect(SHORTCUT_SECTIONS).toContain(shortcut.section);
    expect(shortcut.label.length).toBeGreaterThan(0);
    const hasKeys = Array.isArray(shortcut.keys) && shortcut.keys.length > 0;
    expect(hasKeys || Boolean(shortcut.gesture)).toBe(true);
  }
});

test("the quick-open shortcut is listed and the search keys are unambiguous", () => {
  const combos = listedCombos();
  expect(combos).toContain("Ctrl+P");
  expect(combos).toContain("Ctrl+Shift+P");
  // Scrollback search is documented as Ctrl+Shift+F only (plain Ctrl+F goes to
  // the shell while a terminal has focus).
  expect(combos).toContain("Ctrl+Shift+F");
  expect(combos).not.toContain("Ctrl+F");
});

test("F1 is not presented as a terminal-wide help key", () => {
  const help = KEYBOARD_SHORTCUTS.find((s) => s.id === "help");
  expect(help.keys.map(formatCombo)).toEqual(["Ctrl+Shift+?"]);
  expect(help.note).toMatch(/F1/);
  expect(help.note).toMatch(/outside the terminal/);
  expect(listedCombos()).not.toContain("F1");
});

test("keys that xterm turns into shell input are marked outside-terminal", () => {
  const byCombo = new Map(
    KEYBOARD_SHORTCUTS.flatMap((s) =>
      (s.keys || []).map((combo) => [formatCombo(combo), s]),
    ),
  );
  for (const combo of ["Ctrl+P", "Ctrl+G", "Ctrl+Z", "F11", "Alt+Shift+←"]) {
    expect(byCombo.get(combo)?.scope).toBe("outside-terminal");
  }
  for (const combo of ["Ctrl+N", "Ctrl+W", "Ctrl+Tab", "Ctrl+1–9"]) {
    expect(byCombo.get(combo)?.scope).toBe("app-window");
  }
  for (const combo of ["Ctrl+Shift+P", "Ctrl+Shift+F", "Ctrl+Shift+D"]) {
    expect(byCombo.get(combo)?.scope).toBeUndefined();
  }
});

test("buildHelpSections keeps the section order and drops empty sections", () => {
  const sections = buildHelpSections();
  expect(sections.map((s) => s.title)).toEqual(SHORTCUT_SECTIONS);
  const general = sections[0];
  expect(general.rows[0]).toMatchObject({
    id: "command-palette",
    combos: [["Ctrl", "Shift", "P"]],
    scopeLabel: "",
  });
  const quickOpen = general.rows.find((r) => r.id === "quick-open");
  expect(quickOpen.scopeLabel).toBe("outside terminal");
  expect(
    buildHelpSections([
      { id: "x", section: "Mouse", gesture: "Drag", label: "Y" },
    ]).map((s) => s.title),
  ).toEqual(["Mouse"]);
  expect(buildHelpSections(null)).toEqual([]);
});

test("shortcutForAction maps palette action ids to their first combo", () => {
  expect(shortcutForAction("search-terminal")).toBe("Ctrl+Shift+F");
  expect(shortcutForAction("split-workspace")).toBe("Ctrl+Shift+D");
  expect(shortcutForAction("open-help")).toBe("Ctrl+Shift+?");
  expect(shortcutForAction("no-such-action")).toBe("");
});

test("isHelpShortcut: Ctrl+Shift+? anywhere, F1 and ? only outside the terminal", () => {
  const ev = (o) => ({
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    key: "",
    code: "",
    ...o,
  });
  const ctrlShiftSlash = ev({ ctrlKey: true, shiftKey: true, key: "?", code: "Slash" });
  expect(isHelpShortcut(ctrlShiftSlash, { inTerminal: true })).toBe(true);
  // Layouts where Shift+/ is not "?" still match on the physical key.
  expect(
    isHelpShortcut(ev({ ctrlKey: true, shiftKey: true, key: "_", code: "Slash" }), {
      inTerminal: true,
    }),
  ).toBe(true);

  expect(isHelpShortcut(ev({ key: "F1" }), { inTerminal: true })).toBe(false);
  expect(isHelpShortcut(ev({ key: "F1" }), { inTerminal: false })).toBe(true);
  expect(isHelpShortcut(ev({ key: "F1" }), { editable: true })).toBe(true);

  expect(isHelpShortcut(ev({ key: "?", shiftKey: true }), {})).toBe(true);
  expect(
    isHelpShortcut(ev({ key: "?", shiftKey: true }), { editable: true }),
  ).toBe(false);
  expect(
    isHelpShortcut(ev({ key: "?", shiftKey: true }), { inTerminal: true }),
  ).toBe(false);

  expect(isHelpShortcut(ev({ key: "p", ctrlKey: true }), {})).toBe(false);
  expect(isHelpShortcut(null)).toBe(false);
});

test("compactCombos folds alternatives that share their modifiers", () => {
  expect(
    compactCombos([
      ["Alt", "Shift", "↑"],
      ["Alt", "Shift", "↓"],
    ]),
  ).toEqual({ prefix: ["Alt", "Shift"], finals: ["↑", "↓"] });
  expect(compactCombos([["Ctrl", "+"], ["Ctrl", "-"]])).toEqual({
    prefix: ["Ctrl"],
    finals: ["+", "-"],
  });
  expect(compactCombos([["Ctrl", "+"]])).toBeNull();
  expect(compactCombos([["Ctrl", "A"], ["Alt", "B"]])).toBeNull();
  expect(compactCombos([["F1"], ["F2"]])).toBeNull();
  expect(compactCombos(null)).toBeNull();
});
