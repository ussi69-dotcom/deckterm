import type { Subprocess } from "bun";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import { buildTmuxSessionName } from "../tmux-session-names";
import { brokerExec, brokerKill, brokerSpawn } from "./broker-client";
import type {
  BrokeredExecContext,
  TerminalBackend,
  TerminalBackendAttachOptions,
  TerminalBackendAttachResult,
  TerminalBackendSession,
  TerminalScrollDirection,
} from "./terminal-backend";
import type { TmuxPipeDelta, TmuxSessionInfo } from "./tmux-terminal-backend";

/**
 * B2 brokered tmux backend (design §5). A per-uid `TerminalBackend` whose every
 * tmux invocation runs through the root-owned broker's `tmux` profile
 * (subcommand allowlist §3.5) as the mapped account, rather than a direct
 * `Bun.spawn(["tmux","-S",socket,…])` by the service account. The socket path
 * is broker-computed; the server never opens it. The reconnect spool is read
 * fd-safely from the broker-provisioned, service-group-readable capture dir.
 *
 * The tmux session NAME (e.g. `deckterm_<ns>_<uuid>`) doubles as the broker
 * `--session` id and the capture-dir key — it satisfies both the broker session
 * regex and the tmux `-t` target pattern, so no id⇄name mapping is needed.
 */
export type BrokeredTmuxBackendOptions = {
  namespace: string;
  captureRoot: string;
  exec: BrokeredExecContext;
};

// The broker's session-id regex, re-asserted server-side before any path join
// so capture-path safety never rests solely on broker-side validation.
const BROKER_SESSION_RE = /^[a-z0-9][a-z0-9_-]{7,63}$/;

// Cap per-replay reads so a mapped user (who owns pipe.log) cannot force a
// huge/sparse allocation that pressures the service (Codex S3b size-safety).
const MAX_PIPE_DELTA_BYTES = 1024 * 1024;

export class BrokeredTmuxBackend implements TerminalBackend {
  readonly mode = "tmux" as const;
  readonly namespace: string;
  readonly captureRoot: string;
  /** The mapped identity this backend is permanently bound to (per-uid cache
   *  key + tuple-consistency check in BrokeredTmuxBackendCache). */
  readonly exec: BrokeredExecContext;
  // Per-session cwd so control ops pass a dir the mapped user can traverse.
  private readonly sessionCwds = new Map<string, string>();

  constructor(options: BrokeredTmuxBackendOptions) {
    this.namespace = options.namespace;
    this.captureRoot = options.captureRoot;
    this.exec = options.exec;
  }

  private cwdFor(sessionName: string): string {
    return this.sessionCwds.get(sessionName) || "/";
  }

  private pipePathFor(sessionName: string): string {
    if (!BROKER_SESSION_RE.test(sessionName)) {
      throw new Error(`unsafe brokered session name: ${sessionName}`);
    }
    return join(this.captureRoot, sessionName, "pipe.log");
  }

  /** Run a tmux control subcommand through the broker's `exec` (non-PTY). */
  private async control(
    sessionName: string,
    tmuxArgs: string[],
    timeoutMs = 15_000,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return brokerExec(
      {
        session: sessionName,
        username: this.exec.osUsername,
        uid: this.exec.uid,
        gid: this.exec.gid,
        cwd: this.cwdFor(sessionName),
        profile: "tmux",
        profileArgs: tmuxArgs,
      },
      undefined,
      timeoutMs,
    );
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
    this.sessionCwds.set(sessionName, cwd);

    // First new-session for this uid also starts the per-user tmux-server scope
    // and provisions the capture dir (both broker-side, design §3.5).
    const created = await this.control(sessionName, [
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
    ]);
    if (created.code !== 0) {
      throw new Error(
        `brokered tmux new-session failed (${created.code}): ${created.stderr}`,
      );
    }

    await this.hideStatusBar(sessionName);
    await this.ensureHistoryLimit(sessionName);
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
    if (options.cwd) this.sessionCwds.set(sessionName, options.cwd);
    await this.hideStatusBar(sessionName);
    await this.resize(sessionName, options.cols, options.rows);
    const { pipePath, pipeOffset } = await this.ensurePipeCapture(sessionName);

    // The attach client is a PTY: hand the server-owned terminal to the broker
    // `spawn` chain so the tmux client runs as the mapped user on our PTY.
    const proc = brokerSpawn({
      session: sessionName,
      username: this.exec.osUsername,
      uid: this.exec.uid,
      gid: this.exec.gid,
      cwd: this.cwdFor(sessionName),
      profile: "tmux",
      cols: options.cols,
      rows: options.rows,
      profileArgs: ["attach-session", "-t", sessionName],
      terminal: options.terminal,
      onExit: options.onExit,
    });

    return { proc, pipePath, pipeOffset };
  }

  async capture(sessionName: string): Promise<string> {
    const res = await this.control(sessionName, [
      "capture-pane",
      "-e",
      "-p",
      "-S",
      "-2000",
      "-t",
      sessionName,
    ]);
    return res.code === 0 ? res.stdout : "";
  }

  async resize(
    sessionName: string,
    cols: number,
    rows: number,
    _options: { waitForClient?: boolean } = {},
  ): Promise<void> {
    await this.control(sessionName, [
      "resize-window",
      "-t",
      sessionName,
      "-x",
      String(cols),
      "-y",
      String(rows),
    ]);
    await this.control(sessionName, [
      "resize-pane",
      "-t",
      sessionName,
      "-x",
      String(cols),
      "-y",
      String(rows),
    ]);
    // Client-size sync (tmux-client-size) opens the socket directly and is not
    // available in brokered mode; the resize-window/pane above bound the pane.
  }

  async scrollHistory(
    sessionName: string,
    direction: TerminalScrollDirection,
    lines: number,
  ): Promise<boolean> {
    const count = Math.max(1, Math.min(100, Math.trunc(lines)));
    if (direction === "up") {
      const copyMode = await this.control(sessionName, [
        "copy-mode",
        "-e",
        "-t",
        sessionName,
      ]);
      if (copyMode.code !== 0) return false;
    }

    const scroll = await this.control(sessionName, [
      "send-keys",
      "-X",
      "-N",
      String(count),
      "-t",
      sessionName,
      direction === "up" ? "scroll-up" : "scroll-down",
    ]);
    return scroll.code === 0;
  }

  async kill(sessionName: string): Promise<void> {
    const res = await this.control(sessionName, [
      "kill-session",
      "-t",
      sessionName,
    ]);
    this.sessionCwds.delete(sessionName);
    if (res.code !== 0) {
      throw new Error(
        `brokered tmux kill-session returned ${res.code} for ${sessionName}: ${res.stderr}`,
      );
    }
  }

  /** Revocation teardown (design §3.5): stop the whole per-user server scope,
   *  which reaps every session for this uid. Used by killUserSessions. */
  async killServer(): Promise<void> {
    await brokerKill({ tmuxServerUid: this.exec.uid });
  }

  async listSessions(prefix?: string): Promise<string[]> {
    // A per-uid backend; any session name works as the broker --session key.
    const res = await this.control("deckterm_probe_listsessions", [
      "list-sessions",
      "-F",
      "#{session_name}",
    ]);
    if (res.code !== 0) return [];
    return res.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .filter((name) => !prefix || name.startsWith(`${prefix}_`));
  }

  async sessionExists(sessionName: string): Promise<boolean> {
    const res = await this.control(sessionName, [
      "has-session",
      "-t",
      sessionName,
    ]);
    return res.code === 0;
  }

  async getSessionInfo(sessionName: string): Promise<TmuxSessionInfo> {
    const res = await this.control(sessionName, [
      "display-message",
      "-t",
      sessionName,
      "-p",
      "#{pane_current_path}\t#{window_width}\t#{window_height}\t#{pane_pid}\t#{pane_current_command}",
    ]);
    const [
      cwd = "/home/deploy",
      colsStr = "120",
      rowsStr = "30",
      panePidStr = "0",
      paneCurrentCommand = "",
    ] = res.stdout.trim().split("\t");
    return {
      cwd,
      cols: parseInt(colsStr, 10) || 120,
      rows: parseInt(rowsStr, 10) || 30,
      panePid: parseInt(panePidStr, 10) || 0,
      paneCurrentCommand,
    };
  }

  /**
   * fd-safe reconnect-spool read (design §3.5, Codex #5). The mapped user owns
   * (and can swap) the spool, so NEVER blindly follow `pipe.log`: open with
   * O_NOFOLLOW|O_NONBLOCK and fstat a regular file owned by the expected uid
   * with a single link. Any symlink / FIFO / hardlink / owner surprise ⇒ treat
   * as corrupt and skip (replay is best-effort, B1 §2.4).
   */
  async readPipeDelta(
    pipePath: string | null | undefined,
    currentOffset: number,
  ): Promise<TmuxPipeDelta> {
    if (!pipePath) return { chunk: "", offset: currentOffset };
    let fd: number | null = null;
    try {
      fd = openSync(
        pipePath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
      );
      const st = fstatSync(fd);
      if (!st.isFile() || st.uid !== this.exec.uid || st.nlink !== 1) {
        return { chunk: "", offset: currentOffset };
      }
      let offset = currentOffset;
      if (st.size < offset) offset = 0;
      if (st.size === offset) return { chunk: "", offset };

      // Bound the allocation: the mapped user controls pipe.log's size, so read
      // at most MAX_PIPE_DELTA_BYTES per call and advance the offset by what we
      // read (replay is best-effort; the next poll picks up the remainder).
      const length = Math.min(st.size - offset, MAX_PIPE_DELTA_BYTES);
      const buf = Buffer.allocUnsafe(length);
      const read = readSync(fd, buf, 0, length, offset);
      return {
        chunk: buf.subarray(0, read).toString("utf8"),
        offset: offset + read,
      };
    } catch {
      return { chunk: "", offset: currentOffset };
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // already closed
        }
      }
    }
  }

  private async hideStatusBar(sessionName: string): Promise<void> {
    await this.control(sessionName, [
      "set-option",
      "-t",
      sessionName,
      "status",
      "off",
    ]);
  }

  // See TmuxTerminalBackend.ensureHistoryLimit — same tmux default (2000
  // lines) vs. frontend scrollback (10000) mismatch applies to brokered
  // per-uid tmux servers too.
  private async ensureHistoryLimit(sessionName: string): Promise<void> {
    await this.control(sessionName, [
      "set-option",
      "-g",
      "history-limit",
      "10000",
    ]);
  }

  private async ensurePipeCapture(
    sessionName: string,
  ): Promise<{ pipePath: string; pipeOffset: number }> {
    const pipePath = this.pipePathFor(sessionName);
    // The broker owns the capture command (helper path + session id); we pass
    // only the fixed -o flag and the validated -t target.
    await this.control(sessionName, ["pipe-pane", "-o", "-t", sessionName]);
    // Offset starts at the current spool size (fd-safe stat via readPipeDelta
    // machinery: a 0-return offset just means "start from 0").
    const delta = await this.readPipeDelta(pipePath, 0);
    return { pipePath, pipeOffset: delta.offset };
  }
}

/**
 * Per-uid cache of brokered tmux backends (design §5). The execution-context
 * resolver returns a uid; this hands back the one backend instance for that uid
 * so attach/resize/capture/kill all route to the same per-user server, and a
 * disabled user's teardown can stop that user's whole server scope.
 */
export class BrokeredTmuxBackendCache {
  private readonly namespace: string;
  private readonly captureRoot: string;
  private readonly byUid = new Map<number, BrokeredTmuxBackend>();

  constructor(options: { namespace: string; captureRoot: string }) {
    this.namespace = options.namespace;
    this.captureRoot = options.captureRoot;
  }

  get(exec: BrokeredExecContext): BrokeredTmuxBackend {
    const existing = this.byUid.get(exec.uid);
    if (existing) {
      // A cached instance is reused ONLY when the full identity tuple still
      // matches (Codex S3b #2). If the mapping for this uid was deleted and the
      // uid re-issued to a different DeckTerm principal (gid/username changed),
      // the stale backend must never route the new principal's ops — build a
      // fresh one bound to the new identity and evict the old.
      if (
        existing.exec.gid === exec.gid &&
        existing.exec.osUsername === exec.osUsername
      ) {
        return existing;
      }
    }
    const backend = new BrokeredTmuxBackend({
      namespace: this.namespace,
      captureRoot: this.captureRoot,
      exec,
    });
    this.byUid.set(exec.uid, backend);
    return backend;
  }

  peek(uid: number): BrokeredTmuxBackend | undefined {
    return this.byUid.get(uid);
  }
}
