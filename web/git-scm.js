// Pure source-control helpers for the Git panel (VS Code-grade UI). DOM-free
// so they stay unit-testable in bun; app.js (GitManager) consumes them as
// browser globals, tests import the CommonJS exports (same pattern as
// git-error.js).

// VS Code status letter for a /api/git/status file entry.
function statusLetter(file) {
  if (!file) return "?";
  // Merge conflict (Track D slice D3) — the server flags any unmerged XY code
  // (DD/AU/UD/UA/DU/AA/UU) as `conflicted`; this takes priority over every
  // other classification (a conflicted file is never staged/changes/untracked).
  if (file.conflicted) return "C";
  const raw = file.status || "";
  if (raw.startsWith("?") || file.unstagedStatus === "?" || file.untracked) {
    return "U";
  }
  if (file.isRenamed) return "R";
  return file.stagedStatus || file.unstagedStatus || raw[0] || "?";
}

// VS Code color class for a status letter.
function statusClass(letter) {
  switch (letter) {
    case "M":
      return "git-status-modified";
    case "A":
      return "git-status-added";
    case "D":
      return "git-status-deleted";
    case "U":
      return "git-status-untracked";
    case "R":
      return "git-status-renamed";
    case "C":
      return "git-status-conflict";
    default:
      return "";
  }
}

// Splits status files into the four Source Control groups. `merge` (conflicted
// files) is checked FIRST — a conflict takes priority over every other
// classification, mirroring statusLetter()'s precedence (Track D slice D3).
function groupStatusFiles(files) {
  const groups = { merge: [], staged: [], changes: [], untracked: [] };
  for (const file of files || []) {
    if (file.conflicted || file.section === "merge") {
      groups.merge.push({ ...file, staged: false, conflicted: true });
    } else if (file.section === "staged") {
      groups.staged.push({ ...file, staged: true });
    } else if (statusLetter(file) === "U") {
      groups.untracked.push({ ...file, staged: false, untracked: true });
    } else {
      groups.changes.push({ ...file, staged: false });
    }
  }
  return groups;
}

// "3↓ 2↑" sync indicator; empty string when in sync.
function syncLabel(ahead, behind) {
  const parts = [];
  if (behind > 0) parts.push(`${behind}↓`);
  if (ahead > 0) parts.push(`${ahead}↑`);
  return parts.join(" ");
}

// Decides which two document sources the diff editor compares for a file in
// the given mode. Kinds: "git-show" (ref via /api/git/show, INDEX = staged),
// "worktree" (read from disk via /api/files/content), "empty".
function diffSources(mode, file, commit) {
  // Merge conflict (Track D slice D3): ours (index stage 2) vs theirs (index
  // stage 3), both resolved through the gated /api/git/show STAGE2/STAGE3
  // sentinels — never the raw working file (which still has conflict markers).
  if (mode === "conflict") {
    return {
      original: { kind: "git-show", ref: "STAGE2" },
      modified: { kind: "git-show", ref: "STAGE3" },
    };
  }
  if (mode === "commit" && commit) {
    return {
      original: { kind: "git-show", ref: `${commit}~1` },
      modified: { kind: "git-show", ref: commit },
    };
  }
  if (mode === "staged") {
    return {
      original: { kind: "git-show", ref: "HEAD" },
      modified: { kind: "git-show", ref: "INDEX" },
    };
  }
  // working tree
  if (file && (file.untracked || statusLetter(file) === "U")) {
    return { original: { kind: "empty" }, modified: { kind: "worktree" } };
  }
  if (file && file.unstagedStatus === "D") {
    return {
      original: { kind: "git-show", ref: "INDEX" },
      modified: { kind: "empty" },
    };
  }
  return {
    original: { kind: "git-show", ref: "INDEX" },
    modified: { kind: "worktree" },
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    statusLetter,
    statusClass,
    groupStatusFiles,
    syncLabel,
    diffSources,
  };
}

if (typeof exports !== "undefined") {
  exports.statusLetter = statusLetter;
  exports.statusClass = statusClass;
  exports.groupStatusFiles = groupStatusFiles;
  exports.syncLabel = syncLabel;
  exports.diffSources = diffSources;
}
