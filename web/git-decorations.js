// Pure helper that turns a /api/git/status files array + repo root into a map
// of { absPath: { letter, colorClass } } for the file explorer's VS Code-style
// git decorations. DOM-free + dependency-light so it stays unit-testable in
// bun (same pattern as git-scm.js). Reuses statusLetter/statusClass from
// git-scm.js — do not duplicate that status semantics here.

// git-scm.js exposes its helpers as bare globals in the browser (plain
// <script>, no module system) and as CommonJS exports under bun's test
// runner. Resolve both shapes without duplicating the status semantics.
function getGitScm() {
  if (typeof statusLetter === "function" && typeof statusClass === "function") {
    return { statusLetter, statusClass };
  }
  if (typeof require !== "undefined") {
    try {
      return require("./git-scm");
    } catch {
      return null;
    }
  }
  return null;
}

// Joins an absolute repo root + a repo-relative path into an absolute path,
// tolerating a trailing slash on the root.
function joinRepoPath(root, relPath) {
  const base = String(root || "").replace(/\/+$/, "");
  const rel = String(relPath || "").replace(/^\/+/, "");
  return `${base}/${rel}`;
}

// statusFiles: /api/git/status `files` array (repo-relative `path`).
// root: absolute repo toplevel (status response `root`).
// Returns { absPath: { letter, colorClass } }; clean files are simply absent.
function buildDecorationMap(statusFiles, root) {
  const map = {};
  const normalizedRoot = String(root || "").trim();
  if (!normalizedRoot || !Array.isArray(statusFiles)) return map;

  const scm = getGitScm();
  const statusLetter = scm?.statusLetter;
  const statusClass = scm?.statusClass;
  if (!statusLetter || !statusClass) return map;

  for (const file of statusFiles) {
    if (!file || !file.path) continue;
    const letter = statusLetter(file);
    const absPath = joinRepoPath(normalizedRoot, file.path);
    map[absPath] = { letter, colorClass: statusClass(letter) };
  }
  return map;
}

// Color class precedence for folder rollup: a folder's color is the
// "most alarming" status among its changed descendants. Order (highest first):
// conflict > deleted > modified/added/renamed > untracked > unknown.
const FOLDER_COLOR_PRECEDENCE = [
  "git-status-conflict",
  "git-status-deleted",
  "git-status-modified",
  "git-status-added",
  "git-status-renamed",
  "git-status-untracked",
];

function higherPrecedenceColor(a, b) {
  const ai = FOLDER_COLOR_PRECEDENCE.indexOf(a);
  const bi = FOLDER_COLOR_PRECEDENCE.indexOf(b);
  // Unknown classes fall to end (index -1 → treat as lowest).
  if (ai === -1 && bi === -1) return a || b;
  if (ai === -1) return b;
  if (bi === -1) return a;
  return ai <= bi ? a : b;
}

// For each changed file, walk its ancestor directories up to (and including)
// `root`, incrementing `count` and resolving a representative `colorClass`
// by precedence. Returns { <absDirPath>: { count, colorClass } }.
// The existing file-keyed buildDecorationMap shape is left intact.
function buildFolderDecorationMap(statusFiles, root) {
  const map = {};
  const normalizedRoot = String(root || "")
    .trim()
    .replace(/\/+$/, "");
  if (!normalizedRoot || !Array.isArray(statusFiles)) return map;

  const scm = getGitScm();
  const statusLetter = scm?.statusLetter;
  const statusClass = scm?.statusClass;
  if (!statusLetter || !statusClass) return map;

  for (const file of statusFiles) {
    if (!file || !file.path) continue;
    const letter = statusLetter(file);
    const colorClass = statusClass(letter);
    const absFile = joinRepoPath(normalizedRoot, file.path);

    // Walk every ancestor dir from parent up to (and including) the root.
    let dir = absFile.split("/").slice(0, -1).join("/");
    while (dir && dir.startsWith(normalizedRoot)) {
      const existing = map[dir];
      if (existing) {
        existing.count += 1;
        existing.colorClass = higherPrecedenceColor(
          existing.colorClass,
          colorClass,
        );
      } else {
        map[dir] = { count: 1, colorClass };
      }
      if (dir === normalizedRoot) break;
      dir = dir.split("/").slice(0, -1).join("/");
    }
  }
  return map;
}

const GitDecorationsModule = { buildDecorationMap, buildFolderDecorationMap };

if (typeof window !== "undefined") {
  window.GitDecorations = GitDecorationsModule;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = GitDecorationsModule;
}

if (typeof exports !== "undefined") {
  exports.buildDecorationMap = buildDecorationMap;
  exports.buildFolderDecorationMap = buildFolderDecorationMap;
}
