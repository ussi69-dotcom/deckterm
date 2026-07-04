import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendTaskMessageEvent,
  buildPointerLine,
  readTaskMessages,
  readVerdictFile,
  renderWorkerPrompt,
  sanitizeMessageBody,
  type TaskMessageEvent,
} from "./task-messages";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "deckterm-task-messages-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("sanitizeMessageBody", () => {
  test("strips OSC/CSI escape sequences", () => {
    const withOsc = "hello\x1b]0;title\x07world";
    expect(sanitizeMessageBody(withOsc)).toBe("helloworld");

    const withCsi = "red\x1b[31mtext\x1b[0m";
    expect(sanitizeMessageBody(withCsi)).toBe("redtext");
  });

  test("keeps \\n and \\t but strips \\r and other C0 controls", () => {
    const input = "line1\r\nline2\ttabbed\x00\x01\x07end";
    expect(sanitizeMessageBody(input)).toBe("line1\nline2\ttabbedend");
  });

  test("strips C1 range and DEL", () => {
    const c1Char = String.fromCharCode(0x85);
    const del = String.fromCharCode(0x7f);
    const input = `before${c1Char}middle${del}after`;
    expect(sanitizeMessageBody(input)).toBe("beforemiddleafter");
  });

  test("caps at 8 KiB without splitting a multibyte character", () => {
    // Each "é" is 2 bytes in UTF-8; 5000 of them = 10000 bytes, over the cap.
    const body = "é".repeat(5000);
    const result = sanitizeMessageBody(body);

    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(8 * 1024);
    // Must not contain a lone/broken byte: every char must round-trip cleanly.
    expect(Buffer.from(result, "utf8").toString("utf8")).toBe(result);
    // Should be as close to the cap as possible: 4096 é chars = 8192 bytes exactly.
    expect(result.length).toBe(4096);
  });
});

describe("appendTaskMessageEvent + readTaskMessages folding", () => {
  function created(
    id: string,
    overrides: Partial<TaskMessageEvent> = {},
  ): TaskMessageEvent {
    return {
      type: "message-created",
      id,
      at: "2026-01-01T00:00:00.000Z",
      from: "user",
      to: "judge",
      body: "hi",
      ...overrides,
    };
  }

  test("created -> pending", () => {
    const dir = createTempDir();
    const file = join(dir, "messages.jsonl");
    expect(appendTaskMessageEvent(file, created("m1"))).toBe(true);

    const messages = readTaskMessages(file);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "m1",
      delivery: "pending",
      from: "user",
      to: "judge",
      body: "hi",
    });
  });

  test("created -> delivered", () => {
    const dir = createTempDir();
    const file = join(dir, "messages.jsonl");
    appendTaskMessageEvent(file, created("m1"));
    appendTaskMessageEvent(file, {
      type: "message-delivered",
      id: "m1",
      at: "2026-01-01T00:00:05.000Z",
      terminalId: "term-1",
    });

    const messages = readTaskMessages(file);
    expect(messages).toHaveLength(1);
    expect(messages[0].delivery).toBe("delivered");
    expect(messages[0].deliveredAt).toBe("2026-01-01T00:00:05.000Z");
  });

  test("created -> delivery-failed", () => {
    const dir = createTempDir();
    const file = join(dir, "messages.jsonl");
    appendTaskMessageEvent(file, created("m1"));
    appendTaskMessageEvent(file, {
      type: "message-delivery-failed",
      id: "m1",
      at: "2026-01-01T00:00:05.000Z",
      reason: "terminal not found",
    });

    const messages = readTaskMessages(file);
    expect(messages[0].delivery).toBe("failed");
    expect(messages[0].failureReason).toBe("terminal not found");
  });

  test("failed then re-created same id resets to pending", () => {
    const dir = createTempDir();
    const file = join(dir, "messages.jsonl");
    appendTaskMessageEvent(file, created("m1", { body: "first" }));
    appendTaskMessageEvent(file, {
      type: "message-delivery-failed",
      id: "m1",
      at: "2026-01-01T00:00:05.000Z",
      reason: "boom",
    });
    appendTaskMessageEvent(file, created("m1", { body: "second attempt" }));

    const messages = readTaskMessages(file);
    expect(messages).toHaveLength(1);
    expect(messages[0].delivery).toBe("pending");
    expect(messages[0].body).toBe("second attempt");
    expect(messages[0].failureReason).toBeUndefined();
  });

  test("malformed lines and unknown-id events are skipped; file order preserved", () => {
    const dir = createTempDir();
    const file = join(dir, "messages.jsonl");
    appendTaskMessageEvent(file, created("m1"));
    // Malformed line injected directly (not through the event API).
    appendFileSync(file, "not json at all\n");
    appendTaskMessageEvent(file, {
      type: "message-delivered",
      id: "unknown-id",
      at: "2026-01-01T00:00:01.000Z",
    });
    appendTaskMessageEvent(file, created("m2"));

    const messages = readTaskMessages(file);
    expect(messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(messages.every((m) => m.delivery === "pending")).toBe(true);
  });

  test("readTaskMessages returns [] for a missing file", () => {
    const dir = createTempDir();
    const file = join(dir, "does-not-exist.jsonl");
    expect(readTaskMessages(file)).toEqual([]);
  });
});

describe("readVerdictFile", () => {
  function writeVerdict(dir: string, filename: string, payload: unknown) {
    writeFileSync(join(dir, filename), JSON.stringify(payload));
  }

  test("happy path PASS/NEEDS_WORK/BLOCKED", () => {
    const dir = createTempDir();
    writeVerdict(dir, "verdict-r0.json", { round: 0, verdict: "PASS" });
    writeVerdict(dir, "verdict-r1.json", {
      round: 1,
      verdict: "NEEDS_WORK",
      summary: "fix tests",
    });
    writeVerdict(dir, "verdict-r2.json", { round: 2, verdict: "BLOCKED" });

    expect(readVerdictFile(dir, 0)).toEqual({ round: 0, verdict: "PASS" });
    expect(readVerdictFile(dir, 1)).toEqual({
      round: 1,
      verdict: "NEEDS_WORK",
      summary: "fix tests",
    });
    expect(readVerdictFile(dir, 2)).toEqual({ round: 2, verdict: "BLOCKED" });
  });

  test("round mismatch between filename and payload returns null", () => {
    const dir = createTempDir();
    // File is named for round 2 but the payload claims round 1 (stale copy).
    writeVerdict(dir, "verdict-r2.json", { round: 1, verdict: "PASS" });

    expect(readVerdictFile(dir, 2)).toBeNull();
  });

  test("bad verdict string returns null", () => {
    const dir = createTempDir();
    writeVerdict(dir, "verdict-r0.json", { round: 0, verdict: "MAYBE" });

    expect(readVerdictFile(dir, 0)).toBeNull();
  });

  test("non-integer or negative round argument returns null", () => {
    const dir = createTempDir();
    writeVerdict(dir, "verdict-r1.json", { round: 1, verdict: "PASS" });

    expect(readVerdictFile(dir, 1.5)).toBeNull();
    expect(readVerdictFile(dir, -1)).toBeNull();
    expect(readVerdictFile(dir, NaN)).toBeNull();
  });

  test("symlinked verdict file returns null", () => {
    const dir = createTempDir();
    const realFile = join(dir, "real-verdict.json");
    writeFileSync(realFile, JSON.stringify({ round: 0, verdict: "PASS" }));
    symlinkSync(realFile, join(dir, "verdict-r0.json"));

    expect(readVerdictFile(dir, 0)).toBeNull();
  });

  test("oversized verdict file returns null", () => {
    const dir = createTempDir();
    const bigSummary = "a".repeat(70 * 1024);
    writeVerdict(dir, "verdict-r0.json", {
      round: 0,
      verdict: "PASS",
      summary: bigSummary,
    });

    expect(readVerdictFile(dir, 0)).toBeNull();
  });
});

describe("buildPointerLine", () => {
  test("matches the exact expected string for a sample path", () => {
    const line = buildPointerLine("judge", "/home/deploy/.deckterm/inbox.md");
    expect(line).toBe(
      " # deckterm task message from judge — read: cat '/home/deploy/.deckterm/inbox.md'\n",
    );
  });

  test("contains no unquoted shell metacharacters outside the single-quoted path", () => {
    const line = buildPointerLine("user", "/tmp/some/path.md");
    expect(line).toMatch(
      /^ # deckterm task message from (user|judge|system) — read: cat '[^']*'\n$/,
    );
  });

  test("throws for an invalid from value", () => {
    expect(() => buildPointerLine("attacker" as never, "/tmp/x.md")).toThrow();
  });
});

describe("renderWorkerPrompt", () => {
  test("includes task title and round, caps feedback at 16 KiB", () => {
    const longFeedback = "x".repeat(20 * 1024);
    const prompt = renderWorkerPrompt({
      task: { title: "Fix the bug", description: "Do the thing." },
      feedback: longFeedback,
      round: 3,
    });

    expect(prompt).toContain("Fix the bug");
    expect(prompt).toContain("round 2");
    expect(prompt).toContain("Round: 3");

    const feedbackSection = prompt.split("## Round")[0];
    const feedbackOnly = feedbackSection.split(
      "## Previous judge feedback (round 2)",
    )[1];
    expect(Buffer.byteLength(feedbackOnly!, "utf8")).toBeLessThanOrEqual(
      16 * 1024 + 4, // small slack for surrounding newlines
    );
  });
});
