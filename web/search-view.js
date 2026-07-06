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

// ── Replace-in-files pure helpers (D4, DOM-free) ─────────────────────────────
// The token/apply contract binds a FILE set (POST /api/files/replace) — v1 has
// no per-match selection, only per-file include/exclude via checkboxes.

// Per-file eligibility badge text. Global truncation always wins over a
// file's own previewIncomplete flag (server contract: a globally truncated
// preview marks EVERY file ineligible, regardless of its own state).
function replaceFileEligibilityLabel(file, globallyTruncated) {
  if (globallyTruncated) return "narrow your query to replace";
  if (file && file.previewIncomplete) return "too many matches — truncated";
  return "";
}

// Default checked set for a freshly rendered preview: every ELIGIBLE file.
// Ineligible files are never pre-checked (their checkbox is also disabled).
function defaultReplaceCheckedPaths(files) {
  const list = Array.isArray(files) ? files : [];
  return new Set(
    list
      .filter((f) => f && f.eligible && typeof f.path === "string")
      .map((f) => f.path),
  );
}

// The file set to submit as `files` on POST /api/files/replace (preview:
// false) — only paths that are BOTH eligible and currently checked. Order
// follows `files` (not Set iteration order) so it is deterministic.
function buildReplaceApplyFileList(files, checkedPaths) {
  const list = Array.isArray(files) ? files : [];
  const checked =
    checkedPaths instanceof Set ? checkedPaths : new Set(checkedPaths || []);
  return list
    .filter((f) => f && f.eligible && checked.has(f.path))
    .map((f) => f.path);
}

// Human summary of an apply response's per-state counts, e.g.
// "3 replaced, 1 skipped (conflict), 1 dropped (symlink)".
function formatReplaceCounts(counts) {
  if (!counts || typeof counts !== "object") return "No files changed";
  const parts = [];
  if (counts.replaced) parts.push(`${counts.replaced} replaced`);
  if (counts.skipped_conflict)
    parts.push(`${counts.skipped_conflict} skipped (changed on disk)`);
  if (counts.skipped_truncated)
    parts.push(`${counts.skipped_truncated} skipped (truncated)`);
  if (counts.dropped_symlink)
    parts.push(`${counts.dropped_symlink} dropped (symlink)`);
  if (counts.error)
    parts.push(`${counts.error} error${counts.error === 1 ? "" : "s"}`);
  return parts.length ? parts.join(", ") : "No files changed";
}

// Per-file result-state → short badge text for the post-apply render.
function replaceResultBadge(state) {
  switch (state) {
    case "replaced":
      return "Replaced";
    case "skipped_conflict":
      return "Skipped — changed on disk";
    case "skipped_truncated":
      return "Skipped — truncated";
    case "dropped_symlink":
      return "Dropped — symlink";
    case "error":
      return "Error";
    default:
      return "";
  }
}

// ── DOM controller (browser-only) ────────────────────────────────────────────

// Options:
//   document            the DOM document (defaults to global document)
//   getTerminalManager  () => the live TerminalManager (open-at-line + cwd)
//   fetchImpl           fetch (defaults to global fetch) — injectable for tests
//   debounceMs          query debounce (default 250)
const DEFAULT_DEBOUNCE_MS = 250;
const MAX_QUERY_LEN = 200; // stricter UI limit; the server cap is 1024 (SEARCH_MAX_QUERY_LEN)

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

    // ── Replace-in-files state (D4) ────────────────────────────────────────
    this._replaceMode = false; // replacement row visible
    this._replacePhase = "idle"; // idle | previewing | preview | applying | applied
    this._replaceData = null; // last POST /api/files/replace preview response
    this._checkedPaths = new Set(); // paths currently checked in the preview
    this._applyResult = null; // last apply response ({results, counts})
    this._replaceStatus = ""; // status line shown above the replace results
    this._replaceRequestSeq = 0; // staleness guard for preview/apply calls
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
    // Same staleness treatment for any in-flight replace preview/apply call.
    this._replaceRequestSeq++;
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
        <button type="button" class="ide-search-replace-toggle" title="Toggle Replace" aria-label="Toggle Replace">&#8644;</button>
      </div>
      <div class="ide-search-replace-row" hidden>
        <input type="text" class="ide-search-replace-input" placeholder="Replace" maxlength="${MAX_QUERY_LEN}" autocomplete="off" spellcheck="false" />
        <button type="button" class="ide-search-replace-btn">Replace&hellip;</button>
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
    if (
      this._replaceMode &&
      (this._replacePhase === "preview" ||
        this._replacePhase === "applying" ||
        this._replacePhase === "applied")
    ) {
      host.innerHTML = this.renderReplacePreviewHtml();
      return;
    }
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

  // Renders the replace preview/apply view: per-file include checkboxes (the
  // token/apply contract binds a FILE set — no per-match selection in v1),
  // before/after LINE previews, an eligibility badge (previewIncomplete /
  // globallyTruncated), and — once applied — a per-file result badge. Every
  // user-supplied string (paths, before/after text) goes through this.esc().
  renderReplacePreviewHtml() {
    const data = this._replaceData;
    if (!data || !Array.isArray(data.files) || data.files.length === 0) {
      return `<div class="ide-replace-empty">No matches to replace.</div>`;
    }
    const applying = this._replacePhase === "applying";
    const applied = this._replacePhase === "applied";
    const resultsByPath = new Map(
      (this._applyResult && Array.isArray(this._applyResult.results)
        ? this._applyResult.results
        : []
      ).map((r) => [r.path, r]),
    );

    let html = "";
    if (data.globallyTruncated) {
      html += `<div class="ide-replace-banner">Too many matching files — narrow your query to replace.</div>`;
    }
    for (const file of data.files) {
      const fileName = (file.path || "").split("/").pop() || file.path || "";
      const eligibilityLabel = replaceFileEligibilityLabel(
        file,
        data.globallyTruncated,
      );
      const checked = this._checkedPaths.has(file.path);
      const disabled = !file.eligible || applying || applied;
      const result = resultsByPath.get(file.path);
      const resultBadge = result ? replaceResultBadge(result.state) : "";
      const edits = (Array.isArray(file.edits) ? file.edits : [])
        .map(
          (e) => `
            <div class="ide-replace-edit">
              <div class="ide-replace-edit-before">${this.esc(e.before == null ? "" : e.before)}</div>
              <div class="ide-replace-edit-after">${this.esc(e.after == null ? "" : e.after)}</div>
            </div>`,
        )
        .join("");
      html += `
        <div class="ide-replace-file" data-path="${this.esc(file.path)}">
          <div class="ide-replace-file-header">
            <input type="checkbox" class="ide-replace-file-checkbox" data-path="${this.esc(file.path)}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} />
            <span class="ide-replace-file-name" title="${this.esc(file.path)}">${this.esc(fileName)}</span>
            <span class="ide-replace-file-count">${this.esc(String(file.matchCount || 0))}</span>
            ${eligibilityLabel ? `<span class="ide-replace-file-badge">${this.esc(eligibilityLabel)}</span>` : ""}
            ${result ? `<span class="ide-replace-file-result ide-replace-file-result-${this.esc(result.state)}">${this.esc(resultBadge)}</span>` : ""}
          </div>
          <div class="ide-replace-file-edits">${edits}</div>
        </div>`;
    }

    const checkedEligibleCount = data.files.filter(
      (f) => f.eligible && this._checkedPaths.has(f.path),
    ).length;

    html += `<div class="ide-replace-actions">`;
    if (applied) {
      html += `<span class="ide-replace-summary">${this.esc(formatReplaceCounts(this._applyResult ? this._applyResult.counts : null))}</span>`;
      html += `<button type="button" class="ide-replace-cancel-btn">Close</button>`;
    } else {
      const confirmDisabled = checkedEligibleCount === 0 || applying;
      html += `<button type="button" class="ide-replace-confirm-btn" ${confirmDisabled ? "disabled" : ""}>${applying ? "Replacing…" : `Replace ${checkedEligibleCount} file${checkedEligibleCount === 1 ? "" : "s"}`}</button>`;
      html += `<button type="button" class="ide-replace-cancel-btn" ${applying ? "disabled" : ""}>Cancel</button>`;
    }
    html += `</div>`;
    return html;
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
    const replaceToggle = this.q(".ide-search-replace-toggle");
    if (replaceToggle) {
      replaceToggle.addEventListener("click", () => this.toggleReplaceMode());
    }
    const replaceInput = this.q(".ide-search-replace-input");
    if (replaceInput) {
      replaceInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void this.runReplacePreview();
        }
      });
      replaceInput.addEventListener("input", () =>
        this.invalidateReplacePreviewOnInput(),
      );
    }
    const replaceBtn = this.q(".ide-search-replace-btn");
    if (replaceBtn) {
      replaceBtn.addEventListener("click", () => void this.runReplacePreview());
    }
    const results = this.q(".ide-search-results");
    if (results) {
      results.addEventListener("click", (e) => this.onResultClick(e));
      results.addEventListener("change", (e) =>
        this.onReplaceCheckboxChange(e),
      );
    }
  }

  currentQuery() {
    const input = this.q(".ide-search-input");
    return (input?.value || "").slice(0, MAX_QUERY_LEN);
  }

  onQueryInput() {
    this.invalidateReplacePreviewOnInput();
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
    if (e.target.closest(".ide-replace-confirm-btn")) {
      if (this._replacePhase === "preview") void this.confirmReplaceApply();
      return;
    }
    if (e.target.closest(".ide-replace-cancel-btn")) {
      this.cancelReplacePreview();
      return;
    }
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

  // ── Replace-in-files (D4) ────────────────────────────────────────────────

  replacementValue() {
    const input = this.q(".ide-search-replace-input");
    return (input?.value || "").slice(0, MAX_QUERY_LEN);
  }

  toggleReplaceMode() {
    this._replaceMode = !this._replaceMode;
    const row = this.q(".ide-search-replace-row");
    if (row) row.hidden = !this._replaceMode;
    const toggle = this.q(".ide-search-replace-toggle");
    if (toggle) toggle.classList.toggle("active", this._replaceMode);
    if (!this._replaceMode) this.cancelReplacePreview();
  }

  // Runs the preview phase: POST /api/files/replace { cwd, query, replacement,
  // preview:true }. NEVER writes. Regex is search-only (Codex F2) — refuse
  // client-side too so a user doesn't burn a round trip on a guaranteed 400.
  async runReplacePreview() {
    // The RAW query is sent — the backend deliberately preserves leading/
    // trailing whitespace for a literal replace (the token tuple must reflect
    // the exact string). Trim is only the emptiness CHECK, mirroring the
    // server's own validation.
    const query = this.currentQuery();
    if (!query.trim()) {
      this.setStatus("Type a query to replace.");
      return;
    }
    if (this._regex) {
      this.setStatus(
        "Replace does not support regex — turn off .* to replace.",
      );
      return;
    }
    const cwd = this.cwd();
    if (!cwd) {
      this.setStatus("Open a workspace to search.");
      return;
    }
    if (!this.fetchImpl) return;

    const seq = ++this._replaceRequestSeq;
    this._replacePhase = "previewing";
    this._applyResult = null;
    this.setStatus("Previewing replace…");
    try {
      const res = await this.fetchImpl("/api/files/replace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cwd,
          query,
          replacement: this.replacementValue(),
          preview: true,
        }),
      });
      if (seq !== this._replaceRequestSeq) return; // a newer call superseded this one
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        this._replacePhase = "idle";
        this._replaceData = null;
        this._previewTuple = null;
        const denial =
          typeof window !== "undefined"
            ? window.AccessDenied?.describeAccessDenied?.(body)
            : null;
        this.setStatus(denial?.text || body.error || "Replace preview failed");
        this.renderResults();
        return;
      }
      this._replaceData = body;
      // Pin the EXACT tuple this preview (and its token) was minted for —
      // apply sends this, never a re-read of the live inputs, so editing a
      // field after previewing can't produce a token_mismatch surprise.
      this._previewTuple = { query, replacement: this.replacementValue() };
      this._checkedPaths = defaultReplaceCheckedPaths(body.files);
      this._replacePhase = "preview";
      const files = Array.isArray(body.files) ? body.files : [];
      const eligible = files.filter((f) => f.eligible).length;
      this.setStatus(
        body.globallyTruncated
          ? "Too many matches — narrow your query to replace."
          : `${files.length} file${files.length === 1 ? "" : "s"} match (${eligible} replaceable)`,
      );
      this.renderResults();
    } catch {
      if (seq !== this._replaceRequestSeq) return;
      this._replacePhase = "idle";
      this.setStatus("Replace preview failed");
      this.renderResults();
    }
  }

  onReplaceCheckboxChange(e) {
    const box = e.target.closest(".ide-replace-file-checkbox");
    if (!box) return;
    const path = box.dataset.path;
    if (!path) return;
    if (box.checked) this._checkedPaths.add(path);
    else this._checkedPaths.delete(path);
    this.renderResults(); // refresh the confirm button's count/enabled state
  }

  // Apply phase: POST /api/files/replace { ..., preview:false, previewToken,
  // files }. `files` is built from the CURRENT checkbox selection intersected
  // with eligibility (buildReplaceApplyFileList) — the token/apply contract
  // binds this file set server-side.
  async confirmReplaceApply() {
    if (
      !this._replaceData ||
      !this._previewTuple ||
      this._replacePhase !== "preview"
    )
      return;
    // Belt-and-braces (Codex pre-final finding 2): the regex toggle already
    // invalidates any live preview via onQueryInput → invalidateReplace-
    // PreviewOnInput, but a literal preview must never apply while the UI is
    // visibly in regex mode regardless of event ordering.
    if (this._regex) {
      this.setStatus(
        "Replace does not support regex — turn off .* to replace.",
      );
      return;
    }
    const cwd = this.cwd();
    const files = buildReplaceApplyFileList(
      this._replaceData.files,
      this._checkedPaths,
    );
    if (!cwd || files.length === 0 || !this.fetchImpl) return;

    const seq = ++this._replaceRequestSeq;
    this._replacePhase = "applying";
    this.renderResults();
    this.setStatus("Applying replace…");
    try {
      const res = await this.fetchImpl("/api/files/replace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cwd,
          // The pinned preview tuple, NOT a live input re-read (the token was
          // signed over exactly these strings).
          query: this._previewTuple.query,
          replacement: this._previewTuple.replacement,
          preview: false,
          previewToken: this._replaceData.previewToken,
          files,
        }),
      });
      if (seq !== this._replaceRequestSeq) return;
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        this._replacePhase = "preview";
        this.setStatus(body.error || "Replace failed");
        this.renderResults();
        return;
      }
      this._applyResult = body;
      this._replacePhase = "applied";
      this.setStatus(formatReplaceCounts(body.counts));
      this.renderResults();
    } catch {
      if (seq !== this._replaceRequestSeq) return;
      this._replacePhase = "preview";
      this.setStatus("Replace failed");
      this.renderResults();
    }
  }

  cancelReplacePreview() {
    this._replaceRequestSeq++; // stale-out any in-flight preview/apply call
    this._replacePhase = "idle";
    this._replaceData = null;
    this._previewTuple = null;
    this._applyResult = null;
    this._checkedPaths = new Set();
    this.setStatus("");
    this.renderResults();
  }

  // A live preview only stays valid for the tuple it was minted for — any
  // edit to the query or replacement inputs invalidates it (the alternative,
  // applying the pinned stale tuple while the inputs show something else,
  // would be far more surprising).
  invalidateReplacePreviewOnInput() {
    if (this._replacePhase === "preview" || this._replacePhase === "applied") {
      this.cancelReplacePreview();
    }
  }
}

// ── Exports (triple pattern) ─────────────────────────────────────────────────

const SearchViewModule = {
  groupSearchResults,
  searchTotalMatches,
  isStaleResponse,
  searchResultLineLabel,
  replaceFileEligibilityLabel,
  defaultReplaceCheckedPaths,
  buildReplaceApplyFileList,
  formatReplaceCounts,
  replaceResultBadge,
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
  exports.replaceFileEligibilityLabel = replaceFileEligibilityLabel;
  exports.defaultReplaceCheckedPaths = defaultReplaceCheckedPaths;
  exports.buildReplaceApplyFileList = buildReplaceApplyFileList;
  exports.formatReplaceCounts = formatReplaceCounts;
  exports.replaceResultBadge = replaceResultBadge;
  exports.SearchViewController = SearchViewController;
}
