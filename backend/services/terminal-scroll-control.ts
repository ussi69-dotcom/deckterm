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
 * run through one ordered, bounded queue per terminal. Input typed on a
 * `scroll=1` (touch) socket while the pane may be in copy-mode gets a
 * confirmed exit queued in front of it (the server barrier), so tmux
 * copy-mode never eats keys. `scroll-position` frames go only to sockets that
 * asked for them with `scroll=1` in the socket URL: older pages print any
 * unknown JSON frame into the terminal as text.
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
// Upper bound for any cell coordinate or pane size used in a wheel report:
// a bogus client `resize` must never turn into a malformed report.
export const MAX_PANE_CELLS = 1000;
// Per-terminal queue bounds: a slow or wedged tmux must not let one writer
// pile up unbounded work or memory.
export const MAX_QUEUED_SCROLL_OPS = 128;
export const MAX_HELD_INPUT_BYTES = 256 * 1024;

// A "terminal reply" is input the browser terminal generates by itself, not
// user typing: CPR, DA (primary and secondary), DSR (0n / 3n), focus reports,
// OSC replies and DCS replies, or any concatenation made only of these.
const TERMINAL_REPLY_TOKEN = [
  "\\x1b\\[\\d+;\\d+R", // CPR
  "\\x1b\\[[?>][\\d;]*c", // DA / secondary DA reply
  "\\x1b\\[[03]n", // DSR
  "\\x1b\\[[IO]", // focus in / out
  "\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)", // OSC ... BEL | ST
  "\\x1bP[^\\x1b]*\\x1b\\\\", // DCS ... ST
].join("|");
const TERMINAL_REPLY_RE = new RegExp(`^(?:${TERMINAL_REPLY_TOKEN})+$`);

/** True when `data` consists only of terminal replies (never user typing). */
export function isTerminalReply(data: string): boolean {
  if (data.length === 0 || data.charCodeAt(0) !== 0x1b) return false;
  return TERMINAL_REPLY_RE.test(data);
}

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
        message[key] = Math.min(raw[key] as number, MAX_PANE_CELLS);
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
  const n = Math.trunc(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

/** A pane dimension we can trust: an integer in 1..MAX_PANE_CELLS. */
function paneDimension(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return clampInt(value, 1, MAX_PANE_CELLS);
}

/**
 * `count` SGR wheel reports (`ESC [ < 64|65 ; col ; row M`) at one cell.
 *
 * Always SGR, whatever mouse encoding the pane asked for: these bytes go to
 * the tmux client as outer-terminal input, tmux parses the report and
 * re-encodes it into the pane's own mode (SGR, UTF-8 or legacy, clamping
 * legacy coordinates itself; tmux-3.8 input-keys.c input_key_get_mouse). A
 * legacy report built here could not survive the trip: its coordinate bytes
 * above 0x7f would be UTF-8 encoded on the way into the PTY.
 */
export function encodeWheelReports(
  direction: "up" | "down",
  count: number,
  col: number,
  row: number,
): string {
  const button = direction === "up" ? 64 : 65;
  const x = clampInt(col, 1, MAX_PANE_CELLS);
  const y = clampInt(row, 1, MAX_PANE_CELLS);
  return `\x1b[<${button};${x};${y}M`.repeat(count);
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
    const cols = paneDimension(paneSize.cols, 80);
    const rows = paneDimension(state.rows, paneDimension(paneSize.rows, 24));
    const col = clampInt(message.col ?? Math.ceil(cols / 2), 1, cols);
    const row = clampInt(message.row ?? Math.ceil(rows / 2), 1, rows);
    return {
      kind: "wheel",
      bytes: encodeWheelReports(message.direction, count, col, row),
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

/**
 * The tmux side of one terminal. Every tmux call takes an AbortSignal: when
 * the controller's deadline passes it aborts, the backend kills the tmux
 * client process, and the call settles. The queue only moves on after that.
 */
export type ScrollControlTarget = {
  readState(signal: AbortSignal): Promise<TmuxScrollState | null>;
  scrollHistory(
    direction: "up" | "down",
    lines: number,
    signal: AbortSignal,
  ): Promise<boolean>;
  scrollToPosition(position: number, signal: AbortSignal): Promise<boolean>;
  /** `copy-mode -q`: leaves every mode, succeeds when there was none. */
  exitScroll(signal: AbortSignal): Promise<boolean>;
  /** `send -X cancel`: the second try when `copy-mode -q` did not leave. */
  cancelScroll(signal: AbortSignal): Promise<boolean>;
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
  /**
   * False for backends that cannot read or position the pane (brokered tmux,
   * raw): touch-scroll becomes the plain history scroll, scroll-to and
   * scroll-latest are ignored, no `scroll-position` frames and no input
   * barrier.
   */
  scrollControl?: boolean;
  stateCacheMs?: number;
  outputThrottleMs?: number;
  /** Deadline for one tmux call; past it the call is aborted (killed). */
  opTimeoutMs?: number;
  /** A confirmed exit that still finds copy-mode retries this often... */
  exitRetryMs?: number;
  /** ...for this long, then drops the input held behind it. */
  exitGiveUpMs?: number;
  maxQueuedOps?: number;
  maxHeldInputBytes?: number;
  now?: () => number;
  onError?: (err: unknown) => void;
  /** Operational notes (drops, degraded exits). Byte counts only, no data. */
  log?: (message: string) => void;
};

/** Where an input came from: `scroll` = the socket URL carried `scroll=1`. */
export type ScrollInputSource = { scroll?: boolean };

type ScrollOp =
  | { kind: "relative"; lines: number }
  | { kind: "touch"; lines: number; col?: number; row?: number }
  | { kind: "absolute"; position: number }
  | { kind: "input"; data: string; bytes: number };

const isExitOp = (op: ScrollOp | null | undefined): boolean =>
  op?.kind === "absolute" && op.position <= 0;

// Ops that may leave the pane in copy-mode once they ran (a touch op may
// route to wheel reports or keys instead, but cannot be known in advance).
const mayEnterCopyMode = (op: ScrollOp | null | undefined): boolean =>
  op?.kind === "relative" ||
  op?.kind === "touch" ||
  (op?.kind === "absolute" && op.position > 0);

/**
 * One per tmux-backed terminal. Owns the ordered scroll queue, the input
 * barrier in front of copy-mode, the short state cache for routing and the
 * `scroll-position` frames.
 */
export class TerminalScrollController {
  private readonly target: ScrollControlTarget;
  private readonly scrollControl: boolean;
  private readonly stateCacheMs: number;
  private readonly outputThrottleMs: number;
  private readonly opTimeoutMs: number;
  private readonly exitRetryMs: number;
  private readonly exitGiveUpMs: number;
  private readonly maxQueuedOps: number;
  private readonly maxHeldInputBytes: number;
  private readonly now: () => number;
  private readonly onError: (err: unknown) => void;
  private readonly log: (message: string) => void;

  private queue: ScrollOp[] = [];
  private inFlight: ScrollOp | null = null;
  private draining: Promise<void> | null = null;
  private heldBytes = 0;
  private cache: { state: TmuxScrollState | null; at: number } | null = null;
  private lastInMode = false;
  // Server barrier: true from the moment a history scroll or scroll-to ran
  // (or a read saw copy-mode) until a confirmed exit or a read that saw the
  // pane out of it. `modeEpoch` changes whenever an op may have changed the
  // mode, so a read that started before is not allowed to overwrite it.
  private mayBeInCopyMode = false;
  private modeEpoch = 0;
  private seq = 0;
  private emitChain: Promise<void> = Promise.resolve();
  private broadcastQueued = false;
  private outputTimer: ReturnType<typeof setTimeout> | null = null;
  private droppedScrollOps = 0;
  private droppedInputBytes = 0;

  constructor(
    target: ScrollControlTarget,
    options: ScrollControllerOptions = {},
  ) {
    this.target = target;
    this.scrollControl = options.scrollControl ?? true;
    this.stateCacheMs = options.stateCacheMs ?? 250;
    this.outputThrottleMs = options.outputThrottleMs ?? 300;
    this.opTimeoutMs = options.opTimeoutMs ?? 3_000;
    this.exitRetryMs = options.exitRetryMs ?? 200;
    this.exitGiveUpMs = options.exitGiveUpMs ?? 2_000;
    this.maxQueuedOps = options.maxQueuedOps ?? MAX_QUEUED_SCROLL_OPS;
    this.maxHeldInputBytes = options.maxHeldInputBytes ?? MAX_HELD_INPUT_BYTES;
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => {});
    this.log = options.log ?? (() => {});
  }

  /** True while the pane may be in copy-mode (the server barrier flag). */
  get mayBeScrolledBack(): boolean {
    return this.mayBeInCopyMode;
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
    const same = this.trailingScroll("relative");
    if (same) {
      same.lines = clampInt(same.lines + signed, -100, 100);
      if (same.lines === 0) this.removeOp(same);
    } else if (this.roomForScrollOp()) {
      this.queue.push({ kind: "relative", lines: signed });
    }
    return this.drain();
  }

  touchScroll(message: TouchScrollMessage): Promise<void> {
    // Without scroll control the backend cannot read the pane: a drag is the
    // plain history scroll that backend already does.
    if (!this.scrollControl) {
      return this.scrollRelative(message.direction, message.lines);
    }
    const count = clampInt(message.lines, 1, TOUCH_SCROLL_MAX_LINES);
    const signed = message.direction === "up" ? count : -count;
    const same = this.trailingScroll("touch");
    if (same) {
      same.lines = clampInt(
        same.lines + signed,
        -TOUCH_SCROLL_MAX_LINES,
        TOUCH_SCROLL_MAX_LINES,
      );
      same.col = message.col;
      same.row = message.row;
      if (same.lines === 0) this.removeOp(same);
    } else if (this.roomForScrollOp()) {
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
   * input; 0 (or less) is a confirmed exit that holds later input until it
   * ran. An exit right behind another queued exit (only input between) adds
   * nothing and is not queued again.
   */
  scrollTo(position: number): Promise<void> {
    if (!this.scrollControl) return Promise.resolve();
    const target = Math.max(0, Math.trunc(position) || 0);
    while (this.queue.length > 0) {
      const tail = this.queue[this.queue.length - 1]!;
      if (tail.kind === "input") break;
      this.queue.pop();
    }
    if (target <= 0 && isExitOp(this.lastScrollOp())) return this.drain();
    if (this.roomForScrollOp()) {
      this.queue.push({ kind: "absolute", position: target });
    }
    return this.drain();
  }

  /**
   * Input from any socket.
   *
   * - From a `scroll=1` (touch) socket, real typing that may meet copy-mode
   *   gets a confirmed exit queued in front of it, so tmux never eats keys.
   *   Terminal replies (CPR, DA, focus reports...) never leave scrollback.
   * - Everything else is written at once unless an exit is already pending
   *   or input is already waiting behind one; then it waits in order, so
   *   keys are never reordered.
   */
  input(data: string, source: ScrollInputSource = {}): void {
    const barrier =
      this.scrollControl &&
      source.scroll === true &&
      !isTerminalReply(data) &&
      this.projectedMayBeInCopyMode();
    if (!barrier && !this.exitPending() && !this.hasQueuedInput()) {
      this.target.writeInput(data);
      return;
    }
    // Not counted against the op bound: an exit is only queued here after
    // an op that may enter copy-mode, and those are bounded.
    if (barrier) this.queue.push({ kind: "absolute", position: 0 });
    this.holdInput(data);
    void this.drain();
  }

  /** Live pane output: refresh the indicator while scrolled back. */
  onOutput(): void {
    if (!this.scrollControl) return;
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
    if (!this.scrollControl || !this.lastInMode) return Promise.resolve();
    return this.emit();
  }

  /**
   * Sends the current position to every subscriber, or only to `sink` (the
   * socket finishing a reconnect, just before its `ready`). Reads are
   * serialized so `seq` and the reported state never go backwards.
   */
  emit(sink?: ScrollFrameSink): Promise<void> {
    if (!this.scrollControl) return Promise.resolve();
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

  // --- queue bookkeeping -----------------------------------------------------

  private exitPending(): boolean {
    return isExitOp(this.inFlight) || this.queue.some(isExitOp);
  }

  private hasQueuedInput(): boolean {
    return this.queue.some((op) => op.kind === "input");
  }

  /** The pane may be in copy-mode once everything queued so far has run. */
  private projectedMayBeInCopyMode(): boolean {
    let may = this.mayBeInCopyMode;
    for (const op of this.inFlight ? [this.inFlight, ...this.queue] : this.queue) {
      if (mayEnterCopyMode(op)) may = true;
      else if (isExitOp(op)) may = false;
    }
    return may;
  }

  /** The last scroll op queued, or the one running when none is queued. */
  private lastScrollOp(): ScrollOp | null {
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      if (this.queue[i]!.kind !== "input") return this.queue[i]!;
    }
    return this.inFlight;
  }

  /**
   * The op of `kind` in the trailing run of relative/touch scrolls, so
   * alternating wheel/PgUp (`scrollback`) and touch drags still coalesce:
   * the run never grows beyond one op of each kind.
   */
  private trailingScroll<K extends "relative" | "touch">(
    kind: K,
  ): Extract<ScrollOp, { kind: K }> | undefined {
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      const op = this.queue[i]!;
      if (op.kind !== "relative" && op.kind !== "touch") return undefined;
      if (op.kind === kind) return op as Extract<ScrollOp, { kind: K }>;
    }
    return undefined;
  }

  private removeOp(op: ScrollOp): void {
    const index = this.queue.indexOf(op);
    if (index >= 0) this.queue.splice(index, 1);
  }

  private roomForScrollOp(): boolean {
    if (this.queue.length < this.maxQueuedOps) return true;
    if (this.droppedScrollOps === 0) {
      this.log(
        `scroll queue full (${this.maxQueuedOps} ops): dropping further scroll requests`,
      );
    }
    this.droppedScrollOps += 1;
    return false;
  }

  private holdInput(data: string): void {
    const bytes = Buffer.byteLength(data, "utf8");
    if (this.heldBytes + bytes > this.maxHeldInputBytes) {
      if (this.droppedInputBytes === 0) {
        this.log(
          `held input over ${this.maxHeldInputBytes} bytes: dropping ${bytes} bytes of input (${this.heldBytes} bytes held)`,
        );
      }
      this.droppedInputBytes += bytes;
      return;
    }
    this.heldBytes += bytes;
    const tail = this.queue[this.queue.length - 1];
    if (tail?.kind === "input") {
      tail.data += data;
      tail.bytes += bytes;
    } else {
      this.queue.push({ kind: "input", data, bytes });
    }
  }

  /** Ends a burst: one summary line for whatever was dropped during it. */
  private endBurst(): void {
    if (this.droppedScrollOps > 0) {
      this.log(
        `scroll queue drained; ${this.droppedScrollOps} scroll requests were dropped`,
      );
    }
    if (this.droppedInputBytes > 0) {
      this.log(
        `scroll queue drained; ${this.droppedInputBytes} bytes of input were dropped`,
      );
    }
    this.droppedScrollOps = 0;
    this.droppedInputBytes = 0;
  }

  private drain(): Promise<void> {
    if (this.draining) return this.draining;
    const run = (async () => {
      let scrolled = false;
      try {
        while (this.queue.length > 0) {
          if (!this.target.isActive()) {
            this.queue = [];
            this.heldBytes = 0;
            break;
          }
          const op = this.queue.shift()!;
          if (op.kind === "input") {
            this.heldBytes -= op.bytes;
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
        this.endBurst();
      }
      if (scrolled) await this.emit();
    })();
    this.draining = run;
    return run;
  }

  // --- running ops -------------------------------------------------------------

  private markMayEnterCopyMode(): void {
    this.mayBeInCopyMode = true;
    this.modeEpoch += 1;
  }

  /** Runs one scroll op; true when it went to tmux copy-mode. */
  private async runScrollOp(
    op: Exclude<ScrollOp, { kind: "input" }>,
  ): Promise<boolean> {
    switch (op.kind) {
      case "relative":
        this.markMayEnterCopyMode();
        await this.call(
          (signal) =>
            this.target.scrollHistory(
              op.lines > 0 ? "up" : "down",
              Math.abs(op.lines),
              signal,
            ),
          false,
          true,
        );
        return true;
      case "absolute":
        if (op.position <= 0) {
          await this.confirmedExit();
          return true;
        }
        this.markMayEnterCopyMode();
        await this.call(
          (signal) => this.target.scrollToPosition(op.position, signal),
          false,
          true,
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
          this.markMayEnterCopyMode();
          await this.call(
            (signal) =>
              this.target.scrollHistory(direction, Math.abs(op.lines), signal),
            false,
            true,
          );
          return true;
        }
        this.target.writeInput(route.bytes);
        return false;
      }
    }
  }

  /**
   * "Back to latest", confirmed: `copy-mode -q`, then an uncached read; if
   * the pane is still in copy-mode, `send -X cancel` and read again; still
   * in a mode, retry every `exitRetryMs` for up to `exitGiveUpMs`, then drop
   * the input held behind this exit (it would be eaten by copy-mode) and
   * tell the scroll=1 sockets where the pane really is. A state that cannot
   * be read at all lets the input through, as before M0.
   */
  private async confirmedExit(): Promise<void> {
    this.modeEpoch += 1;
    const retries = Math.max(
      0,
      Math.floor(this.exitGiveUpMs / Math.max(1, this.exitRetryMs)),
    );
    for (let attempt = 0; ; attempt += 1) {
      await this.call((signal) => this.target.exitScroll(signal), false, true);
      let state = await this.readFresh();
      if (state && state.inMode) {
        await this.call(
          (signal) => this.target.cancelScroll(signal),
          false,
          true,
        );
        state = await this.readFresh();
      }
      if (!state) {
        this.log(
          `pane state unreadable after leaving scrollback: writing ${this.heldInputAfterHead()} held input bytes unconfirmed`,
        );
        return;
      }
      if (!state.inMode) return;
      if (attempt >= retries || !this.target.isActive()) break;
      await new Promise((resolve) => setTimeout(resolve, this.exitRetryMs));
    }
    const dropped = this.dropHeldInputAtHead();
    this.log(
      `pane stayed in copy-mode after leaving scrollback: dropped ${dropped} held input bytes`,
    );
    void this.emit();
  }

  /** Bytes of the input waiting right behind the op that is running now. */
  private heldInputAfterHead(): number {
    const head = this.queue[0];
    return head?.kind === "input" ? head.bytes : 0;
  }

  private dropHeldInputAtHead(): number {
    let dropped = 0;
    while (this.queue[0]?.kind === "input") {
      const op = this.queue.shift() as Extract<ScrollOp, { kind: "input" }>;
      dropped += op.bytes;
      this.heldBytes -= op.bytes;
    }
    return dropped;
  }

  private async cachedState(): Promise<TmuxScrollState | null> {
    if (this.cache && this.now() - this.cache.at <= this.stateCacheMs) {
      return this.cache.state;
    }
    return this.readFresh();
  }

  private async readFresh(): Promise<TmuxScrollState | null> {
    const epoch = this.modeEpoch;
    const state = await this.call(
      (signal) => this.target.readState(signal),
      null,
      false,
    );
    this.cache = { state, at: this.now() };
    if (state) {
      this.lastInMode = state.inMode;
      // A read that raced an op which may have changed the mode says
      // nothing about the mode now.
      if (epoch === this.modeEpoch) this.mayBeInCopyMode = state.inMode;
    }
    return state;
  }

  /**
   * Runs one tmux call with a deadline. At the deadline the call is aborted
   * (the backend kills its tmux client) and this waits until it really
   * settled, so a late command can never run after the next queued op.
   * A mutating call that timed out may still have reached tmux: the barrier
   * then assumes copy-mode until a read says otherwise.
   */
  private async call<T>(
    run: (signal: AbortSignal) => Promise<T>,
    fallback: T,
    mutating: boolean,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opTimeoutMs);
    (timer as any)?.unref?.();
    try {
      const result = await run(controller.signal);
      return controller.signal.aborted ? fallback : result;
    } catch (err) {
      this.onError(err);
      return fallback;
    } finally {
      clearTimeout(timer);
      if (controller.signal.aborted && mutating) this.markMayEnterCopyMode();
    }
  }
}
