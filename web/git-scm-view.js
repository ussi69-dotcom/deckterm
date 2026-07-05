// VS Code Source Control sidebar view (IDE shell, phase 5 — slice 5).
//
// Re-skins the git panel into a VS Code SCM view mounted in the IDE sidebar:
//   - a commit message box + commit / amend on top
//   - a compact action row (refresh / pull / push / fetch / stash)
//   - the changed files grouped into Staged / Changes / Untracked with VS Code
//     status letters (M/A/D/U/R…) + per-file hover actions (open / discard /
//     stage|unstage), and group-level stage-all / unstage-all
//   - branches + stashes as collapsible sections
//
// It does NOT own git logic. All mutations + fetches reuse the live GitManager
// instance (stage / unstage / discard / commit / sync / stash / branches /
// timeline + the shared git-status-store). Clicking a file opens its diff as an
// EDITOR TAB via terminalManager.openDiffTab (NOT an in-panel pane); timeline
// revisions open commit-mode diff tabs the same way.
//
// ViewHost contract (template-owning re-host): mount(container) builds the SCM
// skeleton into the container, unmount() removes it (model state lives in the
// GitManager + git-status-store, so a re-mount restores from state), resize()
// is a no-op (no measured editors live here — diffs render in editor tabs).
//
// The pure helpers (status grouping/letters reuse git-scm.js; the group-section
// descriptor builder lives here) are DOM-free + unit-tested in bun.

// ── git-scm.js bridge (browser globals OR CommonJS under bun) ─────────────────

// Resolve the shared HTML escaper (browser global OR CommonJS under bun). The
// single security primitive for escaping user-controlled text into innerHTML —
// including ATTRIBUTE contexts (it escapes " and ' too, unlike the old
// textContent round-trip). Falls back to an inline copy of the same algorithm
// if the module can't be resolved, so the view never degrades to an unsafe
// escape. Sites it protects here include data-path, title=…, data-branch, and
// the user-supplied stash message.
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

function getScm() {
  if (
    typeof statusLetter === "function" &&
    typeof statusClass === "function" &&
    typeof groupStatusFiles === "function"
  ) {
    return { statusLetter, statusClass, groupStatusFiles };
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

// Resolve the merge-conflicts parser module (browser global OR CommonJS under
// bun). Returns { parseConflictBlocks, resolveConflicts } or null.
function getMergeConflicts() {
  if (
    typeof window !== "undefined" &&
    window.MergeConflicts?.parseConflictBlocks
  ) {
    return window.MergeConflicts;
  }
  if (typeof require !== "undefined") {
    try {
      return require("./merge-conflicts");
    } catch {
      return null;
    }
  }
  return null;
}

// Resolve the GitHistoryView module (browser global OR CommonJS under bun).
// Returns { GitHistoryViewController } or null when not available.
function getGitHistoryView() {
  if (
    typeof window !== "undefined" &&
    window.GitHistoryView?.GitHistoryViewController
  ) {
    return window.GitHistoryView;
  }
  if (typeof require !== "undefined") {
    try {
      return require("./git-history-view");
    } catch {
      return null;
    }
  }
  return null;
}

// ── Pure helpers (DOM-free, unit-tested) ─────────────────────────────────────

// The SCM group section descriptors, in render order, with the file list +
// the group-level action for each. `mode` is the diff mode a file in that
// group opens with: merge (conflicted) files diff ours/theirs (mode
// "conflict"); staged files diff their INDEX (mode "staged"); everything else
// diffs the working tree (mode "working"). Pure over a grouped-files map (the
// shape groupStatusFiles returns). "Merge Changes" leads (Track D slice D3) —
// conflicts are the most urgent thing in the tree, VS Code-style. It has no
// group-level bulk action (there's no sane "resolve all" — each file's
// eligibility for even a single-file accept action is resolved individually).
function scmSections(groups) {
  const g = groups || {};
  return [
    {
      key: "merge",
      label: "Merge Changes",
      files: Array.isArray(g.merge) ? g.merge : [],
      groupAction: null,
      mode: "conflict",
    },
    {
      key: "staged",
      label: "Staged Changes",
      files: Array.isArray(g.staged) ? g.staged : [],
      groupAction: "unstage-all",
      mode: "staged",
    },
    {
      key: "changes",
      label: "Changes",
      files: Array.isArray(g.changes) ? g.changes : [],
      groupAction: "stage-all",
      mode: "working",
    },
    {
      key: "untracked",
      label: "Untracked",
      files: Array.isArray(g.untracked) ? g.untracked : [],
      groupAction: "stage-all",
      mode: "working",
    },
  ];
}

// Total count of changed files across all groups.
function scmTotalCount(groups) {
  return scmSections(groups).reduce((n, s) => n + s.files.length, 0);
}

// The diff mode a file opens with given the group it lives in. Merge → the
// ours/theirs conflict diff; Staged → "staged" (diff the INDEX side);
// Changes/Untracked → "working".
function scmDiffModeForSection(sectionKey) {
  if (sectionKey === "merge") return "conflict";
  return sectionKey === "staged" ? "staged" : "working";
}

// ── DOM controller (browser-only) ────────────────────────────────────────────

// Options:
//   document       the DOM document (defaults to global document)
//   getGitManager  () => the live GitManager (resolved lazily; built after this)
//   getTerminalManager () => the live TerminalManager (for openDiffTab)
//   getStatusStore () => the shared GitStatusStore (decoration sync)
class GitScmViewController {
  constructor(options = {}) {
    this.doc =
      options.document || (typeof document !== "undefined" ? document : null);
    this.getGitManagerFn =
      typeof options.getGitManager === "function"
        ? options.getGitManager
        : () => options.gitManager || null;
    this.getTerminalManagerFn =
      typeof options.getTerminalManager === "function"
        ? options.getTerminalManager
        : () =>
            options.terminalManager ||
            (typeof window !== "undefined" ? window.terminalManager : null);
    this.getStatusStoreFn =
      typeof options.getStatusStore === "function"
        ? options.getStatusStore
        : () => options.statusStore || null;

    this.root = null; // the mounted skeleton element
    this.container = null; // the host slot
    // In-section collapse + branches/stashes/history section collapse (UI-local).
    // History defaults to collapsed (lazy fetch on first expand).
    this.collapsed = { branches: true, stashes: false, history: true };
    // History scope: "repo" (whole-repo log, 6a) or "file" (active editor file's
    // commits, 6b). UI-local; defaults to repo.
    this.historyScope = "repo";
    // GitHistoryViewController instance + the path it was built for, so a scope
    // change (repo↔file or file→file) can recreate it. Created lazily on expand.
    this._historyCtl = null;
    this._historyPath = null;
    // Subscriptions to tear down on unmount.
    this._unsubscribe = null;

    // Merge-conflict accept-button eligibility (Track D slice D3 / Codex F9):
    // a UU/AA conflict row only gets accept-current/incoming/both buttons when
    // its FETCHED content actually parses into marker-bearing conflict blocks
    // (a UU/AA file can be "clean" of markers if the user already hand-edited
    // it in the terminal). That requires an async fetch + parse, so eligibility
    // is resolved lazily and cached — keyed by path, tagged with the "merge
    // status generation" it was resolved for. `_mergeSig` is the merge group's
    // content signature (path+status); whenever it changes we bump
    // `_conflictGeneration`, which invalidates every prior cache entry (a
    // resolve from a superseded status snapshot never renders stale buttons).
    this._conflictEligibility = new Map(); // path -> { generation, eligible }
    this._conflictChecksInFlight = new Set(); // "generation:path" in flight
    this._conflictGeneration = 0;
    this._mergeSig = null;
  }

  get gitManager() {
    return this.getGitManagerFn();
  }
  get terminalManager() {
    return this.getTerminalManagerFn();
  }
  get statusStore() {
    return this.getStatusStoreFn();
  }

  // ── ViewHost lifecycle ──────────────────────────────────────────────────────

  // Build the SCM skeleton into the container + wire events. Template-owning:
  // mount generates the markup, unmount removes it. Refreshes from the live git
  // state immediately (reusing the GitManager's fetch path).
  mount(container) {
    if (!container || !this.doc) return;
    if (this.root) this.unmount();
    this.container = container;
    const root = this.doc.createElement("div");
    root.className = "ide-scm-view";
    root.innerHTML = this.skeletonHtml();
    container.appendChild(root);
    this.root = root;
    this.bindEvents();

    // Subscribe to the shared status store so an EXTERNAL mutation refreshes us.
    // render() dedupes by a content signature, so a self-induced onChange from
    // this view's own refresh() (identical state) is a no-op rebuild, while a
    // genuine external change rebuilds us — without a fragile timing guard.
    this._renderSig = null;
    const store = this.statusStore;
    if (store && typeof store.onChange === "function") {
      this._unsubscribe = store.onChange(() => this.render());
    }

    // Render whatever the GitManager already has, then refresh from the server.
    this.render();
    void this.refresh();
  }

  // Detach listeners + remove the skeleton. Model state persists in the
  // GitManager + status store, so a later mount() restores from state.
  unmount() {
    if (this._unsubscribe) {
      try {
        this._unsubscribe();
      } catch {
        // best-effort
      }
      this._unsubscribe = null;
    }
    if (this._historyCtl) {
      this._historyCtl.unmount();
      this._historyCtl = null;
    }
    if (this.root && this.root.parentElement) {
      this.root.parentElement.removeChild(this.root);
    }
    this.root = null;
    this.container = null;
  }

  dispose() {
    this.unmount();
  }

  // No measured editors live in the SCM view (diffs render in editor tabs), so a
  // resize is a no-op — kept for the ViewHost contract.
  resize() {}

  // ── Data ────────────────────────────────────────────────────────────────────

  // Re-fetch git state through the GitManager (status/log/stash). The GitManager
  // already invalidates the shared status store + refreshes explorer decorations
  // inside refresh(), so decorations stay in sync. We re-render after.
  async refresh() {
    const gm = this.gitManager;
    if (!gm) return;
    // Re-resolve the LIVE cwd on EVERY refresh (not just when gm has none set)
    // — this used to only fire once, so after the first (often wrong) value it
    // never updated and the panel froze on the initial cwd. getGitCwd() is the
    // canonical source (explorer path, falling back to the active workspace).
    const cwd = this.terminalManager?.getGitCwd?.();
    if (cwd) {
      if (gm.state) gm.state.cwd = cwd;
      gm.currentCwd = cwd;
    }
    try {
      await gm.refresh();
    } catch {
      // refresh failures are surfaced in-panel; never throw into the view.
    }
    // Render once after the state is fresh. gm.refresh() also fires a
    // fire-and-forget force-refresh of the shared status store that later EMITS
    // onChange → our subscription's render(); render() DEDUPES by a content
    // signature, so those self-induced onChange renders that rebuild identical
    // state are skipped. Net: a manual refresh produces exactly one DOM rebuild
    // (the review-flagged double render is gone), while a genuine external
    // change — a different signature — still rebuilds us.
    this.render();
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  skeletonHtml() {
    return `
      <div class="ide-scm-commit">
        <textarea class="ide-scm-message" placeholder="Message (commit on Ctrl+Enter)" rows="2"></textarea>
        <div class="ide-scm-commit-row">
          <label class="ide-scm-amend" title="Amend the last commit"><input type="checkbox" class="ide-scm-amend-input" /> Amend</label>
          <button type="button" class="ide-scm-commit-btn" title="Commit staged changes">Commit</button>
        </div>
        <div class="ide-scm-commit-status"></div>
      </div>
      <div class="ide-scm-actions">
        <span class="ide-scm-branch" title="Current branch"></span>
        <span class="ide-scm-sync" title="Commits behind↓ / ahead↑"></span>
        <span class="ide-scm-actions-spacer"></span>
        <button type="button" class="ide-scm-action" data-action="refresh" title="Refresh">&#x21bb;</button>
        <button type="button" class="ide-scm-action" data-action="pull" title="Pull">&#x2193;</button>
        <button type="button" class="ide-scm-action" data-action="push" title="Push">&#x2191;</button>
        <button type="button" class="ide-scm-action" data-action="fetch" title="Fetch">&#x21e3;</button>
        <button type="button" class="ide-scm-action" data-action="stash" title="Stash changes">&#x2261;</button>
      </div>
      <div class="ide-scm-tree"></div>
      <div class="ide-scm-sections">
        <div class="ide-scm-section ide-scm-history">
          <div class="ide-scm-section-header" data-section="history">
            <span class="ide-scm-section-chevron"></span>
            <span class="ide-scm-section-label">History</span>
            <span class="ide-scm-history-scope">
              <button type="button" class="ide-scm-history-scope-btn" data-history-scope="repo" title="Repository history">Repo</button>
              <button type="button" class="ide-scm-history-scope-btn" data-history-scope="file" title="Active file history">File</button>
            </span>
          </div>
          <div class="ide-scm-section-body ide-scm-history-body"></div>
        </div>
        <div class="ide-scm-section ide-scm-branches">
          <div class="ide-scm-section-header" data-section="branches">
            <span class="ide-scm-section-chevron"></span>
            <span class="ide-scm-section-label">Branches</span>
          </div>
          <div class="ide-scm-section-body ide-scm-branches-body"></div>
        </div>
        <div class="ide-scm-section ide-scm-stashes">
          <div class="ide-scm-section-header" data-section="stashes">
            <span class="ide-scm-section-chevron"></span>
            <span class="ide-scm-section-label">Stashes</span>
          </div>
          <div class="ide-scm-section-body ide-scm-stashes-body"></div>
        </div>
      </div>
    `;
  }

  q(sel) {
    return this.root ? this.root.querySelector(sel) : null;
  }

  // Delegate to the shared HTML escaper (escapes & < > " ' — safe for the
  // attribute interpolation sites: data-path, title=…, data-branch, stash msg).
  esc(text) {
    return resolveEscapeHtml()(text);
  }

  render() {
    if (!this.root) return;
    const gm = this.gitManager;
    const scm = getScm();
    if (!gm || !scm) return;

    const groups = gm.state?.files || {
      staged: [],
      changes: [],
      untracked: [],
    };

    // Dedupe: skip the DOM rebuild when nothing the SCM view shows has changed.
    // A manual refresh triggers BOTH an explicit render() and (later, async) a
    // self-induced store onChange → render() of identical state; this guard makes
    // the redundant rebuild a no-op (the review-flagged double render) while a
    // genuine change — different signature — still rebuilds. The signature spans
    // everything render() paints: branch/sync, grouped file path+status, branch
    // list, stash list, and the UI-local section-collapse flags.
    const sig = this.renderSignature(gm, groups, scm);
    if (sig !== null && sig === this._renderSig) return;
    this._renderSig = sig;

    // Branch + sync header.
    const branchEl = this.q(".ide-scm-branch");
    if (branchEl) branchEl.textContent = gm.state?.branches?.current || "";
    const syncEl = this.q(".ide-scm-sync");
    if (syncEl && typeof window !== "undefined" && window.syncLabel) {
      const sync = gm.state?.sync || { ahead: 0, behind: 0 };
      syncEl.textContent = window.syncLabel(sync.ahead, sync.behind);
    } else if (syncEl) {
      const sync = gm.state?.sync || { ahead: 0, behind: 0 };
      const parts = [];
      if (sync.behind > 0) parts.push(`${sync.behind}↓`);
      if (sync.ahead > 0) parts.push(`${sync.ahead}↑`);
      syncEl.textContent = parts.join(" ");
    }

    this.renderTree(groups, scm, gm.state?.error || null);
    this.renderHistory();
    this.renderBranches(gm);
    this.renderStashes(gm);
  }

  // A cheap content signature over EVERYTHING render() paints, so identical
  // re-renders (e.g. a self-induced store onChange after a manual refresh) can be
  // skipped. Returns null when state is too sparse to fingerprint safely (then
  // render() never dedupes). Includes the UI-local section-collapse flags so a
  // collapse/expand still rebuilds.
  renderSignature(gm, groups, scm) {
    try {
      const fileSig = (arr) =>
        (Array.isArray(arr) ? arr : [])
          .map((f) => `${f.path}:${scm.statusLetter(f)}`)
          .join(",");
      const sync = gm.state?.sync || {};
      const branches = gm.state?.branches || {};
      const stashes = gm.state?.stashes || [];
      return JSON.stringify({
        branch: branches.current || "",
        ahead: sync.ahead || 0,
        behind: sync.behind || 0,
        error: gm.state?.error || "",
        staged: fileSig(groups.staged),
        changes: fileSig(groups.changes),
        untracked: fileSig(groups.untracked),
        branchList: Array.isArray(branches.list) ? branches.list : [],
        stashes: stashes.map((s) => `${s.index}:${s.message}`),
        collBranches: !!this.collapsed.branches,
        collStashes: !!this.collapsed.stashes,
        collHistory: !!this.collapsed.history,
        histScope: this.historyScope,
      });
    } catch {
      return null;
    }
  }

  renderTree(groups, scm, errorMessage) {
    // Remembered so a merge-conflict eligibility resolution (async, arrives
    // well after render()'s dedupe already latched _renderSig) can re-invoke
    // renderTree() directly — bypassing that dedupe — with the same inputs.
    this._lastTreeGroups = groups;
    this._lastTreeScm = scm;
    this._lastTreeError = errorMessage || null;

    const tree = this.q(".ide-scm-tree");
    if (!tree) return;
    // A status-fetch error (most commonly "Not a git repository") must show a
    // distinct banner — NOT the silent "No changes" empty state the classic
    // Git window would never show in this situation. Mirrors the classic
    // window's `.error` red banner (reuses that existing shared class).
    if (errorMessage) {
      tree.innerHTML = `<p class="error">${this.esc(errorMessage)}</p>`;
      return;
    }
    const sections = scmSections(groups);
    const total = scmTotalCount(groups);
    if (total === 0) {
      tree.innerHTML = '<p class="ide-scm-empty">No changes</p>';
      return;
    }

    // Merge-conflict eligibility cache generation (Track D slice D3): bump
    // whenever the merge group's path+status set changes, invalidating every
    // previously-resolved eligibility (a stale "eligible" from a superseded
    // conflict never lingers once the underlying status snapshot moves on).
    const mergeSection = sections.find((s) => s.key === "merge");
    const mergeSig = (mergeSection?.files || [])
      .map((f) => `${f.path}:${f.status || ""}`)
      .join(",");
    if (mergeSig !== this._mergeSig) {
      this._mergeSig = mergeSig;
      this._conflictGeneration += 1;
    }

    let html = "";
    for (const section of sections) {
      if (section.files.length === 0) continue;
      if (section.key === "merge") {
        html += this.renderMergeGroupHtml(section, scm);
        continue;
      }
      const groupGlyph = section.groupAction === "unstage-all" ? "−" : "+";
      const groupTitle =
        section.groupAction === "unstage-all" ? "Unstage all" : "Stage all";
      const rows = section.files
        .map((file) => {
          const letter = scm.statusLetter(file);
          const colorClass = scm.statusClass(letter);
          const fileName =
            (file.path || "").split("/").pop() || file.path || "";
          const staged = section.key === "staged";
          const stageGlyph = staged ? "−" : "+";
          const stageTitle = staged ? "Unstage" : "Stage";
          const discardTitle =
            letter === "U" ? "Delete untracked file" : "Discard changes";
          return `
            <div class="ide-scm-file" data-path="${this.esc(file.path)}" data-section="${section.key}">
              <span class="ide-scm-file-name ${colorClass}" title="${this.esc(file.path)}">${this.esc(fileName)}</span>
              <span class="ide-scm-file-actions">
                <button type="button" class="ide-scm-file-action" data-file-action="open" title="Open file">⤢</button>
                <button type="button" class="ide-scm-file-action" data-file-action="discard" title="${discardTitle}">⟲</button>
                <button type="button" class="ide-scm-file-action" data-file-action="stage" title="${stageTitle}">${stageGlyph}</button>
              </span>
              <span class="ide-scm-file-status ${colorClass}" title="${this.esc(letter)}">${this.esc(letter)}</span>
            </div>`;
        })
        .join("");
      html += `
        <div class="ide-scm-group ide-scm-group-${section.key}">
          <div class="ide-scm-group-header">
            <span class="ide-scm-group-label">${section.label}</span>
            <span class="ide-scm-group-count">${section.files.length}</span>
            <button type="button" class="ide-scm-group-action" data-group="${section.key}" data-group-action="${section.groupAction}" title="${groupTitle}">${groupGlyph}</button>
          </div>
          <div class="ide-scm-group-items">${rows}</div>
        </div>`;
    }
    tree.innerHTML = html;
  }

  // The "Merge Changes" group: no bulk group action (unlike the other
  // sections), and every row's actions depend on per-file eligibility (Codex
  // F9) rather than a uniform stage/discard/open trio.
  renderMergeGroupHtml(section, scm) {
    const rows = section.files
      .map((file) => this.renderMergeFileHtml(file, scm))
      .join("");
    return `
      <div class="ide-scm-group ide-scm-group-merge">
        <div class="ide-scm-group-header">
          <span class="ide-scm-group-label">${section.label}</span>
          <span class="ide-scm-group-count">${section.files.length}</span>
        </div>
        <div class="ide-scm-group-items">${rows}</div>
      </div>`;
  }

  // A single conflict row. Accept buttons render ONLY when the file's XY
  // shape is UU/AA AND its fetched content actually parses into conflict
  // markers (Codex F9) — every other shape (DD/AU/UD/UA/DU, or a UU/AA file
  // with no markers left) gets the conflict badge + a "resolve in terminal"
  // hint instead. Eligibility is async (fetch + parse) so it renders "hint"
  // until resolved, then re-renders once known (see getConflictEligibility).
  renderMergeFileHtml(file, scm) {
    const letter = scm.statusLetter(file); // always "C" for a conflicted file
    const colorClass = scm.statusClass(letter);
    const fileName = (file.path || "").split("/").pop() || file.path || "";
    const xy = file.status || "";
    const checkable = xy === "UU" || xy === "AA";
    const eligible = checkable && this.getConflictEligibility(file);
    const actionsHtml = eligible
      ? `
              <button type="button" class="ide-scm-file-action" data-file-action="accept-current" title="Accept Current (keep ours)">⇦</button>
              <button type="button" class="ide-scm-file-action" data-file-action="accept-incoming" title="Accept Incoming (keep theirs)">⇨</button>
              <button type="button" class="ide-scm-file-action" data-file-action="accept-both" title="Accept Both">⇹</button>`
      : `
              <span class="ide-scm-merge-hint" title="Binary conflicts and files over the editor size limit resolve in the terminal">resolve in terminal</span>`;
    return `
            <div class="ide-scm-file ide-scm-merge-file" data-path="${this.esc(file.path)}" data-section="merge">
              <span class="ide-scm-file-name ${colorClass}" title="${this.esc(file.path)}">${this.esc(fileName)}</span>
              <span class="ide-scm-file-actions">${actionsHtml}</span>
              <span class="ide-scm-file-status ${colorClass}" title="${this.esc(letter)}">${this.esc(letter)}</span>
            </div>`;
  }

  // Resolves (and caches, per merge-status generation) whether `file` is
  // eligible for accept buttons: its content must actually fetch and parse
  // into marker-bearing conflict blocks. Returns false (render the "resolve in
  // terminal" hint) until the async check completes, then triggers a direct
  // renderTree() re-run (bypassing render()'s signature dedupe, which doesn't
  // span per-file eligibility) so the row updates in place.
  getConflictEligibility(file) {
    const cached = this._conflictEligibility.get(file.path);
    if (cached && cached.generation === this._conflictGeneration) {
      return cached.eligible;
    }
    const generation = this._conflictGeneration;
    const inFlightKey = `${generation}:${file.path}`;
    if (!this._conflictChecksInFlight.has(inFlightKey)) {
      this._conflictChecksInFlight.add(inFlightKey);
      void this.fetchConflictEligibility(file, generation).finally(() => {
        this._conflictChecksInFlight.delete(inFlightKey);
      });
    }
    return false;
  }

  async fetchConflictEligibility(file, generation) {
    let eligible = false;
    try {
      const cwd = (this.cwd() || "").replace(/\/$/, "");
      const res = await fetch(
        `/api/files/content?path=${encodeURIComponent(`${cwd}/${file.path}`)}`,
      );
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const mc = getMergeConflicts();
        if (mc && typeof data.content === "string") {
          const parsed = mc.parseConflictBlocks(data.content);
          eligible = !!(parsed.ok && parsed.hasConflicts);
        }
      }
    } catch {
      eligible = false;
    }
    this._conflictEligibility.set(file.path, { generation, eligible });
    // A stale generation (the merge set moved on while this fetch was in
    // flight) never triggers a render — the cache entry is simply orphaned.
    if (generation === this._conflictGeneration) {
      this.renderTree(
        this._lastTreeGroups,
        this._lastTreeScm,
        this._lastTreeError,
      );
    }
  }

  renderHistory() {
    const body = this.q(".ide-scm-history-body");
    const section = this.q(".ide-scm-history");
    if (!body || !section) return;
    section.classList.toggle("collapsed", this.collapsed.history);
    this.setChevron(
      ".ide-scm-history .ide-scm-section-chevron",
      this.collapsed.history,
    );
    this.updateHistoryScopeButtons();
    if (this.collapsed.history) {
      // Collapsed: unmount the history controller to free resources.
      if (this._historyCtl) {
        this._historyCtl.unmount();
        this._historyCtl = null;
      }
      this._historyPath = null;
      body.innerHTML = "";
      return;
    }
    // Expanded: mount/refresh the history controller into the body.
    const ghv = getGitHistoryView();
    if (!ghv) {
      body.innerHTML = '<p class="ide-scm-empty">History view unavailable</p>';
      return;
    }

    // Resolve the scope path: file-scope (6b) needs an active editor file, else
    // null (repo-wide, 6a). When file-scope is selected but no file is active,
    // show a hint instead of mounting an empty repo log.
    const desiredPath =
      this.historyScope === "file" ? this.activeFileRelPath() : null;
    if (this.historyScope === "file" && !desiredPath) {
      if (this._historyCtl) {
        this._historyCtl.unmount();
        this._historyCtl = null;
      }
      this._historyPath = null;
      body.innerHTML =
        '<p class="ide-scm-empty">Open a file to see its history</p>';
      return;
    }

    // Recreate the controller when the scope path changes (repo↔file, file→file).
    if (this._historyCtl && this._historyPath !== desiredPath) {
      this._historyCtl.unmount();
      this._historyCtl = null;
    }
    if (!this._historyCtl) {
      // Clear any stale empty-hint/markup so it doesn't linger above the freshly
      // mounted history list (the controller appends its own root, it doesn't
      // own the whole body).
      body.innerHTML = "";
      this._historyPath = desiredPath;
      this._historyCtl = new ghv.GitHistoryViewController({
        document: this.doc,
        getTerminalManager: this.getTerminalManagerFn,
        getCwd: () => this.cwd(),
        path: desiredPath,
      });
      this._historyCtl.mount(body);
    } else {
      // Already mounted with the same scope — refresh to pick up cwd changes.
      void this._historyCtl.refresh();
    }
  }

  // The active editor file's path relative to the repo cwd, or null. Powers
  // file-scoped (6b) history: the TerminalManager exposes the active file tab's
  // ABSOLUTE path; we strip the cwd prefix so /api/git/log?path= is repo-relative.
  activeFileRelPath() {
    const tm = this.terminalManager;
    const abs = tm?.getActiveEditorFilePath?.();
    if (!abs) return null;
    const cwd = (this.cwd() || "").replace(/\/$/, "");
    if (cwd && abs.startsWith(`${cwd}/`)) return abs.slice(cwd.length + 1);
    return null;
  }

  // Reflect the active history scope on the Repo/File toggle buttons.
  updateHistoryScopeButtons() {
    const btns = this.root?.querySelectorAll?.("[data-history-scope]");
    if (!btns) return;
    btns.forEach((b) =>
      b.classList.toggle(
        "active",
        b.dataset.historyScope === this.historyScope,
      ),
    );
  }

  // Host hook: the active editor tab changed. Refresh file-scoped history so it
  // follows the active file. No-op unless History is expanded AND in file scope
  // (repo-wide history doesn't depend on the active file). Called directly (not
  // via render()) so it bypasses the render() dedupe.
  onActiveFileChanged() {
    if (this.collapsed.history || this.historyScope !== "file") return;
    this.renderHistory();
  }

  renderBranches(gm) {
    const body = this.q(".ide-scm-branches-body");
    const section = this.q(".ide-scm-branches");
    if (!body || !section) return;
    section.classList.toggle("collapsed", this.collapsed.branches);
    this.setChevron(
      ".ide-scm-branches .ide-scm-section-chevron",
      this.collapsed.branches,
    );
    if (this.collapsed.branches) {
      body.innerHTML = "";
      return;
    }
    const list = gm.state?.branches?.list || [];
    const current = gm.state?.branches?.current || "";
    if (list.length === 0) {
      body.innerHTML = '<p class="ide-scm-empty">No branches</p>';
      return;
    }
    body.innerHTML = list
      .map((branch) => {
        const isCurrent = branch === current;
        return `<div class="ide-scm-branch-item ${isCurrent ? "current" : ""}" data-branch="${this.esc(branch)}"><span class="ide-scm-branch-dot">${isCurrent ? "●" : "○"}</span><span class="ide-scm-branch-name">${this.esc(branch)}</span></div>`;
      })
      .join("");
  }

  renderStashes(gm) {
    const body = this.q(".ide-scm-stashes-body");
    const section = this.q(".ide-scm-stashes");
    if (!body || !section) return;
    section.classList.toggle("collapsed", this.collapsed.stashes);
    this.setChevron(
      ".ide-scm-stashes .ide-scm-section-chevron",
      this.collapsed.stashes,
    );
    if (this.collapsed.stashes) {
      body.innerHTML = "";
      return;
    }
    const stashes = gm.state?.stashes || [];
    if (stashes.length === 0) {
      body.innerHTML = '<p class="ide-scm-empty">No stashes</p>';
      return;
    }
    body.innerHTML = stashes
      .map(
        (s) =>
          `<div class="ide-scm-stash-item" data-index="${s.index}"><span class="ide-scm-stash-msg" title="${this.esc(s.message)}">${this.esc(s.message)}</span><button type="button" class="ide-scm-stash-action" data-stash-action="apply" title="Apply">apply</button><button type="button" class="ide-scm-stash-action" data-stash-action="pop" title="Pop">pop</button><button type="button" class="ide-scm-stash-action" data-stash-action="drop" title="Drop">×</button></div>`,
      )
      .join("");
  }

  setChevron(sel, collapsed) {
    const el = this.q(sel);
    if (el) el.textContent = collapsed ? "▸" : "▾";
  }

  // ── Events ───────────────────────────────────────────────────────────────────

  bindEvents() {
    if (!this.root) return;

    // Commit box.
    const commitBtn = this.q(".ide-scm-commit-btn");
    if (commitBtn) commitBtn.addEventListener("click", () => this.commit());
    const msg = this.q(".ide-scm-message");
    if (msg) {
      msg.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          this.commit();
        }
      });
    }

    // Action row (delegated).
    const actions = this.q(".ide-scm-actions");
    if (actions) {
      actions.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-action]");
        if (!btn) return;
        this.onAction(btn.dataset.action);
      });
    }

    // Tree (delegated): file actions + file click → diff tab.
    const tree = this.q(".ide-scm-tree");
    if (tree) {
      tree.addEventListener("click", (e) => this.onTreeClick(e));
    }

    // Sections collapse + branch/stash actions (delegated on the whole root).
    const sections = this.q(".ide-scm-sections");
    if (sections) {
      sections.addEventListener("click", (e) => this.onSectionsClick(e));
    }
  }

  onAction(action) {
    const gm = this.gitManager;
    if (!gm) return;
    switch (action) {
      case "refresh":
        void this.refresh();
        break;
      case "pull":
      case "push":
      case "fetch":
        void gm.syncAction?.(action).then(() => this.render());
        break;
      case "stash":
        void gm.stashPush?.().then(() => this.render());
        break;
    }
  }

  onTreeClick(e) {
    const gm = this.gitManager;
    if (!gm) return;
    // Group-level stage-all / unstage-all.
    const groupBtn = e.target.closest(".ide-scm-group-action");
    if (groupBtn) {
      e.stopPropagation();
      const group = groupBtn.dataset.group;
      const files = gm.state?.files?.[group] || [];
      if (files.length === 0) return;
      void gm
        .stagePaths?.(
          files.map((f) => f.path),
          groupBtn.dataset.groupAction === "unstage-all",
        )
        .then(() => this.render());
      return;
    }

    const row = e.target.closest(".ide-scm-file");
    if (!row) return;
    const path = row.dataset.path;
    const sectionKey = row.dataset.section;
    const fileAction = e.target.closest(".ide-scm-file-action");
    if (fileAction) {
      e.stopPropagation();
      const action = fileAction.dataset.fileAction;
      if (action === "stage") {
        const staged = sectionKey === "staged";
        void gm.toggleStage?.(path, staged).then(() => this.render());
      } else if (action === "discard") {
        // Discard the resolved file object (it carries the status letter so
        // discardFile picks delete-vs-revert correctly). If the file is no
        // longer in the model, no-op rather than mis-classify a bare path.
        const file = this.findFile(gm, path);
        if (file) void gm.discardFile?.(file).then(() => this.render());
      } else if (action === "open") {
        this.openFile(path);
      } else if (
        action === "accept-current" ||
        action === "accept-incoming" ||
        action === "accept-both"
      ) {
        // Merge-conflict resolve (Track D slice D3): a full refresh() (not
        // just render()) — resolving changes the file's staged status, which
        // only a re-fetched /api/git/status reflects.
        const mode =
          action === "accept-current"
            ? "ours"
            : action === "accept-incoming"
              ? "theirs"
              : "both";
        void gm.resolveConflict?.(path, mode).then(() => this.refresh());
      }
      return;
    }

    // File row click → open the diff as an editor tab.
    this.openDiff(path, scmDiffModeForSection(sectionKey));
  }

  onSectionsClick(e) {
    const gm = this.gitManager;
    if (!gm) return;
    // History scope toggle (Repo/File) — caught BEFORE the header collapse so a
    // scope click doesn't also collapse the section. Picking a scope expands it.
    const scopeBtn = e.target.closest("[data-history-scope]");
    if (scopeBtn) {
      const scope = scopeBtn.dataset.historyScope;
      if (scope && scope !== this.historyScope) {
        this.historyScope = scope;
        this.collapsed.history = false;
        this.render();
      }
      return;
    }
    // Section collapse toggles.
    const header = e.target.closest(".ide-scm-section-header");
    if (header) {
      const section = header.dataset.section;
      if (section === "history") {
        this.collapsed.history = !this.collapsed.history;
        // renderHistory() mounts/unmounts the controller on expand/collapse.
        this.render();
      } else if (section === "branches") {
        this.collapsed.branches = !this.collapsed.branches;
        if (!this.collapsed.branches)
          void gm.loadBranches?.().then(() => this.render());
        else this.render();
      } else if (section === "stashes") {
        this.collapsed.stashes = !this.collapsed.stashes;
        this.render();
      }
      return;
    }
    // Branch switch.
    const branchItem = e.target.closest(".ide-scm-branch-item:not(.current)");
    if (branchItem) {
      void gm
        .switchBranch?.(branchItem.dataset.branch)
        .then(() => this.render());
      return;
    }
    // Stash actions.
    const stashBtn = e.target.closest(".ide-scm-stash-action");
    if (stashBtn) {
      const item = stashBtn.closest(".ide-scm-stash-item");
      const index = parseInt(item?.dataset.index, 10);
      void gm
        .stashAction?.(stashBtn.dataset.stashAction, index)
        .then(() => this.render());
    }
  }

  findFile(gm, path) {
    const all = [
      ...(gm.state?.files?.staged || []),
      ...(gm.state?.files?.changes || []),
      ...(gm.state?.files?.untracked || []),
    ];
    return all.find((f) => f.path === path) || null;
  }

  // ── Editor-tab integration ───────────────────────────────────────────────────

  cwd() {
    const gm = this.gitManager;
    return gm?.state?.cwd || gm?.currentCwd || "";
  }

  // Open a file's diff as an editor tab (Slice-4 API). Staged files → mode
  // "staged" (diffs the INDEX side); everything else → "working".
  openDiff(relPath, mode) {
    const tm = this.terminalManager;
    if (!tm?.openDiffTab || !relPath) return;
    tm.openDiffTab({ relPath, mode: mode || "working", cwd: this.cwd() });
  }

  // Open the working-tree file in an editor tab (or modal in terminal mode).
  openFile(relPath) {
    const tm = this.terminalManager;
    if (!tm || !relPath) return;
    const cwd = (this.cwd() || "").replace(/\/$/, "");
    const abs = `${cwd}/${relPath}`;
    if (tm.handleExplorerOpenFile)
      tm.handleExplorerOpenFile(abs, { pinned: false });
    else tm.openFileInEditor?.(abs);
  }

  commit() {
    const gm = this.gitManager;
    if (!gm) return;
    const msgEl = this.q(".ide-scm-message");
    const amendEl = this.q(".ide-scm-amend-input");
    const statusEl = this.q(".ide-scm-commit-status");
    const message = (msgEl?.value || "").trim();
    if (!message) {
      if (statusEl) statusEl.textContent = "Commit message required";
      return;
    }
    if (typeof gm.commitWith !== "function") {
      if (statusEl) statusEl.textContent = "Commit unavailable";
      return;
    }
    // Drive the commit directly through the parameterized op — no hidden-DOM
    // mirroring. The op POSTs /api/git/commit + refreshes; we reflect the
    // outcome in OUR controls (clear the box on success, surface the error).
    const amend = Boolean(amendEl?.checked);
    void gm
      .commitWith({ message, amend })
      .then((result) => {
        if (result?.ok) {
          if (msgEl) msgEl.value = "";
          if (amendEl) amendEl.checked = false;
          if (statusEl) statusEl.textContent = amend ? "Amended" : "Committed";
        } else if (statusEl) {
          statusEl.textContent = result?.error || "Commit failed";
        }
        this.render();
      })
      .catch((err) => {
        if (statusEl)
          statusEl.textContent =
            err instanceof Error ? err.message : "Commit failed";
      });
  }
}

// ── Exports (triple pattern) ─────────────────────────────────────────────────

const GitScmViewModule = {
  scmSections,
  scmTotalCount,
  scmDiffModeForSection,
  GitScmViewController,
};

if (typeof window !== "undefined") {
  window.GitScmView = GitScmViewModule;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = GitScmViewModule;
}

if (typeof exports !== "undefined") {
  exports.scmSections = scmSections;
  exports.scmTotalCount = scmTotalCount;
  exports.scmDiffModeForSection = scmDiffModeForSection;
  exports.GitScmViewController = GitScmViewController;
}
