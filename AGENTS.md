# DeckTerm

Web terminal workspace with persistent PTY sessions, a floating/tiling window
manager, and desktop and mobile file, git, and task surfaces.

## Structure

```
deckterm/
├── backend/
│   ├── index.ts                 # Loopback-safe process entry point
│   ├── server.ts                # Hono routes, PTYs, WebSocket, auth, lifecycle
│   └── services/                # Foundation state, authz, fs, Trash, transfers
├── web/
│   ├── app.js                   # Window manager and terminal client
│   ├── api-client.js            # Same-origin unsafe-request marker
│   ├── file-explorer.js         # Files, Trash and reversible delete UX
│   ├── settings-*.js            # Actor-scoped settings UI and runtime behavior
│   ├── assets/                  # Generated, self-hosted browser dependencies
│   └── vendor/                  # xterm.js libraries; do not edit
├── scripts/                     # Assets, backup/restore, release and broker tools
├── ops/systemd/                 # Optional backup service/timer templates
└── package.json                 # Runtime, checks and test commands
```

## Stack

- **Runtime:** Bun 1.3.5+; `Bun.Terminal` is the PTY API.
- **Backend:** Hono, native Bun WebSocket, SQLite state, optional Cloudflare
  Access, and a guarded filesystem executor.
- **Frontend:** Vanilla JS, xterm.js, and locally served pinned assets.

## Commands

```bash
bun install
bun run dev                       # Development server, normally 127.0.0.1:4174
bun run typecheck
bun run build
bun run assets:check
bun run test:unit
bun run test:e2e:smoke
```

Run browser tests only against development on port `4174`, never production on
`4173`. `bun run start` starts the application using its current environment; it
does not itself authorize or perform a production deployment.

## Environments

| Port | Purpose     | Source                                    | Systemd service        |
| ---- | ----------- | ----------------------------------------- | ---------------------- |
| 4173 | Production  | `/home/deploy/apps/deckterm/prod/current` | `deckterm.service`     |
| 4174 | Development | `/home/deploy/deckterm_dev`               | `deckterm-dev.service` |

Development and production must use separate `DECKTERM_STATE_DIR` values and
tmux sockets.

## Code map

| Area                           | Location                                  | Role                                                    |
| ------------------------------ | ----------------------------------------- | ------------------------------------------------------- |
| Server startup and routes      | `backend/server.ts`                       | Hono app, PTYs, lifecycle, filesystem and API routes    |
| Browser boundary               | `backend/services/browser-boundary.ts`    | Origin checks, mutation marker and response headers     |
| State ownership                | `backend/services/state-ownership.ts`     | Private-state lock and ownership checks                 |
| Filesystem operations          | `backend/services/fs-executor.ts`         | Legacy/brokered contained file operations               |
| Reversible deletes             | `backend/services/file-trash.ts`          | Actor/root-bound Trash, restore and purge state machine |
| Client terminal/window manager | `web/app.js`                              | Reconnect, tiling and terminal lifecycle                |
| Files and Trash UI             | `web/file-explorer.js`                    | Explorer, undo, restore and permanent-purge actions     |
| Settings                       | `web/settings-*.js`, `web/editor-tabs.js` | Stored preferences and settings surface behavior        |
| Browser dependencies           | `scripts/build-assets.ts`, `web/assets/`  | Pinned local assets and manifest verification           |

## API

| Endpoint                    | Method    | Description                              |
| --------------------------- | --------- | ---------------------------------------- |
| `/api/health`               | GET       | Server status and release identity       |
| `/api/stats`                | GET       | CPU, RAM and disk usage                  |
| `/api/terminals`            | GET, POST | List or create PTYs                      |
| `/api/terminals/:id`        | DELETE    | Kill a PTY                               |
| `/api/terminals/:id/resize` | POST      | Resize a PTY                             |
| `/ws/terminals/:id`         | WS        | Terminal I/O stream                      |
| `/api/browse?path=`         | GET       | List an authorized directory             |
| `/api/files/download?path=` | GET       | Download an authorized regular file      |
| `/api/files/upload?path=`   | POST      | Upload into an authorized directory      |
| `/api/files/mkdir?path=`    | POST      | Create a directory                       |
| `/api/files`                | DELETE    | Move an item to same-root Trash          |
| `/api/files/rename`         | POST      | Rename an item                           |
| `/api/files/trash?path=`    | GET       | List the current root's Trash items      |
| `/api/files/trash/restore`  | POST      | Restore one Trash item without overwrite |
| `/api/files/trash/purge`    | POST      | Permanently purge one Trash item         |

Unsafe same-origin API calls need `X-DeckTerm-Request: 1`. The browser client
adds it through `web/api-client.js`; keep new client mutations on that path.

## Runtime configuration

| Variable                                | Default              | Meaning                                                         |
| --------------------------------------- | -------------------- | --------------------------------------------------------------- |
| `PORT`                                  | `4174`               | HTTP port                                                       |
| `HOST`                                  | `127.0.0.1`          | Bind address; safe local default                                |
| `OPENCODE_WEB_DEBUG`                    | `0`                  | DeckTerm debug logging compatibility name                       |
| `OPENCODE_WEB_MAX_TERMINALS`            | `10`                 | Global PTY cap                                                  |
| `MAX_TERMINALS_PER_USER`                | `10`                 | Per-actor PTY cap                                               |
| `ALLOWED_FILE_ROOTS`                    | service home         | Authorized legacy file roots                                    |
| `DECKTERM_STATE_DIR`                    | `~/.deckterm`        | Private database, tmux and task state                           |
| `TRUSTED_ORIGINS`                       | empty for local mode | Exact comma-separated HTTP(S) browser origins                   |
| `CF_ACCESS_REQUIRED`                    | `0`                  | Require Cloudflare Access JWT validation                        |
| `CF_ACCESS_TEAM_NAME` / `CF_ACCESS_AUD` | empty                | Required issuer team and audience when CF Access is required    |
| `DECKTERM_OS_ISOLATION`                 | `0`                  | Enable mapped-user brokered operations; unmapped work is denied |
| `DECKTERM_RELEASE`                      | inferred             | Release identity returned by health                             |

Public or proxy publishing, and Cloudflare Access, require explicit
`TRUSTED_ORIGINS`; the server refuses to start without them. Values must be
exact origins with no path. `FILE_TRASH_RETENTION_DAYS` is not operator
configuration: the reviewed implementation retains items for 30 days and
performs bounded expiry cleanup during a later explicit delete.

## Security and filesystem boundaries

- Keep production behind an authenticated internal boundary. Cloudflare Access
  mode requires both a team and audience configuration.
- Do not remove origin checks, the unsafe-request marker, CORS middleware, CSP,
  or WebSocket cleanup. The CSP permits only self-hosted scripts and styles;
  browser dependencies belong in `web/assets/`, not a CDN.
- All filesystem routes must resolve through the scoped executor. `.deckterm-trash`
  is reserved and cannot be browsed, downloaded, uploaded to, renamed into, or
  otherwise addressed through general file APIs.
- `DELETE /api/files` has no permanent fallback: it moves an item to an
  actor/root/mapping-bound directory on the same filesystem. Restore never
  overwrites an existing destination. The Trash is private (`0700`), so a
  second mapped Unix user sharing one writable root is refused rather than
  silently deleting permanently.
- The installed root-owned filesystem helper is a separate host prerequisite
  for `DECKTERM_OS_ISOLATION=1`. Do not replace it as part of an ordinary
  application release, and do not claim brokered Trash support until its
  reviewed helper version is installed.

## Deployment and operations

- A push to `main` is expected to use `.github/workflows/deploy-main.yml`.
  Verify the `Deploy Main` conclusion before saying production changed.
- Do not manually deploy production unless explicitly requested. A requested
  manual deploy must use `DEPLOY_ROOT=/home/deploy/apps/deckterm/prod`.
- A deployment using this release driver takes its production backup, restore,
  preflight and schema checks from the active reviewed release; the incoming
  tree is only `SOURCE_DIR`. The first rollout of this driver trust boundary
  needs the separate reviewed bootstrap described in
  [docs/upgrade-and-backup-runbook.md](docs/upgrade-and-backup-runbook.md).
- Backup timer templates are provided but are not installed by deployment.
  Enable or change production timers, off-host copies, or host privileges only
  under their own authorized operation.

## Anti-patterns

- Do not use Node PTY libraries; use `Bun.Terminal`.
- Do not edit `web/vendor/`.
- Do not hard-code deployment paths in runtime code; use configuration.
- Do not bypass rate limits, filesystem containment, state ownership, or
  release preflight checks to make a test pass.
