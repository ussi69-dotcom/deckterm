import type { Subprocess } from "bun";
import { chmod, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { syncTmuxSessionClients } from "../tmux-client-size";
import { buildTmuxSessionName } from "../tmux-session-names";
import type {
  TerminalBackend,
  TerminalBackendAttachOptions,
  TerminalBackendAttachResult,
  TerminalBackendSession,
  TerminalScrollDirection,
} from "./terminal-backend";

export type TmuxSessionInfo = {
  cwd: string;
  cols: number;
  rows: number;
  panePid: number;
  paneCurrentCommand: string;
};

export type TmuxPipeDelta = {
  chunk: string;
  offset: number;
};

export type TmuxTerminalBackendOptions = {
  namespace: string;
  socketPath: string;
  pipeDir?: string;
  shellCommandResolver: () => Promise<string[]>;
  env?: Record<string, string | undefined>;
};

export class TmuxTerminalBackend implements TerminalBackend {
  readonly mode = "tmux" as const;
  readonly namespace: string;
  readonly socketPath: string;
  readonly pipeDir: string;
  private readonly shellCommandResolver: () => Promise<string[]>;
  private readonly baseEnv: Record<string, string | undefined>;
  private socketDirectoryReady: Promise<void> | null = null;

  constructor(options: TmuxTerminalBackendOptions) {
    this.namespace = options.namespace;
    this.socketPath = options.socketPath;
    this.pipeDir = options.pipeDir || "/tmp/deckterm-tmux-pipes";
    this.shellCommandResolver = options.shellCommandResolver;
    this.baseEnv = options.env || process.env;
  }

  async createSession(
    id: string,
    cwd: string,
    cols: number,
    rows: number,
    ownerId: string,
    ownerEmail: string,
  ): Promise<TerminalBackendSession> {
    const sessionName = buildTmuxSessionName({
      namespace: this.namespace,
      terminalId: id,
    });
    const shellCommand = await this.shellCommandResolver();
    const createProc = await this.spawnTmux(
      [
        "new-session",
        "-d",
        "-s",
        sessionName,
        "-x",
        String(cols),
        "-y",
        String(rows),
        "-c",
        cwd,
        ...shellCommand,
      ],
      {
        env: {
          ...this.baseEnv,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
        },
      },
    );
    await createProc.exited;

    await this.hideStatusBar(sessionName);
    await this.ensureHistoryLimit();
    await this.resize(sessionName, cols, rows);
    const { pipePath, pipeOffset } = await this.ensurePipeCapture(sessionName);

    return {
      id,
      mode: this.mode,
      sessionName,
      cwd,
      cols,
      rows,
      ownerId,
      ownerEmail,
      pipePath,
      pipeOffset,
    };
  }

  async attach(
    sessionName: string,
    options: TerminalBackendAttachOptions,
  ): Promise<TerminalBackendAttachResult> {
    await this.hideStatusBar(sessionName);
    await this.resize(sessionName, options.cols, options.rows);
    const { pipePath, pipeOffset } = await this.ensurePipeCapture(sessionName);

    const proc = await this.spawnTmux(["attach-session", "-t", sessionName], {
      cwd: options.cwd,
      env: {
        ...this.baseEnv,
        ...options.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        COLUMNS: String(options.cols),
        LINES: String(options.rows),
      },
      terminal: options.terminal,
      onExit: options.onExit,
    } as any);

    await this.resize(sessionName, options.cols, options.rows, {
      waitForClient: options.waitForClient,
    });

    return { proc, pipePath, pipeOffset };
  }

  async capture(sessionName: string): Promise<string> {
    const captureProc = await this.spawnTmux(
      ["capture-pane", "-ep", "-S", "-2000", "-t", sessionName],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response((captureProc as any).stdout).text();
    await captureProc.exited;
    return output;
  }

  async resize(
    sessionName: string,
    cols: number,
    rows: number,
    options: { waitForClient?: boolean } = {},
  ): Promise<void> {
    const resizeWindowProc = await this.spawnTmux([
      "resize-window",
      "-t",
      sessionName,
      "-x",
      String(cols),
      "-y",
      String(rows),
    ]);
    await resizeWindowProc.exited;

    const resizePaneProc = await this.spawnTmux([
      "resize-pane",
      "-t",
      sessionName,
      "-x",
      String(cols),
      "-y",
      String(rows),
    ]);
    await resizePaneProc.exited;

    await syncTmuxSessionClients(sessionName, cols, rows, {
      waitForClient: options.waitForClient,
      socketPath: this.socketPath,
    });
  }

  async scrollHistory(
    sessionName: string,
    direction: TerminalScrollDirection,
    lines: number,
  ): Promise<boolean> {
    const count = Math.max(1, Math.min(100, Math.trunc(lines)));
    if (direction === "up") {
      const copyModeProc = await this.spawnTmux([
        "copy-mode",
        "-e",
        "-t",
        sessionName,
      ]);
      if ((await copyModeProc.exited) !== 0) return false;
    }

    const scrollProc = await this.spawnTmux([
      "send-keys",
      "-X",
      "-N",
      String(count),
      "-t",
      sessionName,
      direction === "up" ? "scroll-up" : "scroll-down",
    ]);
    return (await scrollProc.exited) === 0;
  }

  async kill(sessionName: string): Promise<void> {
    const killProc = await this.spawnTmux(["kill-session", "-t", sessionName]);
    const exitCode = await killProc.exited;
    if (exitCode !== 0) {
      throw new Error(
        `tmux kill-session returned ${exitCode} for ${sessionName}`,
      );
    }
  }

  async listSessions(prefix?: string): Promise<string[]> {
    const result = await this.spawnTmux([
      "list-sessions",
      "-F",
      "#{session_name}",
    ]);
    const output = await new Response((result as any).stdout).text();
    await result.exited;
    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .filter((sessionName) => !prefix || sessionName.startsWith(`${prefix}_`));
  }

  async sessionExists(sessionName: string): Promise<boolean> {
    const proc = await this.spawnTmux(["has-session", "-t", sessionName], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  }

  async getSessionInfo(sessionName: string): Promise<TmuxSessionInfo> {
    const infoResult = await this.spawnTmux([
      "display-message",
      "-t",
      sessionName,
      "-p",
      "#{pane_current_path}\t#{window_width}\t#{window_height}\t#{pane_pid}\t#{pane_current_command}",
    ]);
    const infoOutput = await new Response((infoResult as any).stdout).text();
    await infoResult.exited;
    const [
      cwd = "/home/deploy",
      colsStr = "120",
      rowsStr = "30",
      panePidStr = "0",
      paneCurrentCommand = "",
    ] = infoOutput.trim().split("\t");
    return {
      cwd,
      cols: parseInt(colsStr, 10) || 120,
      rows: parseInt(rowsStr, 10) || 30,
      panePid: parseInt(panePidStr, 10) || 0,
      paneCurrentCommand,
    };
  }

  async readPipeDelta(
    pipePath: string | null | undefined,
    currentOffset: number,
  ): Promise<TmuxPipeDelta> {
    if (!pipePath) return { chunk: "", offset: currentOffset };

    try {
      const fileStat = await stat(pipePath);
      let offset = currentOffset;
      if (fileStat.size < offset) {
        offset = 0;
      }
      if (fileStat.size === offset) {
        return { chunk: "", offset };
      }

      const nextOffset = fileStat.size;
      const chunk = await Bun.file(pipePath).slice(offset, nextOffset).text();
      return { chunk, offset: nextOffset };
    } catch {
      return { chunk: "", offset: currentOffset };
    }
  }

  private async spawnTmux(args: string[], options?: any): Promise<Subprocess> {
    await this.ensureSocketDirectory();
    return Bun.spawn(["tmux", "-S", this.socketPath, ...args], options);
  }

  private async ensureSocketDirectory(): Promise<void> {
    if (!this.socketDirectoryReady) {
      this.socketDirectoryReady = (async () => {
        const socketDir = dirname(this.socketPath);
        await mkdir(socketDir, { recursive: true });
        await chmod(socketDir, 0o700);
      })();
    }
    return this.socketDirectoryReady;
  }

  private async hideStatusBar(sessionName: string): Promise<void> {
    const hideStatusProc = await this.spawnTmux([
      "set-option",
      "-t",
      sessionName,
      "status",
      "off",
    ]);
    await hideStatusProc.exited;
  }

  // tmux's default history-limit (2000 lines) is far below the frontend's
  // xterm.js scrollback (10000, see web/app.js) and gets exhausted within a
  // single long-lived agent session, silently evicting old output (including
  // completed Codex/Claude responses) long before the alt-screen fix's
  // failure mode ever triggers. -g applies server-wide, so this is a no-op
  // once set but safe to repeat on every session create.
  private async ensureHistoryLimit(): Promise<void> {
    const proc = await this.spawnTmux([
      "set-option",
      "-g",
      "history-limit",
      "10000",
    ]);
    await proc.exited;
  }

  private getPipePath(sessionName: string): string {
    return join(this.pipeDir, `${sessionName}.log`);
  }

  // Serializes check-and-arm per session: two concurrent ensurePipeCapture
  // calls could both read pane_pipe=0 and both run the TOGGLING `pipe-pane
  // -o`, closing the pipe the first call just opened (Codex Phase-3 review).
  private pipeArmLocks = new Map<string, Promise<unknown>>();

  private async ensurePipeCapture(
    sessionName: string,
  ): Promise<{ pipePath: string; pipeOffset: number }> {
    const prev = this.pipeArmLocks.get(sessionName) ?? Promise.resolve();
    const run = prev.then(
      () => this.ensurePipeCaptureLocked(sessionName),
      () => this.ensurePipeCaptureLocked(sessionName),
    );
    const guard = run.then(
      () => undefined,
      () => undefined,
    );
    this.pipeArmLocks.set(sessionName, guard);
    try {
      return await run;
    } finally {
      if (this.pipeArmLocks.get(sessionName) === guard) {
        this.pipeArmLocks.delete(sessionName);
      }
    }
  }

  private async ensurePipeCaptureLocked(
    sessionName: string,
  ): Promise<{ pipePath: string; pipeOffset: number }> {
    await mkdir(this.pipeDir, { recursive: true });
    const pipePath = this.getPipePath(sessionName);
    // `pipe-pane -o` TOGGLES on tmux 3.4: a second call closes an open pipe.
    // Since this runs on both create() and attach(), the pipe used to end up
    // CLOSED after any create→attach sequence, silently dropping every
    // shell-integration marker in tmux mode (S9 spike finding). Only arm the
    // pipe when the pane reports none is open.
    const checkProc = await this.spawnTmux(
      ["display-message", "-p", "-t", sessionName, "#{pane_pipe}"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const pipeState = (
      await new Response((checkProc as any).stdout).text()
    ).trim();
    await checkProc.exited;
    if (pipeState !== "1") {
      const pipeProc = await this.spawnTmux(
        ["pipe-pane", "-o", "-t", sessionName, `cat >> ${pipePath}`],
        { stdout: "pipe", stderr: "pipe" },
      );
      await pipeProc.exited;
    }

    try {
      return { pipePath, pipeOffset: (await stat(pipePath)).size };
    } catch {
      return { pipePath, pipeOffset: 0 };
    }
  }
}
