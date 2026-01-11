import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import type { ServerWebSocket, Subprocess } from "bun";

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
};

type WsData = { terminalId: string };

// Configuration
const DEBUG = process.env.OPENCODE_WEB_DEBUG === "1";
const MAX_TERMINALS = parseInt(
  process.env.OPENCODE_WEB_MAX_TERMINALS || "10",
  10,
);
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 20; // max terminals per minute

// Terminal sessions (PTY processes)
const terminals = new Map<string, Terminal>();
const terminalSockets = new Map<string, Set<WebSocket>>();

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

// Debug logger
function debug(...args: unknown[]) {
  if (DEBUG) console.log("[web-terminal]", ...args);
}

export function createWebApp() {
  const app = new Hono();

  // CORS - allow all origins for development
  app.use("/*", cors());

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
    const memUsage = ((totalMem - freeMem) / totalMem) * 100;

    let diskUsage = 0;
    try {
      const stat = await fs.statfs("/");
      diskUsage = ((stat.blocks - stat.bfree) / stat.blocks) * 100;
    } catch {
      // statfs not available
    }

    return c.json({
      cpu: { usage: Math.round(cpuUsage) },
      memory: { percent: Math.round(memUsage) },
      disk: { percent: Math.round(diskUsage) },
    });
  });

  // Create new terminal running shell
  app.post("/api/terminals", async (c) => {
    // Rate limiting check
    if (!rateLimitState.canCreate()) {
      return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
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

    const proc = Bun.spawn([shell, "-il"], {
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
        debug(`Terminal ${id} exited: code=${exitCode}, signal=${signalCode}`);
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

    terminals.set(id, {
      id,
      proc,
      terminal,
      cwd,
      cols,
      rows,
      createdAt: Date.now(),
    });
    terminalSockets.set(id, new Set());

    debug(`Terminal ${id} created with PID ${proc.pid}`);

    return c.json({ id, cols, rows, cwd });
  });

  // List terminals
  app.get("/api/terminals", (c) => {
    const list = Array.from(terminals.values()).map((t) => ({
      id: t.id,
      cwd: t.cwd,
      createdAt: t.createdAt,
    }));
    return c.json(list);
  });

  // Delete terminal
  app.delete("/api/terminals/:id", (c) => {
    const id = c.req.param("id");
    const term = terminals.get(id);
    if (term) {
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
    }
    return c.json({ error: "Terminal not found" }, 404);
  });

  // Resize terminal - now with proper PTY resize support via Bun.Terminal
  app.post("/api/terminals/:id/resize", async (c) => {
    const id = c.req.param("id");
    const term = terminals.get(id);
    if (!term) {
      return c.json({ error: "Terminal not found" }, 404);
    }

    const body = await c.req.json();
    const cols = body.cols || 120;
    const rows = body.rows || 30;
    term.cols = cols;
    term.rows = rows;

    // Actually resize the PTY - this sends SIGWINCH to the process
    try {
      term.terminal.resize(cols, rows);
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

export function startWebServer(host: string, port: number) {
  const app = createWebApp();

  const server = Bun.serve<WsData>({
    port,
    hostname: host,

    fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade for terminal connection
      if (url.pathname.startsWith("/ws/terminals/")) {
        const id = url.pathname.split("/").pop();
        if (id && terminals.has(id)) {
          const success = server.upgrade(req, { data: { terminalId: id } });
          if (success) return undefined;
        }
        return new Response("Terminal not found", { status: 404 });
      }

      // Regular HTTP requests go to Hono
      return app.fetch(req, server);
    },

    websocket: {
      open(ws: ServerWebSocket<WsData>) {
        const terminalId = ws.data.terminalId;
        const term = terminals.get(terminalId);
        const sockets = terminalSockets.get(terminalId);

        if (!term || !sockets) {
          ws.close();
          return;
        }

        sockets.add(ws as unknown as WebSocket);
        debug(`WebSocket connected for terminal ${terminalId}`);
      },

      message(ws: ServerWebSocket<WsData>, message) {
        const terminalId = ws.data.terminalId;
        const term = terminals.get(terminalId);

        if (!term) {
          debug(`Terminal ${terminalId} not found for message`);
          return;
        }

        // Handle different message types
        if (typeof message === "string") {
          debug(`WS message for ${terminalId}`);
          try {
            const parsed = JSON.parse(message);
            if (parsed.type === "ping") {
              // Respond to heartbeat
              ws.send(JSON.stringify({ type: "pong" }));
              return;
            }
            if (parsed.type === "resize") {
              debug(`Resize ${terminalId}: ${parsed.cols}x${parsed.rows}`);
              term.cols = parsed.cols;
              term.rows = parsed.rows;
              // Use Bun.Terminal resize - sends SIGWINCH
              try {
                term.terminal.resize(parsed.cols, parsed.rows);
              } catch (err) {
                debug(`Resize error for ${terminalId}:`, err);
              }
              return;
            }
            if (parsed.type === "input") {
              debug(`Input ${terminalId}`);
              term.terminal.write(parsed.data);
              return;
            }
          } catch {
            // Not JSON, treat as raw input
            debug(`Raw input ${terminalId}`);
            term.terminal.write(message);
          }
        } else {
          // Binary data (Buffer in Bun WebSocket)
          const buf = message as unknown as Uint8Array;
          debug(`Binary input ${terminalId}: ${buf.byteLength} bytes`);
          term.terminal.write(new TextDecoder().decode(buf));
        }
      },

      close(ws: ServerWebSocket<WsData>) {
        const terminalId = ws.data.terminalId;
        const sockets = terminalSockets.get(terminalId);
        if (sockets) {
          sockets.delete(ws as unknown as WebSocket);
        }
      },
    },
  });

  console.log(`🚀 OpenCode Web Terminal running at http://${host}:${port}`);

  // Cleanup on exit
  process.on("SIGINT", () => {
    for (const term of terminals.values()) {
      term.proc.kill();
    }
    process.exit(0);
  });

  return server;
}
