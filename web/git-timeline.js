// Pure helpers for the per-file Git timeline (commit history -> diff against a
// revision) in the Git panel right pane. DOM-free so they stay unit-testable in
// bun; app.js (GitManager) consumes them as browser globals, tests import the
// CommonJS exports (same pattern as git-scm.js).

// Empty-tree object id. A repo's very first commit of a file has no parent
// content to diff against; git's well-known empty tree provides the "before"
// side so additions render as a clean add instead of erroring.
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// Relative "time ago" label for an ISO date. Mirrors the existing
// GitManager.formatDate semantics (git-scm.js ships no date helper).
function relativeDate(isoDate) {
  if (!isoDate) return "";
  const date = new Date(isoDate);
  if (isNaN(date.getTime())) return "";
  const now = Date.now();
  const diffDays = Math.floor((now - date.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

// Maps the /api/git/log?path= commits array into display rows for the timeline.
// The LAST entry (oldest in `git log` order) is the file's root commit (first
// add along the current path); flagged so the diff loader knows to diff against
// the empty tree. Scope is current-path history only (renames/deletes out of
// scope, see revPairForCommit).
function buildTimelineEntries(logCommits) {
  const commits = Array.isArray(logCommits) ? logCommits : [];
  const lastIndex = commits.length - 1;
  return commits.map((commit, index) => {
    const fullHash = commit.fullHash || commit.hash || "";
    const shortHash = commit.hash || (fullHash ? fullHash.slice(0, 7) : "");
    return {
      hash: fullHash,
      shortHash,
      message: commit.message || "",
      author: commit.author || "",
      date: commit.date || "",
      relativeDate: relativeDate(commit.date),
      isRoot: index === lastIndex,
    };
  });
}

// The { ref, prevRef } pair to feed the diff editor for a given commit. `ref` is
// the commit itself (the "after" side); `prevRef` is what to diff against (the
// "before" side).
//
// IMPORTANT: the /api/git/show endpoint rejects parent expressions like
// `<sha>~1` / `<sha>^` (its commit regex only accepts plain hashes, HEAD, and
// branch/tag names). So we never use `~1`; instead the "before" side is the
// PREVIOUS revision of THIS file in the per-path log (`prevCommit`), i.e. the
// next-older commit that touched it — which is exactly per-file-timeline
// semantics. A root commit has no prior revision along this path, so it diffs
// against the empty tree. Both sides use the SAME path (current-path history
// only); the diff loader falls back to "" on whichever side the path is absent.
function refOf(commit) {
  if (!commit) return "";
  return String(commit.hash || commit.fullHash || commit || "");
}

function revPairForCommit(commit, isRoot, prevCommit) {
  const ref = refOf(commit);
  if (isRoot || !prevCommit) {
    return { ref, prevRef: EMPTY_TREE_SHA };
  }
  return { ref, prevRef: refOf(prevCommit) };
}

const GitTimelineModule = {
  EMPTY_TREE_SHA,
  relativeDate,
  buildTimelineEntries,
  revPairForCommit,
};

if (typeof window !== "undefined") {
  window.GitTimeline = GitTimelineModule;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = GitTimelineModule;
}

if (typeof exports !== "undefined") {
  exports.EMPTY_TREE_SHA = EMPTY_TREE_SHA;
  exports.relativeDate = relativeDate;
  exports.buildTimelineEntries = buildTimelineEntries;
  exports.revPairForCommit = revPairForCommit;
}
