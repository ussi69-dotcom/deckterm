import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  QUICK_REPLIES,
  getQuickReplySequence,
  getQuickReplyState,
  quickReplyAttentionBaseline,
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

    test("a needs-input notification shows the chips while the agent waits", () => {
      expect(
        shouldShowQuickReplies({
          ...base,
          agentState: "thinking",
          attention: { kind: "needs-input", at: now - 30_000, seq: 3 },
        }),
      ).toBe(true);
    });

    test("no fixed cutoff: an hour-old needs-input still shows them", () => {
      expect(
        shouldShowQuickReplies({
          ...base,
          agentState: null,
          attention: { kind: "needs-input", at: now - 60 * 60_000, seq: 3 },
        }),
      ).toBe(true);
    });

    test("needs-input hides them while the agent is responding again", () => {
      expect(
        shouldShowQuickReplies({
          ...base,
          agentState: "Responding",
          attention: { kind: "needs-input", at: now - 1000, seq: 3 },
        }),
      ).toBe(false);
    });

    test("attention from before the current agent session is ignored", () => {
      // A Codex "done" from an earlier run in this terminal: the new session
      // sends no notifications, so the agent-session rule applies.
      expect(
        shouldShowQuickReplies({
          ...base,
          attention: { kind: "done", at: now - 60_000, seq: 4 },
          attentionBaselineSeq: 4,
        }),
      ).toBe(true);
      // An old needs-input is ignored too (no stale "waiting" signal).
      expect(
        shouldShowQuickReplies({
          ...base,
          agentState: "responding",
          attention: { kind: "needs-input", at: now - 60_000, seq: 2 },
          attentionBaselineSeq: 4,
        }),
      ).toBe(true);
      // A notification from this session counts again.
      expect(
        shouldShowQuickReplies({
          ...base,
          attention: { kind: "done", at: now, seq: 5 },
          attentionBaselineSeq: 4,
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

describe("quickReplyAttentionBaseline", () => {
  test("re-baselines only when a new agent session starts", () => {
    const attention = { kind: "done", at: 1, seq: 7 };
    // Agent appears: everything seen so far predates it.
    expect(
      quickReplyAttentionBaseline({
        previousAgentName: null,
        nextAgentName: "claude",
        attention,
        currentBaseline: null,
      }),
    ).toBe(7);
    // Same agent keeps its baseline.
    expect(
      quickReplyAttentionBaseline({
        previousAgentName: "claude",
        nextAgentName: "claude",
        attention: { kind: "needs-input", at: 2, seq: 9 },
        currentBaseline: 7,
      }),
    ).toBe(7);
    // A different agent starts a new session.
    expect(
      quickReplyAttentionBaseline({
        previousAgentName: "claude",
        nextAgentName: "codex",
        attention: { kind: "needs-input", at: 2, seq: 9 },
        currentBaseline: 7,
      }),
    ).toBe(9);
    // No attention yet: nothing to ignore.
    expect(
      quickReplyAttentionBaseline({
        previousAgentName: null,
        nextAgentName: "claude",
        attention: null,
        currentBaseline: 3,
      }),
    ).toBeNull();
  });
});

describe("shouldShowQuickReplies with a screen-rule agentStatus", () => {
  const base = { touchLayout: true, agentName: "claude" };
  const needsInput = { kind: "needs-input", seq: 9 };

  test("shows only while the agent is blocked", () => {
    expect(shouldShowQuickReplies({ ...base, agentStatus: "blocked" })).toBe(
      true,
    );
    expect(shouldShowQuickReplies({ ...base, agentStatus: "working" })).toBe(
      false,
    );
    expect(shouldShowQuickReplies({ ...base, agentStatus: "idle" })).toBe(
      false,
    );
  });

  test("the status wins over a stale needs-input attention", () => {
    expect(
      shouldShowQuickReplies({
        ...base,
        agentStatus: "working",
        attention: needsInput,
      }),
    ).toBe(false);
    expect(
      shouldShowQuickReplies({
        ...base,
        agentStatus: "blocked",
        agentState: "responding",
        attention: { kind: "done", seq: 10 },
      }),
    ).toBe(true);
  });

  test("a null status keeps today's attention logic", () => {
    expect(
      shouldShowQuickReplies({ ...base, agentStatus: null, attention: needsInput }),
    ).toBe(true);
    expect(shouldShowQuickReplies({ ...base, agentStatus: null })).toBe(true);
    expect(
      shouldShowQuickReplies({
        ...base,
        agentStatus: null,
        attention: { kind: "done", seq: 4 },
      }),
    ).toBe(false);
  });

  test("never on desktop or without an agent", () => {
    expect(
      shouldShowQuickReplies({ ...base, touchLayout: false, agentStatus: "blocked" }),
    ).toBe(false);
    expect(
      shouldShowQuickReplies({ touchLayout: true, agentName: null, agentStatus: "blocked" }),
    ).toBe(false);
  });
});
