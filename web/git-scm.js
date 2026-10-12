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

// Splits a repo-relative path into the file name and its directory, for rows
// that show "name  dim/dir". An untracked directory entry ("docs/drafts/")
// keeps its trailing slash on the name so it still reads as a folder.
function splitRepoPath(path) {
  const raw = typeof path === "string" ? path : "";
  if (!raw) return { name: "", dir: "" };
  const trailing = raw.endsWith("/");
  const trimmed = trailing ? raw.slice(0, -1) : raw;
  const cut = trimmed.lastIndexOf("/");
  const name =
    (cut === -1 ? trimmed : trimmed.slice(cut + 1)) + (trailing ? "/" : "");
  const dir = cut === -1 ? "" : trimmed.slice(0, cut);
  return { name, dir };
}

// Display order for the file groups: groups that hold files come first (in
// their original order), empty groups follow as compact one-line headers.
// A section flagged `hideWhenEmpty` (Merge Conflicts) disappears when empty.
// Returns shallow copies with `empty` set; the input is not mutated.
function orderFileSections(sections) {
  const list = Array.isArray(sections) ? sections : [];
  const full = [];
  const empty = [];
  for (const section of list) {
    const files = Array.isArray(section?.files) ? section.files : [];
    if (files.length > 0) {
      full.push({ ...section, files, empty: false });
    } else if (!section?.hideWhenEmpty) {
      empty.push({ ...section, files, empty: true });
    }
  }
  return [...full, ...empty];
}

// True when a /api/git/status payload is the server's "this folder is not a
// git repository" probe result (HTTP 200, isRepository:false) rather than an
// operational failure. Older servers sent only the error string.
function isNotRepositoryStatus(data) {
  if (!data || typeof data !== "object") return false;
  if (data.isRepository === false) return true;
  return (
    typeof data.error === "string" && /not a git repository/i.test(data.error)
  );
}

// The remote/stash actions shown in the Git panel header (inline when there
// is room, otherwise in the overflow menu). `icon` is a lucide name; `glyph`
// is the text fallback rendered inside the <i> until lucide replaces it.
function gitSyncActions(sync) {
  const upstream = sync?.upstream || null;
  return [
    {
      op: "pull",
      label: "Pull",
      title: upstream ? "Pull" : "Pull (no upstream branch)",
      icon: "arrow-down-to-line",
      glyph: "\u2193",
      disabled: !upstream,
    },
    {
      op: "push",
      label: upstream ? "Push" : "Publish branch",
      title: upstream ? "Push" : "Publish branch (push -u origin)",
      icon: upstream ? "arrow-up-from-line" : "cloud-upload",
      glyph: "\u2191",
      disabled: false,
    },
    {
      op: "fetch",
      label: "Fetch",
      title: "Fetch",
      icon: "cloud-download",
      glyph: "\u21e3",
      disabled: false,
    },
    {
      op: "stash",
      label: "Stash changes",
      title: "Stash changes",
      icon: "archive",
      glyph: "\u2261",
      disabled: false,
    },
  ];
}

// Builds the folder tree for a group's files: { folders: Map, files: [] },
// each folder { name, fullPath, folders, files }. With `compact`, a folder
// that holds no files and exactly one sub-folder merges with it into one node
// named "a/b" (VS Code "compact folders"), which keeps deep paths from eating
// the row width on phones. fullPath always names the deepest folder.
function buildFileTree(files, options = {}) {
  const root = { folders: new Map(), files: [] };
  for (const file of Array.isArray(files) ? files : []) {
    const parts = String(file?.path || "").split("/");
    let node = root;
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i++) {
      const folder = parts[i];
      if (!folder) continue;
      prefix = prefix ? `${prefix}/${folder}` : folder;
      if (!node.folders.has(folder)) {
        node.folders.set(folder, {
          name: folder,
          fullPath: prefix,
          folders: new Map(),
          files: [],
        });
      }
      node = node.folders.get(folder);
    }
    node.files.push(file);
  }
  if (options.compact) compactFolders(root);
  return root;
}

function compactFolders(node) {
  const next = new Map();
  for (const folder of node.folders.values()) {
    let merged = folder;
    while (merged.files.length === 0 && merged.folders.size === 1) {
      const child = merged.folders.values().next().value;
      merged = {
        name: `${merged.name}/${child.name}`,
        fullPath: child.fullPath,
        folders: child.folders,
        files: child.files,
      };
    }
    compactFolders(merged);
    next.set(merged.name, merged);
  }
  node.folders = next;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    statusLetter,
    statusClass,
    groupStatusFiles,
    syncLabel,
    diffSources,
    splitRepoPath,
    orderFileSections,
    isNotRepositoryStatus,
    gitSyncActions,
    buildFileTree,
  };
}

if (typeof exports !== "undefined") {
  exports.statusLetter = statusLetter;
  exports.statusClass = statusClass;
  exports.groupStatusFiles = groupStatusFiles;
  exports.syncLabel = syncLabel;
  exports.diffSources = diffSources;
  exports.splitRepoPath = splitRepoPath;
  exports.orderFileSections = orderFileSections;
  exports.isNotRepositoryStatus = isNotRepositoryStatus;
  exports.gitSyncActions = gitSyncActions;
  exports.buildFileTree = buildFileTree;
}
