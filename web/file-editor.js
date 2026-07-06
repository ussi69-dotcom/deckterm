// In-browser file editor (backlog #6 MVP, design:
// docs/plans/2026-06-12-file-editor-design.md). Pure helpers are exported for
// bun tests; the FileEditor class owns the modal DOM and lazily imports the
// vendored CodeMirror 6 bundle (web/vendor/codemirror.js) on first open.
// Content flows through GET/PUT /api/files/content — saves are atomic on the
// backend and guarded by expectedMtimeMs so concurrent edits 409 instead of
// clobbering.

const EDITOR_LANGUAGES = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "javascript",
  tsx: "javascript",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  html: "html",
  htm: "html",
  css: "css",
  yaml: "yaml",
  yml: "yaml",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  c: "cpp",
  h: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  rs: "rust",
  go: "go",
};

const BINARY_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "pdf",
  "zip",
  "gz",
  "tar",
  "bz2",
  "xz",
  "7z",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mp3",
  "mp4",
  "mov",
  "avi",
  "wasm",
  "so",
  "dylib",
  "exe",
  "bin",
  "sqlite",
  "db",
]);

function fileExtension(path) {
  const name =
    String(path || "")
      .split("/")
      .pop() || "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

function detectEditorLanguage(path) {
  return EDITOR_LANGUAGES[fileExtension(path)] || null;
}

function isProbablyEditable(path) {
  return !BINARY_EXTENSIONS.has(fileExtension(path));
}

// Decides whether the editor should show a change gutter vs HEAD. Returns the
// HEAD content string when the file is tracked and `git show` succeeded, else
// null (untracked file, not-a-repo, show error, or a non-string body). null
// means "do not add the merge/change-gutter extension" — the editor stays a
// plain editor with no false change bars.
function headOriginalFor(showResponse, isTracked) {
  if (!isTracked) return null;
  if (!showResponse || !showResponse.ok) return null;
  if (typeof showResponse.content !== "string") return null;
  return showResponse.content;
}

// Autosave setting values are the raw settings-schema strings ("off", "1000",
// "5000") — this is the one place that turns that into a debounce interval.
// Any other value (missing, unrecognized, non-numeric) is treated as "off" so
// a bad/legacy stored value can never spin up silent background saves.
function parseAutosaveMs(rawValue) {
  if (rawValue === "off" || rawValue === null || rawValue === undefined) {
    return null;
  }
  const n = Number(rawValue);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Debounced-save engine for one editor tab. Pure/DOM-free and driven entirely
// through the injected `save` + `schedule`/`cancel` (mirrors the injectable
// scheduler in settings-store.js so both are deterministically unit-testable
// without real timers).
//
// Contract (plan §3 CRITICAL INVARIANTS):
//   - notifyChange() is a no-op whenever autosave is off (intervalMs is
//     null/0) OR the last save attempt failed — a file that failed its last
//     save is NEVER autosaved again until a manual save succeeds.
//   - The scheduled save always goes through the SAME `save` callback the
//     caller wires to the tab-handle's save() (expectedMtimeMs optimistic
//     locking + 409 conflict UI are whatever that function already does —
//     this controller only decides WHEN to call it, never how).
//   - notifySaved(ok) lets a save triggered from anywhere (manual Ctrl+S,
//     click, or this controller's own timer) update the failed state, so a
//     successful manual save always re-arms autosave.
function createAutosaveController({
  save,
  intervalMs = null,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (id) => clearTimeout(id),
} = {}) {
  let timer = null;
  let failed = false;

  function isEnabled() {
    return Number.isFinite(intervalMs) && intervalMs > 0;
  }

  function stop() {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
  }

  async function run() {
    timer = null;
    if (failed || typeof save !== "function") return;
    const ok = await save();
    failed = !ok;
  }

  function notifyChange() {
    if (!isEnabled() || failed) return;
    stop();
    timer = schedule(() => {
      void run();
    }, intervalMs);
  }

  // Called after ANY save of this tab resolves (autosave-triggered or
  // manual) so both paths share the same failed/armed state.
  function notifySaved(ok) {
    failed = !ok;
    if (ok) stop();
  }

  function setIntervalMs(next) {
    intervalMs = next;
    if (!isEnabled()) stop();
  }

  function dispose() {
    stop();
  }

  return {
    notifyChange,
    notifySaved,
    setIntervalMs,
    dispose,
    get failed() {
      return failed;
    },
    get enabled() {
      return isEnabled();
    },
  };
}

class FileEditor {
  constructor({ fetchImpl, alertImpl, confirmImpl } = {}) {
    this.fetchImpl = fetchImpl || ((...args) => fetch(...args));
    this.alertImpl = alertImpl || ((msg) => window.alert(msg));
    this.confirmImpl = confirmImpl || ((msg) => window.confirm(msg));
    this.modal = null;
    this.view = null;
    this.cm = null; // lazy-loaded vendored module
    this.current = null; // { path, mtimeMs }
    this.dirty = false;
  }

  async ensureModule() {
    if (!this.cm) {
      this.cm = await import("/vendor/codemirror.js");
    }
    return this.cm;
  }

  // Fetches HEAD content for the file via GET /api/git/show so the editor can
  // render change bars vs the committed version. Returns the original string
  // when meaningful (tracked + changed), or null. Any failure (not a repo,
  // untracked, fetch error) silently yields null — never surfaced to the user.
  async fetchHeadOriginal(absPath) {
    try {
      const slash = String(absPath || "").lastIndexOf("/");
      if (slash <= 0) return null;
      const cwd = absPath.slice(0, slash);
      const base = absPath.slice(slash + 1);
      // "./<base>" makes git resolve the path relative to cwd (the file's
      // directory) instead of the repo root, so we don't need to know the
      // toplevel here.
      const params = new URLSearchParams({
        cwd,
        commit: "HEAD",
        path: `./${base}`,
      });
      const res = await this.fetchImpl(`/api/git/show?${params.toString()}`);
      const body = await res.json().catch(() => ({}));
      // A 404 means the file is untracked / absent at HEAD — treat as untracked.
      const isTracked = res.ok;
      return headOriginalFor({ ok: res.ok, content: body.content }, isTracked);
    } catch {
      return null;
    }
  }

  ensureModal() {
    if (this.modal) return this.modal;
    const modal = document.createElement("div");
    modal.id = "file-editor-modal";
    modal.className = "file-editor-modal hidden";
    modal.innerHTML = `
      <div class="file-editor-shell">
        <div class="file-editor-header">
          <span class="file-editor-title"></span>
          <span class="file-editor-dirty" title="Unsaved changes">●</span>
          <span class="file-editor-status" aria-live="polite"></span>
          <button type="button" class="btn btn-primary file-editor-save" title="Save (Ctrl+S)">Save</button>
          <button type="button" class="btn-icon file-editor-close" title="Close (Esc)">✕</button>
        </div>
        <div class="file-editor-mount"></div>
      </div>
    `;
    modal.querySelector(".file-editor-save").addEventListener("click", () => {
      void this.save();
    });
    modal.querySelector(".file-editor-close").addEventListener("click", () => {
      this.close();
    });
    modal.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "s") {
        event.preventDefault();
        void this.save();
      } else if (event.key === "Escape") {
        // The CodeMirror search panel (@codemirror/search) also binds Escape
        // to close ITSELF, and — since it doesn't stop propagation — the
        // keydown still bubbles up here. Without this guard the first Escape
        // while the find bar is focused would close the panel AND the whole
        // editor modal in the same keystroke. Let the panel own Escape while
        // it's open; the modal's Escape-to-close resumes once it's gone.
        if (modal.querySelector(".cm-search")) return;
        event.preventDefault();
        this.close();
      }
    });
    document.getElementById("app")?.appendChild(modal);
    this.modal = modal;
    return modal;
  }

  setStatus(text) {
    this.modal
      ?.querySelector(".file-editor-status")
      ?.replaceChildren(document.createTextNode(text || ""));
  }

  setDirty(dirty) {
    this.dirty = dirty;
    this.modal
      ?.querySelector(".file-editor-dirty")
      ?.classList.toggle("visible", dirty);
  }

  // Load a file's content + HEAD-original through the GATED file/git endpoints.
  // Returns { payload, headOriginal } on success, or null on any error (binary,
  // 403/404, fetch failure). `silent` suppresses the user-facing alert — used by
  // the IDE editor-tab path where a failed open SILENTLY drops the tab instead
  // of popping an alert (the modal path keeps the alert for direct opens).
  async loadFile(path, { silent = false } = {}) {
    if (!isProbablyEditable(path)) {
      if (!silent)
        this.alertImpl("This looks like a binary file — download it instead.");
      return null;
    }
    let payload;
    try {
      const res = await this.fetchImpl(
        `/api/files/content?path=${encodeURIComponent(path)}`,
      );
      payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (!silent) {
          const denial = window.AccessDenied?.describeAccessDenied(payload);
          this.alertImpl(
            denial?.text || payload.error || "Cannot open file for editing",
          );
        }
        return null;
      }
    } catch {
      if (!silent) this.alertImpl("Cannot open file for editing");
      return null;
    }
    const headOriginal = await this.fetchHeadOriginal(payload.path);
    return { payload, headOriginal };
  }

  // Build a CodeMirror EditorView for a loaded file into `mount`. Shared by the
  // modal (open) and the IDE editor-tab body (mountInto) so the phase-3 HEAD
  // change-bar gutter + language setup stay identical. `onDocChanged` fires on
  // the first edit (the modal sets dirty; the tab path pins the preview tab).
  // `extraKeymaps` is an optional array of CodeMirror key bindings the IDE tab
  // path injects (e.g. a Mod-s save) — it's bound at HIGH precedence (before
  // basicSetup) so it's naturally scoped to when THIS editor view has focus,
  // and the modal path leaves it empty (the modal owns its own Ctrl+S on the
  // modal element). Returning true from such a binding swallows the browser's
  // "save page" default without a global document listener.
  buildEditorView(
    cm,
    mount,
    payload,
    headOriginal,
    path,
    onDocChanged,
    extraKeymaps = null,
  ) {
    const language = detectEditorLanguage(path);
    const languageExtensions = {
      javascript: () => cm.javascript({ typescript: true, jsx: true }),
      json: () => cm.json(),
      markdown: () => cm.markdown(),
      python: () => cm.python(),
      html: () => cm.html(),
      css: () => cm.css(),
      yaml: () => cm.yaml(),
      xml: () => cm.xml(),
      sql: () => cm.sql(),
      cpp: () => cm.cpp(),
      rust: () => cm.rust(),
      go: () => cm.go(),
    };
    return new cm.EditorView({
      state: cm.EditorState.create({
        doc: payload.content,
        extensions: [
          ...(Array.isArray(extraKeymaps) && extraKeymaps.length
            ? [cm.keymap.of(extraKeymaps)]
            : []),
          // In-editor search (Mod-f). basicSetup already bundles
          // @codemirror/search's own default Mod-f binding (opens the same
          // panel) but WITHOUT stopping propagation, so it would also let the
          // document-level terminal-scrollback-search handler (app.js, plain
          // Ctrl+F) fire for the same keystroke. Declaring our own binding
          // here — BEFORE basicSetup in the array, same ordering as the
          // extraKeymaps save binding above — makes it win ("keymaps
          // specified early... get checked first", @codemirror/view) and
          // `stopPropagation: true` keeps the keystroke from bubbling past
          // this view's DOM, so it only ever fires while THIS editor is
          // focused and never shadows the terminal shortcut when it isn't.
          cm.keymap.of([
            {
              key: "Mod-f",
              preventDefault: true,
              stopPropagation: true,
              run: (view) => {
                cm.openSearchPanel(view);
                return true;
              },
            },
          ]),
          cm.highlightSelectionMatches(),
          cm.basicSetup,
          cm.keymap.of([cm.indentWithTab]),
          cm.oneDark,
          ...(language ? [languageExtensions[language]()] : []),
          // Change bars vs HEAD (no accept/reject merge controls). Only added
          // when the file is tracked and differs — otherwise no false markers.
          ...(typeof headOriginal === "string"
            ? [
                cm.unifiedMergeView({
                  original: headOriginal,
                  mergeControls: false,
                  gutter: true,
                }),
              ]
            : []),
          cm.EditorView.updateListener.of((update) => {
            if (update.docChanged && typeof onDocChanged === "function")
              onDocChanged(update);
          }),
        ],
      }),
      parent: mount,
    });
  }

  async open(path) {
    const loaded = await this.loadFile(path);
    if (!loaded) return;
    const { payload, headOriginal } = loaded;

    const cm = await this.ensureModule();
    const modal = this.ensureModal();

    this.view?.destroy();
    const mount = modal.querySelector(".file-editor-mount");
    mount.replaceChildren();

    this.view = this.buildEditorView(
      cm,
      mount,
      payload,
      headOriginal,
      path,
      () => this.setDirty(true),
    );

    this.current = { path: payload.path, mtimeMs: payload.mtimeMs };
    this.setDirty(false);
    this.setStatus("");
    modal.querySelector(".file-editor-title").textContent = payload.path;
    modal.classList.remove("hidden");
    this.view.focus();
  }

  // Mount a standalone CodeMirror editor for `path` into an arbitrary host (the
  // IDE editor-tab body) — NO modal, NO SurfaceWindow. Reuses the exact gated
  // load + the phase-3 HEAD change-bar gutter via buildEditorView. Returns a
  // small handle the tab controller drives:
  //   { view, save(), refresh(), destroy() }  (or null when the load failed —
  //   the caller silently drops the tab).
  // `onEdit` fires on the first edit so the tab controller can pin the preview.
  // `autosaveMs` is the initial debounce interval from the editor.autosave
  // setting (null/0 = off; see parseAutosaveMs) — the caller can change it
  // live via the returned handle's setAutosaveIntervalMs.
  // Each mounted tab owns its OWN view + current pointer (the modal's this.view
  // / this.current stay reserved for the modal path).
  async mountInto(hostEl, path, { onEdit, autosaveMs = null } = {}) {
    if (!hostEl) return null;
    const loaded = await this.loadFile(path, { silent: true });
    if (!loaded) return null;
    const { payload, headOriginal } = loaded;
    const cm = await this.ensureModule();

    hostEl.replaceChildren();
    let current = { path: payload.path, mtimeMs: payload.mtimeMs };
    let edited = false;
    // Forward reference so the Mod-s keymap (built before the handle) can route
    // to the handle's CURRENT save(). It points at the handle object (not a
    // captured function) so a caller that WRAPS handle.save (e.g. the app adding
    // a success toast) is still invoked by the keybinding. The binding only
    // fires when THIS view has DOM focus, so Ctrl/Cmd+S is naturally scoped to
    // the focused editor tab and never steals the shortcut from a terminal, the
    // modal, or the explorer.
    const handleRef = { handle: null };
    // Debounced autosave — always goes through handle.save() (whatever the
    // CURRENT one is, including any wrapper a caller installs, e.g. the
    // "Saved ✓" toast in app.js's mountEditorFileTab), so it gets the exact
    // same expectedMtimeMs optimistic-locking + 409-conflict-UI behavior as a
    // manual save. See createAutosaveController for the off/failed-save
    // invariants.
    const autosave = createAutosaveController({
      save: () => handleRef.handle?.save?.(),
      intervalMs: autosaveMs,
    });
    const view = this.buildEditorView(
      cm,
      hostEl,
      payload,
      headOriginal,
      path,
      () => {
        if (!edited) {
          edited = true;
          if (typeof onEdit === "function") onEdit();
        }
        autosave.notifyChange();
      },
      [
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            void handleRef.handle?.save?.();
            // Returning true marks the key as handled → CodeMirror swallows the
            // browser "save page" default without a global document listener.
            return true;
          },
        },
      ],
    );

    const handle = {
      view,
      path: payload.path,
      // Returns true when the file has unsaved changes. Used by the tab
      // controller's dirty-close guard (Codex fix 2: isDirty lives here, not
      // in FileEditor.dispose; the modal's confirmImpl stays on close()).
      isDirty: () => edited,
      // Atomic save through the gated PUT, mirroring the modal's save() (409 +
      // access-denied handling). Returns true on success.
      save: async () => {
        try {
          const res = await this.fetchImpl("/api/files/content", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              path: current.path,
              content: view.state.doc.toString(),
              expectedMtimeMs: current.mtimeMs,
            }),
          });
          const body = await res.json().catch(() => ({}));
          if (res.status === 409) {
            this.alertImpl(
              "The file changed on disk since you opened it. Close the tab and reopen to pick up the new content (your version stays in this tab until then).",
            );
            autosave.notifySaved(false);
            return false;
          }
          if (!res.ok) {
            const denial = window.AccessDenied?.describeAccessDenied(body);
            this.alertImpl(denial?.text || body.error || "Save failed");
            autosave.notifySaved(false);
            return false;
          }
          current.mtimeMs = body.mtimeMs;
          edited = false;
          autosave.notifySaved(true);
          return true;
        } catch {
          this.alertImpl("Save failed");
          autosave.notifySaved(false);
          return false;
        }
      },
      // CodeMirror needs a measure after its container resizes (mode switch,
      // dock sash drag, tab activation).
      refresh: () => {
        try {
          view.requestMeasure();
        } catch {
          // best-effort
        }
      },
      // Live-update the autosave debounce interval (editor.autosave setting
      // changed while this tab is open). null/0 turns autosave off for this
      // tab and cancels any pending scheduled save.
      setAutosaveIntervalMs: (ms) => autosave.setIntervalMs(ms),
      destroy: () => {
        autosave.dispose();
        try {
          view.destroy();
        } catch {
          // best-effort
        }
      },
    };
    // Bind the forward reference so the Mod-s keymap routes to this handle's
    // current save (including a wrapper a caller may install on handle.save).
    handleRef.handle = handle;
    return handle;
  }

  async save() {
    if (!this.view || !this.current) return;
    this.setStatus("Saving…");
    try {
      const res = await this.fetchImpl("/api/files/content", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: this.current.path,
          content: this.view.state.doc.toString(),
          expectedMtimeMs: this.current.mtimeMs,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (res.status === 409) {
        this.setStatus("");
        this.alertImpl(
          "The file changed on disk since you opened it. Close the editor and reopen to pick up the new content (your version stays in this window until then).",
        );
        return;
      }
      if (!res.ok) {
        this.setStatus("");
        const denial = window.AccessDenied?.describeAccessDenied(payload);
        this.alertImpl(denial?.text || payload.error || "Save failed");
        return;
      }
      this.current.mtimeMs = payload.mtimeMs;
      this.setDirty(false);
      this.setStatus("Saved ✓");
      setTimeout(() => this.setStatus(""), 2000);
    } catch {
      this.setStatus("");
      this.alertImpl("Save failed");
    }
  }

  close() {
    if (this.dirty && !this.confirmImpl("Discard unsaved changes?")) {
      return;
    }
    this.modal?.classList.add("hidden");
    this.view?.destroy();
    this.view = null;
    this.current = null;
    this.setDirty(false);
    // In windowed mode the editor lives inside a SurfaceWindow that must
    // close with it (Esc and the in-editor ✕ call close() directly).
    if (typeof window !== "undefined") {
      window.terminalManager?.surfaceWindowManager?.close("editor");
    }
  }
}

const FileEditorModule = {
  detectEditorLanguage,
  isProbablyEditable,
  headOriginalFor,
  parseAutosaveMs,
  createAutosaveController,
  FileEditor,
};

if (typeof window !== "undefined") {
  window.FileEditorModule = FileEditorModule;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = FileEditorModule;
}

if (typeof exports !== "undefined") {
  exports.detectEditorLanguage = detectEditorLanguage;
  exports.isProbablyEditable = isProbablyEditable;
  exports.headOriginalFor = headOriginalFor;
  exports.parseAutosaveMs = parseAutosaveMs;
  exports.createAutosaveController = createAutosaveController;
  exports.FileEditor = FileEditor;
}
