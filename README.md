# DeckTerm

DeckTerm is a browser-based terminal workspace for long-running remote development sessions.

It combines persistent tmux-backed shells, workspace tabs, split tiles, mobile-first controls, file and git tooling, and agent-aware status signals into one interface. The product direction is inspired by Ghostty's calm terminal UX, Termux-style mobile ergonomics, VS Code-style workspace affordances, and the practical needs of Codex and Claude-driven server workflows.

## What It Does

- Persistent tmux-backed terminal sessions that survive browser reconnects and service restarts
- Workspace tabs with split terminals, drag-to-merge behavior, linked views, and cwd-based color signals
- Mobile-friendly terminal controls with extra keys, viewport-aware focus recovery, and image/text clipboard handling
- Workspace-aware file explorer for browse, upload, download, mkdir, rename, and delete inside allowed roots
- Built-in git panel and git APIs for status, diff, stage, unstage, commit, branch, checkout, log, and show
- Agent-aware workspace badges such as `Codex` and `Codex Responding`
- Supervised Task Runner for Codex/Claude task workspaces, check runs, judge prompts, and optional git worktrees
- Release-based production deployment from `main` with CI verification and atomic rollout

## Product Snapshot

DeckTerm today is optimized for one practical job: keep remote coding sessions usable from desktop and mobile without losing context.

Current product pillars:

1. Session continuity
2. Workspace management
3. Mobile usability
4. File and git operations close to the terminal
5. Safe promotion from `dev` to `main`

For the full current-state description, see [docs/product-guide.md](/home/deploy/deckterm_dev/docs/product-guide.md).
For rollout and CI/CD details, see [deploy/README.md](/home/deploy/deckterm_dev/deploy/README.md) and [docs/operations-guide.md](/home/deploy/deckterm_dev/docs/operations-guide.md).

## Runtime Model

Two separate environments are used on the server:

| Port   | Role        | Source                                                          | Service                |
| ------ | ----------- | --------------------------------------------------------------- | ---------------------- |
| `4174` | Development | [`/home/deploy/deckterm_dev`](/home/deploy/deckterm_dev)        | `deckterm-dev.service` |
| `4173` | Production  | release symlink under `/home/deploy/apps/deckterm/prod/current` | `deckterm.service`     |

Important:

- Development work happens in [`/home/deploy/deckterm_dev`](/home/deploy/deckterm_dev) on branch `dev`
- Production no longer runs directly from a live git checkout
- `main` deploys through GitHub Actions into release directories

## Quick Start

```bash
git clone https://github.com/ussi69-dotcom/deckterm.git
cd deckterm
bun install
bun run dev
```

By default the backend starts on `4174` unless `PORT` overrides it.

For a dedicated server install with Cloudflare Access, Cloudflare Tunnel,
nginx, systemd, and firewall guidance, see
[docs/install-dedicated-server.md](docs/install-dedicated-server.md).

## Core Features

### Terminal and workspace UX

- Up to 10 concurrent terminals by default
- New workspace tabs and split terminals inside a workspace
- Drag one workspace tab onto another to merge them
- Command palette for workspace switching, reopening recent workspaces, directory jumps, cwd reveal in Files, and branch checkout via `Ctrl+Shift+P`
- Desktop uses a compact top bar with primary actions for Files, Git, Palette, and More
- Mobile uses a bottom action bar for Files, Git, Paste, and More
- More opens overflow actions for secondary utilities like Clipboard, Extra Keys, Wrap, Fullscreen, Fonts, and Help
- Setup runs the deployment doctor, profile wizard, remediation rows, and config snippets for dedicated installs
- Tasks opens a supervised Agent Runner surface for creating task workspaces, running checks, and launching worker/judge terminals
- Desktop Files opens as a persistent right-side explorer while mobile Files opens as an overlay
- Command palette stays focused on jump-layer and advanced commands rather than basic visible navigation
- Search, font scaling, fullscreen, line wrap toggle, reconnect lifecycle overlay
- Linked view for tmux-backed sessions

### Mobile workflow

- Extra keys bar with modifiers, arrows, navigation keys, and F-keys
- Focus recovery when switching back to the active terminal
- Clipboard image upload and touch paste fallback
- Layout fixes for narrow screens, virtual keyboards, and viewport shifts

### Clipboard and files

- OSC52 clipboard capture
- Clipboard history panel
- Large-paste warning flow
- File explorer under allowed filesystem roots with per-workspace path memory

### Git workflow

- Git status, diff, stage, unstage, commit, branch listing, checkout, log, and show
- Git panel intended for lightweight terminal-adjacent operations, including mobile use

### Agent-aware signals

- Workspace tabs detect running processes
- Codex and Claude sessions can surface `Codex` / `Codex Responding` style labels
- Port and worktree hints are also surfaced in workspace metadata

### Agent tool telemetry (opt-in)

Each terminal can carry a small, display-only ring buffer (last 50) of recent
agent tool activity, shown in the workspace tab's tooltip alongside the
existing agent/running/port/worktree signals — for example `Bash · ls -la`.
This is opt-in: nothing is captured unless you wire up the emitter script as
a Claude Code hook.

Add a `PreToolUse` hook in your Claude Code `settings.json` that pipes the
hook payload into `scripts/deckterm-agent-hook.sh`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/deckterm/scripts/deckterm-agent-hook.sh"
          }
        ]
      }
    ]
  }
}
```

The script writes a terminal OSC marker (`\033]9;9;deckterm;tool;...\007`)
to `/dev/tty` and always exits 0, so it never blocks the tool call. It only
works when the session is attached to a controlling terminal — that means
the **tmux terminal backend** (`TMUX_BACKEND=1`, the deployed default). The
raw backend has no controlling tty, so the marker is silently dropped there.

## Security and Access

DeckTerm supports Cloudflare Access JWT validation and trusted origins. Production should be treated as a protected internal tool, not a public terminal exposed directly to the internet.

Relevant variables include:

- `CF_ACCESS_REQUIRED`
- `CF_ACCESS_TEAM_NAME`
- `CF_ACCESS_AUD`
- `TRUSTED_ORIGINS`
- `ALLOWED_FILE_ROOTS`

## Configuration

Common runtime variables:

| Variable                              | Default                      | Purpose                                                                                                                                                                                                 |
| ------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                | `4174`                       | HTTP server port                                                                                                                                                                                        |
| `HOST`                                | `0.0.0.0`                    | Bind address                                                                                                                                                                                            |
| `OPENCODE_WEB_DEBUG`                  | `0`                          | Debug logging                                                                                                                                                                                           |
| `OPENCODE_WEB_MAX_TERMINALS`          | `10`                         | Global terminal cap                                                                                                                                                                                     |
| `MAX_TERMINALS_PER_USER`              | `10`                         | Per-user cap                                                                                                                                                                                            |
| `TERMINAL_IDLE_TIMEOUT_MS`            | `86400000` (24 h)            | Attached-but-idle terminal cleanup (neither input nor output)                                                                                                                                           |
| `DECKTERM_ORPHAN_TTL_HOURS`           | `72`                         | Detached terminal reaper window (neither input nor output)                                                                                                                                              |
| `SCROLLBACK_MAX_LINES`                | `2000`                       | Reconnect replay line budget                                                                                                                                                                            |
| `SCROLLBACK_MAX_BYTES`                | `1048576`                    | Reconnect replay byte budget                                                                                                                                                                            |
| `AGENT_RESPONDING_IDLE_MS`            | `700`                        | Response-to-idle decay for agent badges                                                                                                                                                                 |
| `ALLOWED_FILE_ROOTS`                  | `$HOME`                      | Allowed browse/upload/git roots                                                                                                                                                                         |
| `TMUX_BACKEND`                        | `1` in deployed environments | Persistent tmux sessions                                                                                                                                                                                |
| `DECKTERM_STATE_DIR`                  | `$HOME/.deckterm`            | Task Runner metadata, control files, and worktree root                                                                                                                                                  |
| `DECKTERM_TASK_MAX_ROUNDS`            | `5`                          | Reserved cap for supervised worker/judge rounds                                                                                                                                                         |
| `DECKTERM_TASK_PROVIDERS`             | `codex,claude`               | Reserved provider allow-list for task workflows                                                                                                                                                         |
| `DECKTERM_PUBLISH_MODE`               | `local`                      | Setup doctor profile: `local`, `cloudflare`, `nginx`, or `direct`                                                                                                                                       |
| `CF_ACCESS_REQUIRED`                  | `0`                          | Require Cloudflare Access JWTs                                                                                                                                                                          |
| `CF_ACCESS_TEAM_NAME`                 | empty                        | Cloudflare Access team name                                                                                                                                                                             |
| `CF_ACCESS_AUD`                       | empty                        | Cloudflare Access application audience tag                                                                                                                                                              |
| `TRUSTED_ORIGINS`                     | empty                        | Comma-separated allowed browser origins                                                                                                                                                                 |
| `DECKTERM_DOCTOR_ENV`                 | `.env`                       | Env file used by the Setup doctor endpoint                                                                                                                                                              |
| `DECKTERM_DOCTOR_SCRIPT`              | `scripts/doctor.sh`          | Fixed local doctor script used by Setup                                                                                                                                                                 |
| `DECKTERM_OS_ISOLATION`               | `0`                          | Multiuser enablement gate: startup refuses (fail-closed) on unreviewed legacy wildcard grants/admins or no owner when `1`; runs PTY/files/git as the mapped unix user via the broker (B2/B4), or denies |
| `DECKTERM_MIN_UID`                    | `1000`                       | Floor for a mappable unix uid; accounts below it (system accounts) are never mappable                                                                                                                   |
| `DECKTERM_OS_USERS_GROUP`             | `deckterm-users`             | Required opt-in group — a unix account must be a member to be mappable                                                                                                                                  |
| `DECKTERM_ISOLATION_PER_UID_CAP`      | `8`                          | Max concurrent brokered fs/git/search ops per mapped uid (over the cap → `429`); isolation mode only                                                                                                    |
| `DECKTERM_ISOLATION_GLOBAL_CAP`       | `64`                         | Max concurrent brokered fs/git/search ops across all users (over the cap → `429`); isolation mode only                                                                                                  |
| `DECKTERM_EVENT_RETENTION_DAYS`       | `30`                         | TTL for `terminal_events` rows; daily prune (B6)                                                                                                                                                        |
| `DECKTERM_SESSION_RETENTION_DAYS`     | `30`                         | TTL for `ended` terminal session rows; daily prune (B6)                                                                                                                                                 |
| `DECKTERM_STATE_EVENT_RETENTION_DAYS` | `2`                          | Short TTL for `state`-kind events (replay-only metadata; applies to live sessions too)                                                                                                                  |
| `DECKTERM_RETENTION_DISABLED`         | unset                        | `1` turns the B6 retention scheduler off entirely                                                                                                                                                       |
| `DECKTERM_TERMINAL_LIST_ENDED_LIMIT`  | `10`                         | Max ended sessions returned by `GET /api/terminals` (DB retention unaffected; `0` = active only)                                                                                                        |
| `DECKTERM_BACKUP_KEEP`                | `7`                          | Backup sets kept by `scripts/backup-state.sh`                                                                                                                                                           |
| `TERMINAL_RATE_LIMIT_PER_USER_MAX`    | rate-limit max (`40`)        | Per-user terminal-create budget per window (B7)                                                                                                                                                         |
| `TERMINAL_RATE_LIMIT_GLOBAL_MAX`      | `4×` per-user                | Global backstop terminal-create budget per window (B7)                                                                                                                                                  |

Legacy compatibility note:

- The OpenCode proxy routes were removed in June 2026 (OpenCode is not part of the DeckTerm workflow). The `OPENCODE_WEB_*` env var names remain for deployment compatibility: they configure DeckTerm itself (debug logging, terminal caps, rate limits), not OpenCode.

## Development Workflow

Branch model:

- `feature/*` for scoped work
- `dev` as integration branch
- `main` as production branch

Promotion model:

1. Build on `feature/*` or directly on `dev`
2. Validate on `4174`
3. Promote to `main`
4. Let `Deploy Main` verify, package, and atomically deploy production

## Testing

```bash
bun run test:unit
bun run test:e2e:smoke
bun run test:e2e:workspace
bun run test:e2e
```

Project rule: browser tests target the dev environment on `4174`.

## Docs

- Product guide: [docs/product-guide.md](/home/deploy/deckterm_dev/docs/product-guide.md)
- Operations and CI/CD: [docs/operations-guide.md](/home/deploy/deckterm_dev/docs/operations-guide.md)
- Deploy layout and rollback: [deploy/README.md](/home/deploy/deckterm_dev/deploy/README.md)

## Tech Stack

- Runtime: Bun
- Backend: Hono + Bun WebSocket + Bun.Terminal
- Frontend: Vanilla JS + xterm.js
- Persistence: tmux
- Auth: optional Cloudflare Access JWT validation

## License

MIT
