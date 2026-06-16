# VS Code-grade Workspace — Design (4 phases)

**Date:** 2026-06-12
**Status:** Approved (user session 2026-06-12)
**Scope:** Umbrella design for four mergeable slices. Each phase ships its own
impl plan doc (`docs/plans/2026-06-12-<phase-name>.md`) and tests.

## Motivation

User feedback on current state (screenshots, 2026-06-12 session):

- Files and Git live in fixed right-side `side-panel` overlays — they cannot be
  moved or resized, while terminal tiles already can (TileManager).
- The Git panel renders raw colored hunks and a flat history list. Target bar
  is VS Code's Source Control: changes tree, real diff editor, timeline,
  sync actions.
- No settings UI at all; ~10 scattered `localStorage` keys (font size, wrap,
  extra keys, auto-copy, task view, action layout) and server-only `.env`.

## Decisions (user-approved)

1. **Build VS Code-grade UI inside DeckTerm** — vanilla JS + vendored
   CodeMirror, copying VS Code UX patterns (and MIT code/CSS where useful).
   No embedded openvscode-server/code-server: it would bypass the foundation
   capability gates, duplicate the terminal, and break mobile-first UX.
2. **Settings are server-side, actor-scoped** — new foundation DB table +
   `/api/settings`, portable across devices/browsers (user accesses dev via
   `deckterm_dev.learnai.cz` from multiple devices). Existing localStorage
   keys migrate. `.env` stays read-only (documented in the UI).
3. **Git write scope: full daily workflow** — add push/pull/fetch, discard
   (with confirmation), stash, branch create/delete. No merge/rebase conflict
   UI — the terminal already does that.

## Phase 1 — Windowing: surfaces become windows

**Problem:** `Tile` (web/app.js ~696) hardcodes a terminal (`terminalId`,
`terminal-wrapper`). Files/Git/Tasks/Editor are fixed overlays.

- Extract/generalize window chrome — drag, 8-edge resize, snap
  (halves/quadrants, logic exists), z-order, close — into a content-agnostic
  window so TileManager can manage non-terminal windows.
- Convert Files, Git, Tasks, Editor into managed windows: movable, resizable,
  snappable, per-window-type remembered geometry.
- **Bottom dock (VS Code panel):** a dock zone at the bottom; the sessions
  (terminal workspace) area can be docked there — drag down to dock, sash to
  resize, collapse/expand. Other windows snap but float freely.
- **Settings storage slice (no UI):** foundation DB migration adding an
  actor-scoped `settings` KV table + `GET/PUT /api/settings`. Used first for
  window geometry/dock layout persistence; Phase 4 builds the UI on top.
- Mobile keeps fullscreen sheets — window dragging is desktop-only.

## Phase 2 — Git: VS Code-grade Source Control

Backend already has status/diff/stage/unstage/commit/branches/log/checkout/
show (`backend/server.ts` ~3268–3700). The frontend rendering is the gap.

- **Changes tree:** Staged / Changes / Untracked groups, tree⇄flat toggle,
  VS Code status colors and letters (M/A/D/U/R/C), row hover actions
  (stage/unstage, discard, open file, open diff).
- **Diff editor:** add `@codemirror/merge` to the vendored CodeMirror build
  (`scripts/build-codemirror-vendor.js`) → side-by-side and inline diffs with
  syntax highlighting and expandable context.
- **Commit UX:** message box + Commit button (amend option), branch indicator
  with ahead/behind, Sync actions (push/pull/fetch).
- **New endpoints** (all behind `requireFileAccess` + audit rows, with tests):
  `POST /api/git/push|pull|fetch`, `POST /api/git/discard` (confirm required;
  untracked via `clean` handled separately), `GET/POST /api/git/stash`
  (list/push/pop/drop), `POST /api/git/branch` (create/delete),
  `GET /api/git/log?path=` (per-file, for Phase 3 timeline).

## Phase 3 — Explorer ⇄ Git integration + Timeline

**Status: shipped on `dev` 2026-06-16** (impl plan `docs/plans/2026-06-16-vscode-phase3-explorer-git-timeline.md`; commits `2ba8ead`, `a7ebfce`, `ca5fea4`, `8da0284`). Explorer decorations + per-file timeline + editor gutter all live, unit + e2e green. Scope note: timeline is current-path history only (renames/deletes fall back to empty diff sides).

- **Explorer decorations:** git status badge + color on files/folders in the
  file explorer tree (VS Code Explorer style); "Open Changes" jumps to diff.
- **Timeline:** per-file commit history view; clicking a commit shows the
  file's diff against that revision (existing `show` + per-file `log`).
- **Editor gutter:** change indicators vs HEAD in the CodeMirror editor
  (green/blue/red bars, from `@codemirror/merge` gutter); git panel rows open
  the file directly in the editor window.

## Phase 4 — Settings UI

**Status: shipped on `dev` 2026-06-16** (impl plan `docs/plans/2026-06-16-vscode-phase4-settings-ui.md`; commits `0f780c8`, `3ecc556`, `1ec1dd4`, `f1b7fb6`). Schema registry + VS Code-style settings window (sidebar + search) + central settings runtime + migration of the 6 legacy localStorage keys onto `/api/settings` + read-only env-info (allowlist, paths coarsened/capability-gated, no secrets). **This completes the VS Code-grade workspace umbrella (phases 1–4).** Note: `terminal.autoCopy` default is now `false` (schema is source of truth; previously implicitly `true` when unset — explicitly-set values migrate).

- VS Code-style settings window: category sidebar (Appearance, Terminal,
  Windows & Layout, Git, Files, Tasks, Advanced) + full-text search; controls
  generated from a frontend schema registry.
- Migrate existing localStorage keys onto the Phase 1 settings API.
- New settings: default diff mode, scrollback limit, default cwd, window snap
  behavior, reconnect behavior, git auto-fetch interval, destructive-action
  confirmations, theme accents.
- Read-only section listing server `.env` config with descriptions.

## Constraints

- Every phase merges to `dev` independently and is verified on 4174.
- Foundation rules apply: new mutating git endpoints need capability checks,
  audit rows, and foundation-bearing tests (one foundation test per file,
  pinned env vars — see CLAUDE.md).
- No new runtime deps; `@codemirror/merge` is a devDependency vendored into
  `web/vendor/codemirror.js`.
- Don't touch `web/vendor/` by hand; regenerate via the build script.
