import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  QUICK_REPLIES,
  QUICK_REPLY_ATTENTION_WINDOW_MS,
  getQuickReplySequence,
  getQuickReplyState,
  shouldShowQuickReplies,
} from "./quick-replies.js";

// Load the real KEY_SEQUENCES table from app.js so the chip bytes are checked
// against the exact map the extra keys send through, not a copy.
function loadAppKeySequences() {
  const source = readFileSync(join(import.meta.dir, "app.js"), "utf8");
  const match = source.match(/const KEY_SEQUENCES = (\{[\s\S]*?\n\});/);
  if (!match) throw new Error("KEY_SEQUENCES not found in app.js");
  return Function(`"use strict"; return (${match[1]});`)();
}

const KEY_SEQUENCES = loadAppKeySequences();

describe("QUICK_REPLIES", () => {
  test("offers the agent prompt answers in order", () => {
    expect(QUICK_REPLIES.map((reply) => reply.label)).toEqual([
      "1",
      "2",
      "3",
      "Enter",
      "Esc",
      "⇧Tab",
      "Ctrl+C",
    ]);
  });

  test("every chip has a unique id and an accessible name", () => {
    const ids = new Set(QUICK_REPLIES.map((reply) => reply.id));
    expect(ids.size).toBe(QUICK_REPLIES.length);
    for (const reply of QUICK_REPLIES) {
      expect(reply.ariaLabel.length).toBeGreaterThan(0);
    }
  });

  test("every chip key resolves through the extra-keys KEY_SEQUENCES table", () => {
    for (const reply of QUICK_REPLIES) {
      expect(getQuickReplySequence(reply, KEY_SEQUENCES)).not.toBeNull();
    }
  });
});

describe("getQuickReplySequence", () => {
  test("maps each chip to the terminal bytes an agent TUI expects", () => {
    const bytesFor = (label) =>
      getQuickReplySequence(
        QUICK_REPLIES.find((reply) => reply.label === label),
        KEY_SEQUENCES,
      );
    expect(bytesFor("1")).toBe("1");
    expect(bytesFor("2")).toBe("2");
    expect(bytesFor("3")).toBe("3");
    expect(bytesFor("Enter")).toBe("\r");
    expect(bytesFor("Esc")).toBe("\x1b");
    expect(bytesFor("⇧Tab")).toBe("\x1b[Z");
    expect(bytesFor("Ctrl+C")).toBe("\x03");
  });

  test("Esc reuses the same sequence as the ESC extra key", () => {
    const esc = QUICK_REPLIES.find((reply) => reply.label === "Esc");
    expect(esc.key).toBe("ESC");
    expect(getQuickReplySequence(esc, KEY_SEQUENCES)).toBe(KEY_SEQUENCES.ESC);
  });

  test("accepts a bare key name and rejects unknown multi-character keys", () => {
    expect(getQuickReplySequence("ENTER", KEY_SEQUENCES)).toBe("\r");
    expect(getQuickReplySequence("NOPE", KEY_SEQUENCES)).toBeNull();
    expect(getQuickReplySequence(null, KEY_SEQUENCES)).toBeNull();
    expect(getQuickReplySequence("ENTER", null)).toBeNull();
  });
});

describe("shouldShowQuickReplies", () => {
  test("shows on touch layouts while an agent session is active", () => {
    expect(
      shouldShowQuickReplies({
        touchLayout: true,
        agentName: "claude",
        agentState: "thinking",
      }),
    ).toBe(true);
    expect(
      shouldShowQuickReplies({
        touchLayout: true,
        agentName: "codex",
        agentState: null,
      }),
    ).toBe(true);
  });

  test("stays visible while the agent streams output (no layout churn)", () => {
    expect(
      shouldShowQuickReplies({
        touchLayout: true,
        agentName: "claude",
        agentState: "responding",
      }),
    ).toBe(true);
  });

  test("hidden without an agent", () => {
    expect(
      shouldShowQuickReplies({
        touchLayout: true,
        agentName: null,
        agentState: null,
      }),
    ).toBe(false);
    expect(
      shouldShowQuickReplies({
        touchLayout: true,
        agentName: "   ",
        agentState: "thinking",
      }),
    ).toBe(false);
  });

  test("hidden on desktop layouts and with no input", () => {
    expect(
      shouldShowQuickReplies({
        touchLayout: false,
        agentName: "claude",
        agentState: "thinking",
      }),
    ).toBe(false);
    expect(shouldShowQuickReplies()).toBe(false);
  });

  describe("with the agent attention signal from /api/terminals", () => {
    const now = 10_000_000;
    const base = { touchLayout: true, agentName: "claude", now };

    test("a recent needs-input notification shows the chips", () => {
      expect(
        shouldShowQuickReplies({
          ...base,
          attention: { kind: "needs-input", at: now - 30_000, seq: 3 },
        }),
      ).toBe(true);
    });

    test("an older needs-input notification no longer does", () => {
      expect(
        shouldShowQuickReplies({
          ...base,
          attention: {
            kind: "needs-input",
            at: now - QUICK_REPLY_ATTENTION_WINDOW_MS - 1,
            seq: 3,
          },
        }),
      ).toBe(false);
    });

    test("any other latest notification hides them", () => {
      for (const kind of ["done", "error", "info"]) {
        expect(
          shouldShowQuickReplies({
            ...base,
            attention: { kind, at: now - 1000, seq: 4 },
          }),
        ).toBe(false);
      }
    });

    test("no signal keeps the agent-session rule", () => {
      expect(shouldShowQuickReplies({ ...base, attention: null })).toBe(true);
      expect(shouldShowQuickReplies({ ...base, attention: {} })).toBe(true);
    });

    test("still needs a touch layout and an agent", () => {
      const attention = { kind: "needs-input", at: now, seq: 1 };
      expect(
        shouldShowQuickReplies({ ...base, touchLayout: false, attention }),
      ).toBe(false);
      expect(
        shouldShowQuickReplies({ ...base, agentName: null, attention }),
      ).toBe(false);
    });
  });
});

describe("getQuickReplyState", () => {
  test("waiting when the agent is quiet, busy while it streams output", () => {
    expect(getQuickReplyState({ agentState: "thinking" })).toBe("waiting");
    expect(getQuickReplyState({ agentState: null })).toBe("waiting");
    expect(getQuickReplyState({ agentState: "Responding" })).toBe("busy");
    expect(getQuickReplyState()).toBe("waiting");
  });
});
