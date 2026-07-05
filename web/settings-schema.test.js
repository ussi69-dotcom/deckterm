const { test, expect, describe } = require("bun:test");
const {
  SETTINGS_SCHEMA,
  searchSchema,
  categoriesOf,
  defaultsOf,
  coerceValue,
} = require("./settings-schema.js");

const byKey = (key) => SETTINGS_SCHEMA.find((d) => d.key === key);

describe("SETTINGS_SCHEMA shape", () => {
  test("every entry has the required declarative fields", () => {
    const types = new Set(["toggle", "number", "select", "text"]);
    for (const def of SETTINGS_SCHEMA) {
      expect(typeof def.key).toBe("string");
      expect(def.key.length).toBeGreaterThan(0);
      expect(typeof def.category).toBe("string");
      expect(typeof def.label).toBe("string");
      expect(typeof def.description).toBe("string");
      expect(types.has(def.type)).toBe(true);
      expect(def).toHaveProperty("default");
      expect(typeof def.searchText).toBe("string");
      if (def.type === "select") {
        expect(Array.isArray(def.options)).toBe(true);
        expect(def.options.length).toBeGreaterThan(0);
        // default must be a valid option value
        const values = def.options.map((o) =>
          typeof o === "object" ? o.value : o,
        );
        expect(values).toContain(def.default);
      }
      if (def.type === "number") {
        expect(typeof def.min).toBe("number");
        expect(typeof def.max).toBe("number");
        expect(def.min).toBeLessThanOrEqual(def.max);
      }
    }
  });

  test("keys are unique", () => {
    const keys = SETTINGS_SCHEMA.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("includes the 6 migrated canonical keys", () => {
    for (const key of [
      "terminal.fontSize",
      "terminal.wrapLines",
      "terminal.autoCopy",
      "terminal.extraKeysVisible",
      "tasks.view",
      "files.defaultCwd",
    ]) {
      expect(byKey(key)).toBeDefined();
    }
  });

  test("includes the design's new settings", () => {
    expect(byKey("git.diffMode")).toBeDefined();
    expect(byKey("terminal.scrollbackLimit")).toBeDefined();
    expect(byKey("files.defaultCwd")).toBeDefined();
    expect(byKey("windows.snapBehavior")).toBeDefined();
    expect(byKey("workspace.reconnectBehavior")).toBeDefined();
    expect(byKey("git.autoFetchInterval")).toBeDefined();
    expect(byKey("workspace.confirmDestructive")).toBeDefined();
    expect(byKey("appearance.accent")).toBeDefined();
  });

  test("editor.autosave defaults to off with a 1s/5s select", () => {
    const def = byKey("editor.autosave");
    expect(def).toBeDefined();
    expect(def.type).toBe("select");
    expect(def.default).toBe("off");
    const values = def.options.map((o) =>
      typeof o === "object" ? o.value : o,
    );
    expect(values).toEqual(["off", "1000", "5000"]);
  });
});

describe("categoriesOf", () => {
  test("returns ordered unique categories in the canonical order", () => {
    expect(categoriesOf(SETTINGS_SCHEMA)).toEqual([
      "Appearance",
      "Terminal",
      "Windows & Layout",
      "Git",
      "Files",
      "Tasks",
      "Advanced",
    ]);
  });

  test("dedupes while preserving first-seen order", () => {
    const schema = [
      { category: "Terminal" },
      { category: "Git" },
      { category: "Terminal" },
      { category: "Appearance" },
    ];
    expect(categoriesOf(schema)).toEqual(["Terminal", "Git", "Appearance"]);
  });
});

describe("defaultsOf", () => {
  test("maps every key to its default", () => {
    const defaults = defaultsOf(SETTINGS_SCHEMA);
    expect(Object.keys(defaults).length).toBe(SETTINGS_SCHEMA.length);
    for (const def of SETTINGS_SCHEMA) {
      expect(defaults[def.key]).toEqual(def.default);
    }
  });
});

describe("searchSchema", () => {
  test("empty / whitespace query returns all entries", () => {
    expect(searchSchema(SETTINGS_SCHEMA, "")).toEqual(SETTINGS_SCHEMA);
    expect(searchSchema(SETTINGS_SCHEMA, "   ")).toEqual(SETTINGS_SCHEMA);
    expect(searchSchema(SETTINGS_SCHEMA, undefined)).toEqual(SETTINGS_SCHEMA);
  });

  test("matches on label case-insensitively", () => {
    const results = searchSchema(SETTINGS_SCHEMA, "FONT");
    expect(results.some((d) => d.key === "terminal.fontSize")).toBe(true);
  });

  test("matches on category", () => {
    const results = searchSchema(SETTINGS_SCHEMA, "git");
    expect(results.length).toBeGreaterThan(0);
    expect(
      results.every((d) =>
        /git/i.test(
          `${d.category} ${d.label} ${d.description} ${d.searchText}`,
        ),
      ),
    ).toBe(true);
  });

  test("matches on searchText synonyms", () => {
    const schema = [
      {
        key: "a.b",
        category: "Terminal",
        label: "Wrap lines",
        description: "Soft wrap",
        type: "toggle",
        default: true,
        searchText: "reflow truncate columns",
      },
    ];
    expect(searchSchema(schema, "reflow")).toHaveLength(1);
  });

  test("ranks a label match above a description-only match", () => {
    const schema = [
      {
        key: "desc.only",
        category: "Misc",
        label: "Zebra",
        description: "contains alpha keyword",
        type: "text",
        default: "",
        searchText: "",
      },
      {
        key: "label.match",
        category: "Misc",
        label: "Alpha widget",
        description: "nothing",
        type: "text",
        default: "",
        searchText: "",
      },
    ];
    const results = searchSchema(schema, "alpha");
    expect(results).toHaveLength(2);
    expect(results[0].key).toBe("label.match");
  });

  test("no match returns empty", () => {
    expect(searchSchema(SETTINGS_SCHEMA, "zzzznotathing")).toEqual([]);
  });
});

describe("coerceValue", () => {
  test("number coerces and clamps to [min, max]", () => {
    const def = { type: "number", default: 14, min: 8, max: 32 };
    expect(coerceValue(def, "20")).toBe(20);
    expect(coerceValue(def, 100)).toBe(32);
    expect(coerceValue(def, 2)).toBe(8);
    expect(coerceValue(def, 16)).toBe(16);
  });

  test("number falls back to default on non-numeric", () => {
    const def = { type: "number", default: 14, min: 8, max: 32 };
    expect(coerceValue(def, "abc")).toBe(14);
    expect(coerceValue(def, null)).toBe(14);
    expect(coerceValue(def, NaN)).toBe(14);
  });

  test("select validates against options, invalid → default", () => {
    const def = {
      type: "select",
      default: "split",
      options: [
        { value: "split", label: "Split" },
        { value: "inline", label: "Inline" },
      ],
    };
    expect(coerceValue(def, "inline")).toBe("inline");
    expect(coerceValue(def, "bogus")).toBe("split");
  });

  test("select supports plain string options", () => {
    const def = { type: "select", default: "a", options: ["a", "b", "c"] };
    expect(coerceValue(def, "c")).toBe("c");
    expect(coerceValue(def, "z")).toBe("a");
  });

  test("toggle coerces to boolean", () => {
    const def = { type: "toggle", default: false };
    expect(coerceValue(def, true)).toBe(true);
    expect(coerceValue(def, false)).toBe(false);
    expect(coerceValue(def, "true")).toBe(true);
    expect(coerceValue(def, "false")).toBe(false);
    expect(coerceValue(def, 0)).toBe(false);
    expect(coerceValue(def, 1)).toBe(true);
  });

  test("text coerces to string", () => {
    const def = { type: "text", default: "" };
    expect(coerceValue(def, "hello")).toBe("hello");
    expect(coerceValue(def, 42)).toBe("42");
    expect(coerceValue(def, null)).toBe("");
    expect(coerceValue(def, undefined)).toBe("");
  });

  test("real schema entries coerce sanely", () => {
    expect(coerceValue(byKey("terminal.fontSize"), "9999")).toBe(
      byKey("terminal.fontSize").max,
    );
    expect(coerceValue(byKey("terminal.wrapLines"), "true")).toBe(true);
    expect(coerceValue(byKey("git.diffMode"), "nope")).toBe(
      byKey("git.diffMode").default,
    );
  });
});
