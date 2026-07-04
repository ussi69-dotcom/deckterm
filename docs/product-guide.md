# DeckTerm Product Guide

## Overview

DeckTerm is a browser terminal workspace for remote development. It is designed around persistent tmux sessions, multi-terminal workspaces, strong mobile ergonomics, and agent-driven coding workflows.

The current product is shaped by four influences:

- Ghostty: terminal polish, calm signals, tab ergonomics
- Termux: touch-first modifier and extra-key workflows
- VS Code: workspace and side-tool affordances
- Practical Codex and Claude usage on remote Linux servers

## Current Capabilities

### 1. Persistent terminal sessions

- PTY sessions run behind Bun and can be backed by tmux
- Existing tmux sessions are recovered on server startup
- Reconnect replay restores scrollback after transient disconnects
- Linked views allow multiple DeckTerm views into the same tmux session

### 2. Workspace-oriented terminal UI

- Each top tab is a workspace
- A workspace can contain one or more split terminals
- Tabs can be merged by drag and drop
- A command palette acts as a jump layer for workspace switching, recent workspace reopen, directory jumps, cwd reveal in Files, and branch checkout
- Desktop uses a compact top bar with primary actions for Files, Git, Palette, and More
- Mobile uses a bottom action bar with Files, Git, Paste, and More
- More opens the overflow surface for secondary utilities like Clipboard, Extra Keys, Wrap, Fullscreen, Fonts, and Help
- Workspace labels follow cwd
- Workspace color is derived from cwd
- Workspace signals can show:
  - running activity
  - `Codex` or `Codex Responding`
  - exposed localhost ports
  - worktree status

### 3. Mobile-first interaction fixes

- Extra keys bar for modifiers and navigation keys
- Better focus restoration when returning to a terminal
- Virtual-keyboard-aware viewport handling
- Touch paste support for text and images
- Clipboard failure paths degrade gracefully instead of crashing

### 4. Built-in file operations

- Desktop Files opens as a persistent right-side explorer sidebar
- Mobile Files opens as a full overlay explorer
- Explorer path and lightweight selection state are remembered per workspace
- Files and Git coordinate as mutually exclusive right-side shell surfaces
- Desktop Files and Git are surfaced directly from the top bar, while mobile keeps them in the bottom action bar
- Browse directories inside allowed roots
- Fallback to a valid root if a stored path becomes invalid
- Upload files
- Create folders
- Create a folder in the active cwd directly from the command palette
- Rename files
- Delete files and directories
- Download files

### 5. Clipboard workflow

- OSC52 clipboard ingestion from terminal tools
- Clipboard history panel
- Large paste warning
- Async clipboard API support
- Native DOM paste fallback on touch devices
- Image clipboard upload to server-side temp storage

### 6. Git workflow

DeckTerm includes git-focused backend APIs and UI support for lightweight repo operations:

- status
- diff
- stage / unstage
- commit
- branches
- explicit branch checkout from the command palette
- checkout
- log
- show

This is intended as a terminal-adjacent helper, not a full graphical git client. When Git opens, it takes over the same right-side shell slot used by Files.

### 7. Agent-aware workspace state

DeckTerm can distinguish general running commands from supported agent CLIs:

- generic `Running`
- `Codex`
- `Codex Responding`
- equivalent `Claude` labels when detected

The state model is driven by shell integration markers plus agent output heuristics.

## User Interface Inventory

Primary toolbar actions in the current product:

- new workspace terminal
- workspace tabs
- working directory input
- directory browser
- desktop Files / Git / Palette / More actions
- mobile Files / Git / Paste / More actions
- linked tmux view
- server CPU / RAM / disk stats

Secondary navigation surfaces:

- desktop files explorer as a persistent right-side sidebar
- mobile files explorer as a full overlay
- command palette for jump-layer navigation, folder creation, cwd reveal in Files, and branch checkout
- overflow surface behind More for clipboard and utility actions

Modal and support surfaces:

- directory picker
- large paste confirmation
- search bar
- clipboard panel
- git panel
- debug panel

## API Surface

Core endpoints currently present:

### Terminal APIs

- `GET /api/health`
- `GET /api/stats`
- `POST /api/terminals`
- `POST /api/terminals/:id/linked-view`
- `GET /api/terminals`
- `DELETE /api/terminals/:id`
- `POST /api/terminals/:id/resize`
- `WS /ws/terminals/:id`

### File APIs

- `GET /api/browse`
- `GET /api/files/download`
- `POST /api/files/upload`
- `POST /api/files/mkdir`
- `DELETE /api/files`
- `POST /api/files/rename`

### Git APIs

- `GET /api/git/status`
- `GET /api/git/diff`
- `POST /api/git/stage`
- `POST /api/git/unstage`
- `POST /api/git/commit`
- `GET /api/git/branches`
- `GET /api/git/log`
- `POST /api/git/checkout`
- `GET /api/git/show`

### Clipboard API

- `POST /api/clipboard/image`

> The API surface above is a partial inventory (terminal/file/git/clipboard). It
> has grown since this list was written — foundation (`/api/foundation/status`,
> `/api/bootstrap`), settings (`/api/settings`, `/api/settings/env-info`), tasks
> (`/api/tasks*`), onboarding (`/api/onboarding/*`), plus additional file/git
> routes (`/api/files/content`, `/api/files/search`, `/api/git/stash`,
> `/api/git/discard`, `/api/git/commit-files`, `/api/git/branch`) are not listed
> here. TODO: full API reference refresh — Track E5,
> `docs/plans/2026-07-02-enterprise-1.0-program.md`.

## Runtime Topology

### Development

- port: `4174`
- service: `deckterm-dev.service`
- checkout: [`/home/deploy/deckterm_dev`](/home/deploy/deckterm_dev)
- branch: `dev`

### Production

- port: `4173`
- service: `deckterm.service`
- runtime source: release symlink under `/home/deploy/apps/deckterm/prod/current`
- source branch: `main`

## Security Model

DeckTerm supports Cloudflare Access JWT validation and origin restriction.

Important controls:

- `CF_ACCESS_REQUIRED`
- `CF_ACCESS_TEAM_NAME`
- `CF_ACCESS_AUD`
- `TRUSTED_ORIGINS`
- `ALLOWED_FILE_ROOTS`
- per-user terminal ownership limits
- rate limiting on terminal creation

## What Is No Longer Part of the Product Story

- OpenCode is no longer promoted as a first-class UI feature
- Production is no longer expected to run from a mutable git checkout
- The old mental model of "edit live prod checkout and restart it" is obsolete

## Recommended Usage Model

1. Build and test on `4174`
2. Keep product changes in `dev`
3. Promote to `main` only when `dev` is validated
4. Let GitHub Actions package and deploy production
