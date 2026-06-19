// Pure render helpers for the VS Code-style settings window. These turn a
// declarative schema entry + a current value into a flat "control descriptor"
// the DOM layer can render without re-deriving types, and group/filter the
// schema for the sidebar + search view. No DOM dependency — covered by bun
// tests; the actual DOM wiring lives in app.js (SettingsManager).

const Schema =
  typeof require === "function"
    ? require("./settings-schema.js")
    : typeof window !== "undefined"
      ? window.SettingsSchema
      : null;

// Build a flat descriptor for one setting definition + its current stored
// value. The value is coerced through the schema so the rendered control always
// reflects a valid, typed value (UX only — not a security boundary).
function buildControlDescriptor(def, currentValue) {
  if (!def || typeof def !== "object" || typeof def.key !== "string") {
    return null;
  }
  const coerce = Schema?.coerceValue;
  const raw = currentValue === undefined ? def.default : currentValue;
  const value = coerce ? coerce(def, raw) : raw;

  const descriptor = {
    key: def.key,
    type: def.type,
    label: def.label || def.key,
    description: def.description || "",
    category: def.category || "",
    value,
  };
  if (def.type === "select") {
    descriptor.options = (def.options || []).map((o) =>
      o && typeof o === "object" ? { value: o.value, label: o.label } : o,
    );
  }
  if (typeof def.min === "number") descriptor.min = def.min;
  if (typeof def.max === "number") descriptor.max = def.max;
  return descriptor;
}

// Group schema entries into ordered category buckets (category order follows
// first appearance, matching categoriesOf). Entry order within a category is
// preserved.
function groupByCategory(schema) {
  const list = schema || [];
  const order = [];
  const buckets = new Map();
  for (const def of list) {
    if (!def || typeof def.category !== "string") continue;
    if (!buckets.has(def.category)) {
      buckets.set(def.category, []);
      order.push(def.category);
    }
    buckets.get(def.category).push(def);
  }
  return order.map((category) => ({
    category,
    entries: buckets.get(category),
  }));
}

// Produce the grouped view for a search query: filter via searchSchema, then
// group by category. Empty/whitespace query returns every entry grouped;
// non-matching query returns an empty list. Filtered groups never contain
// empty entry arrays.
function filterSchemaView(schema, query) {
  const search = Schema?.searchSchema;
  const filtered = search ? search(schema, query) : schema || [];
  return groupByCategory(filtered);
}

const SettingsUI = {
  buildControlDescriptor,
  groupByCategory,
  filterSchemaView,
};

if (typeof window !== "undefined") {
  window.SettingsUI = SettingsUI;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = SettingsUI;
}
