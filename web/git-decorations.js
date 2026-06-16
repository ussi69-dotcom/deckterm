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

const GitDecorationsModule = { buildDecorationMap };

if (typeof window !== "undefined") {
  window.GitDecorations = GitDecorationsModule;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = GitDecorationsModule;
}

if (typeof exports !== "undefined") {
  exports.buildDecorationMap = buildDecorationMap;
}
