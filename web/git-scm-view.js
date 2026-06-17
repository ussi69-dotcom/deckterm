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

// ── Pure helpers (DOM-free, unit-tested) ─────────────────────────────────────

// The three SCM group section descriptors, in render order, with the file list
// + the group-level action for each. `mode` is the diff mode a file in that
// group opens with: staged files diff their INDEX (mode "staged"); everything
// else diffs the working tree (mode "working"). Pure over a grouped-files map
// (the shape groupStatusFiles returns).
function scmSections(groups) {
  const g = groups || {};
  return [
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

// The diff mode a file opens with given the group it lives in. Staged group →
// "staged" (diff the INDEX side); Changes/Untracked → "working".
function scmDiffModeForSection(sectionKey) {
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
    // In-section collapse + branches/stashes section collapse (UI-local).
    this.collapsed = { branches: true, stashes: false };
    // Subscriptions to tear down on unmount.
    this._unsubscribe = null;
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
    // Ensure the GitManager has a cwd to work with (the active workspace).
    if (!gm.state?.cwd && !gm.currentCwd) {
      const tm = this.terminalManager;
      const cwd = tm?.getActiveWorkspaceContext?.()?.cwd;
      if (cwd) {
        gm.state.cwd = cwd;
        gm.currentCwd = cwd;
      }
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

  esc(text) {
    const div = this.doc.createElement("div");
    div.textContent = text == null ? "" : String(text);
    return div.innerHTML;
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

    this.renderTree(groups, scm);
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
        staged: fileSig(groups.staged),
        changes: fileSig(groups.changes),
        untracked: fileSig(groups.untracked),
        branchList: Array.isArray(branches.list) ? branches.list : [],
        stashes: stashes.map((s) => `${s.index}:${s.message}`),
        collBranches: !!this.collapsed.branches,
        collStashes: !!this.collapsed.stashes,
      });
    } catch {
      return null;
    }
  }

  renderTree(groups, scm) {
    const tree = this.q(".ide-scm-tree");
    if (!tree) return;
    const sections = scmSections(groups);
    const total = scmTotalCount(groups);
    if (total === 0) {
      tree.innerHTML = '<p class="ide-scm-empty">No changes</p>';
      return;
    }

    let html = "";
    for (const section of sections) {
      if (section.files.length === 0) continue;
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
      }
      return;
    }

    // File row click → open the diff as an editor tab.
    this.openDiff(path, scmDiffModeForSection(sectionKey));
  }

  onSectionsClick(e) {
    const gm = this.gitManager;
    if (!gm) return;
    // Section collapse toggles.
    const header = e.target.closest(".ide-scm-section-header");
    if (header) {
      const section = header.dataset.section;
      if (section === "branches") {
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
