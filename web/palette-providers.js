// Pure logic for the command-palette prefix modes:
//   "@" — fuzzy session switch (entries from the server session catalog),
//   "$" — saved commands (localStorage-backed, run in the active terminal).
// DOM wiring and the actual run side-effects live in app.js; the providers
// there pass the post-prefix text through these filters and decorate the
// results into ActionRegistry actions.

function parsePrefixQuery(query, prefix) {
  const raw = typeof query === "string" ? query : "";
  if (!raw.startsWith(prefix)) return null;
  return raw.slice(prefix.length).trim();
}

function normalize(value) {
  return String(value || "").toLowerCase();
}

// Open-here-able catalog entries, open tabs first (focus), then live attach
// targets, then ended sessions. Text matches cwd or id, case-insensitive.
function filterSessions({ sessions, text, isLocallyOpen, planAction }) {
  const needle = normalize(text);
  const kindRank = { focus: 0, attach: 1, "open-here": 2 };

  return (Array.isArray(sessions) ? sessions : [])
    .filter((session) => {
      if (!needle) return true;
      return (
        normalize(session.cwd).includes(needle) ||
        normalize(session.id).includes(needle)
      );
    })
    .map((session) => ({
      session,
      plan: planAction(session, { isLocallyOpen: isLocallyOpen(session.id) }),
    }))
    .sort(
      (a, b) =>
        (kindRank[a.plan.kind] ?? 9) - (kindRank[b.plan.kind] ?? 9) ||
        normalize(a.session.cwd).localeCompare(normalize(b.session.cwd)),
    );
}

const SAVED_COMMANDS_KEY = "deckterm-saved-commands";

function createSavedCommandsStore(storage) {
  function read() {
    try {
      const raw = storage.getItem(SAVED_COMMANDS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (entry) =>
          entry &&
          typeof entry.name === "string" &&
          typeof entry.command === "string",
      );
    } catch {
      return [];
    }
  }

  function write(commands) {
    storage.setItem(SAVED_COMMANDS_KEY, JSON.stringify(commands));
  }

  return {
    list() {
      return read();
    },
    save(name, command) {
      const trimmedName = String(name || "").trim();
      const trimmedCommand = String(command || "").trim();
      if (!trimmedName || !trimmedCommand) return false;
      const commands = read().filter((entry) => entry.name !== trimmedName);
      commands.push({ name: trimmedName, command: trimmedCommand });
      commands.sort((a, b) => a.name.localeCompare(b.name));
      write(commands);
      return true;
    },
    remove(name) {
      write(read().filter((entry) => entry.name !== name));
    },
  };
}

function filterSavedCommands(commands, text) {
  const needle = normalize(text);
  return (Array.isArray(commands) ? commands : []).filter((entry) => {
    if (!needle) return true;
    return (
      normalize(entry.name).includes(needle) ||
      normalize(entry.command).includes(needle)
    );
  });
}

const PaletteProviders = {
  parsePrefixQuery,
  filterSessions,
  createSavedCommandsStore,
  filterSavedCommands,
};

if (typeof window !== "undefined") {
  window.PaletteProviders = PaletteProviders;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = PaletteProviders;
}

if (typeof exports !== "undefined") {
  exports.parsePrefixQuery = parsePrefixQuery;
  exports.filterSessions = filterSessions;
  exports.createSavedCommandsStore = createSavedCommandsStore;
  exports.filterSavedCommands = filterSavedCommands;
}
