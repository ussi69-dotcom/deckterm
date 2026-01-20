# DeckTerm

A web-based terminal emulator with full PTY support, floating/tiling window manager, and mobile-friendly UI.

![Bun](https://img.shields.io/badge/Bun-1.3.5+-black?logo=bun)
![Hono](https://img.shields.io/badge/Hono-4.x-orange)
![xterm.js](https://img.shields.io/badge/xterm.js-5.x-green)
![License](https://img.shields.io/badge/License-MIT-blue)

## Features

- **Full PTY Support** - Native terminal emulation with resize, colors, and cursor positioning
- **Tiling Window Manager** - Drag, resize, snap, and tile multiple terminal windows
- **Multi-Terminal** - Up to 10 concurrent terminal sessions per user
- **Auto-Reconnect** - WebSocket reconnection with exponential backoff
- **Mobile Support** - Touch-friendly extra keys bar (ESC, TAB, CTRL, ALT, SHIFT, arrows, F1-F12)
- **File Manager** - Browse, upload, download, and manage files
- **Server Stats** - Real-time CPU, RAM, and disk usage monitoring
- **OSC52 Clipboard** - Copy from TUI tools (vim, tmux, OpenCode) with history panel
- **OpenCode Integration** - Embedded AI coding assistant via reverse proxy
- **Git Panel** - Quick commits from mobile with VS Code-like UI
- **Cloudflare Access Auth** - Secure multi-user access with JWT authentication

## Requirements

- **Bun 1.3.5+** (required for native PTY API)

## Quick Start

```bash
git clone https://github.com/ussi69-dotcom/deckterm.git
cd deckterm
bun install
bun run dev
```

Open http://localhost:4173 in your browser.

## Security

**⚠️ IMPORTANT: DO NOT expose DeckTerm directly to the public internet!**

DeckTerm is designed to run behind **Cloudflare Tunnel** with **Cloudflare Access** for authentication. Direct exposure creates serious security risks.

### Required Environment Variables

| Variable              | Description                               | Required                |
| --------------------- | ----------------------------------------- | ----------------------- |
| `CF_ACCESS_REQUIRED`  | Set to `1` to enforce JWT validation      | Yes (production)        |
| `CF_ACCESS_TEAM_NAME` | Your Cloudflare Access team name          | Yes (when auth enabled) |
| `CF_ACCESS_AUD`       | Application AUD tag from Access dashboard | Yes (when auth enabled) |
| `TRUSTED_ORIGINS`     | Comma-separated list of allowed origins   | Recommended             |

### Deployment Checklist

- [ ] Set up Cloudflare Tunnel pointing to DeckTerm
- [ ] Create Cloudflare Access application
- [ ] Configure email OTP authentication
- [ ] Set required environment variables in `.env`
- [ ] Test authentication from a new device
- [ ] Verify terminal ownership isolation (users can't see each other's terminals)

### OpenCode Integration (Optional)

To enable the embedded AI coding assistant:

1. **Start OpenCode server:**

   ```bash
   # Run in tmux for persistence
   tmux new -d -s opencode "opencode web --port 4096"
   ```

2. **Expose via Cloudflare Tunnel:**

   ```bash
   # Add to your tunnel config (e.g., ~/.cloudflared/config.yml)
   # - hostname: opencode.yourdomain.com
   #   service: http://localhost:4096
   ```

3. **Configure DeckTerm:**

   ```bash
   # Add to .env
   OPENCODE_URL=https://opencode.yourdomain.com
   ```

4. **Restart DeckTerm** - The OpenCode button will now open the embedded panel.

If `OPENCODE_URL` is not set, clicking the OpenCode button shows setup instructions.

## Configuration

| Variable                     | Default                    | Description                                     |
| ---------------------------- | -------------------------- | ----------------------------------------------- |
| `PORT`                       | 4173                       | Server port                                     |
| `HOST`                       | 0.0.0.0                    | Bind address                                    |
| `TMUX_BACKEND`               | 0                          | Enable tmux for session persistence (1=enabled) |
| `OPENCODE_WEB_DEBUG`         | 0                          | Enable debug logging (1=enabled)                |
| `OPENCODE_WEB_MAX_TERMINALS` | 10                         | Max concurrent terminals (global limit)         |
| `MAX_TERMINALS_PER_USER`     | 10                         | Max terminals per user                          |
| `TERMINAL_IDLE_TIMEOUT_MS`   | 7200000 (2 hours)          | Auto-close terminals after idle time (ms)       |
| `CF_ACCESS_REQUIRED`         | 0                          | Require Cloudflare Access JWT (1=enabled)       |
| `CF_ACCESS_TEAM_NAME`        | -                          | Cloudflare Access team name                     |
| `CF_ACCESS_AUD`              | -                          | Cloudflare Access application AUD tag           |
| `TRUSTED_ORIGINS`            | (empty = allow all in dev) | Comma-separated allowed origins for CORS        |
| `OPENCODE_UPSTREAM`          | http://127.0.0.1:4096      | OpenCode backend URL (for health checks)        |
| `OPENCODE_URL`               | (empty = disabled)         | OpenCode frontend URL (Cloudflare-exposed)      |

### Tmux Backend (Recommended)

Enable `TMUX_BACKEND=1` for:

- **Session persistence** - Terminal history preserved across reconnections
- **Cross-device continuity** - Switch from mobile to PC without losing context
- **TUI app support** - Claude Code, htop, vim redraw properly after reconnect

```bash
# In systemd service or .env
Environment=TMUX_BACKEND=1
```

Without tmux backend, terminal content is lost on reconnection (only SIGWINCH-triggered redraws work).

## Keyboard Shortcuts

| Shortcut          | Action                  |
| ----------------- | ----------------------- |
| `Ctrl+N`          | New terminal            |
| `Ctrl+W`          | Close terminal          |
| `Ctrl+Tab`        | Switch to next tab      |
| `Ctrl+1-9`        | Switch to tab by number |
| `Ctrl+Shift+D`    | Split workspace         |
| `Ctrl+G`          | Group terminals         |
| `Ctrl+F`          | Search in terminal      |
| `Ctrl++`/`Ctrl+-` | Adjust font size        |
| `F11`             | Toggle fullscreen       |

## Mobile Extra Keys

Bottom bar provides touch access to special keys:

- **Row 1:** ESC, TAB, CTRL, ALT, SHIFT, arrows, HOME, END, INS, DEL
- **Row 2:** F1-F12, PgUp, PgDn (toggle with ⋯)

## API

### Terminals

```bash
POST /api/terminals              # Create terminal
GET /api/terminals               # List terminals
DELETE /api/terminals/:id        # Delete terminal
POST /api/terminals/:id/resize   # Resize terminal
WS /ws/terminals/:id             # WebSocket connection
```

### Files

```bash
GET /api/browse?path=            # Browse directory
GET /api/files/download?path=    # Download file
POST /api/files/upload?path=     # Upload file
POST /api/files/mkdir?path=      # Create directory
DELETE /api/files?path=          # Delete file/directory
POST /api/files/rename           # Rename file
```

### Health

```bash
GET /api/health                  # Server status
GET /api/stats                   # CPU/RAM/Disk usage
```

### OpenCode Integration

```bash
GET /api/apps/opencode/health    # OpenCode server status
ALL /apps/opencode/*             # Reverse proxy to OpenCode
WS /apps/opencode/ws             # WebSocket proxy for OpenCode
```

### Git Operations

```bash
GET /api/git/status?cwd=...      # Git status
GET /api/git/diff?cwd=...&path=... # Git diff
POST /api/git/stage              # Stage files
POST /api/git/unstage            # Unstage files
POST /api/git/commit             # Create commit
GET /api/git/branches?cwd=...    # List branches
```

## Project Structure

```
deckterm/
├── backend/
│   ├── index.ts        # Entry point
│   └── server.ts       # Hono server + PTY
├── web/
│   ├── app.js          # Frontend app (~3200 lines)
│   ├── index.html      # UI shell
│   ├── styles.css      # GitHub dark theme
│   ├── terminal-colors.js  # Workspace color hashing
│   ├── terminal-colors.test.js  # Unit tests
│   └── vendor/         # xterm.js libs
├── .env
└── package.json
```

## Testing

```bash
# Run all tests
bun test

# Run specific test file
bun test ./web/terminal-colors.test.js
```

### Test Coverage

| Module             | Tests | Status     |
| ------------------ | ----- | ---------- |
| terminal-colors.js | 2     | ✅ Passing |

### Browser Compatibility

The `terminal-colors.js` module uses CommonJS-style exports for browser compatibility:

```javascript
// Works in both Node.js/Bun and browser <script> tags
if (typeof module !== "undefined" && module.exports) {
  module.exports = { hashCwdToColor, blendWorkspaceColors, hexToRgba };
}
```

**Note:** ESM `export {}` syntax breaks in browser `<script>` tags. Always use the CommonJS pattern above for browser-loaded modules.

## Tech Stack

- **Runtime**: [Bun](https://bun.sh/) with native PTY
- **Backend**: [Hono](https://hono.dev/)
- **Frontend**: Vanilla JS + [xterm.js](https://xtermjs.org/)

## License

MIT
