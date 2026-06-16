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
  buildEditorView(cm, mount, payload, headOriginal, path, onDocChanged) {
    const language = detectEditorLanguage(path);
    const languageExtensions = {
      javascript: () => cm.javascript({ typescript: true, jsx: true }),
      json: () => cm.json(),
      markdown: () => cm.markdown(),
      python: () => cm.python(),
      html: () => cm.html(),
      css: () => cm.css(),
    };
    return new cm.EditorView({
      state: cm.EditorState.create({
        doc: payload.content,
        extensions: [
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
  // Each mounted tab owns its OWN view + current pointer (the modal's this.view
  // / this.current stay reserved for the modal path).
  async mountInto(hostEl, path, { onEdit } = {}) {
    if (!hostEl) return null;
    const loaded = await this.loadFile(path, { silent: true });
    if (!loaded) return null;
    const { payload, headOriginal } = loaded;
    const cm = await this.ensureModule();

    hostEl.replaceChildren();
    let current = { path: payload.path, mtimeMs: payload.mtimeMs };
    let edited = false;
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
      },
    );

    const handle = {
      view,
      path: payload.path,
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
            return false;
          }
          if (!res.ok) {
            const denial = window.AccessDenied?.describeAccessDenied(body);
            this.alertImpl(denial?.text || body.error || "Save failed");
            return false;
          }
          current.mtimeMs = body.mtimeMs;
          edited = false;
          return true;
        } catch {
          this.alertImpl("Save failed");
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
      destroy: () => {
        try {
          view.destroy();
        } catch {
          // best-effort
        }
      },
    };
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
  exports.FileEditor = FileEditor;
}
