/**
 * Pure domain logic + rendering for task messages (D0 primitives layer).
 *
 * No HTTP, no terminal writes, no task-runner imports — this module only
 * knows how to sanitize/fold/render task-message data. All file IO goes
 * through the fd-safe primitives in `task-file-io.ts`.
 */
import { join } from "node:path";
import { appendTaskFileSafe, readTaskFileSafe } from "./task-file-io";

export type TaskMessageFrom = "user" | "judge" | "system";

const TASK_MESSAGE_FROM_VALUES: readonly TaskMessageFrom[] = [
  "user",
  "judge",
  "system",
];

function isTaskMessageFrom(value: unknown): value is TaskMessageFrom {
  return (
    typeof value === "string" &&
    (TASK_MESSAGE_FROM_VALUES as readonly string[]).includes(value)
  );
}

export interface TaskMessageEvent {
  type: "message-created" | "message-delivered" | "message-delivery-failed";
  id: string;
  at: string;
  from?: TaskMessageFrom;
  to?: string;
  body?: string;
  terminalId?: string;
  reason?: string;
}

export interface TaskMessage {
  id: string;
  from: TaskMessageFrom;
  to: string;
  body: string;
  createdAt: string;
  delivery: "pending" | "delivered" | "failed";
  deliveredAt?: string;
  failureReason?: string;
}

// Canonical task-message file locations (single source for S6/S7 callers).
export function taskMessagesPath(taskDir: string): string {
  return join(taskDir, "messages.jsonl");
}

export function taskInboxDir(taskDir: string): string {
  return join(taskDir, "inbox");
}

export function workerPromptPath(taskDir: string): string {
  return join(taskDir, "WORKER_PROMPT.md");
}

const MAX_MESSAGE_BODY_BYTES = 8 * 1024;
const DEFAULT_MESSAGES_MAX_BYTES = 1024 * 1024; // 1 MiB
const MAX_VERDICT_BYTES = 64 * 1024;
const MAX_FEEDBACK_BYTES = 16 * 1024;

// Mirrors the control-sequence stripping style in telemetry.ts.
const OSC_SEQUENCE_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI_SEQUENCE_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const C1_ESCAPE_SEQUENCE_RE = /\x1b[@-_]/g;
const ANY_ESC_RE = /\x1b/g;
// C0 controls except \n (\x0a) and \t (\x09); also strips \r (\x0d).
const C0_CONTROL_RE = /[\x00-\x08\x0b-\x1f]/g;
const C1_RANGE_RE = /[\u0080-\u009f]/g;
const DEL_RE = /\x7f/g;

/**
 * Truncate a UTF-8 string to at most `maxBytes` bytes without splitting a
 * multi-byte character.
 */
function truncateToByteLimit(input: string, maxBytes: number): string {
  if (Buffer.byteLength(input, "utf8") <= maxBytes) {
    return input;
  }
  const buf = Buffer.from(input, "utf8");
  let end = maxBytes;
  // Back off while we're in the middle of a multi-byte UTF-8 sequence.
  // Continuation bytes have the pattern 10xxxxxx (0x80-0xBF).
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return buf.subarray(0, end).toString("utf8");
}

/**
 * Sanitize a task-message body: strip ESC sequences, C0 controls (keeping
 * \n and \t, stripping \r), C1 range chars, and DEL, then cap at 8 KiB
 * (UTF-8 byte-safe truncation). This is the ONLY sanitization step; the
 * result is the canonical stored form.
 */
export function sanitizeMessageBody(raw: string): string {
  const stripped = raw
    .replace(OSC_SEQUENCE_RE, "")
    .replace(CSI_SEQUENCE_RE, "")
    .replace(C1_ESCAPE_SEQUENCE_RE, "")
    .replace(ANY_ESC_RE, "")
    .replace(C0_CONTROL_RE, "")
    .replace(DEL_RE, "")
    .replace(C1_RANGE_RE, "");
  return truncateToByteLimit(stripped, MAX_MESSAGE_BODY_BYTES);
}

/**
 * Append a single task-message event as one JSON line via the fd-safe
 * append primitive.
 */
export function appendTaskMessageEvent(
  messagesFile: string,
  event: TaskMessageEvent,
): boolean {
  return appendTaskFileSafe(messagesFile, `${JSON.stringify(event)}\n`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEventLine(line: string): TaskMessageEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const { type, id, at } = parsed;
  if (
    type !== "message-created" &&
    type !== "message-delivered" &&
    type !== "message-delivery-failed"
  ) {
    return null;
  }
  if (typeof id !== "string" || !id) return null;
  if (typeof at !== "string" || !at) return null;
  return parsed as unknown as TaskMessageEvent;
}

/**
 * Read a task-messages file and fold its event log into current-state
 * messages. Malformed lines and events referencing unknown ids are skipped
 * silently. File order is preserved; a `message-created` event for an id
 * that previously failed resets it to pending (last created event wins).
 */
export function readTaskMessages(
  messagesFile: string,
  opts?: { maxBytes?: number },
): TaskMessage[] {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MESSAGES_MAX_BYTES;
  const raw = readTaskFileSafe(messagesFile, { maxBytes });
  if (raw === null) return [];

  const order: string[] = [];
  const byId = new Map<string, TaskMessage>();

  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseEventLine(line);
    if (!event) continue;

    if (event.type === "message-created") {
      if (!isTaskMessageFrom(event.from)) continue;
      if (typeof event.to !== "string" || !event.to) continue;
      if (typeof event.body !== "string") continue;
      const message: TaskMessage = {
        id: event.id,
        from: event.from,
        to: event.to,
        body: event.body,
        createdAt: event.at,
        delivery: "pending",
      };
      if (!byId.has(event.id)) {
        order.push(event.id);
      }
      byId.set(event.id, message);
      continue;
    }

    const existing = byId.get(event.id);
    if (!existing) continue; // unknown id — skip silently

    if (event.type === "message-delivered") {
      existing.delivery = "delivered";
      existing.deliveredAt = event.at;
      continue;
    }

    if (event.type === "message-delivery-failed") {
      existing.delivery = "failed";
      if (typeof event.reason === "string") {
        existing.failureReason = event.reason;
      }
      continue;
    }
  }

  return order.map((id) => byId.get(id)!).filter(Boolean);
}

/**
 * Render a message as a deterministic inbox markdown file. Body is assumed
 * already sanitized — this function does not re-sanitize.
 */
export function renderInboxFile(msg: {
  id: string;
  from: TaskMessageFrom;
  body: string;
  at: string;
}): string {
  return [`# Message from ${msg.from} — ${msg.at}`, "", msg.body, ""].join(
    "\n",
  );
}

/**
 * Build the single-line pointer written to a PTY to notify an agent of a
 * new inbox message. This is the ONLY thing ever written to a PTY by the
 * message feature — message bodies are never interpolated here.
 */
export function buildPointerLine(
  from: TaskMessageFrom,
  inboxPath: string,
): string {
  if (!isTaskMessageFrom(from)) {
    throw new Error(`buildPointerLine: invalid from value: ${String(from)}`);
  }
  return ` # deckterm task message from ${from} — read: cat '${inboxPath}'\n`;
}

export interface VerdictFile {
  round: number;
  verdict: "PASS" | "NEEDS_WORK" | "BLOCKED";
  summary?: string;
}

const VALID_VERDICTS: readonly VerdictFile["verdict"][] = [
  "PASS",
  "NEEDS_WORK",
  "BLOCKED",
];

/**
 * Read and strictly validate a round's verdict file. Returns null if the
 * round argument is invalid, the file can't be read safely, the JSON is
 * malformed, the schema doesn't strictly match, or (Codex BLOCKER fix) the
 * payload's `round` field doesn't exactly match the requested round —
 * guarding against a stale previous-round file satisfying the current
 * round.
 */
export function readVerdictFile(
  taskDir: string,
  round: number,
): VerdictFile | null {
  if (!Number.isInteger(round) || round < 0) return null;

  const path = join(taskDir, `verdict-r${round}.json`);
  const raw = readTaskFileSafe(path, { maxBytes: MAX_VERDICT_BYTES });
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;

  const { round: parsedRound, verdict, summary } = parsed;
  if (typeof parsedRound !== "number" || parsedRound !== round) return null;
  if (
    typeof verdict !== "string" ||
    !(VALID_VERDICTS as readonly string[]).includes(verdict)
  ) {
    return null;
  }
  if (summary !== undefined && typeof summary !== "string") return null;

  const result: VerdictFile = {
    round: parsedRound,
    verdict: verdict as VerdictFile["verdict"],
  };
  if (typeof summary === "string") {
    result.summary = summary;
  }
  return result;
}

/**
 * Render the worker prompt shown at the start of a new round: task
 * section, capped previous-judge-feedback section, and round metadata.
 * Deterministic — no timestamps.
 */
export function renderWorkerPrompt(input: {
  task: { title: string; description: string };
  feedback: string;
  round: number;
}): string {
  const cappedFeedback = truncateToByteLimit(
    input.feedback,
    MAX_FEEDBACK_BYTES,
  );
  return [
    `# Task: ${input.task.title}`,
    "",
    input.task.description,
    "",
    `## Previous judge feedback (round ${input.round - 1})`,
    "",
    cappedFeedback,
    "",
    "## Round",
    "",
    `- Round: ${input.round}`,
    "",
  ].join("\n");
}
