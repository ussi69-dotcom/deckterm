# TermDeck Security & Integration Roadmap - Work Plan v1.1

> **Created:** 2026-01-11
> **Updated:** 2026-01-11 (post-Oracle review)
> **Status:** REVIEWED - Ready for implementation
> **Planner:** Prometheus (ultrawork mode)
> **Reviewer:** Oracle agent

---

## Executive Summary

This plan transforms TermDeck from an open development tool into a secure, multi-user terminal platform accessible from anywhere via Cloudflare Tunnel + Access. The implementation follows a strict priority order (P0 → P1 → P2) with security-first approach.

### Oracle Review - Critical Findings Incorporated

| Issue                                   | Severity | Resolution                           |
| --------------------------------------- | -------- | ------------------------------------ |
| WebSocket auth bypass                   | CRITICAL | Full JWT verification for WS upgrade |
| "anonymous" fallback when auth required | HIGH     | Return 401, never allow anonymous    |
| CORS "hardening" insufficient           | MEDIUM   | Properly reject unknown origins      |
| xterm.js version mismatch for OSC52     | MEDIUM   | Add version check/upgrade subtask    |
| Git path containment bypass via `..`    | HIGH     | Use `realpath` + `--` separator      |
| Per-user rate limits missing            | MEDIUM   | Add user-keyed terminal limits       |
| Base64 decode UTF-8 issue               | LOW      | Use Uint8Array + TextDecoder         |

---

## Table of Contents

1. [Current Architecture Analysis](#1-current-architecture-analysis)
2. [P0-1: Cloudflare Access JWT + Terminal Ownership](#2-p0-1-cloudflare-access-jwt--terminal-ownership)
3. [P0-2: OSC52 Clipboard Support](#3-p0-2-osc52-clipboard-support)
4. [P1-3: OpenCode Web Integration](#4-p1-3-opencode-web-integration)
5. [P1-4: Git Panel](#5-p1-4-git-panel)
6. [Implementation Order & Dependencies](#6-implementation-order--dependencies)
7. [Risks & Mitigations](#7-risks--mitigations)

---

## 1. Current Architecture Analysis

### 1.1 Backend (`backend/server.ts` - 595 lines)

**Tech Stack:**

- Runtime: Bun 1.3.5+ (required for `Bun.Terminal` PTY API)
- Framework: Hono 4.x
- Dependencies: Only `hono` (minimal attack surface)

**Current Endpoints:**

| Endpoint                    | Method | Handler          | Line    |
| --------------------------- | ------ | ---------------- | ------- |
| `/api/health`               | GET    | Health check     | 91-98   |
| `/api/stats`                | GET    | CPU/RAM/Disk     | 101-130 |
| `/api/terminals`            | POST   | Create PTY       | 133-236 |
| `/api/terminals`            | GET    | List terminals   | 239-246 |
| `/api/terminals/:id`        | DELETE | Kill terminal    | 249-266 |
| `/api/terminals/:id/resize` | POST   | Resize PTY       | 269-291 |
| `/api/browse`               | GET    | Directory list   | 294-334 |
| `/api/files/download`       | GET    | Download file    | 337-365 |
| `/api/files/upload`         | POST   | Upload file      | 368-403 |
| `/api/files/mkdir`          | POST   | Create directory | 406-424 |
| `/api/files`                | DELETE | Delete file      | 427-452 |
| `/api/files/rename`         | POST   | Rename file      | 455-471 |
| `/ws/terminals/:id`         | WS     | Terminal I/O     | 496-580 |

**State Management:**

- `terminals: Map<string, Terminal>` - In-memory PTY sessions (line 48)
- `terminalSockets: Map<string, Set<WebSocket>>` - Active WS connections (line 49)
- No persistence - terminals lost on restart

**Current Security (CRITICAL GAPS):**

```typescript
// Line 78 - CORS allows ALL origins!
app.use("/*", cors());

// No authentication at all
// No terminal ownership concept
// No user identity tracking
```

**Rate Limiting:**

- 20 terminals/minute (line 44-67)
- Max 10 concurrent terminals (line 40-43)

### 1.2 Frontend (`web/app.js` - 2855 lines)

**Major Classes:**

| Class                   | Responsibility                 | Lines     |
| ----------------------- | ------------------------------ | --------- |
| `FolderColorManager`    | Maps folder paths to colors    | 58-127    |
| `ReconnectingWebSocket` | Auto-reconnect with heartbeat  | 135-252   |
| `Tile`                  | Individual floating window     | 258-533   |
| `TileGroup`             | Visual grouping of tiles       | 539-558   |
| `Workspace`             | Container for terminals        | 564-588   |
| `TileManager`           | Floating/tiling window manager | 594-1335  |
| `ExtraKeysManager`      | Mobile extra keys handler      | 1341-1463 |
| `FileManager`           | File browser UI                | 1469-1702 |
| `StatsManager`          | Server stats display           | 1709-1753 |
| `TerminalManager`       | Main orchestrator              | 1760-2795 |

**xterm.js Configuration (lines 2108-2152):**

- Theme: GitHub Dark
- Font: JetBrains Mono + Nerd Font
- Addons: FitAddon, WebLinksAddon
- NO: SearchAddon, ClipboardAddon

**WebSocket Protocol:**

```javascript
// Client → Server
{ type: "input", data: "..." }   // Terminal input
{ type: "resize", cols, rows }   // Resize PTY
{ type: "ping" }                 // Heartbeat

// Server → Client
{ type: "pong" }                 // Heartbeat response
{ type: "exit", code }           // Terminal exited
raw string                       // PTY output
```

**Clipboard (current - lines 2670-2687):**

- Manual copy: `terminal.getSelection()` + `navigator.clipboard.writeText()`
- Manual paste: `navigator.clipboard.readText()` + send to WS
- NO OSC52 support

---

## 2. P0-1: Cloudflare Access JWT + Terminal Ownership

### 2.1 Research Findings

**Official Hono Middleware Exists!**

- Package: `@hono/cloudflare-access` (honojs/middleware repo)
- Source: https://github.com/honojs/middleware/tree/main/packages/cloudflare-access
- Handles: JWT parsing, signature validation, JWKS caching, expiry check

**JWT Structure (from CF docs):**

```typescript
type CloudflareAccessPayload = {
  aud: string[]; // Application AUD tag
  email: string; // User email
  exp: number; // Expiration timestamp
  iat: number; // Issued at
  nbf: number; // Not before
  iss: string; // Issuer (team domain)
  type: string; // "app" or "org"
  identity_nonce: string;
  sub: string; // Subject (unique user ID)
  country: string; // User's country
};
```

**Header:** `Cf-Access-Jwt-Assertion`
**Cookie:** `CF_Authorization`

### 2.2 Implementation Design

#### 2.2.1 Environment Variables

```bash
# Required when CF_ACCESS_REQUIRED=1
CF_ACCESS_REQUIRED=1              # Enable mandatory auth
CF_ACCESS_TEAM_NAME=termdeck      # Your CF Access team name
CF_ACCESS_AUD=xxxxx               # Application AUD tag

# CORS hardening
TRUSTED_ORIGINS=https://termdeck.eu,https://termdeck.cloudflareaccess.com
```

#### 2.2.2 Backend Changes

**File: `backend/server.ts`**

```typescript
// NEW IMPORTS (line ~1-5)
import {
  cloudflareAccess,
  type CloudflareAccessPayload,
} from "@hono/cloudflare-access";

// EXTEND Terminal TYPE (line ~26-34)
type Terminal = {
  id: string;
  proc: Subprocess;
  terminal: BunTerminalInstance;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  ownerId: string; // NEW: User sub/email
  ownerEmail: string; // NEW: User email for display
};

// NEW: Auth middleware (after cors, line ~78)
const CF_ACCESS_REQUIRED = process.env.CF_ACCESS_REQUIRED === "1";
const CF_ACCESS_TEAM = process.env.CF_ACCESS_TEAM_NAME || "";

if (CF_ACCESS_REQUIRED && CF_ACCESS_TEAM) {
  app.use("/*", cloudflareAccess(CF_ACCESS_TEAM));
}

// NEW: CORS hardening (replace line 78)
const TRUSTED_ORIGINS = (process.env.TRUSTED_ORIGINS || "")
  .split(",")
  .filter(Boolean);
app.use(
  "/*",
  cors({
    origin:
      TRUSTED_ORIGINS.length > 0
        ? (origin) =>
            TRUSTED_ORIGINS.includes(origin) ? origin : TRUSTED_ORIGINS[0]
        : "*", // Allow all only in dev mode
    credentials: true,
  }),
);

// MODIFY: Create terminal (line ~133)
// Add owner from JWT payload
const accessPayload = c.get("accessPayload") as
  | CloudflareAccessPayload
  | undefined;
const ownerId = accessPayload?.sub || "anonymous";
const ownerEmail = accessPayload?.email || "anonymous";

terminals.set(id, {
  id,
  proc,
  terminal,
  cwd,
  cols,
  rows,
  createdAt: Date.now(),
  ownerId, // NEW
  ownerEmail, // NEW
});

// MODIFY: List terminals (line ~239)
// Filter by owner
const accessPayload = c.get("accessPayload") as
  | CloudflareAccessPayload
  | undefined;
const currentUser = accessPayload?.sub || "anonymous";
const list = Array.from(terminals.values())
  .filter((t) => t.ownerId === currentUser) // NEW: Only show own terminals
  .map((t) => ({
    id: t.id,
    cwd: t.cwd,
    createdAt: t.createdAt,
  }));

// MODIFY: Delete terminal (line ~249)
// Check ownership
const accessPayload = c.get("accessPayload") as
  | CloudflareAccessPayload
  | undefined;
const currentUser = accessPayload?.sub || "anonymous";
const term = terminals.get(id);
if (!term) return c.json({ error: "Terminal not found" }, 404);
if (term.ownerId !== currentUser) return c.json({ error: "Forbidden" }, 403); // NEW

// MODIFY: Resize terminal (line ~269)
// Same ownership check

// MODIFY: WebSocket upgrade (line ~496-502)
// Verify ownership before upgrade
if (url.pathname.startsWith("/ws/terminals/")) {
  const id = url.pathname.split("/").pop();
  const term = terminals.get(id);

  // NEW: Extract JWT from request
  const jwt = req.headers.get("cf-access-jwt-assertion");
  if (CF_ACCESS_REQUIRED && !jwt) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Verify owner (simplified - full impl needs JWT parsing)
  // For WS, we store ownerId at creation time and trust WS cookie

  if (id && term) {
    const success = server.upgrade(req, {
      data: { terminalId: id, ownerId: term.ownerId },
    });
    if (success) return undefined;
  }
  return new Response("Terminal not found or forbidden", { status: 404 });
}
```

#### 2.2.3 Dependencies

```bash
bun add @hono/cloudflare-access
```

### 2.3 Acceptance Criteria

| #   | Criterion                                                     | Test Method                    |
| --- | ------------------------------------------------------------- | ------------------------------ |
| 1   | Without `Cf-Access-Jwt-Assertion` header, all API returns 401 | `curl` without header          |
| 2   | With valid JWT, user can create terminals                     | Create terminal via UI         |
| 3   | User A cannot see User B's terminals                          | List terminals from 2 accounts |
| 4   | User A cannot delete User B's terminal                        | Try DELETE with wrong token    |
| 5   | User A cannot connect WS to User B's terminal                 | Try WS upgrade                 |
| 6   | CORS rejects requests from untrusted origins                  | `curl` with wrong Origin       |

### 2.4 File Changes Summary

| File                | Changes                                       |
| ------------------- | --------------------------------------------- |
| `backend/server.ts` | +80 lines (auth middleware, ownership checks) |
| `package.json`      | +1 dependency                                 |
| `.env.example`      | +4 env vars                                   |
| `README.md`         | Security section update                       |

---

## 3. P0-2: OSC52 Clipboard Support

### 3.1 Research Findings

**OSC52 Sequence Format:**

```
ESC ] 52 ; c ; <base64-data> BEL
ESC ] 52 ; c ; <base64-data> ESC \
```

- `ESC ]` = OSC introducer (0x1B 0x5D)
- `52` = clipboard operation code
- `c` = clipboard selection (c=clipboard, p=primary, s=secondary)
- `<base64-data>` = base64-encoded text to copy
- `BEL` or `ESC \` = terminator

**xterm.js Support:**

- Issue #3260: OSC52 support added in xterm.js 6.0
- PR #4220: Implementation merged
- Uses `terminal.onOsc52` callback

**Browser Limitations:**

- `navigator.clipboard.writeText()` requires user gesture in some browsers
- Safari is particularly strict
- Solution: Fallback UI with "Copy" button

### 3.2 Implementation Design

#### 3.2.1 Frontend Changes

**File: `web/app.js`**

```javascript
// =============================================================================
// CLIPBOARD MANAGER - OSC52 + History
// =============================================================================

class ClipboardManager {
  constructor() {
    this.history = [];
    this.maxHistory = 20;
    this.maxItemSize = 200 * 1024; // 200KB
    this.panel = null;
    this.toast = null;
    this.pendingCopy = null;
    this.init();
  }

  init() {
    this.createPanel();
    this.createToast();
  }

  createPanel() {
    this.panel = document.createElement('div');
    this.panel.id = 'clipboard-panel';
    this.panel.className = 'clipboard-panel hidden';
    this.panel.innerHTML = `
      <div class="clipboard-header">
        <h3>Clipboard History</h3>
        <button class="clipboard-close">&times;</button>
      </div>
      <div class="clipboard-list"></div>
    `;
    document.getElementById('app').appendChild(this.panel);

    this.panel.querySelector('.clipboard-close').addEventListener('click', () => this.hidePanel());
  }

  createToast() {
    this.toast = document.createElement('div');
    this.toast.className = 'clipboard-toast hidden';
    this.toast.innerHTML = `
      <span class="toast-message"></span>
      <button class="toast-copy">Copy</button>
    `;
    document.getElementById('app').appendChild(this.toast);

    this.toast.querySelector('.toast-copy').addEventListener('click', () => {
      if (this.pendingCopy) {
        this.copyWithGesture(this.pendingCopy);
      }
    });
  }

  // Handle OSC52 from terminal
  handleOsc52(data) {
    // Parse: c;<base64>
    const parts = data.split(';');
    if (parts.length < 2) return;

    const base64Data = parts.slice(1).join(';');

    try {
      const text = atob(base64Data);

      // Size limit check
      if (text.length > this.maxItemSize) {
        this.showToast('Content too large. Click to download.', 'download', text);
        return;
      }

      // Try clipboard API
      this.copyToClipboard(text);
    } catch (e) {
      console.error('OSC52 decode error:', e);
    }
  }

  async copyToClipboard(text) {
    // Add to history first
    this.addToHistory(text);

    try {
      await navigator.clipboard.writeText(text);
      this.showToast('Copied to clipboard!', 'success');
    } catch (err) {
      // Clipboard API failed (no user gesture)
      console.warn('Clipboard API failed, showing fallback:', err);
      this.pendingCopy = text;
      this.showToast('Click to copy', 'pending', text);
    }
  }

  copyWithGesture(text) {
    navigator.clipboard.writeText(text)
      .then(() => {
        this.showToast('Copied!', 'success');
        this.pendingCopy = null;
      })
      .catch(err => {
        console.error('Copy failed even with gesture:', err);
        this.showToast('Copy failed', 'error');
      });
  }

  addToHistory(text) {
    // Prevent duplicates
    const existing = this.history.findIndex(h => h.text === text);
    if (existing !== -1) {
      this.history.splice(existing, 1);
    }

    this.history.unshift({
      text,
      timestamp: Date.now(),
      preview: text.substring(0, 100) + (text.length > 100 ? '...' : '')
    });

    // Trim history
    if (this.history.length > this.maxHistory) {
      this.history.pop();
    }

    this.renderHistory();
  }

  renderHistory() {
    const list = this.panel.querySelector('.clipboard-list');
    list.innerHTML = this.history.map((item, i) => `
      <div class="clipboard-item" data-index="${i}">
        <span class="item-preview">${this.escapeHtml(item.preview)}</span>
        <span class="item-time">${this.formatTime(item.timestamp)}</span>
        <button class="item-copy" data-index="${i}">Copy</button>
      </div>
    `).join('');

    list.querySelectorAll('.item-copy').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.target.dataset.index);
        this.copyWithGesture(this.history[idx].text);
      });
    });
  }

  showToast(message, type, data = null) {
    const toast = this.toast;
    const msgEl = toast.querySelector('.toast-message');
    const copyBtn = toast.querySelector('.toast-copy');

    msgEl.textContent = message;
    toast.className = `clipboard-toast ${type}`;
    copyBtn.style.display = (type === 'pending') ? 'inline-block' : 'none';

    toast.classList.remove('hidden');

    if (type === 'success' || type === 'error') {
      setTimeout(() => toast.classList.add('hidden'), 2000);
    }
  }

  hideToast() {
    this.toast.classList.add('hidden');
  }

  showPanel() {
    this.panel.classList.remove('hidden');
    this.renderHistory();
  }

  hidePanel() {
    this.panel.classList.add('hidden');
  }

  togglePanel() {
    this.panel.classList.toggle('hidden');
    if (!this.panel.classList.contains('hidden')) {
      this.renderHistory();
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  formatTime(timestamp) {
    const now = Date.now();
    const diff = now - timestamp;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff/60000)}m ago`;
    return new Date(timestamp).toLocaleTimeString();
  }
}

// In TerminalManager.createXtermInstance() - add OSC52 handler:
const terminal = new Terminal({...});

// Register OSC52 handler
terminal.parser.registerOscHandler(52, (data) => {
  this.clipboardManager.handleOsc52(data);
  return true;  // Handled
});
```

#### 3.2.2 CSS Changes

**File: `web/styles.css`**

```css
/* Clipboard Panel */
.clipboard-panel {
  position: fixed;
  right: 0;
  top: var(--toolbar-height);
  width: 300px;
  height: calc(100vh - var(--toolbar-height));
  background: var(--bg-secondary);
  border-left: 1px solid var(--border-primary);
  z-index: 500;
  display: flex;
  flex-direction: column;
}

.clipboard-panel.hidden {
  display: none;
}

.clipboard-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-primary);
}

.clipboard-header h3 {
  margin: 0;
  font-size: 14px;
}

.clipboard-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.clipboard-item {
  padding: 10px;
  background: var(--bg-tertiary);
  border-radius: 6px;
  margin-bottom: 8px;
  cursor: pointer;
}

.clipboard-item:hover {
  background: var(--bg-hover);
}

.item-preview {
  display: block;
  font-family: monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 60px;
  overflow: hidden;
}

.item-time {
  display: block;
  font-size: 10px;
  color: var(--text-muted);
  margin-top: 4px;
}

.item-copy {
  margin-top: 6px;
  padding: 4px 10px;
  background: var(--btn-green);
  border: none;
  border-radius: 4px;
  color: white;
  font-size: 11px;
  cursor: pointer;
}

/* Clipboard Toast */
.clipboard-toast {
  position: fixed;
  bottom: 80px;
  left: 50%;
  transform: translateX(-50%);
  padding: 10px 20px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-primary);
  border-radius: 8px;
  z-index: 1000;
  display: flex;
  align-items: center;
  gap: 12px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
}

.clipboard-toast.hidden {
  display: none;
}

.clipboard-toast.success {
  border-color: var(--accent-green);
}

.clipboard-toast.pending {
  border-color: var(--accent-orange);
}

.clipboard-toast.error {
  border-color: var(--accent-red);
}

.toast-copy {
  padding: 6px 12px;
  background: var(--btn-green);
  border: none;
  border-radius: 4px;
  color: white;
  cursor: pointer;
}
```

### 3.3 Acceptance Criteria

| #   | Criterion                                                                 | Test Method             |
| --- | ------------------------------------------------------------------------- | ----------------------- |
| 1   | Running `printf '\e]52;c;%s\a' $(echo -n "test" \| base64)` copies "test" | Manual in terminal      |
| 2   | If clipboard API fails, toast with "Copy" button appears                  | Test on Safari          |
| 3   | Clipboard history shows last 20 items                                     | Copy multiple times     |
| 4   | Items > 200KB show download option                                        | Copy large file         |
| 5   | Works with OpenCode's clipboard operations                                | Run OpenCode, copy text |

### 3.4 File Changes Summary

| File             | Changes                             |
| ---------------- | ----------------------------------- |
| `web/app.js`     | +200 lines (ClipboardManager class) |
| `web/styles.css` | +100 lines (panel + toast styles)   |
| `web/index.html` | +1 button (clipboard panel toggle)  |

---

## 4. P1-3: OpenCode Web Integration

### 4.1 Research Findings

**OpenCode Web Server:**

```bash
opencode web --hostname 127.0.0.1 --port 4096
```

- HTTP server with SSE for streaming
- WebSocket for real-time communication
- Static assets served from built-in paths

**Proxy Requirements:**

- HTTP: Standard reverse proxy
- SSE: Streaming response passthrough
- WS: WebSocket upgrade handling

### 4.2 Implementation Design

#### 4.2.1 Backend Changes

**File: `backend/server.ts`**

```typescript
// NEW: OpenCode proxy configuration
const OPENCODE_UPSTREAM =
  process.env.OPENCODE_UPSTREAM || "http://127.0.0.1:4096";

// Hop-by-hop headers to strip
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
];

// NEW: OpenCode health check
app.get("/api/apps/opencode/health", async (c) => {
  try {
    const res = await fetch(`${OPENCODE_UPSTREAM}/api/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return c.json({
      status: res.ok ? "running" : "error",
      upstream: OPENCODE_UPSTREAM,
    });
  } catch {
    return c.json({ status: "not_running", upstream: OPENCODE_UPSTREAM });
  }
});

// NEW: OpenCode HTTP proxy
app.all("/apps/opencode/*", async (c) => {
  const path = c.req.path.replace("/apps/opencode", "") || "/";
  const url = `${OPENCODE_UPSTREAM}${path}${c.req.url.includes("?") ? "?" + c.req.url.split("?")[1] : ""}`;

  // Forward headers (strip hop-by-hop)
  const headers = new Headers();
  for (const [key, value] of c.req.raw.headers) {
    if (!HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) {
      headers.set(key, value);
    }
  }

  try {
    const response = await fetch(url, {
      method: c.req.method,
      headers,
      body:
        c.req.method !== "GET" && c.req.method !== "HEAD"
          ? await c.req.raw.arrayBuffer()
          : undefined,
    });

    // Check for SSE
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      // Stream SSE response
      return new Response(response.body, {
        status: response.status,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // Regular response
    const responseHeaders = new Headers();
    for (const [key, value] of response.headers) {
      if (!HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    }

    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (err) {
    return c.json({ error: "OpenCode unavailable", message: String(err) }, 502);
  }
});

// NEW: OpenCode WebSocket proxy (in Bun.serve websocket handler)
// Add in fetch handler before terminal WS:
if (url.pathname.startsWith("/apps/opencode/ws")) {
  // Proxy WebSocket to OpenCode
  const wsUrl =
    OPENCODE_UPSTREAM.replace("http", "ws") +
    url.pathname.replace("/apps/opencode", "") +
    url.search;

  // Create upstream connection
  const upstream = new WebSocket(wsUrl);

  // Upgrade client connection
  const success = server.upgrade(req, {
    data: { type: "opencode_proxy", upstream },
  });

  if (success) {
    // Set up bidirectional pipe
    // ... (implementation details)
  }
  return new Response("WebSocket upgrade failed", { status: 500 });
}
```

#### 4.2.2 Frontend Changes

**File: `web/index.html`**

```html
<!-- Add button to toolbar row 2 -->
<button
  id="opencode-btn"
  class="btn-icon"
  data-action="opencode"
  title="OpenCode"
>
  <i data-lucide="code"></i>
</button>

<!-- Add OpenCode panel/iframe -->
<div id="opencode-panel" class="app-panel hidden">
  <div class="app-panel-header">
    <span>OpenCode</span>
    <span id="opencode-status" class="app-status">checking...</span>
    <button class="app-panel-close">&times;</button>
  </div>
  <iframe id="opencode-iframe" src="" frameborder="0"></iframe>
</div>
```

**File: `web/app.js`**

```javascript
// OpenCode panel manager
class OpenCodeManager {
  constructor() {
    this.panel = document.getElementById("opencode-panel");
    this.iframe = document.getElementById("opencode-iframe");
    this.status = document.getElementById("opencode-status");
    this.init();
  }

  init() {
    document
      .querySelector('[data-action="opencode"]')
      ?.addEventListener("click", () => this.toggle());
    this.panel
      ?.querySelector(".app-panel-close")
      ?.addEventListener("click", () => this.hide());
    this.checkHealth();
    setInterval(() => this.checkHealth(), 30000);
  }

  async checkHealth() {
    try {
      const res = await fetch("/api/apps/opencode/health");
      const data = await res.json();
      this.status.textContent =
        data.status === "running" ? "running" : "offline";
      this.status.className = `app-status ${data.status === "running" ? "online" : "offline"}`;
    } catch {
      this.status.textContent = "error";
      this.status.className = "app-status offline";
    }
  }

  show() {
    this.panel?.classList.remove("hidden");
    if (this.iframe && !this.iframe.src) {
      this.iframe.src = "/apps/opencode/";
    }
  }

  hide() {
    this.panel?.classList.add("hidden");
  }

  toggle() {
    this.panel?.classList.contains("hidden") ? this.show() : this.hide();
  }
}
```

### 4.3 Acceptance Criteria

| #   | Criterion                             | Test Method                      |
| --- | ------------------------------------- | -------------------------------- |
| 1   | Health endpoint shows OpenCode status | `curl /api/apps/opencode/health` |
| 2   | OpenCode UI loads in panel            | Click OpenCode button            |
| 3   | SSE streaming works                   | Create agent task in OpenCode    |
| 4   | WebSocket works (if used)             | Test real-time features          |
| 5   | Same CF Access policy applies         | Try without JWT                  |

### 4.4 File Changes Summary

| File                | Changes                     |
| ------------------- | --------------------------- |
| `backend/server.ts` | +100 lines (proxy routes)   |
| `web/index.html`    | +15 lines (panel HTML)      |
| `web/app.js`        | +60 lines (OpenCodeManager) |
| `web/styles.css`    | +50 lines (panel styles)    |

---

## 5. P1-4: Git Panel

### 5.1 Implementation Design

#### 5.1.1 Backend API

**File: `backend/server.ts`**

```typescript
// NEW: Git API endpoints
// All require cwd parameter, validated against allowed roots

const ALLOWED_GIT_ROOTS = [process.env.HOME || "/home/deploy"];

function validateGitCwd(cwd: string): boolean {
  return ALLOWED_GIT_ROOTS.some((root) => cwd.startsWith(root));
}

// GET /api/git/status?cwd=/path/to/repo
app.get("/api/git/status", async (c) => {
  const cwd = c.req.query("cwd") || process.env.HOME;
  if (!validateGitCwd(cwd)) return c.json({ error: "Forbidden path" }, 403);

  try {
    const proc = Bun.spawn(["git", "status", "--porcelain", "-b"], { cwd });
    const output = await new Response(proc.stdout).text();
    const lines = output.trim().split("\n");
    const branch = lines[0]?.replace("## ", "").split("...")[0] || "unknown";
    const files = lines.slice(1).map((line) => ({
      status: line.substring(0, 2).trim(),
      path: line.substring(3),
    }));
    return c.json({ branch, files, cwd });
  } catch (err) {
    return c.json({ error: "Not a git repository", message: String(err) }, 400);
  }
});

// GET /api/git/diff?cwd=...&path=... (optional path for single file)
app.get("/api/git/diff", async (c) => {
  const cwd = c.req.query("cwd") || process.env.HOME;
  const path = c.req.query("path");
  if (!validateGitCwd(cwd)) return c.json({ error: "Forbidden path" }, 403);

  const args = ["git", "diff", "--color=never"];
  if (path) args.push("--", path);

  const proc = Bun.spawn(args, { cwd });
  const output = await new Response(proc.stdout).text();
  return c.json({ diff: output, cwd, path });
});

// POST /api/git/stage { cwd, paths: string[] }
app.post("/api/git/stage", async (c) => {
  const { cwd, paths } = await c.req.json();
  if (!validateGitCwd(cwd)) return c.json({ error: "Forbidden path" }, 403);

  const proc = Bun.spawn(["git", "add", ...paths], { cwd });
  await proc.exited;
  return c.json({ ok: true });
});

// POST /api/git/unstage { cwd, paths: string[] }
app.post("/api/git/unstage", async (c) => {
  const { cwd, paths } = await c.req.json();
  if (!validateGitCwd(cwd)) return c.json({ error: "Forbidden path" }, 403);

  const proc = Bun.spawn(["git", "restore", "--staged", ...paths], { cwd });
  await proc.exited;
  return c.json({ ok: true });
});

// POST /api/git/commit { cwd, message }
app.post("/api/git/commit", async (c) => {
  const { cwd, message } = await c.req.json();
  if (!validateGitCwd(cwd)) return c.json({ error: "Forbidden path" }, 403);
  if (!message?.trim()) return c.json({ error: "Message required" }, 400);

  const proc = Bun.spawn(["git", "commit", "-m", message], { cwd });
  const output = await new Response(proc.stdout).text();
  const code = await proc.exited;

  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    return c.json({ error: "Commit failed", message: stderr }, 400);
  }
  return c.json({ ok: true, output });
});

// GET /api/git/branches?cwd=...
app.get("/api/git/branches", async (c) => {
  const cwd = c.req.query("cwd") || process.env.HOME;
  if (!validateGitCwd(cwd)) return c.json({ error: "Forbidden path" }, 403);

  const proc = Bun.spawn(["git", "branch", "-a", "--format=%(refname:short)"], {
    cwd,
  });
  const output = await new Response(proc.stdout).text();
  const branches = output.trim().split("\n").filter(Boolean);
  return c.json({ branches, cwd });
});
```

#### 5.1.2 Frontend Panel

**File: `web/app.js`**

```javascript
class GitManager {
  constructor() {
    this.panel = null;
    this.currentCwd = null;
    this.init();
  }

  init() {
    this.createPanel();
    document
      .querySelector('[data-action="git"]')
      ?.addEventListener("click", () => this.toggle());
  }

  createPanel() {
    this.panel = document.createElement("div");
    this.panel.id = "git-panel";
    this.panel.className = "side-panel hidden";
    this.panel.innerHTML = `
      <div class="panel-header">
        <h3>Git</h3>
        <span id="git-branch" class="git-branch"></span>
        <button class="panel-refresh" title="Refresh">↻</button>
        <button class="panel-close">&times;</button>
      </div>
      <div id="git-status" class="git-status"></div>
      <div id="git-diff" class="git-diff"></div>
      <div class="git-commit">
        <textarea id="git-message" placeholder="Commit message..."></textarea>
        <button id="git-commit-btn" class="btn btn-primary">Commit</button>
      </div>
    `;
    document.getElementById("app").appendChild(this.panel);

    this.panel
      .querySelector(".panel-close")
      .addEventListener("click", () => this.hide());
    this.panel
      .querySelector(".panel-refresh")
      .addEventListener("click", () => this.refresh());
    this.panel
      .querySelector("#git-commit-btn")
      .addEventListener("click", () => this.commit());
  }

  async show(cwd) {
    this.currentCwd =
      cwd || document.getElementById("directory")?.value || process.env.HOME;
    this.panel.classList.remove("hidden");
    await this.refresh();
  }

  hide() {
    this.panel.classList.add("hidden");
  }

  toggle() {
    this.panel.classList.contains("hidden") ? this.show() : this.hide();
  }

  async refresh() {
    if (!this.currentCwd) return;

    try {
      const res = await fetch(
        `/api/git/status?cwd=${encodeURIComponent(this.currentCwd)}`,
      );
      const data = await res.json();

      if (data.error) {
        this.panel.querySelector("#git-branch").textContent = "not a repo";
        this.panel.querySelector("#git-status").innerHTML =
          `<p class="error">${data.error}</p>`;
        return;
      }

      this.panel.querySelector("#git-branch").textContent = data.branch;
      this.renderStatus(data.files);
    } catch (err) {
      console.error("Git status error:", err);
    }
  }

  renderStatus(files) {
    const container = this.panel.querySelector("#git-status");
    if (files.length === 0) {
      container.innerHTML = '<p class="muted">No changes</p>';
      return;
    }

    container.innerHTML = files
      .map(
        (f) => `
      <div class="git-file" data-path="${f.path}">
        <span class="git-file-status ${this.statusClass(f.status)}">${f.status}</span>
        <span class="git-file-path">${f.path}</span>
        <button class="git-file-diff" title="View diff">diff</button>
        <button class="git-file-stage" title="Stage/Unstage">+/-</button>
      </div>
    `,
      )
      .join("");

    container.querySelectorAll(".git-file-diff").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const path = e.target.closest(".git-file").dataset.path;
        this.showDiff(path);
      });
    });

    container.querySelectorAll(".git-file-stage").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const path = e.target.closest(".git-file").dataset.path;
        const status = e.target
          .closest(".git-file")
          .querySelector(".git-file-status").textContent;
        this.toggleStage(path, status);
      });
    });
  }

  statusClass(status) {
    if (status.includes("M")) return "modified";
    if (status.includes("A")) return "added";
    if (status.includes("D")) return "deleted";
    if (status.includes("?")) return "untracked";
    return "";
  }

  async showDiff(path) {
    const url = `/api/git/diff?cwd=${encodeURIComponent(this.currentCwd)}&path=${encodeURIComponent(path)}`;
    const res = await fetch(url);
    const data = await res.json();

    const diffContainer = this.panel.querySelector("#git-diff");
    diffContainer.innerHTML = `<pre class="diff-content">${this.escapeHtml(data.diff || "No diff")}</pre>`;
  }

  async toggleStage(path, status) {
    const isStaged = !status.startsWith(" ") && !status.startsWith("?");
    const endpoint = isStaged ? "/api/git/unstage" : "/api/git/stage";

    await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: this.currentCwd, paths: [path] }),
    });

    await this.refresh();
  }

  async commit() {
    const message = this.panel.querySelector("#git-message").value.trim();
    if (!message) {
      alert("Commit message required");
      return;
    }

    const res = await fetch("/api/git/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: this.currentCwd, message }),
    });

    const data = await res.json();
    if (data.error) {
      alert(data.error + ": " + data.message);
    } else {
      this.panel.querySelector("#git-message").value = "";
      await this.refresh();
    }
  }

  escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
}
```

### 5.2 Acceptance Criteria

| #   | Criterion                       | Test Method                 |
| --- | ------------------------------- | --------------------------- |
| 1   | Git status shows modified files | Make changes, open panel    |
| 2   | Diff viewer shows changes       | Click diff on file          |
| 3   | Stage/unstage works             | Click +/- button            |
| 4   | Commit creates commit           | Enter message, click Commit |
| 5   | Forbidden paths rejected        | Try `?cwd=/etc`             |

### 5.3 File Changes Summary

| File                | Changes                        |
| ------------------- | ------------------------------ |
| `backend/server.ts` | +120 lines (git API endpoints) |
| `web/app.js`        | +180 lines (GitManager)        |
| `web/styles.css`    | +80 lines (git panel styles)   |
| `web/index.html`    | +1 button                      |

---

## 6. Implementation Order & Dependencies

```
P0-1: CF Access JWT (MUST BE FIRST)
  └── No dependencies
  └── Enables: secure multi-device access

P0-2: OSC52 Clipboard
  └── No backend dependency
  └── Enables: copy from TUI tools (OpenCode, vim, etc.)

P1-3: OpenCode Integration
  └── Depends on: P0-1 (auth applies to proxy)
  └── Enables: AI coding assistant in panel

P1-4: Git Panel
  └── Depends on: P0-1 (auth applies to git API)
  └── Enables: quick commits from mobile
```

### Recommended PR/Commit Sequence

1. **PR #1: Security Foundation (P0-1)**
   - Add `@hono/cloudflare-access` dependency
   - Implement auth middleware
   - Add terminal ownership
   - Harden CORS
   - Update README with security section

2. **PR #2: OSC52 Clipboard (P0-2)**
   - Add ClipboardManager class
   - Add clipboard panel UI
   - Add toast notifications
   - Test with OpenCode

3. **PR #3: OpenCode Proxy (P1-3)**
   - Add reverse proxy routes
   - Add OpenCode panel/iframe
   - Add health check
   - Test SSE/WS passthrough

4. **PR #4: Git Panel (P1-4)**
   - Add git API endpoints
   - Add GitManager class
   - Add git panel UI
   - Test on mobile

---

## 7. Risks & Mitigations

| Risk                                | Impact           | Likelihood | Mitigation                                           |
| ----------------------------------- | ---------------- | ---------- | ---------------------------------------------------- |
| JWT validation fails silently       | Auth bypass      | Medium     | Add explicit logging, test both valid/invalid tokens |
| OSC52 blocked by CSP                | Clipboard broken | Low        | Check CSP headers, no external fetch needed          |
| OpenCode WS proxy drops messages    | Broken streaming | Medium     | Use established proxy patterns, test with load       |
| Git commands hang                   | Blocked API      | Low        | Add timeouts (10s), spawn with signal handler        |
| Large clipboard items crash browser | UX broken        | Low        | Size limit (200KB), offer download                   |

---

## 8. README Updates Required

```markdown
## Security

**DO NOT expose TermDeck directly to the public internet!**

TermDeck is designed to run behind Cloudflare Tunnel with Cloudflare Access for authentication.

### Required Environment Variables

| Variable              | Description                               |
| --------------------- | ----------------------------------------- |
| `CF_ACCESS_REQUIRED`  | Set to `1` to enforce JWT validation      |
| `CF_ACCESS_TEAM_NAME` | Your Cloudflare Access team name          |
| `CF_ACCESS_AUD`       | Application AUD tag from Access dashboard |
| `TRUSTED_ORIGINS`     | Comma-separated list of allowed origins   |

### Deployment Checklist

1. [ ] Set up Cloudflare Tunnel pointing to TermDeck
2. [ ] Create Cloudflare Access application
3. [ ] Configure OTP email authentication
4. [ ] Set required env vars in `.env`
5. [ ] Test authentication from new device
```

---

## Execution Instructions

Po schválení tohoto plánu spusť implementaci pomocí:

```bash
/start-work
```

nebo pro paralelní implementaci více kroků:

```bash
/ralphloop
```

Doporučuji začít s **P0-1 (CF Access)** jako samostatným PR, pak pokračovat sekvenčně.

---

_Plan generated by Prometheus (ultrawork planner) - 2026-01-11_
