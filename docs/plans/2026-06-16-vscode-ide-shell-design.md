# VS Code IDE Shell — Design

**Date:** 2026-06-16
**Status:** Drafted (brainstorming session 2026-06-16, user-approved sections 1–4)
**Scope:** Optional desktop "IDE mode" that reshapes the DeckTerm workspace into a VS Code-style shell (activity bar + sidebar + editor tabs + bottom terminal panel), toggled from the default terminal-first layout. Effectively "phase 5", building on the completed VS Code-grade workspace umbrella (phases 1–4).

## Motivation

User feedback (2026-06-16, screenshot of the git panel on a clean tree): the workspace "doesn't look much like VS Code", and the changes tree / per-file status / file browsing are hard to find because Files and Git are **separate floating windows** and the git panel is a custom 3-pane layout, not VS Code's unified activity-bar + sidebar + editor-tabs shell. The features from phases 1–4 exist but aren't arranged the way a VS Code user expects.

## Core model (user-approved)

A **mode toggle**, not a permanent replacement:

- **Terminal mode (default):** today's fullscreen terminals (TileManager full-bleed). Unchanged.
- **IDE mode** (toggled via an **"IDE"** button in the top toolbar): the surface reshapes into a VS Code shell. Terminals dock to the **bottom panel** (reusing the phase-1 bottom dock); activity bar + sidebar + editor area take the main area.
- **Everything is movable:** any sidebar view or panel can be "popped out" into a floating SurfaceWindow (phase 1) and docked back. The IDE shell is the default _arrangement_, not a cage.
- **Mobile:** unchanged (fullscreen terminals + sheets). IDE mode is **desktop-only** (≥768px), consistent with phase 1.

Layout state (`layout.mode`, `layout.sidebarWidth`, `layout.activeView`, `layout.editorTabs`, `layout.detached[viewId]`, bottom-panel height) persists via the phase-1 `settingsStore` and applies live through the phase-4 settings runtime — portable across devices.

## Shell layout (IDE mode)

```
┌──┬───────────────┬────────────────────────┐
│A │  SIDEBAR      │  editor tabs            │
│C │  (active view)│ [⏱bash][app.js][↔diff]  │
│T │               ├────────────────────────┤
│I │               │  tab content            │
│V │               │  (file / diff / settings)│
│B │               ├────────────────────────┤
│ ⚙│               │  ⏱ terminals (bottom panel)│
└──┴───────────────┴────────────────────────┘
A=activity bar: Explorer · Source Control · Search · Tasks · (⚙ Settings bottom)
```

## Sidebar views

The activity bar switches the active view; clicking the active icon collapses the sidebar (VS Code behavior).

- **Explorer** — `FileExplorerController` (phases 1/3) with git decorations, rendered in the sidebar. Single-click = preview tab (italic), double-click = pin. "Open Changes" context action opens the diff.
- **Source Control** — the current git panel **restructured into a VS Code SCM view**: commit box on top, sync/actions, grouped changes (Staged / Changes / Untracked) with status letters + hover actions (stage/unstage/discard/open). **Clicking a file opens its diff as a tab in the editor area** (not the old right pane). Stashes/branches as collapsible sections or a "⋯" menu. The per-file timeline (phase 3) also opens diffs as editor tabs.
- **Search** _(new feature)_ — query input + results grouped by file; backend `POST /api/files/search` (ripgrep/grep scoped to allowed roots, behind `requireFileAccess` + audit, bounded by timeout + max-results). Clicking a result opens the file at the line in the editor.
- **Tasks** — the existing `TaskBoard`/list rendered as a sidebar view.

## Editor area (tabs)

A tab bar + content host. Tab types:

- **file** — CodeMirror editor (phase 3 HEAD change-bar gutter applies).
- **diff** — `renderMergeDiff` (working / staged / commit / timeline-revision).
- **settings** — the phase-4 settings window opens as a tab.

VS Code preview semantics (single-click = preview/italic, replaced by the next preview; double-click or edit = pinned). Open tabs + active + preview persisted as `layout.editorTabs` (`[{type, ref}]`) so reload restores the workspace. Terminals in the bottom panel keep tmux session persistence.

## Key refactor — mount-target-agnostic views

Today's components (FileExplorer, git panel, TaskBoard, FileEditor) assume a fixed panel/window. They will be refactored to **render into a provided container**. The same instance can then live in a sidebar slot, a floating SurfaceWindow, or (diffs) the editor area. This is the bridge between "fixed shell" and "everything movable", and the main enabling change.

## Data flow

- IDE toggle → `ideShell.setMode("ide"|"terminal")` → persists `layout.mode`; mounts/unmounts shell chrome and docks/undocks TileManager.
- `layout.*` keys flow through the phase-4 settings runtime (live apply + cross-device persistence).
- Shared git status: the phase-3 `git-status-store` feeds both Explorer decorations and the SCM view; git mutations invalidate both.
- Open flows: SCM file click → `editor.openDiff(path, mode)`; Explorer click → `editor.openFile(path)`; Search result → `editor.openFile(path, line)`.
- Pop-out: view header "⤢" → `surfaceWindowManager.open(viewId, {host})`, removed from sidebar; "dock back" returns it. `layout.detached[viewId]` persisted.

## Build phasing (mergeable slices, each with tests, to `dev`, verified on 4174)

- **Slice 0 — mount-agnostic refactor.** Components render into a provided container; no visible change; existing floating-window e2e stays green.
- **Slice 1 — IDE shell scaffold + toggle.** Activity bar + sidebar host + terminal docking to bottom panel + "IDE" button (`layout.mode`); re-host Explorer/SCM/Tasks. Terminal mode unchanged.
- **Slice 2 — editor area with tabs.** Tab bar (file/diff/settings), wire view clicks to open tabs, preview/pin, persist `layout.editorTabs`.
- **Slice 3 — Source Control view.** Restructure the git panel into the VS Code SCM view; diffs open in the editor area.
- **Slice 4 — Search.** Backend `POST /api/files/search` (ripgrep, allowed-roots, `requireFileAccess` + audit, timeout + max-results) + Search view + open-at-line.
- **Slice 5 — pop-out/dock + VS Code polish.** Detach views to floating windows + dock back; styling pass.

## Testing

Unit (pure helpers: editor tab model, layout-state reducers, search-result parsing) + Playwright e2e per slice against 4174 (watch the `MAX_TERMINALS_PER_USER` terminal-cap gotcha — kill the dev tmux server + restart if a whole suite fails). `tsc --noEmit` is not a gate (pre-existing failures); `bun run test:unit` is the canonical gate.

## Risks / constraints

- `web/app.js` is ~10k lines — extract the shell into `web/ide-shell.js` + `web/editor-tabs.js`; do not bloat the mono file.
- The mount-agnostic refactor (Slice 0) touches many call sites — regression risk; keep phase 1–4 e2e green.
- Mobile must stay on sheets — gate IDE mode behind the desktop breakpoint.
- Terminals in the bottom panel — verify PTY/`Bun.Terminal` sizing when docked (phase 1 suppressed the size warning while docked; reuse that path).
- **Search backend is a real host capability** (grep over the filesystem) — must be behind `requireFileAccess` + audit + allowed-roots and bounded (timeout, max results, max file size) to avoid DoS. Security-sensitive: Codex review before merge.
- Foundation rules apply to the new endpoint (capability checks, audit rows, foundation-bearing test; one foundation test per file, pinned env vars — see CLAUDE.md).

## Orchestration

Same model as phases 3–4: per-slice subagents in the **main checkout** (worktree isolation branched from a stale base here — avoid it), serialize `web/app.js`-touching slices, parallelize disjoint ones. Codex (gpt-5.5) second opinion on the refactor plan and the Search backend. Each slice gets its own impl-plan doc (`docs/plans/2026-06-16-ide-shell-sliceN-*.md`) per the project convention.
