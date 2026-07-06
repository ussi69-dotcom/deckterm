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

// Quick-open (Ctrl+P) fuzzy matcher — a pure subsequence scorer over a file's
// relativePath. Returns null when `query` is NOT a subsequence of `path`
// (case-insensitive); otherwise a positive-or-zero score where HIGHER is a
// better match. Bonuses (roughly VS Code / fzf style):
//   - basename bonus: characters matched after the last "/" score higher —
//     a query should prefer matching the filename over its directory.
//   - boundary bonus: a character matched right at the start of the string or
//     right after a path/word separator (/ _ - . space) scores higher — this
//     rewards matching the START of a segment over a mid-word hit.
//   - consecutive bonus: a run of consecutively-matched characters scores
//     increasingly higher than the same characters scattered apart.
// An empty (or whitespace-only) query is a neutral match — score 0 — so
// callers can use it to mean "show everything, unranked".
function fuzzyScoreFilePath(query, path) {
  const q = normalize(query).trim();
  const target = String(path || "");
  if (!q) return 0;

  const lower = target.toLowerCase();
  const lastSlash = lower.lastIndexOf("/");
  const basenameStart = lastSlash + 1; // 0 when there is no "/"
  const BOUNDARY_CHARS = new Set(["/", "-", "_", ".", " "]);
  const CONSECUTIVE_CAP = 5;

  let qi = 0;
  let score = 0;
  let consecutiveRun = 0;
  let lastMatchIndex = -1;

  for (let ti = 0; ti < lower.length && qi < q.length; ti++) {
    if (lower[ti] !== q[qi]) {
      continue;
    }

    let charScore = 1;
    if (ti >= basenameStart) charScore += 3;

    const prevChar = ti > 0 ? lower[ti - 1] : "";
    const isBoundary = ti === 0 || BOUNDARY_CHARS.has(prevChar);
    if (isBoundary) charScore += 2;

    if (lastMatchIndex === ti - 1) {
      consecutiveRun += 1;
      charScore += Math.min(consecutiveRun, CONSECUTIVE_CAP);
    } else {
      consecutiveRun = 0;
    }

    score += charScore;
    lastMatchIndex = ti;
    qi += 1;
  }

  if (qi < q.length) return null; // not a subsequence — no match

  // Tiny penalty for longer paths so tighter matches win ties.
  score -= target.length * 0.01;

  return score;
}

// Rank `files` (each `{path, relativePath}`, or a bare path string) against
// `query` via fuzzyScoreFilePath over relativePath, best match first, capped
// at `limit`. An empty query returns the input as-is (capped), unranked —
// mirrors filterSessions/filterSavedCommands' "no text = show all" behavior.
function filterQuickOpenFiles(query, files, limit = 50) {
  const list = Array.isArray(files) ? files : [];
  const q = normalize(query).trim();

  if (!q) {
    return list.slice(0, limit);
  }

  const scored = [];
  for (const file of list) {
    const relativePath =
      typeof file === "string" ? file : file?.relativePath || file?.path;
    const score = fuzzyScoreFilePath(q, relativePath);
    if (score === null) continue;
    scored.push({ file, score, relativePath: String(relativePath || "") });
  }

  scored.sort(
    (a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath),
  );

  return scored.slice(0, limit).map((entry) => entry.file);
}

const PaletteProviders = {
  parsePrefixQuery,
  filterSessions,
  createSavedCommandsStore,
  filterSavedCommands,
  fuzzyScoreFilePath,
  filterQuickOpenFiles,
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
  exports.fuzzyScoreFilePath = fuzzyScoreFilePath;
  exports.filterQuickOpenFiles = filterQuickOpenFiles;
}
