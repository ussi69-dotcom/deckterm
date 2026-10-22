import type { Subprocess } from "bun";
import type { TmuxScrollState } from "./tmux-scroll-state";

export type TerminalBackendMode = "raw" | "tmux";
export type TerminalScrollDirection = "up" | "down";

/**
 * Options for the tmux calls the scroll controller makes. Aborting `signal`
 * kills the tmux client process, so a timed-out command cannot run later
 * and break the controller's queue order.
 */
export type TerminalScrollCallOptions = { signal?: AbortSignal };

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

  /**
   * True when this backend can read the pane's scroll state and position
   * copy-mode itself (readScrollState, scrollToPosition, exitScroll,
   * cancelScroll). False (brokered tmux, raw): touch-scroll falls back to
   * scrollHistory, scroll-to / scroll-latest are ignored, no
   * `scroll-position` frames and no input barrier.
   */
  readonly supportsScrollControl: boolean;

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
    options?: TerminalScrollCallOptions,
  ): Promise<boolean>;

  /** The pane's live scroll state, or null when it cannot be read. */
  readScrollState(
    sessionName: string,
    options?: TerminalScrollCallOptions,
  ): Promise<TmuxScrollState | null>;

  /**
   * Shows the history `position` lines above the live bottom (tmux copy-mode,
   * clamped by tmux to the available history). 0 or less leaves copy-mode.
   * Refused (false) on the alternate screen, which has no history.
   */
  scrollToPosition(
    sessionName: string,
    position: number,
    options?: TerminalScrollCallOptions,
  ): Promise<boolean>;

  /** Leaves copy-mode; succeeds when the pane was not scrolled back either. */
  exitScroll(
    sessionName: string,
    options?: TerminalScrollCallOptions,
  ): Promise<boolean>;

  /** `send -X cancel`: the fallback when exitScroll left the pane in a mode. */
  cancelScroll(
    sessionName: string,
    options?: TerminalScrollCallOptions,
  ): Promise<boolean>;

  kill(sessionName: string): Promise<void>;
}
