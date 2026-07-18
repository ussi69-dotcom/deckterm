// Declarative settings schema registry — the single source of truth for the
// VS Code-style settings UI. It drives the rendered controls, the search index,
// the defaults map, and the canonical setting keys consumed via settingsStore.
//
// Pure & dependency-free. `coerceValue` is a UX convenience only — it is NOT a
// security boundary; any setting that touches host resources (paths, scrollback
// size, fetch intervals, reconnect timing) MUST be re-validated/clamped where it
// is applied (see the phase-4 plan, resolved decision #3).
//
// Each entry: { key, category, label, description, type, default,
//               options?, min?, max?, searchText }.
// type ∈ toggle | number | select | text.

const SETTINGS_SCHEMA = [
  // ── Appearance ──────────────────────────────────────────────────────────
  {
    key: "appearance.accent",
    category: "Appearance",
    label: "Accent color",
    description: "Highlight color used across the workspace UI.",
    type: "select",
    default: "blue",
    options: [
      { value: "blue", label: "Blue" },
      { value: "green", label: "Green" },
      { value: "purple", label: "Purple" },
      { value: "orange", label: "Orange" },
      { value: "pink", label: "Pink" },
    ],
    searchText: "theme accent color highlight brand tint",
  },

  // ── Terminal ────────────────────────────────────────────────────────────
  {
    key: "terminal.fontSize",
    category: "Terminal",
    label: "Font size",
    description: "Terminal font size in pixels.",
    type: "number",
    default: 14,
    min: 8,
    max: 32,
    searchText: "font size text zoom pixels terminal",
  },
  {
    key: "terminal.wrapLines",
    category: "Terminal",
    label: "Wrap long lines",
    description: "Soft-wrap output that exceeds the terminal width.",
    type: "toggle",
    default: true,
    searchText: "wrap reflow soft wrap long lines columns truncate",
  },
  {
    key: "terminal.autoCopy",
    category: "Terminal",
    label: "Copy on select",
    description: "Automatically copy selected text to the clipboard.",
    type: "toggle",
    default: false,
    searchText: "auto copy clipboard select selection paste",
  },
  {
    key: "terminal.extraKeysVisible",
    category: "Terminal",
    label: "Show extra keys bar",
    description: "Display the mobile extra-keys toolbar (Esc, Tab, arrows, …).",
    type: "toggle",
    default: false,
    searchText: "extra keys bar mobile toolbar esc tab arrows ctrl",
  },
  {
    key: "terminal.renderer",
    category: "Terminal",
    label: "Renderer",
    description:
      "GPU-accelerated WebGL rendering when supported, or the built-in renderer.",
    type: "select",
    default: "auto",
    options: [
      { value: "auto", label: "Auto (GPU when available)" },
      { value: "default", label: "Default" },
    ],
    searchText:
      "renderer webgl gpu acceleration canvas fallback performance rendering",
  },
  {
    key: "terminal.scrollbackLimit",
    category: "Terminal",
    label: "Scrollback limit",
    description: "Maximum number of scrollback lines retained per terminal.",
    type: "number",
    default: 2000,
    min: 200,
    max: 50000,
    searchText: "scrollback history buffer lines limit memory",
  },

  // ── Windows & Layout ──────────────────────────────────────────────────────
  {
    key: "windows.snapBehavior",
    category: "Windows & Layout",
    label: "Window snapping",
    description: "How surface windows snap to edges and each other.",
    type: "select",
    default: "edges",
    options: [
      { value: "off", label: "Off" },
      { value: "edges", label: "Screen edges" },
      { value: "grid", label: "Grid" },
    ],
    searchText: "window snap snapping edges grid layout tiling align",
  },

  // ── Git ───────────────────────────────────────────────────────────────────
  {
    key: "git.diffMode",
    category: "Git",
    label: "Default diff mode",
    description: "Layout used when opening a diff in the git panel.",
    type: "select",
    default: "split",
    options: [
      { value: "split", label: "Side by side" },
      { value: "inline", label: "Inline" },
    ],
    searchText: "diff mode layout split inline side by side merge compare",
  },
  {
    key: "git.autoFetchInterval",
    category: "Git",
    label: "Auto-fetch interval",
    description:
      "How often to fetch from the remote in seconds (0 disables auto-fetch).",
    type: "number",
    default: 0,
    min: 0,
    max: 3600,
    searchText: "git auto fetch interval remote poll refresh seconds",
  },

  // ── Files ───────────────────────────────────────────────────────────────
  {
    key: "files.defaultCwd",
    category: "Files",
    label: "Default working directory",
    description:
      "Starting directory for the file explorer and new terminals (must be inside an allowed root).",
    type: "text",
    default: "",
    searchText:
      "default cwd working directory path explorer home folder web dir",
  },
  {
    key: "editor.autosave",
    category: "Files",
    label: "Autosave",
    description:
      "Automatically save an open file after you stop typing (off disables autosave).",
    type: "select",
    default: "off",
    options: [
      { value: "off", label: "Off" },
      { value: "1000", label: "After 1 second" },
      { value: "5000", label: "After 5 seconds" },
    ],
    searchText: "autosave auto save editor debounce interval delay file tab",
  },

  // ── Tasks ───────────────────────────────────────────────────────────────
  {
    key: "tasks.view",
    category: "Tasks",
    label: "Default task view",
    description: "Layout used when opening the task runner panel.",
    type: "select",
    default: "list",
    options: [
      { value: "list", label: "List" },
      { value: "board", label: "Board" },
    ],
    searchText: "tasks view list board kanban runner layout default",
  },

  // ── Notifications ───────────────────────────────────────────────────────
  {
    key: "notifications.soundMode",
    category: "Notifications",
    label: "Completion sounds",
    description:
      "Play a sound when a terminal command or agent session finishes.",
    type: "select",
    default: "unfocused",
    options: [
      { value: "always", label: "Always" },
      { value: "unfocused", label: "Only when DeckTerm is unfocused" },
      { value: "off", label: "Off" },
    ],
    searchText:
      "notification sound audio bell alert completion finished focus background off",
  },
  {
    key: "notifications.sound",
    category: "Notifications",
    label: "Completion sound",
    description: "Sound played for a completed terminal session.",
    type: "select",
    default: "chime",
    options: [
      { value: "chime", label: "Chime" },
      { value: "ping", label: "Ping" },
      { value: "bell", label: "Bell" },
      { value: "pop", label: "Pop" },
    ],
    searchText: "notification sound audio tone chime ping bell pop preview",
  },

  // ── Advanced ──────────────────────────────────────────────────────────────
  {
    key: "workspace.reconnectBehavior",
    category: "Advanced",
    label: "Reconnect behavior",
    description: "What to do when a terminal WebSocket connection drops.",
    type: "select",
    default: "auto",
    options: [
      { value: "auto", label: "Reconnect automatically" },
      { value: "prompt", label: "Ask before reconnecting" },
      { value: "manual", label: "Manual only" },
    ],
    searchText:
      "reconnect behavior websocket connection drop retry backoff network",
  },
  {
    key: "workspace.confirmDestructive",
    category: "Advanced",
    label: "Confirm destructive actions",
    description:
      "Ask for confirmation before discarding changes, killing sessions, or other destructive operations.",
    type: "toggle",
    default: true,
    searchText:
      "confirm destructive discard delete kill prompt warning dangerous",
  },
];

// Returns the option *values* for a select definition, supporting both plain
// strings and { value, label } objects.
function optionValues(def) {
  if (!def || !Array.isArray(def.options)) return [];
  return def.options.map((o) => (o && typeof o === "object" ? o.value : o));
}

// Ordered, de-duplicated list of categories as they first appear in the schema.
function categoriesOf(schema) {
  const seen = new Set();
  const out = [];
  for (const def of schema || []) {
    if (!def || typeof def.category !== "string") continue;
    if (seen.has(def.category)) continue;
    seen.add(def.category);
    out.push(def.category);
  }
  return out;
}

// { key: default } for every entry.
function defaultsOf(schema) {
  const out = {};
  for (const def of schema || []) {
    if (def && typeof def.key === "string") out[def.key] = def.default;
  }
  return out;
}

// Case-insensitive search across label/description/searchText/category.
// Returns a filtered + ranked copy (label matches rank highest, then
// category, then description/searchText). Empty/whitespace query → all entries
// unchanged (same array reference for the empty case so callers can shortcut).
function searchSchema(schema, query) {
  const list = schema || [];
  const q = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (!q) return list;

  const scored = [];
  for (const def of list) {
    if (!def) continue;
    const label = String(def.label || "").toLowerCase();
    const category = String(def.category || "").toLowerCase();
    const description = String(def.description || "").toLowerCase();
    const searchText = String(def.searchText || "").toLowerCase();

    let score = 0;
    if (label.includes(q)) score += 100;
    if (category.includes(q)) score += 40;
    if (description.includes(q)) score += 20;
    if (searchText.includes(q)) score += 10;
    // Bonus for a prefix/exact label hit so the most relevant rises to the top.
    if (label === q) score += 50;
    else if (label.startsWith(q)) score += 15;

    if (score > 0) scored.push({ def, score });
  }

  // Stable sort by descending score; ties keep original order.
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.def);
}

// Coerce a raw value into the type declared by the definition. UX-only.
function coerceValue(def, raw) {
  if (!def || typeof def !== "object") return raw;
  switch (def.type) {
    case "toggle": {
      if (typeof raw === "string") {
        const v = raw.trim().toLowerCase();
        if (v === "false" || v === "0" || v === "" || v === "no") return false;
        return true;
      }
      return Boolean(raw);
    }
    case "number": {
      if (raw === null || raw === undefined || raw === "") return def.default;
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n)) return def.default;
      let out = n;
      if (typeof def.min === "number" && out < def.min) out = def.min;
      if (typeof def.max === "number" && out > def.max) out = def.max;
      return out;
    }
    case "select": {
      const values = optionValues(def);
      return values.includes(raw) ? raw : def.default;
    }
    case "text":
    default: {
      if (raw === null || raw === undefined)
        return def.type === "text" ? "" : raw;
      return String(raw);
    }
  }
}

const SettingsSchema = {
  SETTINGS_SCHEMA,
  searchSchema,
  categoriesOf,
  defaultsOf,
  coerceValue,
  optionValues,
};

if (typeof window !== "undefined") {
  window.SettingsSchema = SettingsSchema;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = SettingsSchema;
}
