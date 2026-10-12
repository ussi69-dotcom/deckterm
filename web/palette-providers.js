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
        normalize(session.name).includes(needle) ||
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
// `mruRank(file)` (optional) returns the file's index in the recently-opened
// list (0 = most recent) or -1; recent files get a fading bonus so they win
// ties and near-ties without burying a clearly better match.
const QUICK_OPEN_MRU_BONUS = 8;
const QUICK_OPEN_MRU_SPAN = 25;

function filterQuickOpenFiles(query, files, limit = 50, { mruRank } = {}) {
  const list = Array.isArray(files) ? files : [];
  const q = normalize(query).trim();

  if (!q) {
    return list.slice(0, limit);
  }

  const scored = [];
  for (const file of list) {
    const relativePath =
      typeof file === "string" ? file : file?.relativePath || file?.path;
    let score = fuzzyScoreFilePath(q, relativePath);
    if (score === null) continue;
    const rank = typeof mruRank === "function" ? mruRank(file) : -1;
    if (Number.isInteger(rank) && rank >= 0 && rank < QUICK_OPEN_MRU_SPAN) {
      score += QUICK_OPEN_MRU_BONUS * (1 - rank / QUICK_OPEN_MRU_SPAN);
    }
    scored.push({ file, score, relativePath: String(relativePath || "") });
  }

  scored.sort(
    (a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath),
  );

  return scored.slice(0, limit).map((entry) => entry.file);
}

// --- Row presentation helpers ----------------------------------------------

const WORD_BOUNDARY = /[\s/_\-.:@$]/;

// Character indices of `text` that `query` matched, for highlighting. Prefers
// a contiguous occurrence (at a word start when there is one), then falls
// back to the leftmost subsequence. Empty query → []; no match → null.
function matchPositions(query, text) {
  const q = normalize(query).trim();
  const target = String(text || "");
  if (!q) return [];
  const lower = target.toLowerCase();

  let best = -1;
  for (
    let index = lower.indexOf(q);
    index !== -1;
    index = lower.indexOf(q, index + 1)
  ) {
    if (best === -1) best = index;
    if (index === 0 || WORD_BOUNDARY.test(lower[index - 1])) {
      best = index;
      break;
    }
  }
  if (best !== -1) {
    return Array.from({ length: q.length }, (_, offset) => best + offset);
  }

  const positions = [];
  let qi = 0;
  for (let ti = 0; ti < lower.length && qi < q.length; ti++) {
    if (lower[ti] === q[qi]) {
      positions.push(ti);
      qi += 1;
    }
  }
  return qi === q.length ? positions : null;
}

// Split `text` into [{text, match}] runs for the given matched indices.
function highlightSegments(text, positions) {
  const value = String(text ?? "");
  const matched = new Set(Array.isArray(positions) ? positions : []);
  const segments = [];
  for (let index = 0; index < value.length; index++) {
    const match = matched.has(index);
    const last = segments[segments.length - 1];
    if (last && last.match === match) last.text += value[index];
    else segments.push({ text: value[index], match });
  }
  if (segments.length === 0 && value) segments.push({ text: value, match: false });
  return segments;
}

function truncateMiddle(text, max) {
  const value = String(text || "");
  if (value.length <= max) return value;
  const keep = Math.max(1, max - 1);
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${value.slice(0, head)}…${tail ? value.slice(-tail) : ""}`;
}

// Middle-truncate a path to `max` characters, keeping its first segment and
// as many trailing segments as fit ("/home/…/models/x.jinja"); falls back to
// a character-level middle cut when even the last segment is too long.
function truncatePathMiddle(path, max = 48) {
  const value = String(path || "");
  if (value.length <= max) return value;
  const absolute = value.startsWith("/");
  const parts = value.split("/").filter(Boolean);
  if (parts.length >= 2) {
    const head = `${absolute ? "/" : ""}${parts[0]}/…/`;
    let tail = "";
    for (let index = parts.length - 1; index >= 1; index--) {
      const next = tail ? `${parts[index]}/${tail}` : parts[index];
      if (head.length + next.length > max) break;
      tail = next;
    }
    if (tail) return `${head}${tail}`;
  }
  return truncateMiddle(value, max);
}

function splitFilePath(relativePath) {
  const value = String(relativePath || "");
  const slash = value.lastIndexOf("/");
  if (slash === -1) return { dir: "", base: value };
  return { dir: value.slice(0, slash), base: value.slice(slash + 1) };
}

function basenameOf(path) {
  const trimmed = String(path || "").replace(/\/+$/, "");
  if (!trimmed) return path ? "/" : "";
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}

// Palette row for an "@" session entry: a human title (session name or cwd
// basename), the agent/run state and cwd as dim detail, and the row action
// as the right-hand hint. The raw session id is never shown.
function describePaletteSession(session, plan = {}) {
  const title =
    String(session?.name || "").trim() || basenameOf(session?.cwd) || "Terminal";
  const state = [];
  const agentName = String(session?.agentName || "").trim();
  const agentState = String(session?.agentState || "")
    .trim()
    .toLowerCase();
  if (agentName) {
    state.push(agentName);
    if (agentState) state.push(agentState);
  } else if (plan.statusClass === "ended") {
    state.push("ended");
  } else if (session?.running) {
    state.push("running");
  }
  const cwd = String(session?.cwd || "").trim();
  if (cwd) state.push(truncatePathMiddle(cwd, 48));
  return { title, detail: state.join(" · "), hint: plan.label || "" };
}

// Recently used palette entries, per kind ("files" = absolute paths opened,
// "commands" = action ids run), most recent first. localStorage-backed and
// failure-tolerant: a throwing or corrupt storage degrades to an empty list.
const PALETTE_MRU_KEY = "deckterm-palette-mru";

function createPaletteMruStore(storage, { limit = 50 } = {}) {
  function read() {
    try {
      const parsed = JSON.parse(storage?.getItem(PALETTE_MRU_KEY) || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch {
      return {};
    }
  }

  function entries(state, kind) {
    const list = Array.isArray(state[kind]) ? state[kind] : [];
    return list.filter(
      (entry) => entry && typeof entry.id === "string" && entry.id,
    );
  }

  return {
    touch(kind, id, now = Date.now()) {
      const key = String(id || "");
      if (!key) return;
      const state = read();
      const next = entries(state, kind).filter((entry) => entry.id !== key);
      next.unshift({ id: key, at: now });
      state[kind] = next.slice(0, limit);
      try {
        storage?.setItem(PALETTE_MRU_KEY, JSON.stringify(state));
      } catch {
        // quota / privacy mode: MRU is a nicety, never an error
      }
    },
    list(kind) {
      return entries(read(), kind).map((entry) => entry.id);
    },
    rankOf(kind, id) {
      return this.list(kind).indexOf(String(id || ""));
    },
  };
}

const PaletteProviders = {
  parsePrefixQuery,
  filterSessions,
  createSavedCommandsStore,
  filterSavedCommands,
  fuzzyScoreFilePath,
  filterQuickOpenFiles,
  matchPositions,
  highlightSegments,
  truncatePathMiddle,
  splitFilePath,
  describePaletteSession,
  createPaletteMruStore,
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
  exports.matchPositions = matchPositions;
  exports.highlightSegments = highlightSegments;
  exports.truncatePathMiddle = truncatePathMiddle;
  exports.splitFilePath = splitFilePath;
  exports.describePaletteSession = describePaletteSession;
  exports.createPaletteMruStore = createPaletteMruStore;
}
