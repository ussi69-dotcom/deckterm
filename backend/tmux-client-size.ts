export type TmuxSessionClient = {
  tty: string;
  pid: number;
};

type SyncTmuxSessionClientsOptions = {
  waitForClient?: boolean;
  maxAttempts?: number;
  delayMs?: number;
  socketPath?: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function parseTmuxSessionClients(
  output: string,
  sessionName: string,
): TmuxSessionClient[] {
  if (!output || !sessionName) return [];

  const clients: TmuxSessionClient[] = [];
  for (const line of output.split("\n")) {
    const [tty = "", pidText = "", currentSession = ""] = line
      .trim()
      .split("\t");
    const pid = Number.parseInt(pidText, 10);
    if (
      !tty ||
      currentSession !== sessionName ||
      !Number.isInteger(pid) ||
      pid <= 0
    ) {
      continue;
    }
    clients.push({ tty, pid });
  }

  return clients;
}

export function buildTmuxClientResizeCommands(
  clients: TmuxSessionClient[],
  cols: number,
  rows: number,
): string[][] {
  if (!Array.isArray(clients) || clients.length === 0) return [];

  const normalizedCols = String(Math.max(1, cols));
  const normalizedRows = String(Math.max(1, rows));
  const commands: string[][] = [];

  for (const client of clients) {
    if (!client?.tty || !Number.isInteger(client.pid) || client.pid <= 0) {
      continue;
    }
    commands.push([
      "stty",
      "-F",
      client.tty,
      "rows",
      normalizedRows,
      "cols",
      normalizedCols,
    ]);
    commands.push(["kill", "-WINCH", String(client.pid)]);
  }

  return commands;
}

async function listTmuxSessionClients(
  sessionName: string,
  socketPath?: string,
): Promise<TmuxSessionClient[]> {
  const command = [
    "tmux",
    ...(socketPath ? ["-S", socketPath] : []),
    "list-clients",
    "-F",
    "#{client_tty}\t#{client_pid}\t#{session_name}",
  ];
  const clientProc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(clientProc.stdout).text();
  await clientProc.exited;
  return parseTmuxSessionClients(output, sessionName);
}

export async function syncTmuxSessionClients(
  sessionName: string,
  cols: number,
  rows: number,
  options: SyncTmuxSessionClientsOptions = {},
): Promise<number> {
  const {
    waitForClient = false,
    maxAttempts = 6,
    delayMs = 25,
    socketPath,
  } = options;

  let clients: TmuxSessionClient[] = [];
  const attempts = waitForClient ? Math.max(1, maxAttempts) : 1;

  for (let attempt = 0; attempt < attempts; attempt++) {
    clients = await listTmuxSessionClients(sessionName, socketPath);
    if (clients.length > 0) break;
    if (attempt + 1 < attempts) {
      await sleep(delayMs);
    }
  }

  for (const command of buildTmuxClientResizeCommands(clients, cols, rows)) {
    const proc = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
  }

  return clients.length;
}

export type TmuxSize = { cols: number; rows: number };

export type TmuxResizePlan = {
  /** Window size to apply BEFORE the client PTY resize, or null. */
  growFirst: TmuxSize | null;
  /** Window size to apply after the client has taken its new size. */
  final: TmuxSize;
};

// tmux paints a '│···' fill frame whenever a window is smaller than its client.
// That frame is drawn at the client's size, so when it reaches an xterm that
// has already shrunk, its rows wrap and land in the browser's scrollback. The
// plan keeps the window at least as large as the client at every step: the
// dimensions that grow are applied to the window first, then the client
// takes its new size, then the window is trimmed to match it.
export function planTmuxResize(
  current: TmuxSize | null,
  next: TmuxSize,
): TmuxResizePlan {
  const final = { cols: next.cols, rows: next.rows };
  if (!current) return { growFirst: null, final };
  const cols = Math.max(current.cols, next.cols);
  const rows = Math.max(current.rows, next.rows);
  const grows = cols !== current.cols || rows !== current.rows;
  return { growFirst: grows ? { cols, rows } : null, final };
}

export function parseTmuxWindowSize(output: string): TmuxSize | null {
  const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(output || "");
  if (!match) return null;
  const cols = Number.parseInt(match[1], 10);
  const rows = Number.parseInt(match[2], 10);
  if (cols <= 0 || rows <= 0) return null;
  return { cols, rows };
}

// `list-clients -F "#{client_tty}\t#{client_width}\t#{client_height}\t#{session_name}"`
// output: true when every client of the session reports cols x rows (and when
// the session has no client, since there is nothing to wait for).
export function tmuxClientsHaveSize(
  output: string,
  sessionName: string,
  cols: number,
  rows: number,
): boolean {
  for (const line of (output || "").split("\n")) {
    const [tty = "", width = "", height = "", session = ""] = line
      .trim()
      .split("\t");
    if (!tty || session !== sessionName) continue;
    if (Number(width) !== cols || Number(height) !== rows) return false;
  }
  return true;
}

// Runs `apply` for one value at a time. A value requested while another is
// being applied replaces any value still waiting, so a burst of requests
// applies the first and the last only (the last value wins). The returned
// promise settles when the queue is drained; apply errors go to onError and
// never stop the queue.
export function createLatestWinsRunner<T>(
  apply: (value: T) => Promise<void>,
  onError: (err: unknown, value: T) => void = () => {},
): (value: T) => Promise<void> {
  let pending: { value: T } | null = null;
  let running: Promise<void> | null = null;

  return (value: T) => {
    pending = { value };
    if (!running) {
      running = (async () => {
        try {
          while (pending) {
            const next = pending.value;
            pending = null;
            try {
              await apply(next);
            } catch (err) {
              onError(err, next);
            }
          }
        } finally {
          running = null;
        }
      })();
    }
    return running;
  };
}
