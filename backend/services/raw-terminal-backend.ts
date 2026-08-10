import type { Subprocess } from "bun";
import { brokerKill, brokerSpawn } from "./broker-client";
import type {
  BrokeredExecContext,
  TerminalBackend,
  TerminalBackendAttachOptions,
  TerminalBackendAttachResult,
  TerminalBackendSession,
} from "./terminal-backend";

export type RawTerminalBackendOptions = {
  shellCommandResolver: () => Promise<string[]>;
  env?: Record<string, string | undefined>;
};

export class RawTerminalBackend implements TerminalBackend {
  readonly mode = "raw" as const;
  private readonly shellCommandResolver: () => Promise<string[]>;
  private readonly baseEnv: Record<string, string | undefined>;
  private readonly processes = new Map<string, Subprocess>();
  // Sessions spawned through the broker: killed via `brokerKill` (systemctl
  // stop the transient scope), not a bare proc.kill() (design §5).
  private readonly brokered = new Set<string>();

  constructor(options: RawTerminalBackendOptions) {
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
    return {
      id,
      mode: this.mode,
      sessionName: id,
      cwd,
      cols,
      rows,
      ownerId,
      ownerEmail,
      pipePath: null,
      pipeOffset: 0,
    };
  }

  async attach(
    sessionName: string,
    options: TerminalBackendAttachOptions,
  ): Promise<TerminalBackendAttachResult> {
    // OS-isolation path (design §5): spawn the login shell AS THE MAPPED USER
    // through the root-owned broker on the server-owned PTY, instead of as the
    // service account. `exec` is server-resolved only (invariant §7.2).
    if (options.exec) {
      return this.attachBrokered(sessionName, options, options.exec);
    }

    const home = this.baseEnv.HOME || "/home/deploy";
    const shellCommand =
      options.shellCommand || (await this.shellCommandResolver());
    const proc = Bun.spawn(shellCommand, {
      cwd: options.cwd,
      env: {
        ...this.baseEnv,
        ...options.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        COLUMNS: String(options.cols),
        LINES: String(options.rows),
        PATH: `${home}/.opencode/bin:${this.baseEnv.PATH || "/usr/bin"}`,
      },
      // @ts-expect-error - terminal option is Bun 1.3.5+ API, not yet in bun-types
      terminal: options.terminal,
      onExit: options.onExit,
    });
    this.processes.set(sessionName, proc);
    return { proc, pipePath: null, pipeOffset: 0 };
  }

  private attachBrokered(
    sessionName: string,
    options: TerminalBackendAttachOptions,
    exec: BrokeredExecContext,
  ): TerminalBackendAttachResult {
    const proc = brokerSpawn({
      session: sessionName,
      username: exec.osUsername,
      uid: exec.uid,
      gid: exec.gid,
      cwd: options.cwd,
      profile: "pty",
      cols: options.cols,
      rows: options.rows,
      terminal: options.terminal,
      onExit: options.onExit,
    });
    this.processes.set(sessionName, proc);
    this.brokered.add(sessionName);
    return { proc, pipePath: null, pipeOffset: 0 };
  }

  async capture(_sessionName: string): Promise<string> {
    return "";
  }

  async resize(
    _sessionName: string,
    _cols: number,
    _rows: number,
  ): Promise<void> {
    // Raw Bun.Terminal sessions are resized by the server's terminal handle.
  }

  async scrollHistory(): Promise<boolean> {
    return false;
  }

  async kill(sessionName: string): Promise<void> {
    if (this.brokered.has(sessionName)) {
      // Tear down the broker-created transient scope (which reaps the shell),
      // then drop the local proc handle.
      try {
        await brokerKill({ session: sessionName });
      } finally {
        this.brokered.delete(sessionName);
        const proc = this.processes.get(sessionName);
        if (proc) {
          try {
            proc.kill();
          } catch {
            // already gone
          }
        }
        this.processes.delete(sessionName);
      }
      return;
    }
    const proc = this.processes.get(sessionName);
    if (!proc) return;
    proc.kill();
    this.processes.delete(sessionName);
  }
}
