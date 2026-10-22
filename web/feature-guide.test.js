import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_INTRO_LENGTH,
  ACTION_DESCRIPTIONS,
  PALETTE_DESCRIPTIONS,
  PANEL_INTROS,
  LAUNCHER_TIPS,
  WHATS_WHAT,
  describeAction,
  describePaletteAction,
  withPaletteDescriptions,
  shortcutLabelForAction,
  formatTooltip,
  tooltipForAction,
  buildWhatsWhat,
  planLauncherTips,
} from "./feature-guide";
import { KEYBOARD_SHORTCUTS } from "./keyboard-shortcuts";

const appSource = readFileSync(new URL("./app.js", import.meta.url), "utf8");

// The toolbar / tools-sheet action ids exactly as app.js declares them.
function toolbarActionIds() {
  const start = appSource.indexOf("const ACTION_BUTTON_CONFIG = Object.freeze({");
  const end = appSource.indexOf("const FIXED_TOOLS_SHEET_ACTION_IDS");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = appSource.slice(start, end);
  const ids = [];
  for (const match of block.matchAll(
    /^ {2}(?:"([\w-]+)"|([A-Za-z][\w]*)): Object\.freeze\(\{/gm,
  )) {
    ids.push(match[1] || match[2]);
  }
  return ids;
}

// The built-in command-palette actions (id + title) from registerCommandPaletteActions.
function staticPaletteActionIds() {
  const start = appSource.indexOf("registerCommandPaletteActions() {");
  const from = appSource.indexOf("const actions = [", start);
  const to = appSource.indexOf("\n    ];", from);
  expect(from).toBeGreaterThan(start);
  const block = appSource.slice(from, to);
  return [...block.matchAll(/^ {8}id: "([\w-]+)",/gm)].map((m) => m[1]);
}

test("the parsers actually find the action lists in app.js", () => {
  expect(toolbarActionIds()).toContain("compose");
  expect(toolbarActionIds().length).toBeGreaterThan(15);
  expect(staticPaletteActionIds()).toContain("open-tasks");
  expect(staticPaletteActionIds().length).toBeGreaterThan(15);
});

test("every toolbar / tools-sheet action has a plain one-line description", () => {
  for (const id of toolbarActionIds()) {
    const text = describeAction(id);
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
    expect(text).not.toMatch(/\n/);
    expect(text.trim()).toBe(text);
  }
});

test("app.js wires each toolbar action to the shared descriptions", () => {
  const start = appSource.indexOf("const ACTION_BUTTON_CONFIG = Object.freeze({");
  const end = appSource.indexOf("const FIXED_TOOLS_SHEET_ACTION_IDS");
  const block = appSource.slice(start, end);
  const described = [...block.matchAll(/description: describeFeature\("([\w-]+)"\)/g)];
  expect(described.map((m) => m[1]).sort()).toEqual(
    toolbarActionIds().sort(),
  );
});

test("every built-in palette action has a description", () => {
  for (const id of staticPaletteActionIds()) {
    const text = PALETTE_DESCRIPTIONS[id];
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
  }
});

test("all descriptions, intros and tips respect their length limits", () => {
  for (const text of Object.values(ACTION_DESCRIPTIONS)) {
    expect(text.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
  }
  for (const text of Object.values(PALETTE_DESCRIPTIONS)) {
    expect(text.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
  }
  for (const text of Object.values(PANEL_INTROS)) {
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(MAX_INTRO_LENGTH);
  }
  for (const tip of LAUNCHER_TIPS) {
    expect(tip.text.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
  }
});

test("palette rows describe the same feature with the same words as the toolbar", () => {
  expect(PALETTE_DESCRIPTIONS["open-tasks"]).toBe(ACTION_DESCRIPTIONS.tasks);
  expect(PALETTE_DESCRIPTIONS["compose-message"]).toBe(
    ACTION_DESCRIPTIONS.compose,
  );
  expect(PALETTE_DESCRIPTIONS["open-git"]).toBe(ACTION_DESCRIPTIONS.git);
  expect(describePaletteAction("open-tasks")).toBe(ACTION_DESCRIPTIONS.tasks);
  expect(describePaletteAction("does-not-exist")).toBe("");
});

test("withPaletteDescriptions adds a description without overriding an own one", () => {
  const out = withPaletteDescriptions([
    { id: "open-tasks", title: "Open Tasks" },
    { id: "open-git", title: "Open Git", description: "custom" },
    { id: "go-to-directory:/x", title: "Go" },
  ]);
  expect(out[0].description).toBe(ACTION_DESCRIPTIONS.tasks);
  expect(out[1].description).toBe("custom");
  expect("description" in out[2]).toBe(false);
  expect(withPaletteDescriptions(null)).toEqual([]);
});

test("formatTooltip: label, description and shortcut", () => {
  expect(
    formatTooltip({
      label: "Palette",
      description: "Search every action",
      shortcut: "Ctrl+Shift+P",
    }),
  ).toBe("Palette — Search every action (Ctrl+Shift+P)");
});

test("formatTooltip: without a shortcut or without a description", () => {
  expect(formatTooltip({ label: "Tasks", description: "Give an agent a job" })).toBe(
    "Tasks — Give an agent a job",
  );
  expect(formatTooltip({ label: "Tasks", shortcut: "Ctrl+T" })).toBe(
    "Tasks (Ctrl+T)",
  );
  expect(formatTooltip({ label: "Tasks" })).toBe("Tasks");
  expect(formatTooltip({})).toBe("");
});

test("tooltipForAction reads the shortcut registry", () => {
  const palette = tooltipForAction("palette", "Palette", KEYBOARD_SHORTCUTS);
  expect(palette).toBe(
    `Palette — ${ACTION_DESCRIPTIONS.palette} (Ctrl+Shift+P)`,
  );
  const fullscreen = tooltipForAction("fullscreen", "Fullscreen", KEYBOARD_SHORTCUTS);
  expect(fullscreen.endsWith("(F11)")).toBe(true);
  // No shortcut registered for Tasks: no empty parentheses.
  const tasks = tooltipForAction("tasks", "Tasks", KEYBOARD_SHORTCUTS);
  expect(tasks).toBe(`Tasks — ${ACTION_DESCRIPTIONS.tasks}`);
  // Unknown action: just the label.
  expect(tooltipForAction("nope", "Nope", KEYBOARD_SHORTCUTS)).toBe("Nope");
});

test("shortcutLabelForAction maps toolbar ids to registry combos", () => {
  expect(shortcutLabelForAction("palette", KEYBOARD_SHORTCUTS)).toBe(
    "Ctrl+Shift+P",
  );
  expect(shortcutLabelForAction("help", KEYBOARD_SHORTCUTS)).toBe(
    "Ctrl+Shift+?",
  );
  expect(shortcutLabelForAction("compose", KEYBOARD_SHORTCUTS)).toBe("");
  expect(shortcutLabelForAction("palette", [])).toBe("");
});

test("What's what is generated from the shared descriptions", () => {
  const rows = buildWhatsWhat(KEYBOARD_SHORTCUTS);
  const titles = rows.map((row) => row.title);
  for (const wanted of [
    "Command palette",
    "Compose",
    "Tasks",
    "Sessions",
    "Files",
    "Git",
    "Search",
    "Quick replies",
    "Attention dot",
  ]) {
    expect(titles).toContain(wanted);
  }
  for (const row of rows) {
    expect(row.description).toBe(describeAction(row.featureId));
    expect(row.description.length).toBeGreaterThan(0);
  }
  const palette = rows.find((row) => row.featureId === "palette");
  expect(palette.shortcut).toBe("Ctrl+Shift+P");
  expect(palette.keys).toEqual(["Ctrl", "Shift", "P"]);
  const compose = rows.find((row) => row.featureId === "compose");
  expect(compose.description).toBe(ACTION_DESCRIPTIONS.compose);
  expect(compose.shortcut).toBe("");
  expect(compose.keys).toEqual([]);
  // Every What's what entry points at a described feature.
  for (const entry of WHATS_WHAT) {
    expect(describeAction(entry.featureId).length).toBeGreaterThan(0);
  }
});

test("planLauncherTips resolves exactly three tips with their shortcuts", () => {
  const tips = planLauncherTips(LAUNCHER_TIPS, KEYBOARD_SHORTCUTS);
  expect(tips.map((tip) => tip.title)).toEqual([
    "Command palette",
    "Compose",
    "Tasks",
  ]);
  expect(tips[0].keys).toEqual(["Ctrl", "Shift", "P"]);
  expect(tips[1].keys).toEqual([]);
  for (const tip of tips) expect(tip.text.length).toBeGreaterThan(0);
  expect(planLauncherTips(null, null)).toEqual([]);
});

test("the Agents overview has its lines, shortcuts and Help entries", () => {
  for (const id of ["agents", "next-agent", "agents-chip"]) {
    const text = describeAction(id);
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
  }
  expect(PALETTE_DESCRIPTIONS.agents).toBe(ACTION_DESCRIPTIONS.agents);
  expect(PALETTE_DESCRIPTIONS["next-agent"]).toBe(
    ACTION_DESCRIPTIONS["next-agent"],
  );
  expect(shortcutLabelForAction("agents", KEYBOARD_SHORTCUTS)).toBe(
    "Ctrl+Shift+L",
  );
  expect(shortcutLabelForAction("next-agent", KEYBOARD_SHORTCUTS)).toBe(
    "Ctrl+Shift+X",
  );
  const titles = buildWhatsWhat(KEYBOARD_SHORTCUTS).map((row) => row.title);
  expect(titles).toContain("Agents panel");
  expect(titles).toContain("Next agent");
});
