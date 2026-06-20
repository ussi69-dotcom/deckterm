# IDE SCM + Explorer gaps — design

> 2026-06-20 · branch `dev` (port 4174) · follows the VS Code-grade workspace
> phases (umbrella `2026-06-12-vscode-grade-workspace-design.md`, phase 5 IDE
> shell). Closes the gap between the shipped IDE shell and "VS Code-grade"
> Source Control + Explorer reported in user testing.

## Motivation

User testing of the IDE mode surfaced a cluster of SCM/Explorer gaps — some
real bugs, some missing parity features. This slice closes all of them. The
backend already carries most of the needed surface (`/api/files/rename`,
`PUT /api/files/content`, `/api/git/log --graph`, `/api/git/show`); the work is
~80% frontend wiring plus one backend diff fix.

## Work items

### 1. BUG — empty diff preview when opening an untracked file (SCM)

**Symptom:** clicking a changed file in Source Control opens an empty diff tab.
**Root cause:** untracked files (`U`) are the common case (see test screenshot:
`playwright-2048/`, `glm-bench-2048/`). `GET /api/git/diff` runs plain
`git diff -- <path>`, which **ignores untracked files** → empty output →
empty preview. (`server.ts:4081`, `git-scm-view.js:646`)

**Approach:** add an `untracked=1` query param to `/api/git/diff`. When set,
run `git diff --no-index --color=never -- /dev/null <path>` (whole file shown
as added). `--no-index` exits **1 on differences**, so treat exit 1 with
non-empty stdout as success (don't 400). The SCM view already knows each file's
status letter — pass `untracked: letter === "U"` through `openDiffTab` →
`editorTabs.openDiff` → the diff fetch. Default behaviour unchanged.

**Files:** `backend/server.ts` (diff route), `web/git-scm-view.js`,
`web/editor-tabs.js` (thread `untracked` into the ref + fetch URL),
`web/app.js` (`openDiffTab` passthrough).
**Tests:** server diff route test for untracked path; `editor-tabs` URL build;
`git-scm-view` passes the flag for `U` rows.

### 2. BUG — breadcrumb "blue links" don't navigate folder levels (Explorer)

**Symptom:** clicking path segments does nothing.
**Root cause:** the breadcrumb is built from the **filesystem root** `/`
(`file-explorer.js:509`), splitting the absolute path into every segment. The
explorer is scoped to allowed roots (`/home/deploy`), so clicking any segment
**above** the allowed root → `loadDir` hits a 403 → silent no-op → looks
broken. Segments inside the root navigate fine, but the visible ones (`/`,
`home`, `deploy`) are all above it.

**Approach:** scope the breadcrumb to the **allowed root** the current path
falls under. Show the root as the first crumb (label = root basename or a home
glyph), then only the segments _below_ it are clickable. The explorer already
knows its allowed roots from the workspace context; resolve the longest
matching root and slice the path there. Pure helper `breadcrumbSegments(path,
roots)` (DOM-free, unit-tested).

**Files:** `web/file-explorer.js` (`renderBreadcrumb`, new pure helper).
**Tests:** `file-explorer.test.js` — segments stop at the allowed root; each
emitted crumb path is inside a root.

### 3. BUG — SCM doesn't list files inside untracked subfolders

**Symptom:** an untracked **directory** shows as one row `dir/`, not its files.
**Root cause:** `git status --porcelain` collapses untracked directories to a
single entry by default (`server.ts:3953`).

**Approach:** add `-uall` to the status invocation so untracked files are listed
individually. This also makes folder-rollup decorations (item 4) accurate. Low
risk; the porcelain parser already handles per-file rows. Watch perf on huge
untracked trees — `git status` is fast, and we already time out at 10s.

**Files:** `backend/server.ts` (status args).
**Tests:** status route test asserting nested untracked files appear as rows.

### 4. FEATURE — folder rollup git decorations in the Explorer

**Symptom:** changed files deep in a tree leave their ancestor folders
undecorated; user wants the VS Code "+N / colored folder" cue at the root.
**Root cause:** `buildDecorationMap` maps only **exact** file paths
(`git-decorations.js:35`) — no ancestor aggregation.

**Approach:** extend the decoration map with **folder rollups**: for each
changed file, walk its ancestor dirs up to the repo root and mark each with an
aggregate (count of changed descendants + a representative color, e.g. modified
vs untracked precedence). Explorer folder rows render a small count badge +
color; files keep their letter badge. Keep `buildDecorationMap`
backward-compatible (add a `folders` map or a `kind` field; don't break the
existing file-keyed shape its tests assert).

**Files:** `web/git-decorations.js` (rollup), `web/file-explorer.js`
(`createItemElement` folder badge), CSS in the IDE stylesheet.
**Tests:** `git-decorations.test.js` — nested change rolls up to each ancestor
with the right count + color precedence.

### 5. FEATURE — New File / Rename in the Explorer

**Symptom:** explorer only has mkdir + upload; no new-file, no rename.
**Backend:** already present — `POST /api/files/rename` (move/rename) and
`PUT /api/files/content` (writing to a new path creates the file). No backend
work beyond confirming `rename` accepts a same-dir target.

**Approach:** add two explorer actions:

- **New File** — toolbar button next to mkdir; prompt for a name; `PUT
/api/files/content` with empty body at `currentPath/name`; reload + select.
- **Rename** — per-row hover action (and/or context affordance); prompt
  pre-filled with the current name; `POST /api/files/rename` `{from, to}` in the
  same dir; reload + reselect. Works for files and folders.
  Reuse the existing prompt/refresh pattern from `createFolder()`. Guard empty /
  duplicate names client-side; surface server 403/409 inline.

**Files:** `web/file-explorer.js` (two actions + handlers), IDE markup for the
New File toolbar button, CSS.
**Tests:** `file-explorer.test.js` — new-file POSTs the right URL/body; rename
POSTs `{from,to}`; both reload after success and no-op when disposed.

### 6. FEATURE — Git graph / history view (+ surface the existing per-file Timeline in IDE)

**Symptom:** SCM shows a flat branch list, no commit history / graph.
**Backend:** `GET /api/git/log` already returns `--graph` prefix + per-commit
`{hash, fullHash, message, author, date, graph}` (`server.ts:4263`); `/api/git/
show` + `/api/git/diff?commit=` open a commit's diff.

**⚠️ Pre-existing half-wired feature (audit finding 2026-06-20):** a complete
**per-file Timeline** already exists — pure helpers in `web/git-timeline.js`
(`buildTimelineEntries`, `relativeDate`, `revPairForCommit`, empty-tree handling)
and full UI wired into the **legacy** GitManager panel (`app.js:2837`, the
"Diff / Timeline" right-pane toggle). But the **IDE SCM view
(`git-scm-view.js`) never surfaces it** — its skeleton has only commit box /
actions / tree / branches / stashes. So IDE mode silently loses the Timeline
that is already written and unit-tested. This slice finishes that embroidery
rather than leaving it stranded.

**Approach (scoped) — two complementary pieces, both as collapsible SCM sections:**

- **6a. Repo-wide History** — a **commit history list with an ASCII-lane
  gutter**, not a full hand-rolled multi-lane DAG renderer (that's the "Git
  Graph" extension's whole job; out of scope for parity). Render the `graph`
  prefix in a monospace gutter next to each commit row (hash · subject · author
  · relative date). Clicking a commit opens its diff as an editor tab (commit
  mode, reusing `openDiffTab({commit})`). New collapsible **History** section in
  the SCM view (above Branches), default collapsed → lazy `/api/git/log` on
  expand. Reuse `git-timeline.js`'s `relativeDate` for the date column.
- **6b. Per-file Timeline in IDE** — surface the **already-built** Timeline
  (finding above) in the IDE SCM view: when a file row is selected/active, a
  **Timeline** affordance lists that file's commit history (reuse
  `buildTimelineEntries` + `revPairForCommit` from `git-timeline.js` and the
  GitManager's existing timeline loader), each entry opening a commit-vs-parent
  diff tab. No new backend, no new pure helpers — just an IDE-side host that
  reuses the legacy panel's data path.

**Files:** new `web/git-history-view.js` (+ test) for 6a, wired into
`git-scm-view.js`; a small Timeline host in `git-scm-view.js` for 6b reusing
`git-timeline.js`; CSS. Possibly a small `/api/git/log` tweak to also return ref
decorations (`--decorate`) for branch/tag chips — optional, can follow.
**Tests:** `git-history-view.test.js` — log rows format correctly; commit click
builds the right diff-tab ref; empty/log-error states. Timeline reuse covered by
the existing `git-timeline.test.js` helpers; add a `git-scm-view` test that the
Timeline host calls the loader + builds the right diff ref.

## Sequencing

Ship as small, independently testable commits in this order (bugs first for
fast user relief, graph last as the biggest standalone piece):

1. Item 1 — untracked diff (backend + thread-through)
2. Item 3 — `-uall` status (tiny, unblocks item 4)
3. Item 2 — breadcrumb scoping
4. Item 5 — New File / Rename
5. Item 4 — folder rollup decorations
6. Item 6 — git history view

Each commit carries its unit tests and runs against dev (4174). `test:unit` is
the gate; new `*.test.js` files must be added to the `test:unit` script in
`package.json`.

## Risks / non-goals

- **Non-goal:** full multi-lane DAG graph renderer; merge-conflict resolution
  UI; staging hunks. History view is read + open-diff only.
- **Risk:** `-uall` on a massive untracked tree — bounded by the existing 10s
  timeout; acceptable.
- **Risk:** breadcrumb root resolution must use the _same_ allowed-root list the
  backend enforces, or crumbs 403. Resolve from the workspace context, not a
  hardcoded `$HOME`.
- **Decoration shape:** keep `buildDecorationMap`'s existing file-keyed output
  intact (its tests assert it); add folders as a separate map.
