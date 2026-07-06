const { test, expect } = require("bun:test");
const {
  buildControlDescriptor,
  groupByCategory,
  filterSchemaView,
} = require("./settings-ui.js");
const { SETTINGS_SCHEMA, categoriesOf } = require("./settings-schema.js");

const toggleDef = {
  key: "terminal.wrapLines",
  category: "Terminal",
  label: "Wrap long lines",
  description: "Soft-wrap output.",
  type: "toggle",
  default: true,
};

const numberDef = {
  key: "terminal.fontSize",
  category: "Terminal",
  label: "Font size",
  description: "Terminal font size.",
  type: "number",
  default: 14,
  min: 8,
  max: 32,
};

const selectDef = {
  key: "git.diffMode",
  category: "Git",
  label: "Default diff mode",
  description: "Layout.",
  type: "select",
  default: "split",
  options: [
    { value: "split", label: "Side by side" },
    { value: "inline", label: "Inline" },
  ],
};

const textDef = {
  key: "files.defaultCwd",
  category: "Files",
  label: "Default working directory",
  description: "Starting directory.",
  type: "text",
  default: "",
};

test("buildControlDescriptor surfaces the key metadata and coerced current value", () => {
  const desc = buildControlDescriptor(numberDef, "20");
  expect(desc.key).toBe("terminal.fontSize");
  expect(desc.type).toBe("number");
  expect(desc.label).toBe("Font size");
  expect(desc.description).toBe("Terminal font size.");
  expect(desc.min).toBe(8);
  expect(desc.max).toBe(32);
  // Raw string coerced to a clamped number.
  expect(desc.value).toBe(20);
});

test("buildControlDescriptor clamps out-of-range numbers via coerceValue", () => {
  expect(buildControlDescriptor(numberDef, 9999).value).toBe(32);
  expect(buildControlDescriptor(numberDef, 1).value).toBe(8);
});

test("buildControlDescriptor falls back to the schema default when value is undefined", () => {
  expect(buildControlDescriptor(numberDef, undefined).value).toBe(14);
  expect(buildControlDescriptor(toggleDef, undefined).value).toBe(true);
  expect(buildControlDescriptor(textDef, undefined).value).toBe("");
});

test("buildControlDescriptor coerces toggles to booleans", () => {
  expect(buildControlDescriptor(toggleDef, "false").value).toBe(false);
  expect(buildControlDescriptor(toggleDef, 1).value).toBe(true);
});

// Snapshot of the full descriptor the DOM layer (app.js SettingsManager)
// renders a toggle control from — the custom track/thumb checkbox styling
// added in Track D6 binds its checked state straight off `descriptor.value`,
// so this locks the shape/typing that visual contract depends on.
test("buildControlDescriptor toggle descriptor shape matches the render contract", () => {
  const desc = buildControlDescriptor(toggleDef, true);
  expect(desc).toEqual({
    key: "terminal.wrapLines",
    type: "toggle",
    label: "Wrap long lines",
    description: "Soft-wrap output.",
    category: "Terminal",
    value: true,
  });
  expect(typeof desc.value).toBe("boolean");
});

test("buildControlDescriptor exposes select options and validates the value", () => {
  const desc = buildControlDescriptor(selectDef, "inline");
  expect(desc.value).toBe("inline");
  expect(desc.options).toEqual([
    { value: "split", label: "Side by side" },
    { value: "inline", label: "Inline" },
  ]);
  // Unknown option falls back to default.
  expect(buildControlDescriptor(selectDef, "nope").value).toBe("split");
});

test("buildControlDescriptor returns null for a missing definition", () => {
  expect(buildControlDescriptor(null, 1)).toBe(null);
  expect(buildControlDescriptor({}, 1)).toBe(null);
});

test("groupByCategory returns ordered groups matching categoriesOf", () => {
  const groups = groupByCategory(SETTINGS_SCHEMA);
  const order = groups.map((g) => g.category);
  expect(order).toEqual(categoriesOf(SETTINGS_SCHEMA));
  // Every entry belongs to its group.
  for (const group of groups) {
    expect(group.entries.length).toBeGreaterThan(0);
    for (const def of group.entries) {
      expect(def.category).toBe(group.category);
    }
  }
});

test("groupByCategory preserves entry order within a category", () => {
  const schema = [
    { key: "a", category: "X", type: "toggle", default: false },
    { key: "b", category: "Y", type: "toggle", default: false },
    { key: "c", category: "X", type: "toggle", default: false },
  ];
  const groups = groupByCategory(schema);
  expect(groups.map((g) => g.category)).toEqual(["X", "Y"]);
  expect(groups[0].entries.map((e) => e.key)).toEqual(["a", "c"]);
  expect(groups[1].entries.map((e) => e.key)).toEqual(["b"]);
});

test("filterSchemaView with an empty query returns all grouped entries", () => {
  const view = filterSchemaView(SETTINGS_SCHEMA, "");
  const total = view.reduce((n, g) => n + g.entries.length, 0);
  expect(total).toBe(SETTINGS_SCHEMA.length);
});

test("filterSchemaView with a query returns only matching entries, grouped", () => {
  const view = filterSchemaView(SETTINGS_SCHEMA, "diff");
  const keys = view.flatMap((g) => g.entries.map((e) => e.key));
  expect(keys).toContain("git.diffMode");
  expect(keys).not.toContain("terminal.fontSize");
  // No empty groups in a filtered view.
  for (const group of view) {
    expect(group.entries.length).toBeGreaterThan(0);
  }
});

test("filterSchemaView with no matches returns an empty list", () => {
  expect(filterSchemaView(SETTINGS_SCHEMA, "zzz-nomatch")).toEqual([]);
});
