import type { TmuxScrollState } from "./tmux-scroll-state";

/**
 * Server-side scroll control for tmux-backed terminals (slice M0).
 *
 * On touch layouts the browser cannot trust its own xterm buffer or
 * mouse-mode state (both can be stale after a reload), so it sends the raw
 * gesture and the server routes it from tmux's live pane state:
 * - an app with mouse reporting gets wheel reports, exactly as a browser
 *   wheel would arrive through the tmux client;
 * - an alternate-screen app without mouse reporting (less, man) gets arrow
 *   keys ("AlternateScroll");
 * - everything else scrolls tmux copy-mode history.
 *
 * Scroll operations, and input that must wait for a pending "back to latest",
 * run through one ordered queue per terminal. `scroll-position` frames go only
 * to sockets that asked for them with `scroll=1` in the socket URL: older
 * pages print any unknown JSON frame into the terminal as text.
 */

export type TouchScrollMessage = {
  type: "touch-scroll";
  direction: "up" | "down";
  lines: number;
  col?: number;
  row?: number;
};
export type ScrollToMessage = { type: "scroll-to"; position: number };
export type ScrollLatestMessage = { type: "scroll-latest" };
export type ScrollControlMessage =
  TouchScrollMessage | ScrollToMessage | ScrollLatestMessage;

const SCROLL_CONTROL_TYPES = new Set([
  "touch-scroll",
  "scroll-to",
  "scroll-latest",
]);

// Read-only sockets may only keep the connection alive and finish a
// reconnect. Every scroll message (old `scrollback` and the new types) moves
// the shared pane or writes to it, so it stays write-only.
const READ_ONLY_MESSAGE_TYPES = new Set(["ping", "resume-ready"]);

export const TOUCH_SCROLL_MAX_LINES = 100;
// Wheel reports and arrow keys per touch-scroll message: a fast fling must
// not flood an app with hundreds of keys.
export const TOUCH_SCROLL_MAX_KEYS = 10;
// Legacy (X10) mouse encoding carries a coordinate as one byte: 32 + n.
const LEGACY_MOUSE_MAX_COORD = 223;

export function isReadOnlyAllowedMessageType(type: unknown): boolean {
  return typeof type === "string" && READ_ONLY_MESSAGE_TYPES.has(type);
}

export function isScrollControlMessageType(type: unknown): boolean {
  return typeof type === "string" && SCROLL_CONTROL_TYPES.has(type);
}

/** The socket URL flag that opts a socket in to `scroll-position` frames. */
export function socketWantsScrollFrames(url: URL): boolean {
  return url.searchParams.get("scroll") === "1";
}

/**
 * The sockets that get `scroll-position` broadcasts: open, opted in with
 * `scroll=1`, and not in the middle of a reconnect replay (those get one
 * frame of their own just before `ready`).
 */
export function selectScrollSubscribers<
  T extends { readyState: number; data: { scroll?: boolean } },
>(sockets: Iterable<T>, isReconnecting: (socket: T) => boolean): T[] {
  const selected: T[] = [];
  for (const socket of sockets) {
    if (socket.readyState !== 1 || socket.data.scroll !== true) continue;
    if (isReconnecting(socket)) continue;
    selected.push(socket);
  }
  return selected;
}

function isIntInRange(value: unknown, min: number, max: number): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

/**
 * Validates one parsed client frame of a scroll-control type. Returns a clean
 * message (extra fields dropped) or null for anything out of contract.
 */
export function parseScrollControlMessage(
  parsed: unknown,
): ScrollControlMessage | null {
  if (!parsed || typeof parsed !== "object") return null;
  const raw = parsed as Record<string, unknown>;
  switch (raw.type) {
    case "touch-scroll": {
      if (raw.direction !== "up" && raw.direction !== "down") return null;
      if (!isIntInRange(raw.lines, 1, TOUCH_SCROLL_MAX_LINES)) return null;
      const message: TouchScrollMessage = {
        type: "touch-scroll",
        direction: raw.direction,
        lines: raw.lines as number,
      };
      for (const key of ["col", "row"] as const) {
        if (raw[key] === undefined) continue;
        if (!isIntInRange(raw[key], 1, Number.MAX_SAFE_INTEGER)) return null;
        message[key] = raw[key] as number;
      }
      return message;
    }
    case "scroll-to":
      if (!isIntInRange(raw.position, 0, Number.MAX_SAFE_INTEGER)) return null;
      return { type: "scroll-to", position: raw.position as number };
    case "scroll-latest":
      return { type: "scroll-latest" };
    default:
      return null;
  }
}

export type TouchScrollRoute =
  | { kind: "wheel"; bytes: string }
  | { kind: "arrows"; bytes: string }
  | { kind: "history" };

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

/** `count` wheel reports at one cell, in the encoding the pane asked for. */
export function encodeWheelReports(
  direction: "up" | "down",
  count: number,
  col: number,
  row: number,
  sgr: boolean,
): string {
  const button = direction === "up" ? 64 : 65;
  let report: string;
  if (sgr) {
    report = `\x1b[<${button};${col};${row}M`;
  } else {
    const x = clampInt(col, 1, LEGACY_MOUSE_MAX_COORD);
    const y = clampInt(row, 1, LEGACY_MOUSE_MAX_COORD);
    report = `\x1b[M${String.fromCharCode(32 + button)}${String.fromCharCode(32 + x)}${String.fromCharCode(32 + y)}`;
  }
  return report.repeat(count);
}

/** `count` cursor-up/down keys in normal (ESC [) or application (ESC O) mode. */
export function encodeArrowKeys(
  direction: "up" | "down",
  count: number,
  appCursor: boolean,
): string {
  const key = `\x1b${appCursor ? "O" : "["}${direction === "up" ? "A" : "B"}`;
  return key.repeat(count);
}

/**
 * The routing table for one touch-scroll message. `direction` is the content
 * direction: "up" shows older output (the finger moved down).
 *
 * A pane already in copy-mode keeps scrolling copy-mode history whatever its
 * app asked for: wheel reports or keys would land in tmux's copy-mode, not in
 * the app. A null state (unreadable) also takes the history path, which
 * refuses the alternate screen on its own.
 */
export function routeTouchScroll(
  state: TmuxScrollState | null,
  message: Pick<TouchScrollMessage, "direction" | "lines" | "col" | "row">,
  paneSize: { cols: number; rows: number } = { cols: 80, rows: 24 },
): TouchScrollRoute {
  if (!state || state.inMode) return { kind: "history" };
  const count = clampInt(message.lines, 1, TOUCH_SCROLL_MAX_KEYS);
  if (state.mouseApp) {
    const cols = Math.max(1, Math.trunc(paneSize.cols) || 1);
    const rows = Math.max(1, Math.trunc(state.rows || paneSize.rows) || 1);
    const col = clampInt(message.col ?? Math.ceil(cols / 2), 1, cols);
    const row = clampInt(message.row ?? Math.ceil(rows / 2), 1, rows);
    return {
      kind: "wheel",
      bytes: encodeWheelReports(
        message.direction,
        count,
        col,
        row,
        state.mouseSgr,
      ),
    };
  }
  if (state.altScreen) {
    return {
      kind: "arrows",
      bytes: encodeArrowKeys(message.direction, count, state.appCursor),
    };
  }
  return { kind: "history" };
}

export type ScrollPositionFrame = {
  type: "scroll-position";
  seq: number;
  inMode: boolean;
  position: number;
  total: number;
  rows: number;
  altScreen: boolean;
  mouseApp: boolean;
};

export type ScrollFrameSink = { send(frame: string): unknown };

export type ScrollControlTarget = {
  readState(): Promise<TmuxScrollState | null>;
  scrollHistory(direction: "up" | "down", lines: number): Promise<boolean>;
  scrollToPosition(position: number): Promise<boolean>;
  exitScroll(): Promise<boolean>;
  /** Writes to the tmux client PTY, exactly like browser input. */
  writeInput(data: string): void;
  /** The attached client's size, for the default wheel-report cell. */
  paneSize(): { cols: number; rows: number };
  /** Open sockets of this terminal that sent `scroll=1`, not mid-reconnect. */
  subscribers(): Iterable<ScrollFrameSink>;
  /** False once the terminal was closed or replaced by a re-attach. */
  isActive(): boolean;
};

export type ScrollControllerOptions = {
  stateCacheMs?: number;
  outputThrottleMs?: number;
  /** Bound on one tmux call, so a wedged server never strands input. */
  opTimeoutMs?: number;
  now?: () => number;
  onError?: (err: unknown) => void;
};

type ScrollOp =
  | { kind: "relative"; lines: number }
  | { kind: "touch"; lines: number; col?: number; row?: number }
  | { kind: "absolute"; position: number }
  | { kind: "input"; data: string };

/**
 * One per tmux-backed terminal. Owns the ordered scroll queue, the input gate
 * behind a pending exit, the short state cache for routing and the
 * `scroll-position` frames.
 */
export class TerminalScrollController {
  private readonly target: ScrollControlTarget;
  private readonly stateCacheMs: number;
  private readonly outputThrottleMs: number;
  private readonly opTimeoutMs: number;
  private readonly now: () => number;
  private readonly onError: (err: unknown) => void;

  private queue: ScrollOp[] = [];
  private inFlight: ScrollOp | null = null;
  private draining: Promise<void> | null = null;
  private cache: { state: TmuxScrollState | null; at: number } | null = null;
  private lastInMode = false;
  private seq = 0;
  private emitChain: Promise<void> = Promise.resolve();
  private broadcastQueued = false;
  private outputTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    target: ScrollControlTarget,
    options: ScrollControllerOptions = {},
  ) {
    this.target = target;
    this.stateCacheMs = options.stateCacheMs ?? 250;
    this.outputThrottleMs = options.outputThrottleMs ?? 300;
    this.opTimeoutMs = options.opTimeoutMs ?? 3_000;
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => {});
  }

  handle(message: ScrollControlMessage): Promise<void> {
    switch (message.type) {
      case "touch-scroll":
        return this.touchScroll(message);
      case "scroll-to":
        return this.scrollTo(message.position);
      case "scroll-latest":
        return this.scrollTo(0);
    }
  }

  /** The `scrollback` path: always tmux history, coalesced to ±100. */
  scrollRelative(direction: "up" | "down", lines: number): Promise<void> {
    const count = clampInt(lines, 1, 100);
    const signed = direction === "up" ? count : -count;
    const tail = this.queue[this.queue.length - 1];
    if (tail?.kind === "relative") {
      tail.lines = clampInt(tail.lines + signed, -100, 100);
      if (tail.lines === 0) this.queue.pop();
    } else {
      this.queue.push({ kind: "relative", lines: signed });
    }
    return this.drain();
  }

  touchScroll(message: TouchScrollMessage): Promise<void> {
    const count = clampInt(message.lines, 1, TOUCH_SCROLL_MAX_LINES);
    const signed = message.direction === "up" ? count : -count;
    const tail = this.queue[this.queue.length - 1];
    if (tail?.kind === "touch") {
      tail.lines = clampInt(
        tail.lines + signed,
        -TOUCH_SCROLL_MAX_LINES,
        TOUCH_SCROLL_MAX_LINES,
      );
      tail.col = message.col;
      tail.row = message.row;
      if (tail.lines === 0) this.queue.pop();
    } else {
      this.queue.push({
        kind: "touch",
        lines: signed,
        col: message.col,
        row: message.row,
      });
    }
    return this.drain();
  }

  /**
   * An absolute target replaces the scrolls queued after the last queued
   * input; 0 (or less) leaves copy-mode and holds later input until it ran.
   */
  scrollTo(position: number): Promise<void> {
    const target = Math.max(0, Math.trunc(position) || 0);
    while (this.queue.length > 0) {
      const tail = this.queue[this.queue.length - 1];
      if (tail.kind === "input") break;
      this.queue.pop();
    }
    this.queue.push({ kind: "absolute", position: target });
    return this.drain();
  }

  /**
   * Input from any socket. Written at once unless a "back to latest" is
   * pending (or input is already waiting behind one): then it waits in order,
   * so keys are never eaten by copy-mode nor reordered.
   */
  input(data: string): void {
    if (!this.exitPending() && !this.queue.some((op) => op.kind === "input")) {
      this.target.writeInput(data);
      return;
    }
    this.queue.push({ kind: "input", data });
    void this.drain();
  }

  /** Live pane output: refresh the indicator while scrolled back. */
  onOutput(): void {
    if (!this.lastInMode || this.outputTimer) return;
    // Nobody shows an indicator (e.g. the phone went away): no tmux reads.
    if (Array.from(this.target.subscribers()).length === 0) return;
    this.outputTimer = setTimeout(() => {
      this.outputTimer = null;
      if (!this.target.isActive()) return;
      void this.emit();
    }, this.outputThrottleMs);
    (this.outputTimer as any)?.unref?.();
  }

  /** A finished resize moves the copy-mode position. */
  onResize(): Promise<void> {
    if (!this.lastInMode) return Promise.resolve();
    return this.emit();
  }

  /**
   * Sends the current position to every subscriber, or only to `sink` (the
   * socket finishing a reconnect, just before its `ready`). Reads are
   * serialized so `seq` and the reported state never go backwards.
   */
  emit(sink?: ScrollFrameSink): Promise<void> {
    if (!sink) {
      if (this.broadcastQueued) return this.emitChain;
      this.broadcastQueued = true;
    }
    this.emitChain = this.emitChain.then(async () => {
      if (!sink) this.broadcastQueued = false;
      const sinks = sink ? [sink] : Array.from(this.target.subscribers());
      if (sinks.length === 0 || !this.target.isActive()) return;
      const state = await this.readFresh();
      if (!state) return;
      const frame: ScrollPositionFrame = {
        type: "scroll-position",
        seq: ++this.seq,
        inMode: state.inMode,
        position: state.position,
        total: state.total,
        rows: state.rows,
        altScreen: state.altScreen,
        mouseApp: state.mouseApp,
      };
      const payload = JSON.stringify(frame);
      for (const target of sinks) {
        try {
          target.send(payload);
        } catch {
          // Socket closed meanwhile.
        }
      }
    });
    this.emitChain = this.emitChain.catch((err) => this.onError(err));
    return this.emitChain;
  }

  private exitPending(): boolean {
    const isExit = (op: ScrollOp | null) =>
      op?.kind === "absolute" && op.position <= 0;
    return isExit(this.inFlight) || this.queue.some(isExit);
  }

  private drain(): Promise<void> {
    if (this.draining) return this.draining;
    const run = (async () => {
      let scrolled = false;
      try {
        while (this.queue.length > 0) {
          if (!this.target.isActive()) {
            this.queue = [];
            break;
          }
          const op = this.queue.shift()!;
          if (op.kind === "input") {
            this.target.writeInput(op.data);
            continue;
          }
          this.inFlight = op;
          try {
            if (await this.runScrollOp(op)) {
              // Copy-mode moved: the cached state is stale now.
              this.cache = null;
              scrolled = true;
            }
          } catch (err) {
            this.cache = null;
            this.onError(err);
          } finally {
            this.inFlight = null;
          }
        }
      } finally {
        this.draining = null;
      }
      if (scrolled) await this.emit();
    })();
    this.draining = run;
    return run;
  }

  /** Runs one scroll op; true when it went to tmux copy-mode. */
  private async runScrollOp(
    op: Exclude<ScrollOp, { kind: "input" }>,
  ): Promise<boolean> {
    switch (op.kind) {
      case "relative":
        await this.bounded(
          this.target.scrollHistory(
            op.lines > 0 ? "up" : "down",
            Math.abs(op.lines),
          ),
        );
        return true;
      case "absolute":
        await this.bounded(
          op.position <= 0
            ? this.target.exitScroll()
            : this.target.scrollToPosition(op.position),
        );
        return true;
      case "touch": {
        const state = await this.cachedState();
        const direction = op.lines > 0 ? "up" : "down";
        const route = routeTouchScroll(
          state,
          { direction, lines: Math.abs(op.lines), col: op.col, row: op.row },
          this.target.paneSize(),
        );
        if (route.kind === "history") {
          await this.bounded(
            this.target.scrollHistory(direction, Math.abs(op.lines)),
          );
          return true;
        }
        this.target.writeInput(route.bytes);
        return false;
      }
    }
  }

  private async cachedState(): Promise<TmuxScrollState | null> {
    if (this.cache && this.now() - this.cache.at <= this.stateCacheMs) {
      return this.cache.state;
    }
    return this.readFresh();
  }

  private async readFresh(): Promise<TmuxScrollState | null> {
    const state = await this.bounded(this.target.readState(), null);
    this.cache = { state, at: this.now() };
    if (state) this.lastInMode = state.inMode;
    return state;
  }

  private async bounded<T>(promise: Promise<T>, fallback?: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback as T), this.opTimeoutMs);
      (timer as any)?.unref?.();
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
