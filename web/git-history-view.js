// Git History view — repo-wide (6a) and per-file (6b) commit history for the
// IDE SCM sidebar. Surfaces /api/git/log (which already returns --graph prefix
// + per-commit {hash, fullHash, message, author, date, graph}), renders a list
// of commit rows with a monospace ASCII-lane gutter, and opens a commit diff
// tab on row click via the injected getTerminalManager().
//
// Structure mirrors git-scm-view.js:
//   - DOM-free pure helpers at the top (historyRows)
//   - A DOM controller class (GitHistoryViewController)
//   - Triple export at the bottom (window global + module.exports + exports)
//   - Injectable fetchImpl / document for testing
//
// Lazy: the controller only fetches /api/git/log when first shown (loaded=false
// until the first expand). Collapsed state is owned by the parent SCM view
// which drives mount/unmount on expand/collapse.

// ── relativeDate bridge ───────────────────────────────────────────────────────
// Reuse git-timeline.js's relativeDate (same dual-require resolution pattern as
// git-scm-view.js uses for its helpers). Falls back to a minimal inline copy so
// the module never hard-depends on a load order.
function resolveRelativeDate() {
  if (typeof window !== "undefined" && window.GitTimeline?.relativeDate) {
    return window.GitTimeline.relativeDate;
  }
  if (typeof require !== "undefined") {
    try {
      return require("./git-timeline").relativeDate;
    } catch {
      // fall through to inline copy
    }
  }
  // Inline fallback (same algorithm as git-timeline.js)
  return function relativeDate(isoDate) {
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
  };
}

// ── Pure helpers (DOM-free, unit-tested) ─────────────────────────────────────

// Map the raw /api/git/log commits array into display rows for the history list.
// Each row exposes: shortHash (7-char), fullHash (40-char), subject (first line
// of the message), author, dateLabel (relative), and graph (ASCII-lane prefix).
function historyRows(commits) {
  const relativeDate = resolveRelativeDate();
  if (!Array.isArray(commits)) return [];
  return commits
    .filter((c) => c && (c.fullHash || c.hash))
    .map((c) => {
      const fullHash = c.fullHash || c.hash || "";
      const shortHash = c.hash || (fullHash ? fullHash.slice(0, 7) : "");
      // Subject = first non-empty line of the message
      const subject = (c.message || "").split("\n")[0].trim();
      const author = c.author || "";
      const dateLabel = relativeDate(c.date || "");
      const graph = c.graph || "";
      return { shortHash, fullHash, subject, author, dateLabel, graph };
    });
}

// ── DOM controller ────────────────────────────────────────────────────────────

// Options:
//   document           the DOM document (defaults to global document)
//   fetchImpl          fetch-compatible function (defaults to global fetch)
//   getTerminalManager () => TerminalManager (for openDiffTab on row click)
//   getCwd             () => string — the current git repo cwd for /api/git/log
//   path               optional repo-relative path to scope to a single file (6b)
class GitHistoryViewController {
  constructor(options = {}) {
    this.doc =
      options.document || (typeof document !== "undefined" ? document : null);
    this._fetchImpl =
      options.fetchImpl ||
      (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
    this.getTerminalManagerFn =
      typeof options.getTerminalManager === "function"
        ? options.getTerminalManager
        : () => (typeof window !== "undefined" ? window.terminalManager : null);
    this.getCwdFn =
      typeof options.getCwd === "function"
        ? options.getCwd
        : () => options.cwd || "";
    // Optional: when set, history is scoped to this file's commits (6b)
    this.path = options.path || null;

    this.root = null; // the mounted container element
    this._loaded = false; // true after first successful fetch
    this._loading = false;
    this._rows = []; // last-fetched historyRows
    this._error = null;
    // Repo-scope expand state: a commit row expands to the files it changed
    // (each opens a single-file commit diff). fullHash -> [{status, path}].
    this._expanded = new Set();
    this._commitFiles = new Map();
    this._filesLoading = new Set();
  }

  get terminalManager() {
    return this.getTerminalManagerFn();
  }

  get cwd() {
    return this.getCwdFn();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  // Mount into `container`. Immediately fetches and renders the history list.
  mount(container) {
    if (!container || !this.doc) return;
    if (this.root) this.unmount();
    const root = this.doc.createElement("div");
    root.className = "ide-history-view";
    container.appendChild(root);
    this.root = root;
    this._bindEvents();
    void this._load();
  }

  unmount() {
    if (this.root && this.root.parentElement) {
      this.root.parentElement.removeChild(this.root);
    }
    this.root = null;
  }

  dispose() {
    this.unmount();
  }

  // Reload history from the server (used when the cwd or path changes).
  refresh() {
    this._loaded = false;
    return this._load();
  }

  // ── Data ─────────────────────────────────────────────────────────────────

  async _load() {
    if (this._loading) return;
    const cwd = this.cwd;
    if (!cwd) {
      this._error = "No repository context";
      this._render();
      return;
    }
    this._loading = true;
    this._error = null;
    this._render(); // show loading state

    try {
      const fetchFn = this._fetchImpl;
      if (!fetchFn) throw new Error("No fetch available");
      let url = `/api/git/log?cwd=${encodeURIComponent(cwd)}&limit=50`;
      if (this.path) url += `&path=${encodeURIComponent(this.path)}`;
      const res = await fetchFn(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      this._rows = historyRows(data.commits || []);
      this._loaded = true;
      this._error = null;
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
      this._rows = [];
    } finally {
      this._loading = false;
      this._render();
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  _render() {
    if (!this.root) return;
    if (this._loading && !this._loaded) {
      this.root.innerHTML =
        '<p class="ide-history-loading ide-scm-empty">Loading history…</p>';
      return;
    }
    if (this._error) {
      this.root.innerHTML = `<p class="ide-history-error ide-scm-empty">${_esc(this._error)}</p>`;
      return;
    }
    if (this._rows.length === 0) {
      this.root.innerHTML =
        '<p class="ide-history-empty ide-scm-empty">No history</p>';
      return;
    }
    const rowsHtml = this._rows
      .map((row) => {
        // In repo scope a commit expands to its file list; a caret reflects it.
        const expandable = !this.path;
        const expanded = this._expanded.has(row.fullHash);
        const caret = expandable ? (expanded ? "▾" : "▸") : "";
        const head =
          `<div class="ide-history-row${expandable ? " expandable" : ""}" data-full-hash="${_esc(row.fullHash)}" title="${_esc(row.subject)} — ${_esc(row.author)}">` +
          `<span class="ide-history-caret">${caret}</span>` +
          `<span class="ide-history-graph">${_esc(row.graph)}</span>` +
          `<span class="ide-history-hash">${_esc(row.shortHash)}</span>` +
          `<span class="ide-history-subject">${_esc(row.subject)}</span>` +
          `<span class="ide-history-meta">${_esc(row.author)} · ${_esc(row.dateLabel)}</span>` +
          `</div>`;
        if (!expandable || !expanded) return head;
        return head + this._fileListHtml(row.fullHash);
      })
      .join("");
    this.root.innerHTML = `<div class="ide-history-list">${rowsHtml}</div>`;
  }

  // The expanded file list for a commit (repo scope). Renders a loading/empty
  // state until the commit-files fetch resolves; each file opens a single-file
  // commit diff on click.
  _fileListHtml(fullHash) {
    if (this._filesLoading.has(fullHash)) {
      return '<div class="ide-history-files"><p class="ide-scm-empty">Loading files…</p></div>';
    }
    const files = this._commitFiles.get(fullHash);
    if (!files) return '<div class="ide-history-files"></div>';
    if (files.length === 0) {
      return '<div class="ide-history-files"><p class="ide-scm-empty">No files</p></div>';
    }
    const rows = files
      .map((f) => {
        const name = (f.path || "").split("/").pop() || f.path || "";
        return (
          `<div class="ide-history-file" data-path="${_esc(f.path)}" data-commit="${_esc(fullHash)}" title="${_esc(f.path)}">` +
          `<span class="ide-history-file-status">${_esc(f.status || "")}</span>` +
          `<span class="ide-history-file-name">${_esc(name)}</span>` +
          `</div>`
        );
      })
      .join("");
    return `<div class="ide-history-files">${rows}</div>`;
  }

  // ── Events ────────────────────────────────────────────────────────────────

  _bindEvents() {
    if (!this.root) return;
    this.root.addEventListener("click", (e) => this._onClick(e));
  }

  _onClick(e) {
    const tm = this.terminalManager;
    // A file inside an expanded commit → open that file's single-file diff at
    // the commit (repo scope). This is the path the editor diff tab can render.
    const fileEl = e.target.closest(".ide-history-file");
    if (fileEl) {
      if (!tm?.openDiffTab) return;
      tm.openDiffTab({
        relPath: fileEl.dataset.path,
        mode: "commit",
        commit: fileEl.dataset.commit,
        cwd: this.cwd,
      });
      return;
    }

    const row = e.target.closest(".ide-history-row");
    if (!row) return;
    const fullHash = row.dataset.fullHash;
    if (!fullHash) return;

    // File scope (6b): the commit click opens THIS file's diff at the commit —
    // there's exactly one file to show, so go straight to the diff tab.
    if (this.path) {
      if (!tm?.openDiffTab) return;
      tm.openDiffTab({
        relPath: this.path,
        mode: "commit",
        commit: fullHash,
        cwd: this.cwd,
      });
      return;
    }

    // Repo scope (6a): a whole commit has many files, which the single-file diff
    // tab can't show at once. Expand the commit to its file list instead; each
    // file opens its own commit diff. Toggle + lazy-fetch the file list.
    if (this._expanded.has(fullHash)) {
      this._expanded.delete(fullHash);
      this._render();
      return;
    }
    this._expanded.add(fullHash);
    if (!this._commitFiles.has(fullHash)) void this._loadCommitFiles(fullHash);
    this._render();
  }

  // Fetch the files changed in a commit (repo scope expand). Cached per commit.
  async _loadCommitFiles(fullHash) {
    if (this._filesLoading.has(fullHash)) return;
    this._filesLoading.add(fullHash);
    this._render();
    try {
      const fetchFn = this._fetchImpl;
      const cwd = this.cwd;
      if (!fetchFn || !cwd) throw new Error("no fetch/cwd");
      const res = await fetchFn(
        `/api/git/commit-files?cwd=${encodeURIComponent(cwd)}&commit=${encodeURIComponent(fullHash)}`,
      );
      const data = await res.json().catch(() => ({}));
      this._commitFiles.set(
        fullHash,
        res.ok && Array.isArray(data.files) ? data.files : [],
      );
    } catch {
      this._commitFiles.set(fullHash, []);
    } finally {
      this._filesLoading.delete(fullHash);
      this._render();
    }
  }
}

// Minimal HTML escaper used within this module (not the security-critical path
// for user-controlled attribute injection — this data comes from the git server
// response, not user input; but we still escape to be defensive).
function _esc(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Exports (triple pattern) ─────────────────────────────────────────────────

const GitHistoryViewModule = {
  historyRows,
  GitHistoryViewController,
};

if (typeof window !== "undefined") {
  window.GitHistoryView = GitHistoryViewModule;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = GitHistoryViewModule;
}

if (typeof exports !== "undefined") {
  exports.historyRows = historyRows;
  exports.GitHistoryViewController = GitHistoryViewController;
}
