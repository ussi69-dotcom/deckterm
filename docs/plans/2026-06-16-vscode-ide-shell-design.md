# VS Code IDE Shell — Design

**Date:** 2026-06-16
**Status:** Drafted + hardened (brainstorming session 2026-06-16, user-approved sections 1–4; Codex gpt-5.5 xhigh review incorporated — mode-transition contract, device-local/viewport-gated `layout.mode`, mountable-controller refactor, inverted slicing, Search threat model, access-revalidated tab restore). Ready for per-slice impl planning in a new session.
**Scope:** Optional desktop "IDE mode" that reshapes the DeckTerm workspace into a VS Code-style shell (activity bar + sidebar + editor tabs + bottom terminal panel), toggled from the default terminal-first layout. Effectively "phase 5", building on the completed VS Code-grade workspace umbrella (phases 1–4).

## Motivation

User feedback (2026-06-16, screenshot of the git panel on a clean tree): the workspace "doesn't look much like VS Code", and the changes tree / per-file status / file browsing are hard to find because Files and Git are **separate floating windows** and the git panel is a custom 3-pane layout, not VS Code's unified activity-bar + sidebar + editor-tabs shell. The features from phases 1–4 exist but aren't arranged the way a VS Code user expects.

## Core model (user-approved)

A **mode toggle**, not a permanent replacement:

- **Terminal mode (default):** today's fullscreen terminals (TileManager full-bleed). Unchanged.
- **IDE mode** (toggled via an **"IDE"** button in the top toolbar): the surface reshapes into a VS Code shell. Terminals dock to the **bottom panel** (reusing the phase-1 bottom dock); activity bar + sidebar + editor area take the main area.
- **Everything is movable:** any sidebar view or panel can be "popped out" into a floating SurfaceWindow (phase 1) and docked back. The IDE shell is the default _arrangement_, not a cage.
- **Mobile:** unchanged (fullscreen terminals + sheets). IDE mode is **desktop-only** (≥768px), consistent with phase 1.

Layout state (`layout.sidebarWidth`, `layout.activeView`, `layout.editorTabs`, `layout.detached[viewId]`, bottom-panel height) persists via the phase-1 `settingsStore` and applies live through the phase-4 settings runtime.

> **Codex (xhigh) — `layout.mode` is NOT globally portable.** "Desktop-only" conflicts with "portable across devices": a desktop choosing IDE mode must not force IDE mode onto a phone. `layout.mode` is **device-local / viewport-gated**: stored as a desktop preference, but a viewport `<768px` always renders terminal mode (sheets) **without overwriting** the stored desktop preference. All persisted layout is **schema-versioned**.

### Mode transition contract (Codex xhigh — highest-risk area)

Mode switching is a **reversible presentation change, not a second workspace model**. Invariants the implementation MUST hold:

- **No PTY recreation.** Terminals/`Bun.Terminal` sessions are never destroyed or recreated on a mode switch — only their container/parent changes (reparent or show/hide), preserving tmux session metadata, scrollback, and `activeConnectionCount`.
- **Reversible & lossless.** Terminal→IDE→Terminal restores the prior TileManager state (tile geometry, active terminal, z-order, focus). IDE mode only changes the terminal _presentation layer_ (docked vs full-bleed).
- **Focus & resize.** Active focus is preserved across the switch; a resize/measurement pass runs after reparenting (xterm + CodeMirror need a `resize()` after their container changes size).
- **Floating windows.** Define what happens to detached SurfaceWindows when leaving IDE mode (kept floating vs re-docked) — decide and persist per `layout.detached`.

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

> **Codex (xhigh) — tab restore must re-validate.** Persisted tabs can point at deleted, moved, or no-longer-authorized files. On restore, persist only descriptors (never content), **revalidate every tab through the file capability layer** (`requireFileAccess`/`resolveAllowedPath`), silently drop missing/unauthorized tabs, and version the `layout.editorTabs` schema. The `settings` tab is **deferred** (see revised slicing) — file/diff tabs ship first.

## Key refactor — mountable view controllers

Today's components (FileExplorer, git panel, TaskBoard, FileEditor) assume a fixed panel/window. The enabling abstraction is a **mountable controller contract**, NOT "one live instance that moves everywhere".

> **Codex (xhigh) — do not move live DOM instances between hosts.** A DOM node can't exist in two places, and reparenting live instances leaks listeners and breaks CodeMirror/xterm measurement. Instead:
>
> - **Separate model/state from the rendered view.** Shared state lives in stores (e.g. the phase-3 `git-status-store`, a file-tree model, task state) independent of any DOM.
> - **Each view is a controller with `mount(container)` / `unmount()` / `dispose()` / `resize()`.** Moving a view = `unmount()` from the old host + `mount()` into the new one; state persists in the store, so the re-mounted view restores its UI. No promise that a single instance is reparented.
> - A `ViewHost` abstraction (sidebar slot, floating SurfaceWindow, editor-area pane) just provides a container + lifecycle calls. Refactor a component to this contract **only when it is actually re-hosted** (see revised slicing), not all at once.

## Data flow

- IDE toggle → `ideShell.setMode("ide"|"terminal")` → persists `layout.mode` (device-local, viewport-gated); reparents/show-hides shell chrome and the terminal presentation per the **mode transition contract** above (no PTY recreation, reversible, focus + resize preserved).
- `layout.*` keys flow through the phase-4 settings runtime (live apply); `layout.mode` is device-local + viewport-gated, the rest portable. All persisted layout is schema-versioned.
- Shared git status: the phase-3 `git-status-store` feeds both Explorer decorations and the SCM view; git mutations invalidate both.
- Open flows: SCM file click → `editor.openDiff(path, mode)`; Explorer click → `editor.openFile(path)`; Search result → `editor.openFile(path, line)`.
- Pop-out: view header "⤢" → `surfaceWindowManager.open(viewId, {host})`, removed from sidebar; "dock back" returns it. `layout.detached[viewId]` persisted.

## Build phasing (mergeable slices, each with tests, to `dev`, verified on 4174)

> **Revised after Codex (xhigh): invert the order — do NOT front-load a broad refactor.** Introduce the `ViewHost`/mountable-controller contract for ONE low-risk view first, stand up the shell scaffold around it early, prove pop-out/dock early, and refactor each remaining component only when it is actually re-hosted.

- **Slice 1 — `ViewHost` contract + Explorer adapter.** Define `mount/unmount/dispose/resize` + the file-tree state store; refactor ONLY `FileExplorerController` to it. No visible change yet (still works as a floating window). Existing explorer e2e stays green.
- **Slice 2 — IDE shell scaffold + toggle, hosting Explorer only.** Activity bar (Explorer icon only) + sidebar host + terminal docking to bottom panel + "IDE" button. Implements the **mode transition contract** (no PTY recreation, reversible, focus/resize). Proves the abstraction against real UI with one view. Terminal mode unchanged.
- **Slice 3 — pop-out/dock for the Explorer view.** Detach the sidebar view into a floating SurfaceWindow + dock back, persisted. Proves movability **early** (before refactoring all views) so a wrong host abstraction is caught cheaply.
- **Slice 4 — editor area with file + diff tabs.** Tab bar, preview/pin, wire Explorer click → open file tab; versioned + access-revalidated `layout.editorTabs` restore. (Settings-as-tab deferred.)
- **Slice 5 — Source Control view.** Refactor the git panel to the `ViewHost` contract; restructure into the VS Code SCM view; diffs + timeline open as editor-area tabs.
- **Slice 6 — Tasks view + remaining re-hosts.** Refactor TaskBoard to the contract as a sidebar view; FileEditor as needed.
- **Slice 7 — Search.** Backend `POST /api/files/search` per the threat model below + Search view (debounced, request-id cancellation) + open-at-line.
- **Slice 8 — settings-as-tab + VS Code polish.** Settings opens as an editor tab; styling pass.

## Search backend — threat model & required bounds (Codex xhigh)

`POST /api/files/search` runs grep/ripgrep over user-controlled paths + queries. Behind `requireFileAccess` + audit, it MUST enforce:

- **Path safety:** canonicalize the requested root with `realpath`; reject any path outside the allowed roots **after symlink resolution**; do **not** follow symlinks out of the roots (rg `--no-follow` or equivalent).
- **Query bounds:** fixed max query length; **literal mode by default**, regex only as an explicit opt-in; fixed max include/exclude globs.
- **Resource bounds:** process timeout **plus kill**; max stdout/stderr bytes; max files searched; max match bytes per line; deny binary files; default-ignore `.git`, `node_modules`, build dirs.
- **Secrecy:** exclude known secret files by default (`.env`, private keys, `*_token`/`*_secret`/credentials) unless a separate privileged capability is held — mirrors the env-info endpoint's secret-exclusion stance.
- **Concurrency / cancellation:** client debounces and sends a request id; the server **aborts the previous search** for that session and enforces per-session concurrency of 1–2, so typing can't stack stale `rg` processes.

This endpoint gets its own foundation-bearing test (path-escape rejection, secret-file exclusion, bound enforcement) and a Codex security pass before merge.

## Testing

Unit (pure helpers: editor tab model, layout-state reducers, search-result parsing) + Playwright e2e per slice against 4174 (watch the `MAX_TERMINALS_PER_USER` terminal-cap gotcha — kill the dev tmux server + restart if a whole suite fails). `tsc --noEmit` is not a gate (pre-existing failures); `bun run test:unit` is the canonical gate.

## Risks / constraints

- `web/app.js` is ~10k lines — extract the shell into `web/ide-shell.js` + `web/editor-tabs.js`; do not bloat the mono file.
- The mount-agnostic refactor (Slice 0) touches many call sites — regression risk; keep phase 1–4 e2e green.
- Mobile must stay on sheets — gate IDE mode behind the desktop breakpoint.
- Terminals in the bottom panel — verify PTY/`Bun.Terminal` sizing when docked (phase 1 suppressed the size warning while docked; reuse that path).
- **Search backend is a real host capability** — see the dedicated threat model below; "timeout + max-results" alone is insufficient.
- Foundation rules apply to the new endpoint (capability checks, audit rows, foundation-bearing test; one foundation test per file, pinned env vars — see CLAUDE.md).

## Orchestration

Same model as phases 3–4: per-slice subagents in the **main checkout** (worktree isolation branched from a stale base here — avoid it), serialize `web/app.js`-touching slices, parallelize disjoint ones. Codex (gpt-5.5) second opinion on the refactor plan and the Search backend. Each slice gets its own impl-plan doc (`docs/plans/2026-06-16-ide-shell-sliceN-*.md`) per the project convention.
