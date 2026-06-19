# VS Code-grade Workspace — Phase 3: Explorer⇄Git Decorations + Timeline + Editor Gutter — Implementation Plan

> **For Claude:** Execute this plan using `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` (manual review).
> **REQUIRED SUB-SKILL: superpowers:executing-plans**

**Goal:** Bring git awareness into the file explorer (status badges/colors), add a per-file timeline (commit history → diff against a revision), and show change bars vs HEAD in the CodeMirror editor — completing phase 3 of the VS Code-grade workspace design.

**Architecture:** Vanilla JS frontend, no build step. A single shared git-status data source (fetched from the existing `GET /api/git/status`, extended with the repo `root` so absolute paths can be mapped) feeds the explorer decorations. The timeline is a new mode in the existing git panel right pane, reusing the `@codemirror/merge` diff renderer over `GET /api/git/log?path=` + `GET /api/git/show`. The editor gutter uses `@codemirror/merge`'s `unifiedMergeView` with HEAD content as the original. Pure helpers ship with `*.test.js`; UI ships with Playwright e2e.

**Tech Stack:** Bun + Hono backend, vanilla JS + xterm.js + vendored CodeMirror 6 (`@codemirror/merge`), `bun:test`, Playwright.

---

## Conventions (read before any task)

- Backend mutating/reading git endpoints stay behind `requireFileAccess` + audit. Phase 3 adds **no** mutating endpoints; it only extends a read response.
- New `*.test.ts` / `*.test.js` files **must** be added to `test:unit` in `package.json` or CI skips them.
- Never hand-edit `web/vendor/`. `@codemirror/merge` exports (`MergeView`, `unifiedMergeView`, `goToNextChunk`, `goToPreviousChunk`) are already vendored (see `scripts/build-codemirror-vendor.js`).
- All tests run against **4174**. Verify live on `https://deckterm_dev.learnai.cz/` before claiming done.
- Pure helpers first (testable without DOM), then DOM wiring, then e2e — mirror `git-scm.js` / `git-scm.test.js`.

## Execution waves (orchestration)

Tasks touch overlapping files, so they are **not** all parallelizable:

- **Wave 1 (parallel-safe, isolated files):** Task 0 (backend `root` field) ‖ Task C (editor gutter, `web/file-editor.js`).
- **Wave 2 (sequential — both touch `web/app.js`/`GitManager`):** Task A (explorer decorations) → Task B (timeline). Task A depends on Task 0.

---

## Task 0: Backend — expose repo root in `GET /api/git/status`

**Files:**

- Modify: `backend/server.ts` (the `GET /api/git/status` handler, ~3336)
- Test: `backend/git-actions.test.ts`

**Step 1 — failing test:** add a case asserting the status JSON includes `root` = the absolute toplevel of the fixture repo (from `git rev-parse --show-toplevel`).

**Step 2 — run, expect FAIL** (`root` undefined).

**Step 3 — implement:** in the status handler, run `git -C <cwd> rev-parse --show-toplevel` via the existing `runGit` helper; add `root: result.output.trim()` to the response. Keep the field optional/backward-compatible (git panel ignores it).

**Step 4 — run, expect PASS.** Also run the full `git-actions.test.ts` to confirm no regression.

**Step 5 — commit:** `feat(git): include repo root (toplevel) in status response`

---

## Task A: Explorer git status decorations

**Files:**

- Create: `web/git-decorations.js` + `web/git-decorations.test.js` (pure: map a `git status` files array + repo root → `{ absPath: letter }`; reuse `statusLetter`/status-color logic from `web/git-scm.js`, do not duplicate)
- Modify: `web/file-explorer.js` (`createItemElement`, ~where rows are built — accept an optional `decorations` map from the snapshot and render a status badge + color class)
- Create: `web/git-status-store.js` + `web/git-status-store.test.js` (shared cache: `getStatus(cwd)` / `refreshStatus(cwd)` / change listener — see Resolved decision 3; the single source of git status for the explorer now and the git panel later)
- Modify: `web/app.js` (the explorer construction site + `GitManager`: get status for the explorer's current dir **from `git-status-store.js`**, build the decoration map via `git-decorations.js`, pass into the explorer; refresh decorations when the store invalidates or the explorer navigates)
- Modify: `web/styles.css` (status colors on explorer rows — reuse the `--git-*`/status color vars already used by the git panel tree)
- Test: `web/git-decorations.test.js` + `web/git-status-store.test.js` (unit), `tests/git-vscode-explorer.spec.ts` (extend with an explorer-decoration assertion, or a new `tests/explorer-git-decorations.spec.ts`)

**Step 1 — failing unit test** for `buildDecorationMap(statusFiles, root)`: M/A/D/U/R/C letters map to the right absolute paths and color classes; untracked → `U`; clean files absent from the map.

**Step 2 — run, expect FAIL.**

**Step 3 — implement** `web/git-decorations.js` (pure, import nothing DOM). Add to `test:unit`.

**Step 4 — run unit, expect PASS.**

**Step 5 — wire DOM:** `file-explorer.js` reads `snapshot.decorations?.[item.path]` and adds a `.git-decorated.<color>` class + a single-letter badge span. `app.js` fetches `/api/git/status?cwd=<explorer dir>`, builds the map (using `root` from Task 0), sets it on the explorer, re-renders. Debounce/skip when the dir is not a git repo (status error).

**Step 6 — CSS** for `.git-decorated` letters/colors (reuse existing git status color vars).

**Step 7 — e2e:** in a fixture repo with a modified + untracked file, open the explorer and assert the rows carry the badge/color.

**Step 8 — run e2e against 4174, expect PASS.**

**Step 9 — commit:** `feat(web): git status decorations in the file explorer`

---

## Task B: Per-file timeline (commit history → diff against revision)

**Files:**

- Create: `web/git-timeline.js` + `web/git-timeline.test.js` (pure: parse the `log?path=` commits into timeline rows; compute the `{ ref, prevRef, path }` tuple for "diff this commit" — `commit^` vs `commit`, handling the root commit where `^` is absent)
- Modify: `web/app.js` (`GitManager`: a "Timeline" mode in the right pane next to the diff editor; selecting a file + Timeline lists its commits from `GET /api/git/log?cwd=&path=`; clicking a commit renders the file diff for that revision via the existing `renderMergeDiff` using `GET /api/git/show` for both sides)
- Modify: `web/styles.css` (timeline list rows)
- Test: `web/git-timeline.test.js` (unit), `tests/git-timeline.spec.ts` (e2e)

**Step 1 — failing unit test** for `buildTimelineEntries(logCommits)` and `revPairForCommit(commit, isRoot)` (root commit → diff against empty tree `4b825dc642cb6eb9a060e54bf8d69288fbee4904`).

**Step 2 — run, expect FAIL.**

**Step 3 — implement** `web/git-timeline.js`. Add to `test:unit`.

**Step 4 — run unit, expect PASS.**

**Step 5 — wire DOM:** add a Timeline toggle to the git panel right pane; on file select fetch `log?path=`, render rows; on row click fetch both revisions via `show` and call the existing `renderMergeDiff`. Reuse the existing diff-mode UI plumbing; do not fork a second diff renderer.

> **Codex-flagged correctness (must handle):**
>
> - **Root commit / first add:** `git show <empty-tree>:path` and `git show <commit>:path` for a not-yet-existing file **fail** — they do not return empty content. The diff loader must treat a missing/failed old side as `original = ""` (additions) and a missing new side as `modified = ""` (deletions), never surfacing the `show` error as a diff failure.
> - **Scope:** phase 3 timeline is **current-path history only**. Renames/deletes are out of scope for the diff-against-revision pair; `revPairForCommit` assumes the same path on both sides and the loader falls back to empty on the side where the path is absent. Note this limitation in the impl doc; do not silently show a broken diff.

**Step 6 — CSS** for timeline rows (hash, short message, relative date).

**Step 7 — e2e:** fixture repo with ≥2 commits touching one file; open Timeline, click an older commit, assert the diff editor shows that revision's change.

**Step 8 — run e2e against 4174, expect PASS.**

**Step 9 — commit:** `feat(web): per-file git timeline with diff-against-revision`

---

## Task C: Editor change gutter vs HEAD

**Files:**

- Modify: `web/file-editor.js` (when opening a file under a git repo, fetch HEAD content via `GET /api/git/show?cwd=&ref=HEAD&path=`; add the `@codemirror/merge` `unifiedMergeView` extension with `original = HEAD content` so the editor shows change bars in the gutter; gracefully omit when the file is untracked / not in a repo / show fails)
- Create: `web/editor-git-gutter.test.js` (pure: a helper `headOriginalFor(showResponse, isTracked)` returning the original string or `null` so the extension is only added when meaningful)
- Modify: `web/styles.css` if gutter colors need theming over `oneDark`
- Test: `web/editor-git-gutter.test.js` (unit), `tests/file-editor.spec.ts` (extend) or `tests/editor-git-gutter.spec.ts` (e2e)

**Step 1 — failing unit test** for `headOriginalFor`: tracked+changed → returns HEAD text; untracked → `null`; show-error → `null`.

**Step 2 — run, expect FAIL.**

**Step 3 — implement** the pure helper. Add to `test:unit`.

**Step 4 — run unit, expect PASS.**

**Step 5 — wire editor:** in `FileEditor` open flow, after loading content, fetch HEAD via `show`; if `headOriginalFor` returns a string, include the change gutter in the extensions; otherwise skip. Lazily import as today.

> **Codex-flagged UX (must handle):** `unifiedMergeView` turns the editor into a merge surface (accept/reject affordances) — too heavy for a normal editor. Use `cm.unifiedMergeView({ original, mergeControls: false, gutter: true })` so it renders **change bars only**, and explicitly test that **editing, save (PUT), undo/redo, and selection still behave like a plain editor** with the extension active. If those behaviors regress, fall back to a lightweight custom change gutter computed from the HEAD diff instead.

**Step 6 — e2e:** open a tracked+modified file in the editor, assert the merge/change gutter is present; open an untracked file, assert it is absent.

**Step 7 — run e2e against 4174, expect PASS.**

**Step 8 — commit:** `feat(web): editor change gutter vs HEAD via @codemirror/merge`

---

## Integration / wrap-up

- Run `bun run test:unit` (full) + the three new e2e specs against 4174.
- Manual verification on `https://deckterm_dev.learnai.cz/`: explorer badges, timeline diff, editor gutter.
- Update `docs/deckterm-development-overview.md` and the phase-3 line in `docs/plans/2026-06-12-vscode-grade-workspace-design.md` if behavior diverged.
- Push to `dev`; session-end Notion sync (`/notion-project-sync`).

## Resolved decisions (after Codex second opinion, 2026-06-16)

1. **Timeline placement:** git panel right pane (reuse `renderMergeDiff`, add a clear Timeline tab + empty states). Defer a dedicated surface window until usage proves it's needed.
2. **Editor gutter:** use `@codemirror/merge` `unifiedMergeView` with `mergeControls: false` (change bars only), gated behind the edit/save/undo regression tests in Task C step 5; fall back to a custom gutter if it regresses plain-editor behavior.
3. **Decoration refresh:** centralize in a shared **`web/git-status-store.js`** (`getStatus(cwd)` cache + `refreshStatus(cwd)` + a change listener) used by Task A's explorer decorations now and reused by the git panel later, so a future git mutation can invalidate it and avoid stale badges. Task A builds the explorer decoration map **from this store**, not from ad-hoc fetches scattered in `app.js`. → Add `web/git-status-store.js` + `web/git-status-store.test.js` to Task A's Files and `test:unit`.

**Wave-risk note (Codex):** Task C's only `@codemirror/merge` import lives in `web/file-editor.js`; Task B reuses the already-vendored-and-wired `renderMergeDiff` in `web/app.js` (phase 2) — so they do **not** share a new import site. Still, keep Wave 1 = Task 0 ‖ Task C and run Task C's edit/save/undo verification before Task B wiring lands, to settle the merge-extension behavior once.
