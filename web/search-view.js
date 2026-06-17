// VS Code Search sidebar view (IDE shell, phase 5 — slice 7).
//
// The 4th activity-bar view (Explorer 1st, Source Control 2nd, Tasks 3rd,
// Search 4th). A debounced query input + results grouped by file; clicking a
// result opens the file at the matched line in the editor (open-at-line).
//
// It does NOT search in the browser. The recursive content search runs on the
// backend (POST /api/files/search — grep scoped to allowed roots, gated +
// audited + bounded). This view just dispatches the query (debounced, with a
// monotonic request id so stale responses are dropped) and renders the result.
//
// The pure helpers (result grouping, stale-response reducer, label formatting)
// are DOM-free + unit-tested in bun. ALL user-supplied result text/paths are
// escaped via the shared html-escape.js escapeHtml before innerHTML.

// ── html-escape bridge (browser global OR CommonJS under bun) ────────────────
function resolveEscapeHtml() {
  if (typeof window !== "undefined" && window.HtmlEscape?.escapeHtml) {
    return window.HtmlEscape.escapeHtml;
  }
  if (typeof require !== "undefined") {
    try {
      return require("./html-escape").escapeHtml;
    } catch {
      // fall through to the inline copy
    }
  }
  return (text) =>
    String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
}

// ── Pure helpers (DOM-free, unit-tested) ─────────────────────────────────────

// Group a flat list of matches ({ path, line, col, text }) into per-file groups
// in first-seen order: [{ path, matches:[...] }]. Entries without a path are
// dropped (defensive — never crash the render on junk).
function groupSearchResults(matches) {
  const list = Array.isArray(matches) ? matches : [];
  const order = [];
  const byPath = new Map();
  for (const m of list) {
    if (!m || typeof m.path !== "string" || !m.path) continue;
    let group = byPath.get(m.path);
    if (!group) {
      group = { path: m.path, matches: [] };
      byPath.set(m.path, group);
      order.push(group);
    }
    group.matches.push(m);
  }
  return order;
}

// Total match count across grouped results.
function searchTotalMatches(groups) {
  const list = Array.isArray(groups) ? groups : [];
  return list.reduce(
    (n, g) => n + (Array.isArray(g?.matches) ? g.matches.length : 0),
    0,
  );
}

// Staleness reducer for the request-id concurrency model: a response is stale
// (and must be ignored) when its id is older than the latest dispatched id.
// Junk ids → stale (drop rather than render an unknown response).
function isStaleResponse(responseId, latestId) {
  if (typeof responseId !== "number" || !Number.isFinite(responseId))
    return true;
  if (typeof latestId !== "number" || !Number.isFinite(latestId)) return true;
  return responseId < latestId;
}

// Display label for a match position. Missing col defaults to column 1.
function searchResultLineLabel(match) {
  const line = match && Number.isFinite(match.line) ? match.line : 1;
  const col = match && Number.isFinite(match.col) ? match.col : 1;
  return `${line}:${col}`;
}

// ── DOM controller (browser-only) ────────────────────────────────────────────

// Options:
//   document            the DOM document (defaults to global document)
//   getTerminalManager  () => the live TerminalManager (open-at-line + cwd)
//   fetchImpl           fetch (defaults to global fetch) — injectable for tests
//   debounceMs          query debounce (default 250)
const DEFAULT_DEBOUNCE_MS = 250;
const MAX_QUERY_LEN = 200; // mirror the server cap

class SearchViewController {
  constructor(options = {}) {
    this.doc =
      options.document || (typeof document !== "undefined" ? document : null);
    this.getTerminalManagerFn =
      typeof options.getTerminalManager === "function"
        ? options.getTerminalManager
        : () =>
            options.terminalManager ||
            (typeof window !== "undefined" ? window.terminalManager : null);
    this.fetchImpl =
      options.fetchImpl ||
      (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
    this.debounceMs = Number.isFinite(options.debounceMs)
      ? options.debounceMs
      : DEFAULT_DEBOUNCE_MS;

    this.root = null;
    this.container = null;
    this._debounceTimer = null;
    // Monotonic request id: every dispatched query bumps it; responses whose id
    // is older than this are dropped (paired with the server-side abort).
    this._requestSeq = 0;
    this._latestRequestId = 0;
    this._results = []; // grouped results last rendered
    this._regex = false;
  }

  get terminalManager() {
    return this.getTerminalManagerFn();
  }

  // ── ViewHost lifecycle ──────────────────────────────────────────────────────

  mount(container) {
    if (!container || !this.doc) return;
    if (this.root) this.unmount();
    this.container = container;
    const root = this.doc.createElement("div");
    root.className = "ide-search-view";
    root.innerHTML = this.skeletonHtml();
    container.appendChild(root);
    this.root = root;
    this.bindEvents();
    this.renderResults();
    // Focus the query box on mount (VS Code parity).
    const input = this.q(".ide-search-input");
    if (input && typeof input.focus === "function") {
      try {
        input.focus();
      } catch {
        // best-effort
      }
    }
  }

  unmount() {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    // Bump the request id so any in-flight response is treated as stale.
    this._latestRequestId = ++this._requestSeq;
    if (this.root && this.root.parentElement) {
      this.root.parentElement.removeChild(this.root);
    }
    this.root = null;
    this.container = null;
  }

  dispose() {
    this.unmount();
  }

  resize() {}

  // ── Render ───────────────────────────────────────────────────────────────────

  skeletonHtml() {
    return `
      <div class="ide-search-header">
        <input type="text" class="ide-search-input" placeholder="Search" maxlength="${MAX_QUERY_LEN}" autocomplete="off" spellcheck="false" />
        <label class="ide-search-regex" title="Use regular expression"><input type="checkbox" class="ide-search-regex-input" /> .*</label>
      </div>
      <div class="ide-search-status"></div>
      <div class="ide-search-results"></div>
    `;
  }

  q(sel) {
    return this.root ? this.root.querySelector(sel) : null;
  }

  esc(text) {
    return resolveEscapeHtml()(text);
  }

  setStatus(text) {
    const el = this.q(".ide-search-status");
    if (el) el.textContent = text || "";
  }

  renderResults() {
    const host = this.q(".ide-search-results");
    if (!host) return;
    const groups = this._results;
    if (!Array.isArray(groups) || groups.length === 0) {
      host.innerHTML = "";
      return;
    }
    let html = "";
    for (const group of groups) {
      const fileName = (group.path || "").split("/").pop() || group.path || "";
      const rows = group.matches
        .map((m) => {
          const label = searchResultLineLabel(m);
          return `
            <div class="ide-search-match" data-path="${this.esc(group.path)}" data-line="${this.esc(String(m.line || 1))}" data-col="${this.esc(String(m.col || 1))}" title="${this.esc(group.path)}:${this.esc(label)}">
              <span class="ide-search-match-loc">${this.esc(label)}</span>
              <span class="ide-search-match-text">${this.esc(m.text == null ? "" : m.text)}</span>
            </div>`;
        })
        .join("");
      html += `
        <div class="ide-search-group">
          <div class="ide-search-group-header" title="${this.esc(group.path)}">
            <span class="ide-search-group-name">${this.esc(fileName)}</span>
            <span class="ide-search-group-count">${group.matches.length}</span>
          </div>
          <div class="ide-search-group-items">${rows}</div>
        </div>`;
    }
    host.innerHTML = html;
  }

  // ── Events ───────────────────────────────────────────────────────────────────

  bindEvents() {
    if (!this.root) return;
    const input = this.q(".ide-search-input");
    if (input) {
      input.addEventListener("input", () => this.onQueryInput());
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.runSearchNow();
        }
      });
    }
    const regex = this.q(".ide-search-regex-input");
    if (regex) {
      regex.addEventListener("change", () => {
        this._regex = Boolean(regex.checked);
        this.onQueryInput();
      });
    }
    const results = this.q(".ide-search-results");
    if (results) {
      results.addEventListener("click", (e) => this.onResultClick(e));
    }
  }

  currentQuery() {
    const input = this.q(".ide-search-input");
    return (input?.value || "").slice(0, MAX_QUERY_LEN);
  }

  onQueryInput() {
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this.runSearchNow();
    }, this.debounceMs);
  }

  runSearchNow() {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    void this.dispatchSearch(this.currentQuery());
  }

  cwd() {
    const tm = this.terminalManager;
    const ctx = tm?.getActiveWorkspaceContext?.();
    return ctx?.cwd || tm?.currentCwd || "";
  }

  async dispatchSearch(rawQuery) {
    const query = (rawQuery || "").trim();
    // A new query always bumps the request id (even an empty one), so a pending
    // older response is dropped and the server can abort the prior grep.
    const requestId = ++this._requestSeq;
    this._latestRequestId = requestId;

    if (!query) {
      this._results = [];
      this.renderResults();
      this.setStatus("");
      return;
    }
    const cwd = this.cwd();
    if (!cwd) {
      this.setStatus("Open a workspace to search.");
      this._results = [];
      this.renderResults();
      return;
    }
    if (!this.fetchImpl) return;
    this.setStatus("Searching…");
    try {
      const res = await this.fetchImpl("/api/files/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cwd,
          query,
          regex: this._regex,
          requestId,
        }),
      });
      // Drop a stale response (a newer query was dispatched while this was
      // in-flight). Paired with the server-side per-session abort.
      if (isStaleResponse(requestId, this._latestRequestId)) return;
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        this._results = [];
        this.renderResults();
        const denial =
          typeof window !== "undefined"
            ? window.AccessDenied?.describeAccessDenied?.(body)
            : null;
        this.setStatus(denial?.text || body.error || "Search failed");
        return;
      }
      // Re-check staleness AFTER the async json() too.
      if (isStaleResponse(requestId, this._latestRequestId)) return;
      const groups = groupSearchResults(body.matches);
      this._results = groups;
      this.renderResults();
      const total = searchTotalMatches(groups);
      if (total === 0) {
        this.setStatus("No results");
      } else {
        const fileCount = groups.length;
        const truncated = body.truncated ? " (truncated)" : "";
        this.setStatus(
          `${total} result${total === 1 ? "" : "s"} in ${fileCount} file${fileCount === 1 ? "" : "s"}${truncated}`,
        );
      }
    } catch {
      if (isStaleResponse(requestId, this._latestRequestId)) return;
      this._results = [];
      this.renderResults();
      this.setStatus("Search failed");
    }
  }

  onResultClick(e) {
    const row = e.target.closest(".ide-search-match");
    if (!row) return;
    const path = row.dataset.path;
    const line = parseInt(row.dataset.line, 10) || 1;
    const col = parseInt(row.dataset.col, 10) || 1;
    if (!path) return;
    this.openAtLine(path, line, col);
  }

  // Open the file in an editor tab at the matched line (open-at-line). Falls
  // back to the modal editor in terminal mode. The path returned by the search
  // endpoint is ABSOLUTE (grep prints the realpath start dir + relative path).
  openAtLine(path, line, col) {
    const tm = this.terminalManager;
    if (!tm || !path) return;
    if (tm.isIdeModeActive?.() && tm.editorTabs?.openFile) {
      tm.editorTabs.openFile(path, { preview: true, line, col });
      return;
    }
    if (tm.handleExplorerOpenFile) {
      tm.handleExplorerOpenFile(path, { pinned: false, line, col });
    } else {
      tm.openFileInEditor?.(path, { line, col });
    }
  }
}

// ── Exports (triple pattern) ─────────────────────────────────────────────────

const SearchViewModule = {
  groupSearchResults,
  searchTotalMatches,
  isStaleResponse,
  searchResultLineLabel,
  SearchViewController,
};

if (typeof window !== "undefined") {
  window.SearchView = SearchViewModule;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = SearchViewModule;
}

if (typeof exports !== "undefined") {
  exports.groupSearchResults = groupSearchResults;
  exports.searchTotalMatches = searchTotalMatches;
  exports.isStaleResponse = isStaleResponse;
  exports.searchResultLineLabel = searchResultLineLabel;
  exports.SearchViewController = SearchViewController;
}
