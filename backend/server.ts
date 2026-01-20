import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import type { ServerWebSocket, Subprocess } from "bun";
import {
  cloudflareAccess,
  type CloudflareAccessPayload,
} from "@hono/cloudflare-access";
import { mkdir, readdir, unlink, stat } from "node:fs/promises";
import { join } from "node:path";

// =============================================================================
// GLOBAL ERROR HANDLERS - Prevent 502 from uncaught exceptions
// =============================================================================

process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
  // Don't exit - try to keep serving
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[FATAL] Unhandled rejection at:", promise, "reason:", reason);
  // Don't exit - try to keep serving
});

// Bun.Terminal API types (Bun 1.3.5+) - not yet in bun-types
interface BunTerminalOptions {
  cols: number;
  rows: number;
  data: (terminal: BunTerminalInstance, data: string | Uint8Array) => void;
}

interface BunTerminalInstance {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

// Type-safe wrapper for Bun.Terminal (API not yet in bun-types)
const BunTerminal = (
  Bun as unknown as {
    Terminal: new (opts: BunTerminalOptions) => BunTerminalInstance;
  }
).Terminal;

type Terminal = {
  id: string;
  proc: Subprocess;
  terminal: BunTerminalInstance;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  lastActivityAt: number; // Last user input timestamp for idle detection
  ownerId: string; // User sub from JWT
  ownerEmail: string; // User email for display
  sessionName?: string; // tmux session name (when TMUX_BACKEND=1)
};

type TerminalWsData = { type: "terminal"; terminalId: string; ownerId: string };
type OpenCodeWsData = { type: "opencode_proxy"; upstream: WebSocket };
type WsData = TerminalWsData | OpenCodeWsData;

// Configuration
const DEBUG = process.env.OPENCODE_WEB_DEBUG === "1";
const MAX_TERMINALS = parseInt(
  process.env.OPENCODE_WEB_MAX_TERMINALS || "10",
  10,
);
const MAX_TERMINALS_PER_USER = parseInt(
  process.env.MAX_TERMINALS_PER_USER || "10",
  10,
);
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 20; // max terminals per minute
const TERMINAL_IDLE_TIMEOUT_MS = parseInt(
  process.env.TERMINAL_IDLE_TIMEOUT_MS || String(2 * 60 * 60 * 1000),
  10,
); // 2 hours default

const CF_ACCESS_REQUIRED = process.env.CF_ACCESS_REQUIRED === "1";
const CF_ACCESS_TEAM_NAME = process.env.CF_ACCESS_TEAM_NAME || "";
const CF_ACCESS_AUD = process.env.CF_ACCESS_AUD || "";

// tmux backend for session persistence (survives server restart)
const TMUX_BACKEND = process.env.TMUX_BACKEND === "1";
const TRUSTED_ORIGINS = (process.env.TRUSTED_ORIGINS || "")
  .split(",")
  .filter(Boolean);

// OpenCode configuration
const OPENCODE_UPSTREAM =
  process.env.OPENCODE_UPSTREAM || "http://127.0.0.1:4096";
const OPENCODE_URL = process.env.OPENCODE_URL || "";

// Clipboard image configuration
const CLIPBOARD_IMAGES_DIR = "/tmp/deckterm-clipboard";
const CLIPBOARD_IMAGE_MAX_SIZE = 10 * 1024 * 1024; // 10MB
const CLIPBOARD_IMAGE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Hop-by-hop headers to strip from proxied requests/responses
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

// Terminal sessions (PTY processes)
const terminals = new Map<string, Terminal>();
const terminalSockets = new Map<string, Set<WebSocket>>();

const openCodeCircuit = {
  failures: 0,
  lastFailure: 0,
  isOpen: false,
  threshold: 5,
  resetTimeout: 30_000,
  recordFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.threshold) {
      this.isOpen = true;
      debug("OpenCode circuit OPEN - too many failures");
    }
  },
  recordSuccess() {
    this.failures = 0;
    this.isOpen = false;
  },
  canRequest(): boolean {
    if (!this.isOpen) return true;
    if (Date.now() - this.lastFailure > this.resetTimeout) {
      this.isOpen = false;
      this.failures = 0;
      debug("OpenCode circuit HALF-OPEN - testing");
      return true;
    }
    return false;
  },
};

// Rate limiting state (simple in-memory)
const rateLimitState = {
  timestamps: [] as number[],
  clean() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(
      (t) => now - t < RATE_LIMIT_WINDOW_MS,
    );
  },
  canCreate(): boolean {
    this.clean();
    return this.timestamps.length < RATE_LIMIT_MAX_REQUESTS;
  },
  record() {
    this.timestamps.push(Date.now());
  },
};

// =============================================================================
// CLIPBOARD IMAGE HELPERS
// =============================================================================

// Ensure clipboard directory exists
async function ensureClipboardDir() {
  try {
    await mkdir(CLIPBOARD_IMAGES_DIR, { recursive: true });
  } catch {
    // Directory exists
  }
}

// Cleanup old clipboard images (called periodically)
async function cleanupClipboardImages() {
  try {
    const files = await readdir(CLIPBOARD_IMAGES_DIR);
    const now = Date.now();

    for (const file of files) {
      const filePath = join(CLIPBOARD_IMAGES_DIR, file);
      try {
        const fileStat = await stat(filePath);
        if (now - fileStat.mtimeMs > CLIPBOARD_IMAGE_TTL_MS) {
          await unlink(filePath);
          console.log(`[Clipboard] Cleaned up old image: ${file}`);
        }
      } catch {
        // File may have been deleted
      }
    }
  } catch {
    // Directory may not exist yet
  }
}

// Run cleanup every 15 minutes
setInterval(cleanupClipboardImages, 15 * 60 * 1000);
// Ensure directory exists on startup
ensureClipboardDir();

// Recover existing tmux sessions on startup (for TMUX_BACKEND)
async function recoverTmuxSessions(): Promise<number> {
  if (!TMUX_BACKEND) return 0;

  try {
    const result = Bun.spawn([
      "tmux",
      "list-sessions",
      "-F",
      "#{session_name}",
    ]);
    const output = await new Response(result.stdout).text();
    await result.exited;

    const sessions = output
      .trim()
      .split("\n")
      .filter((s) => s.startsWith("deckterm_"));
    let recovered = 0;

    for (const sessionName of sessions) {
      // Parse: deckterm_{ownerId}_{fullUUID}
      // Session name format: deckterm_OWNERID_UUID (UUID contains dashes, not underscores)
      const parts = sessionName.split("_");
      if (parts.length < 3) continue;

      const ownerId = parts[1];
      // Extract the full UUID (parts[2] and any remaining parts joined back)
      // This handles UUIDs correctly since they use dashes, not underscores
      const id = parts.slice(2).join("_");

      // Get tmux session info
      const infoResult = Bun.spawn([
        "tmux",
        "display-message",
        "-t",
        sessionName,
        "-p",
        "#{pane_current_path}:#{window_width}:#{window_height}",
      ]);
      const infoOutput = await new Response(infoResult.stdout).text();
      await infoResult.exited;

      const [cwd = "/home/deploy", colsStr = "120", rowsStr = "30"] = infoOutput
        .trim()
        .split(":");
      const cols = parseInt(colsStr, 10) || 120;
      const rows = parseInt(rowsStr, 10) || 30;

      // Create BunTerminal for I/O
      const terminal = new BunTerminal({
        cols,
        rows,
        data(term, data) {
          const sockets = terminalSockets.get(id);
          if (sockets && sockets.size > 0) {
            const strData =
              typeof data === "string" ? data : new TextDecoder().decode(data);
            for (const ws of sockets) {
              try {
                ws.send(strData);
              } catch {
                /* ignore */
              }
            }
          }
        },
      });

      // Attach to existing session
      const proc = Bun.spawn(["tmux", "attach-session", "-t", sessionName], {
        cwd,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
        },
        // @ts-expect-error - terminal option is Bun 1.3.5+ API
        terminal,
        onExit() {
          terminals.delete(id);
          terminalSockets.delete(id);
          terminal.close();
        },
      });

      // Hide status bar for recovered session
      const hideStatusProc = Bun.spawn([
        "tmux",
        "set-option",
        "-t",
        sessionName,
        "status",
        "off",
      ]);
      await hideStatusProc.exited;

      const now = Date.now();
      terminals.set(id, {
        id,
        proc,
        terminal,
        cwd,
        cols,
        rows,
        createdAt: now,
        lastActivityAt: now,
        ownerId,
        ownerEmail: "recovered",
        sessionName,
      });
      terminalSockets.set(id, new Set());

      recovered++;
      console.log(`[tmux] Recovered session: ${sessionName} -> terminal ${id}`);
    }

    return recovered;
  } catch (err) {
    // tmux not running or no sessions - that's fine
    console.log("[tmux] No existing sessions to recover");
    return 0;
  }
}

// Debug logger
function debug(...args: unknown[]) {
  if (DEBUG) console.log("[web-terminal]", ...args);
}

function getCurrentUser(c: {
  get: (key: string) => CloudflareAccessPayload | undefined;
}): { ownerId: string; ownerEmail: string } {
  const accessPayload = c.get("accessPayload");
  if (CF_ACCESS_REQUIRED && !accessPayload) {
    throw new Error("Unauthorized");
  }
  return {
    ownerId: accessPayload?.sub || "anonymous",
    ownerEmail: accessPayload?.email || "anonymous",
  };
}

export function createWebApp() {
  const app = new Hono();

  app.onError((err, c) => {
    console.error("[Hono] Route error:", err);
    return c.json(
      { error: "Internal server error", message: String(err) },
      500,
    );
  });

  app.use(
    "/*",
    cors({
      origin:
        TRUSTED_ORIGINS.length > 0
          ? (origin) => (TRUSTED_ORIGINS.includes(origin) ? origin : null)
          : "*",
      credentials: true,
    }),
  );

  // Cloudflare Access JWT authentication
  if (CF_ACCESS_REQUIRED && CF_ACCESS_TEAM_NAME) {
    app.use("/*", cloudflareAccess(CF_ACCESS_TEAM_NAME));
  }

  // No-cache headers - bypass CF cache
  app.use("/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    c.header("Pragma", "no-cache");
    c.header("Expires", "0");
    c.header("CDN-Cache-Control", "no-store");
    c.header("Cloudflare-CDN-Cache-Control", "no-store");
  });

  // Health endpoint
  app.get("/api/health", (c) => {
    return c.json({
      status: "ok",
      terminals: terminals.size,
      maxTerminals: MAX_TERMINALS,
      uptime: process.uptime(),
    });
  });

  // Server stats endpoint (CPU, RAM, Disk)
  app.get("/api/stats", async (c) => {
    const os = await import("os");
    const fs = await import("fs/promises");

    const cpus = os.cpus();
    const cpuUsage =
      cpus.reduce((acc, cpu) => {
        const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
        const idle = cpu.times.idle;
        return acc + ((total - idle) / total) * 100;
      }, 0) / cpus.length;

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    let availableMem = freeMem;
    try {
      const meminfo = await fs.readFile("/proc/meminfo", "utf8");
      const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m);
      if (match) {
        availableMem = parseInt(match[1], 10) * 1024;
      }
    } catch {
      // /proc/meminfo not available, fall back to freeMem
    }

    const memUsage = ((totalMem - availableMem) / totalMem) * 100;

    let diskUsage = 0;
    try {
      const stat = await fs.statfs("/");
      diskUsage = ((stat.blocks - stat.bfree) / stat.blocks) * 100;
    } catch {
      // statfs not available
    }

    return c.json({
      cpu: { usage: Math.round(cpuUsage) },
      memory: {
        percent: Math.round(memUsage),
        availableBytes: Math.round(availableMem),
        freeBytes: Math.round(freeMem),
        totalBytes: Math.round(totalMem),
      },
      disk: { percent: Math.round(diskUsage) },
    });
  });

  // OpenCode health check
  app.get("/api/apps/opencode/health", async (c) => {
    try {
      const res = await fetch(`${OPENCODE_UPSTREAM}/api/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return c.json({
        status: res.ok ? "running" : "error",
        upstream: OPENCODE_UPSTREAM,
        url: OPENCODE_URL,
      });
    } catch {
      return c.json({
        status: "not_running",
        upstream: OPENCODE_UPSTREAM,
        url: OPENCODE_URL,
      });
    }
  });

  app.all("/apps/opencode/*", async (c) => {
    if (!openCodeCircuit.canRequest()) {
      return c.json(
        {
          error: "OpenCode temporarily unavailable",
          message: "Circuit breaker open - too many failures",
          retryAfter: Math.ceil(openCodeCircuit.resetTimeout / 1000),
        },
        503,
      );
    }

    const path = c.req.path.replace("/apps/opencode", "") || "/";
    const url = `${OPENCODE_UPSTREAM}${path}${c.req.url.includes("?") ? "?" + c.req.url.split("?")[1] : ""}`;

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
        signal: AbortSignal.timeout(30_000),
      });

      openCodeCircuit.recordSuccess();

      const contentType = response.headers.get("content-type") || "";

      if (contentType.includes("text/event-stream")) {
        return new Response(response.body, {
          status: response.status,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

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
      openCodeCircuit.recordFailure();
      const isTimeout = err instanceof Error && err.name === "TimeoutError";
      return c.json(
        {
          error: "OpenCode unavailable",
          message: isTimeout ? "Request timeout" : String(err),
        },
        502,
      );
    }
  });

  // Create new terminal running shell
  app.post("/api/terminals", async (c) => {
    const { ownerId, ownerEmail } = getCurrentUser(c);

    // Rate limiting check
    if (!rateLimitState.canCreate()) {
      return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
    }

    // Per-user terminal limit check
    const userTerminals = Array.from(terminals.values()).filter(
      (t) => t.ownerId === ownerId,
    );
    if (userTerminals.length >= MAX_TERMINALS_PER_USER) {
      return c.json(
        {
          error: `Maximum terminals per user (${MAX_TERMINALS_PER_USER}) reached.`,
        },
        429,
      );
    }

    // Max terminals check
    if (terminals.size >= MAX_TERMINALS) {
      return c.json(
        { error: `Maximum terminals (${MAX_TERMINALS}) reached.` },
        429,
      );
    }

    rateLimitState.record();
    const body = await c.req.json().catch(() => ({}));
    const fs = await import("fs/promises");

    let cwd = body.cwd || process.env.HOME || "/";
    try {
      const stat = await fs.stat(cwd);
      if (!stat.isDirectory()) {
        cwd = process.env.HOME || "/";
      }
    } catch {
      cwd = process.env.HOME || "/";
    }

    const id = crypto.randomUUID();
    const cols = body.cols || 120;
    const rows = body.rows || 30;

    const home = process.env.HOME || "/home/deploy";
    const shell = process.env.SHELL || "/bin/bash";

    // Use Bun's native Terminal API for proper PTY support
    // This enables SIGWINCH (resize) and full terminal emulation
    const terminal = new BunTerminal({
      cols,
      rows,
      data(term, data) {
        // Broadcast terminal output to all connected WebSockets
        const sockets = terminalSockets.get(id);
        if (sockets && sockets.size > 0) {
          const strData =
            typeof data === "string" ? data : new TextDecoder().decode(data);
          debug(`PTY ${id} data (${strData.length} bytes)`);
          for (const ws of sockets) {
            try {
              ws.send(strData);
            } catch {
              // WebSocket closed
            }
          }
        }
      },
    });

    // tmux session name for persistence (sanitize ownerId for tmux)
    // Use full UUID in session name for reliable recovery
    const safeOwnerId = ownerId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 20);
    const sessionName = TMUX_BACKEND
      ? `deckterm_${safeOwnerId}_${id}`
      : undefined;

    let proc: Subprocess;

    if (TMUX_BACKEND && sessionName) {
      // tmux backend: create detached session, then attach for I/O
      debug(`Creating tmux session: ${sessionName}`);

      // Create detached tmux session with shell
      const createProc = Bun.spawn(
        [
          "tmux",
          "new-session",
          "-d", // detached
          "-s",
          sessionName, // session name
          "-x",
          String(cols),
          "-y",
          String(rows),
          "-c",
          cwd, // start directory
          shell,
          "-il", // command
        ],
        {
          env: {
            ...process.env,
            TERM: "xterm-256color",
            COLORTERM: "truecolor",
          },
        },
      );
      await createProc.exited;

      // Hide tmux status bar for cleaner terminal display
      const hideStatusProc = Bun.spawn([
        "tmux",
        "set-option",
        "-t",
        sessionName,
        "status",
        "off",
      ]);
      await hideStatusProc.exited;
      debug(`Tmux status bar hidden for session: ${sessionName}`);

      // Attach to the session via PTY for I/O streaming
      proc = Bun.spawn(["tmux", "attach-session", "-t", sessionName], {
        cwd,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          COLUMNS: String(cols),
          LINES: String(rows),
        },
        // @ts-expect-error - terminal option is Bun 1.3.5+ API, not yet in bun-types
        terminal,
        onExit(proc, exitCode, signalCode) {
          debug(
            `Terminal ${id} (tmux: ${sessionName}) exited: code=${exitCode}, signal=${signalCode}`,
          );
          const sockets = terminalSockets.get(id);
          if (sockets) {
            for (const ws of sockets) {
              try {
                ws.send(JSON.stringify({ type: "exit", code: exitCode }));
                ws.close();
              } catch {
                // ignore
              }
            }
          }
          terminals.delete(id);
          terminalSockets.delete(id);
          terminal.close();
          // Note: tmux session stays alive for reconnection
        },
      });
    } else {
      // Raw PTY backend (original behavior)
      proc = Bun.spawn([shell, "-il"], {
        cwd,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          COLUMNS: String(cols),
          LINES: String(rows),
          PATH: `${home}/.opencode/bin:${process.env.PATH || "/usr/bin"}`,
        },
        // @ts-expect-error - terminal option is Bun 1.3.5+ API, not yet in bun-types
        terminal,
        onExit(proc, exitCode, signalCode) {
          debug(
            `Terminal ${id} exited: code=${exitCode}, signal=${signalCode}`,
          );
          const sockets = terminalSockets.get(id);
          if (sockets) {
            for (const ws of sockets) {
              try {
                ws.send(JSON.stringify({ type: "exit", code: exitCode }));
                ws.close();
              } catch {
                // ignore
              }
            }
          }
          terminals.delete(id);
          terminalSockets.delete(id);
          terminal.close();
        },
      });
    }

    const now = Date.now();
    terminals.set(id, {
      id,
      proc,
      terminal,
      cwd,
      cols,
      rows,
      createdAt: now,
      lastActivityAt: now,
      ownerId,
      ownerEmail,
      sessionName,
    });
    terminalSockets.set(id, new Set());

    debug(`Terminal ${id} created with PID ${proc.pid}`);

    return c.json({ id, cols, rows, cwd });
  });

  // List terminals
  app.get("/api/terminals", (c) => {
    const { ownerId } = getCurrentUser(c);
    const list = Array.from(terminals.values())
      .filter((t) => t.ownerId === ownerId)
      .map((t) => ({
        id: t.id,
        cwd: t.cwd,
        createdAt: t.createdAt,
      }));
    return c.json(list);
  });

  // Delete terminal
  app.delete("/api/terminals/:id", async (c) => {
    const { ownerId } = getCurrentUser(c);
    const id = c.req.param("id");
    const term = terminals.get(id);
    if (!term) {
      return c.json({ error: "Terminal not found" }, 404);
    }
    if (term.ownerId !== ownerId) {
      return c.json({ error: "Forbidden" }, 403);
    }

    // Kill tmux session if using tmux backend
    if (TMUX_BACKEND && term.sessionName) {
      debug(`Killing tmux session: ${term.sessionName}`);
      const killProc = Bun.spawn([
        "tmux",
        "kill-session",
        "-t",
        term.sessionName,
      ]);
      await killProc.exited;
    }

    term.proc.kill();
    term.terminal.close();
    terminals.delete(id);
    const sockets = terminalSockets.get(id);
    if (sockets) {
      for (const ws of sockets) {
        ws.close();
      }
    }
    terminalSockets.delete(id);
    return c.json({ ok: true });
  });

  // Resize terminal - now with proper PTY resize support via Bun.Terminal
  app.post("/api/terminals/:id/resize", async (c) => {
    const { ownerId } = getCurrentUser(c);
    const id = c.req.param("id");
    const term = terminals.get(id);
    if (!term) {
      return c.json({ error: "Terminal not found" }, 404);
    }
    if (term.ownerId !== ownerId) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const body = await c.req.json();
    const cols = body.cols || 120;
    const rows = body.rows || 30;
    term.cols = cols;
    term.rows = rows;

    // Actually resize the PTY - this sends SIGWINCH to the process
    try {
      term.terminal.resize(cols, rows);

      // Also resize tmux pane if using tmux backend
      if (TMUX_BACKEND && term.sessionName) {
        const resizeProc = Bun.spawn([
          "tmux",
          "resize-pane",
          "-t",
          term.sessionName,
          "-x",
          String(cols),
          "-y",
          String(rows),
        ]);
        await resizeProc.exited;
        debug(`Terminal ${id} tmux pane resized to ${cols}x${rows}`);
      }

      debug(`Terminal ${id} resized to ${cols}x${rows}`);
    } catch (err) {
      debug(`Terminal ${id} resize error:`, err);
    }

    return c.json({ ok: true, cols, rows });
  });

  // Browse directories (for directory picker)
  app.get("/api/browse", async (c) => {
    const path = c.req.query("path") || process.env.HOME || "/";
    const includeFiles = c.req.query("files") === "true";
    const fs = await import("fs/promises");
    const pathModule = await import("path");

    try {
      const entries = await fs.readdir(path, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort();

      const result: {
        path: string;
        dirs: string[];
        files?: { name: string; size: number }[];
      } = { path, dirs };

      if (includeFiles) {
        const fileEntries = entries.filter(
          (e) => e.isFile() && !e.name.startsWith("."),
        );
        const files = await Promise.all(
          fileEntries.map(async (e) => {
            try {
              const stat = await fs.stat(pathModule.join(path, e.name));
              return { name: e.name, size: stat.size };
            } catch {
              return { name: e.name, size: 0 };
            }
          }),
        );
        result.files = files.sort((a, b) => a.name.localeCompare(b.name));
      }

      return c.json(result);
    } catch {
      return c.json({ error: "Cannot read directory" }, 400);
    }
  });

  // File download
  app.get("/api/files/download", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) {
      return c.json({ error: "Path required" }, 400);
    }

    const fs = await import("fs/promises");
    const pathModule = await import("path");

    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        return c.json({ error: "Not a file" }, 400);
      }

      const data = await fs.readFile(filePath);
      const filename = pathModule.basename(filePath);

      return new Response(data, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Length": String(stat.size),
        },
      });
    } catch {
      return c.json({ error: "Cannot read file" }, 400);
    }
  });

  // File upload
  app.post("/api/files/upload", async (c) => {
    const targetPath = c.req.query("path");
    if (!targetPath) {
      return c.json({ error: "Path required" }, 400);
    }

    const fs = await import("fs/promises");
    const pathModule = await import("path");

    try {
      // Check if target is a directory
      const stat = await fs.stat(targetPath);
      if (!stat.isDirectory()) {
        return c.json({ error: "Target must be a directory" }, 400);
      }

      // Parse multipart form data
      const formData = await c.req.formData();
      const file = formData.get("file") as File | null;

      if (!file) {
        return c.json({ error: "No file provided" }, 400);
      }

      const destPath = pathModule.join(targetPath, file.name);
      const buffer = await file.arrayBuffer();
      await fs.writeFile(destPath, Buffer.from(buffer));

      debug(`File uploaded: ${destPath}`);

      return c.json({ ok: true, path: destPath });
    } catch (err) {
      debug(`Upload error:`, err);
      return c.json({ error: "Failed to upload file" }, 500);
    }
  });

  // Create directory
  app.post("/api/files/mkdir", async (c) => {
    const dirPath = c.req.query("path");
    if (!dirPath) {
      return c.json({ error: "Path required" }, 400);
    }

    const fs = await import("fs/promises");

    try {
      await fs.mkdir(dirPath, { recursive: false });
      return c.json({ ok: true, path: dirPath });
    } catch (err: unknown) {
      const error = err as { code?: string };
      if (error.code === "EEXIST") {
        return c.json({ error: "Directory already exists" }, 400);
      }
      return c.json({ error: "Failed to create directory" }, 500);
    }
  });

  // Delete file or directory
  app.delete("/api/files", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) {
      return c.json({ error: "Path required" }, 400);
    }

    // Security: don't allow deleting root or home directory
    const home = process.env.HOME || "/home/deploy";
    if (filePath === "/" || filePath === home) {
      return c.json({ error: "Cannot delete root or home directory" }, 403);
    }

    const fs = await import("fs/promises");

    try {
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) {
        await fs.rm(filePath, { recursive: true });
      } else {
        await fs.unlink(filePath);
      }
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "Failed to delete" }, 500);
    }
  });

  // Rename file or directory
  app.post("/api/files/rename", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { from, to } = body;

    if (!from || !to) {
      return c.json({ error: "from and to paths required" }, 400);
    }

    const fs = await import("fs/promises");

    try {
      await fs.rename(from, to);
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "Failed to rename" }, 500);
    }
  });

  // =============================================================================
  // GIT API - Secure git operations with realpath validation
  // =============================================================================

  const ALLOWED_GIT_ROOTS = [process.env.HOME || "/home/deploy"];

  async function validateGitCwd(cwd: string): Promise<boolean> {
    try {
      const fs = await import("fs/promises");
      const realCwd = await fs.realpath(cwd);
      return ALLOWED_GIT_ROOTS.some((root) => realCwd.startsWith(root));
    } catch {
      return false;
    }
  }

  // GET /api/git/status?cwd=/path/to/repo
  app.get("/api/git/status", async (c) => {
    const cwd = c.req.query("cwd") || process.env.HOME;
    if (!cwd || !(await validateGitCwd(cwd))) {
      return c.json({ error: "Forbidden path" }, 403);
    }

    try {
      const proc = Bun.spawn(["git", "status", "--porcelain", "-b"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      const timeoutId = setTimeout(() => proc.kill(), 10000);
      const output = await new Response(proc.stdout).text();
      clearTimeout(timeoutId);

      const lines = output.trim().split("\n");
      const branch = lines[0]?.replace("## ", "").split("...")[0] || "unknown";
      const files = lines.slice(1).map((line) => ({
        status: line.substring(0, 2).trim(),
        path: line.substring(3),
      }));

      return c.json({ branch, files, cwd });
    } catch (err) {
      return c.json(
        { error: "Not a git repository", message: String(err) },
        400,
      );
    }
  });

  // GET /api/git/diff?cwd=...&path=... (optional path for single file)
  app.get("/api/git/diff", async (c) => {
    const cwd = c.req.query("cwd") || process.env.HOME;
    const path = c.req.query("path");
    if (!cwd || !(await validateGitCwd(cwd))) {
      return c.json({ error: "Forbidden path" }, 403);
    }

    try {
      const args = ["git", "diff", "--color=never"];
      if (path) {
        args.push("--", path);
      }

      const proc = Bun.spawn(args, {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      const timeoutId = setTimeout(() => proc.kill(), 10000);
      const output = await new Response(proc.stdout).text();
      clearTimeout(timeoutId);

      return c.json({ diff: output, cwd, path });
    } catch (err) {
      return c.json({ error: "Git diff failed", message: String(err) }, 400);
    }
  });

  // POST /api/git/stage { cwd, paths: string[] }
  app.post("/api/git/stage", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { cwd, paths } = body;

    if (!cwd || !(await validateGitCwd(cwd))) {
      return c.json({ error: "Forbidden path" }, 403);
    }

    if (!paths || !Array.isArray(paths) || paths.length === 0) {
      return c.json({ error: "Paths required" }, 400);
    }

    try {
      const proc = Bun.spawn(["git", "add", "--", ...paths], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      const timeoutId = setTimeout(() => proc.kill(), 10000);
      await proc.exited;
      clearTimeout(timeoutId);

      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: "Git add failed", message: String(err) }, 400);
    }
  });

  // POST /api/git/unstage { cwd, paths: string[] }
  app.post("/api/git/unstage", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { cwd, paths } = body;

    if (!cwd || !(await validateGitCwd(cwd))) {
      return c.json({ error: "Forbidden path" }, 403);
    }

    if (!paths || !Array.isArray(paths) || paths.length === 0) {
      return c.json({ error: "Paths required" }, 400);
    }

    try {
      const proc = Bun.spawn(["git", "restore", "--staged", "--", ...paths], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      const timeoutId = setTimeout(() => proc.kill(), 10000);
      await proc.exited;
      clearTimeout(timeoutId);

      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: "Git restore failed", message: String(err) }, 400);
    }
  });

  // POST /api/git/commit { cwd, message }
  app.post("/api/git/commit", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { cwd, message } = body;

    if (!cwd || !(await validateGitCwd(cwd))) {
      return c.json({ error: "Forbidden path" }, 403);
    }

    if (!message?.trim()) {
      return c.json({ error: "Message required" }, 400);
    }

    try {
      const proc = Bun.spawn(["git", "commit", "-m", message], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      const timeoutId = setTimeout(() => proc.kill(), 10000);
      const output = await new Response(proc.stdout).text();
      const code = await proc.exited;
      clearTimeout(timeoutId);

      if (code !== 0) {
        const stderr = await new Response(proc.stderr).text();
        return c.json({ error: "Commit failed", message: stderr }, 400);
      }

      return c.json({ ok: true, output });
    } catch (err) {
      return c.json({ error: "Git commit failed", message: String(err) }, 400);
    }
  });

  // GET /api/git/branches?cwd=...
  app.get("/api/git/branches", async (c) => {
    const cwd = c.req.query("cwd") || process.env.HOME;
    if (!cwd || !(await validateGitCwd(cwd))) {
      return c.json({ error: "Forbidden path" }, 403);
    }

    try {
      const proc = Bun.spawn(
        ["git", "branch", "-a", "--format=%(refname:short)"],
        {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      const timeoutId = setTimeout(() => proc.kill(), 10000);
      const output = await new Response(proc.stdout).text();
      clearTimeout(timeoutId);

      const branches = output.trim().split("\n").filter(Boolean);
      return c.json({ branches, cwd });
    } catch (err) {
      return c.json({ error: "Git branch failed", message: String(err) }, 400);
    }
  });

  // GET /api/git/log?cwd=...&limit=50
  app.get("/api/git/log", async (c) => {
    const cwd = c.req.query("cwd") || process.env.HOME;
    const limit = parseInt(c.req.query("limit") || "50");

    if (!cwd || !(await validateGitCwd(cwd))) {
      return c.json({ error: "Forbidden path" }, 403);
    }

    try {
      const proc = Bun.spawn(
        [
          "git",
          "log",
          `--max-count=${Math.min(limit, 200)}`,
          "--format=%h|%H|%s|%an|%aI",
          "--graph",
          "--",
        ],
        {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      const timeoutId = setTimeout(() => proc.kill(), 10000);
      const output = await new Response(proc.stdout).text();
      clearTimeout(timeoutId);

      const commits = output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          // Parse graph prefix (*, |, etc) and commit data
          const graphMatch = line.match(/^([*|\\ \/]+)\s*(.*)$/);
          const graph = graphMatch ? graphMatch[1] : "";
          const data = graphMatch ? graphMatch[2] : line;

          const parts = data.split("|");
          if (parts.length >= 5) {
            return {
              hash: parts[0],
              fullHash: parts[1],
              message: parts[2],
              author: parts[3],
              date: parts[4],
              graph: graph.trim(),
            };
          }
          return null;
        })
        .filter(Boolean);

      return c.json({ commits, cwd });
    } catch (err) {
      return c.json({ error: "Git log failed", message: String(err) }, 400);
    }
  });

  // POST /api/git/checkout { cwd, branch }
  app.post("/api/git/checkout", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { cwd, branch } = body;

    if (!cwd || !(await validateGitCwd(cwd))) {
      return c.json({ error: "Forbidden path" }, 403);
    }

    if (
      !branch ||
      typeof branch !== "string" ||
      !/^[\w\-\/\.]+$/.test(branch)
    ) {
      return c.json({ error: "Invalid branch name" }, 400);
    }

    try {
      const proc = Bun.spawn(["git", "checkout", branch, "--"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      const timeoutId = setTimeout(() => proc.kill(), 10000);
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      clearTimeout(timeoutId);

      if (exitCode !== 0) {
        return c.json({ error: "Checkout failed", message: stderr }, 400);
      }

      return c.json({ success: true, branch });
    } catch (err) {
      return c.json(
        { error: "Git checkout failed", message: String(err) },
        400,
      );
    }
  });

  // GET /api/git/show?cwd=...&commit=...&path=...
  app.get("/api/git/show", async (c) => {
    const cwd = c.req.query("cwd") || process.env.HOME;
    const commit = c.req.query("commit");
    const path = c.req.query("path");

    if (!cwd || !(await validateGitCwd(cwd))) {
      return c.json({ error: "Forbidden path" }, 403);
    }

    // Allow hex hashes (4-40 chars), HEAD, HEAD~N, HEAD^N, and branch/tag names
    if (
      !commit ||
      !/^([a-f0-9]{4,40}|HEAD(~\d+|\^\d+)?|[\w\-\/\.]+)$/i.test(commit)
    ) {
      return c.json({ error: "Invalid commit reference" }, 400);
    }

    if (!path) {
      return c.json({ error: "Path required" }, 400);
    }

    try {
      const proc = Bun.spawn(["git", "show", `${commit}:${path}`, "--"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      const timeoutId = setTimeout(() => proc.kill(), 10000);
      const content = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      clearTimeout(timeoutId);

      if (exitCode !== 0) {
        return c.json({ error: "File not found at commit" }, 404);
      }

      return c.json({ content, commit, path });
    } catch (err) {
      return c.json({ error: "Git show failed", message: String(err) }, 400);
    }
  });

  // =============================================================================
  // CLIPBOARD IMAGE UPLOAD
  // =============================================================================

  // Whitelist of allowed image types for security
  const ALLOWED_IMAGE_TYPES = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
  ];

  app.post("/api/clipboard/image", async (c) => {
    try {
      const contentType = c.req.header("content-type") || "";

      // Validate content type against whitelist
      const isAllowedType = ALLOWED_IMAGE_TYPES.some((t) =>
        contentType.includes(t),
      );
      if (!contentType.includes("multipart/form-data") && !isAllowedType) {
        return c.json(
          { error: "Invalid image type. Allowed: PNG, JPEG, GIF, WEBP" },
          400,
        );
      }

      let imageData: Uint8Array;
      let extension = "png";

      if (contentType.includes("multipart/form-data")) {
        const formData = await c.req.formData();
        const file = formData.get("image") as File | null;

        if (!file) {
          return c.json({ error: "No image file provided" }, 400);
        }

        if (file.size > CLIPBOARD_IMAGE_MAX_SIZE) {
          return c.json({ error: "Image too large (max 10MB)" }, 400);
        }

        imageData = new Uint8Array(await file.arrayBuffer());

        // Determine extension from mime type
        if (file.type.includes("jpeg") || file.type.includes("jpg")) {
          extension = "jpg";
        } else if (file.type.includes("gif")) {
          extension = "gif";
        } else if (file.type.includes("webp")) {
          extension = "webp";
        }
      } else {
        // Raw image data in body
        const body = await c.req.arrayBuffer();

        if (body.byteLength === 0) {
          return c.json({ error: "Empty image data" }, 400);
        }

        if (body.byteLength > CLIPBOARD_IMAGE_MAX_SIZE) {
          return c.json({ error: "Image too large (max 10MB)" }, 400);
        }

        imageData = new Uint8Array(body);

        if (contentType.includes("jpeg") || contentType.includes("jpg")) {
          extension = "jpg";
        } else if (contentType.includes("gif")) {
          extension = "gif";
        } else if (contentType.includes("webp")) {
          extension = "webp";
        }
      }

      const timestamp = Date.now();
      const random = Math.random().toString(36).slice(2, 8);
      const filename = `clipboard-${timestamp}-${random}.${extension}`;
      const filePath = join(CLIPBOARD_IMAGES_DIR, filename);

      await Bun.write(filePath, imageData);

      console.log(
        `[Clipboard] Image saved: ${filePath} (${imageData.length} bytes)`,
      );

      return c.json({
        success: true,
        path: filePath,
        filename,
        size: imageData.length,
      });
    } catch (e) {
      console.error("[Clipboard] Image upload error:", e);
      return c.json({ error: "Upload failed" }, 500);
    }
  });

  // Serve static files
  app.use(
    "/*",
    serveStatic({
      root: "./web",
      rewriteRequestPath: (path) => (path === "/" ? "/index.html" : path),
    }),
  );

  return app;
}

export async function startWebServer(host: string, port: number) {
  // Recover existing tmux sessions before starting server
  if (TMUX_BACKEND) {
    console.log(
      "[tmux] TMUX_BACKEND enabled - checking for existing sessions...",
    );
    const recovered = await recoverTmuxSessions();
    if (recovered > 0) {
      console.log(`[tmux] Recovered ${recovered} session(s)`);
    }
  }

  const app = createWebApp();

  const server = Bun.serve<WsData>({
    port,
    hostname: host,

    async fetch(req, server) {
      const url = new URL(req.url);

      // OpenCode WebSocket proxy
      if (url.pathname.startsWith("/apps/opencode/ws")) {
        const wsUrl =
          OPENCODE_UPSTREAM.replace("http", "ws") +
          url.pathname.replace("/apps/opencode", "") +
          url.search;

        try {
          const upstream = new WebSocket(wsUrl);

          const success = server.upgrade(req, {
            data: { type: "opencode_proxy", upstream },
          });

          if (success) {
            return undefined;
          }
        } catch (err) {
          debug("OpenCode WebSocket proxy error:", err);
        }

        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      if (url.pathname.startsWith("/ws/terminals/")) {
        const id = url.pathname.split("/").pop();
        if (!id) {
          return new Response("Terminal ID required", { status: 400 });
        }
        const term = terminals.get(id);

        if (!term) {
          return new Response("Terminal not found", { status: 404 });
        }

        const jwt = req.headers.get("cf-access-jwt-assertion");
        if (CF_ACCESS_REQUIRED && !jwt) {
          return new Response("Unauthorized", { status: 401 });
        }

        let ownerId = "anonymous";
        if (jwt && CF_ACCESS_TEAM_NAME) {
          try {
            const { cloudflareAccess: verifyJWT } =
              await import("@hono/cloudflare-access");
            const mockContext = {
              req: { header: (name: string) => req.headers.get(name) },
              set: (key: string, value: CloudflareAccessPayload) => {
                if (key === "accessPayload") {
                  ownerId = value.sub;
                }
              },
            };
            const middleware = verifyJWT(CF_ACCESS_TEAM_NAME);
            await middleware(mockContext as never, async () => {});
          } catch (err) {
            debug("WebSocket JWT verification failed:", err);
            return new Response("Unauthorized", { status: 401 });
          }
        }

        if (term.ownerId !== ownerId) {
          return new Response("Forbidden", { status: 403 });
        }

        const success = server.upgrade(req, {
          data: { type: "terminal" as const, terminalId: id, ownerId },
        });
        if (success) return undefined;

        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      // Regular HTTP requests go to Hono
      return app.fetch(req, server);
    },

    websocket: {
      open(ws: ServerWebSocket<WsData>) {
        const data = ws.data;

        if (data.type === "opencode_proxy") {
          const upstream = data.upstream;

          upstream.onmessage = (event) => {
            try {
              ws.send(event.data);
            } catch (err) {
              debug("OpenCode proxy upstream->client error:", err);
            }
          };

          upstream.onerror = (err) => {
            debug("OpenCode proxy upstream error:", err);
            ws.close();
          };

          upstream.onclose = () => {
            ws.close();
          };

          debug("OpenCode WebSocket proxy connected");
          return;
        }

        const { terminalId } = data;
        const term = terminals.get(terminalId);
        const sockets = terminalSockets.get(terminalId);

        if (!term || !sockets) {
          ws.close();
          return;
        }

        sockets.add(ws as unknown as WebSocket);
        const socketsCount = sockets.size;

        // Check if this is a reconnect (terminal created more than 5 seconds ago)
        const termAge = Date.now() - term.createdAt;
        const isReconnect = termAge > 5000;

        console.log(
          `[ws] WebSocket connected for ${terminalId} (${term.cols}x${term.rows}), ` +
          `sockets: ${socketsCount}, age: ${Math.round(termAge/1000)}s, isReconnect: ${isReconnect}`,
        );

        // Send scrollback buffer to reconnecting client (tmux backend only)
        if (isReconnect && TMUX_BACKEND && term.sessionName) {
          (async () => {
            try {
              // Capture pane content with escape sequences (colors) - last 2000 lines
              const captureProc = Bun.spawn(
                [
                  "tmux",
                  "capture-pane",
                  "-ep",
                  "-S",
                  "-2000",
                  "-t",
                  term.sessionName!,
                ],
                { stdout: "pipe", stderr: "pipe" },
              );
              const output = await new Response(captureProc.stdout).text();
              await captureProc.exited;

              if (output && ws.readyState === 1) {
                // WebSocket.OPEN = 1
                // Clear screen first, then write captured content
                ws.send("\x1b[2J\x1b[H" + output);
                debug(
                  `[reconnect] Sent ${output.length} bytes of scrollback to ${terminalId}`,
                );
              }
            } catch (err) {
              debug(
                `[reconnect] Failed to capture scrollback for ${terminalId}:`,
                err,
              );
              // Send a simple connected confirmation even if capture fails
              if (ws.readyState === 1) {
                ws.send("\x1b[2J\x1b[H\x1b[32m[Reconnected]\x1b[0m\r\n");
              }
            }
          })();
        } else if (isReconnect && !TMUX_BACKEND) {
          // Non-tmux backend reconnect: force SIGWINCH to trigger TUI redraw
          // Use longer delays for Cloudflare tunnel compatibility
          console.log(`[reconnect] Non-tmux reconnect for ${terminalId}, scheduling SIGWINCH sequence`);

          // Wait for WebSocket to be fully established through tunnel
          setTimeout(() => {
            try {
              const originalCols = term.cols;
              const originalRows = term.rows;

              // First SIGWINCH: shrink
              console.log(`[reconnect] SIGWINCH 1/3 shrink for ${terminalId}: ${originalCols}x${originalRows} -> ${originalCols-1}x${originalRows}`);
              term.terminal.resize(originalCols - 1, originalRows);

              // Second SIGWINCH: restore (after delay for tunnel latency)
              setTimeout(() => {
                try {
                  term.terminal.resize(originalCols, originalRows);
                  console.log(`[reconnect] SIGWINCH 2/3 restore for ${terminalId}`);

                  // Third: One more resize cycle to ensure TUI gets the signal
                  setTimeout(() => {
                    try {
                      // Small size change to trigger another redraw
                      term.terminal.resize(originalCols - 1, originalRows - 1);
                      setTimeout(() => {
                        try {
                          term.terminal.resize(originalCols, originalRows);
                          console.log(`[reconnect] SIGWINCH 3/3 final for ${terminalId}`);
                        } catch (e) {
                          console.error(`[reconnect] Final resize error for ${terminalId}:`, e);
                        }
                      }, 300);
                    } catch (e) {
                      console.error(`[reconnect] Third resize error for ${terminalId}:`, e);
                    }
                  }, 500);
                } catch (e) {
                  console.error(`[reconnect] Resize restore error for ${terminalId}:`, e);
                }
              }, 400);
            } catch (e) {
              console.error(`[reconnect] Resize shrink error for ${terminalId}:`, e);
            }
          }, 1000); // Longer initial delay for Cloudflare tunnel
        }
      },

      message(ws: ServerWebSocket<WsData>, message) {
        try {
          const data = ws.data;

          if (data.type === "opencode_proxy") {
            try {
              data.upstream.send(message);
            } catch (err) {
              debug("OpenCode proxy client->upstream error:", err);
            }
            return;
          }

          const { terminalId } = data;
          const term = terminals.get(terminalId);

          if (!term) {
            debug(`Terminal ${terminalId} not found for message`);
            return;
          }

          if (typeof message === "string") {
            debug(`WS message for ${terminalId}`);
            try {
              const parsed = JSON.parse(message);
              if (parsed.type === "ping") {
                ws.send(JSON.stringify({ type: "pong" }));
                return;
              }
              if (parsed.type === "resize") {
                debug(`Resize ${terminalId}: ${parsed.cols}x${parsed.rows}`);
                term.cols = parsed.cols;
                term.rows = parsed.rows;
                try {
                  term.terminal.resize(parsed.cols, parsed.rows);
                } catch (err) {
                  debug(`Resize error for ${terminalId}:`, err);
                }
                return;
              }
              if (parsed.type === "input") {
                debug(`Input ${terminalId}`);
                term.lastActivityAt = Date.now();
                try {
                  term.terminal.write(parsed.data);
                } catch (err) {
                  debug(`Write error for ${terminalId}:`, err);
                }
                return;
              }
            } catch {
              debug(`Raw input ${terminalId}`);
              term.lastActivityAt = Date.now();
              try {
                term.terminal.write(message);
              } catch (err) {
                debug(`Write error for ${terminalId}:`, err);
              }
            }
          } else {
            const buf = message as unknown as Uint8Array;
            debug(`Binary input ${terminalId}: ${buf.byteLength} bytes`);
            term.lastActivityAt = Date.now();
            try {
              term.terminal.write(new TextDecoder().decode(buf));
            } catch (err) {
              debug(`Binary write error for ${terminalId}:`, err);
            }
          }
        } catch (err) {
          console.error("[WebSocket] Message handler error:", err);
        }
      },

      close(ws: ServerWebSocket<WsData>) {
        const data = ws.data;

        if (data.type === "opencode_proxy") {
          try {
            data.upstream.close();
          } catch (err) {
            debug("OpenCode proxy upstream close error:", err);
          }
          return;
        }

        const { terminalId } = data;
        const sockets = terminalSockets.get(terminalId);
        if (sockets) {
          sockets.delete(ws as unknown as WebSocket);
        }
      },
    },
  });

  console.log(`🚀 OpenCode Web Terminal running at http://${host}:${port}`);

  const cleanupIdleTerminals = async () => {
    const now = Date.now();

    for (const [id, term] of terminals) {
      const idleTime = now - term.lastActivityAt;

      if (idleTime > TERMINAL_IDLE_TIMEOUT_MS) {
        const sockets = terminalSockets.get(id);
        console.log(
          `[cleanup] Closing idle terminal ${id} (idle: ${Math.round(idleTime / 1000 / 60)}min, owner: ${term.ownerEmail})`,
        );
        if (sockets) {
          for (const ws of sockets) {
            try {
              ws.send(JSON.stringify({ type: "idle_timeout" }));
              ws.close();
            } catch {}
          }
        }

        // Kill tmux session if using tmux backend (prevents orphaned sessions)
        if (TMUX_BACKEND && term.sessionName) {
          try {
            debug(`[cleanup] Killing tmux session: ${term.sessionName}`);
            const killProc = Bun.spawn([
              "tmux",
              "kill-session",
              "-t",
              term.sessionName,
            ]);
            await killProc.exited;
          } catch (err) {
            debug(`[cleanup] tmux kill-session error for ${id}:`, err);
          }
        }

        try {
          term.proc.kill();
          term.terminal.close();
        } catch (err) {
          debug(`Cleanup error for ${id}:`, err);
        }
        terminals.delete(id);
        terminalSockets.delete(id);
      }
    }
  };

  setInterval(cleanupIdleTerminals, 5 * 60 * 1000);

  process.on("SIGINT", () => {
    for (const term of terminals.values()) {
      try {
        term.proc.kill();
      } catch {}
    }
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    for (const term of terminals.values()) {
      try {
        term.proc.kill();
      } catch {}
    }
    process.exit(0);
  });

  return server;
}
