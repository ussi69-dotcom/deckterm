import type { Subprocess } from "bun";

export type TerminalBackendMode = "raw" | "tmux";
export type TerminalScrollDirection = "up" | "down";

export type TerminalBackendSession = {
  id: string;
  mode: TerminalBackendMode;
  sessionName: string;
  cwd: string;
  cols: number;
  rows: number;
  ownerId: string;
  ownerEmail: string;
  pipePath?: string | null;
  pipeOffset?: number;
};

/**
 * B2 OS-isolation execution context (design §5). When present, the backend
 * spawns the PTY/tmux client AS THIS UNIX ACCOUNT through the root-owned broker
 * instead of as the service account. Absent ⇒ today's legacy path verbatim
 * (invariant §7.1). Server-resolved only — never from the client (§7.2).
 */
export type BrokeredExecContext = {
  uid: number;
  gid: number;
  osUsername: string;
};

export type TerminalBackendAttachOptions = {
  cwd: string;
  cols: number;
  rows: number;
  terminal: unknown;
  shellCommand?: string[];
  env?: Record<string, string | undefined>;
  waitForClient?: boolean;
  /**
   * When set, spawn through the broker as this account (design §5). Absent ⇒
   * legacy service-account spawn, byte-identical to pre-B2 (invariant §7.1).
   */
  exec?: BrokeredExecContext;
  onExit?: (
    proc: Subprocess,
    exitCode: number,
    signalCode?: number | null,
  ) => void;
};

export type TerminalBackendAttachResult = {
  proc: Subprocess;
  pipePath?: string | null;
  pipeOffset?: number;
};

export interface TerminalBackend {
  readonly mode: TerminalBackendMode;

  createSession(
    id: string,
    cwd: string,
    cols: number,
    rows: number,
    ownerId: string,
    ownerEmail: string,
  ): Promise<TerminalBackendSession>;

  attach(sessionName: string, options: any): Promise<any>;

  capture(sessionName: string): Promise<string>;

  resize(sessionName: string, cols: number, rows: number): Promise<void>;

  scrollHistory(
    sessionName: string,
    direction: TerminalScrollDirection,
    lines: number,
  ): Promise<boolean>;

  kill(sessionName: string): Promise<void>;
}
