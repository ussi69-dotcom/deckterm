import { describe, expect, test } from "bun:test";
import type { ScreenRuleResult } from "./agent-screen-rules";
import {
  AGENT_DONE_PUSH_MIN_WORK_MS,
  AGENT_IDLE_HOLD_MS,
  AGENT_INPUT_PUSH_GUARD_MS,
  AGENT_START_GRACE_MS,
  agentStatusNeedsEvaluation,
  applyAgentStatusEvaluation,
  createAgentStatusRecord,
  createAgentsChangedCoalescer,
  markBlockedEpisodePushed,
  selectAgentsChangedSockets,
  shouldSendNotificationInputPush,
  socketWantsAgentsFrames,
  syncAgentStatusAgent,
  type AgentStatusEffect,
  type AgentStatusRecord,
} from "./agent-status";

function result(
  state: ScreenRuleResult["state"],
  ruleId: string,
  extra: Partial<ScreenRuleResult> = {},
): ScreenRuleResult {
  return {
    state,
    ruleId,
    region: "whole_recent",
    visibleIdle: false,
    visibleBlocker: false,
    visibleWorking: false,
    skip: false,
    manifestVersion: "claude@2026.10.11.1",
    ...extra,
  };
}

const WORKING = result("working", "live_turn_working", { visibleWorking: true });
const BLOCKED = result("blocked", "live_blocked_form", { visibleBlocker: true });
const VISIBLE_IDLE = result("idle", "live_prompt_box", {
  region: "prompt_box_body",
  visibleIdle: true,
});
const NO_MATCH = result("idle", "no_match", { region: null });
const SKIP = result("unknown", "transcript_viewer", { skip: true });

/** A Claude record past the start grace (started at t=0). */
function started(): AgentStatusRecord {
  return syncAgentStatusAgent(createAgentStatusRecord(), "claude", 0).record;
}

function apply(
  record: AgentStatusRecord,
  evaluation: ScreenRuleResult,
  now: number,
  lastInputPushAt: number | null = null,
) {
  return applyAgentStatusEvaluation(record, evaluation, {
    now,
    lastInputPushAt,
  });
}

const types = (effects: AgentStatusEffect[]) =>
  effects.map((effect) =>
    effect.type === "raise" || effect.type === "push"
      ? `${effect.type}:${effect.kind}`
      : effect.type,
  );

describe("start grace", () => {
  test("a new agent evaluates nothing for 3 s, then on the first tick after", () => {
    const record = started();
    expect(record.graceUntil).toBe(AGENT_START_GRACE_MS);
    expect(record.status).toBe(null);
    expect(
      agentStatusNeedsEvaluation(record, { now: 2_000, outputSeen: true }),
    ).toBe(false);
    // During the grace an evaluation is ignored.
    expect(apply(record, BLOCKED, 2_999)).toEqual({ record, effects: [] });
    // After it, the first tick evaluates even with no new output.
    expect(
      agentStatusNeedsEvaluation(record, { now: 4_000, outputSeen: false }),
    ).toBe(true);
    const step = apply(record, WORKING, 4_000);
    expect(step.record).toMatchObject({
      status: "working",
      rule: "live_turn_working",
      changedAt: 4_000,
      graceUntil: null,
      rulesVersion: "claude@2026.10.11.1",
    });
    expect(types(step.effects)).toEqual(["nudge"]);
    // Afterwards only new output triggers a capture.
    expect(
      agentStatusNeedsEvaluation(step.record, { now: 6_000, outputSeen: false }),
    ).toBe(false);
    expect(
      agentStatusNeedsEvaluation(step.record, { now: 6_000, outputSeen: true }),
    ).toBe(true);
  });

  test("no agent never evaluates; another agent restarts the grace", () => {
    expect(
      agentStatusNeedsEvaluation(createAgentStatusRecord(), {
        now: 10_000,
        outputSeen: true,
      }),
    ).toBe(false);
    const working = apply(started(), WORKING, 4_000).record;
    const codex = syncAgentStatusAgent(working, "codex", 10_000);
    expect(codex.record).toMatchObject({
      agentName: "codex",
      status: null,
      rule: null,
      graceUntil: 13_000,
    });
    expect(types(codex.effects)).toEqual(["nudge"]);
    // Same agent again: nothing changes.
    expect(syncAgentStatusAgent(codex.record, "codex", 11_000).record).toBe(
      codex.record,
    );
  });

  test("the first commit after the grace raises nothing for idle or working", () => {
    expect(types(apply(started(), NO_MATCH, 3_000).effects)).toEqual(["nudge"]);
    expect(types(apply(started(), WORKING, 3_000).effects)).toEqual(["nudge"]);
  });
});

describe("working -> idle hold", () => {
  test("a non-visible idle is held for one 700 ms re-check, then commits", () => {
    const working = apply(started(), WORKING, 3_000).record;
    const held = apply(working, NO_MATCH, 5_000);
    expect(held.record.status).toBe("working");
    expect(held.record.hold).toEqual({
      since: 5_000,
      recheckAt: 5_000 + AGENT_IDLE_HOLD_MS,
    });
    expect(held.effects).toEqual([
      { type: "recheck", at: 5_000 + AGENT_IDLE_HOLD_MS },
    ]);
    // The re-check is due even without new output.
    expect(
      agentStatusNeedsEvaluation(held.record, { now: 5_700, outputSeen: false }),
    ).toBe(true);
    // An evaluation before the re-check time keeps holding.
    expect(apply(held.record, NO_MATCH, 5_300).record.status).toBe("working");
    const committed = apply(held.record, NO_MATCH, 5_700);
    expect(committed.record).toMatchObject({
      status: "idle",
      rule: "no_match",
      changedAt: 5_700,
      hold: null,
    });
    expect(types(committed.effects)).toEqual(["nudge", "raise:done"]);
  });

  test("a re-check that is not idle drops the hold", () => {
    const working = apply(started(), WORKING, 3_000).record;
    const held = apply(working, NO_MATCH, 5_000).record;
    const dropped = apply(held, WORKING, 5_700);
    expect(dropped.record.status).toBe("working");
    expect(dropped.record.hold).toBe(null);
    expect(dropped.effects).toEqual([]);
    // A later idle starts a new hold instead of committing.
    expect(apply(dropped.record, NO_MATCH, 6_000).record.status).toBe(
      "working",
    );
  });

  test("a skip_state_update result keeps the status and drops the hold", () => {
    const working = apply(started(), WORKING, 3_000).record;
    const held = apply(working, NO_MATCH, 5_000).record;
    const skipped = apply(held, SKIP, 5_700);
    expect(skipped.record.status).toBe("working");
    expect(skipped.record.rule).toBe("live_turn_working");
    expect(skipped.record.hold).toBe(null);
    expect(skipped.effects).toEqual([]);
  });
});

describe("immediate commits", () => {
  test("visible idle, anything into blocked, blocked -> idle and idle -> working", () => {
    const working = apply(started(), WORKING, 3_000).record;
    const visibleIdle = apply(working, VISIBLE_IDLE, 4_000);
    expect(visibleIdle.record.status).toBe("idle");
    expect(visibleIdle.record.hold).toBe(null);

    const toWorking = apply(visibleIdle.record, WORKING, 5_000);
    expect(toWorking.record.status).toBe("working");
    expect(types(toWorking.effects)).toEqual(["nudge"]);

    const toBlocked = apply(toWorking.record, BLOCKED, 6_000);
    expect(toBlocked.record.status).toBe("blocked");

    // blocked -> idle (no_match, not visible) commits at once.
    const toIdle = apply(toBlocked.record, NO_MATCH, 7_000);
    expect(toIdle.record.status).toBe("idle");
    expect(types(toIdle.effects)).toEqual(["nudge", "raise:done"]);
    // The done that ends a blocked episode replaces its needs-input even
    // inside the attention priority window; a done after working does not.
    expect(toIdle.effects).toContainEqual(
      expect.objectContaining({ kind: "done", resolvesBlocked: true }),
    );
    const afterWork = apply(toWorking.record, VISIBLE_IDLE, 8_000);
    expect(afterWork.effects).not.toContainEqual(
      expect.objectContaining({ resolvesBlocked: true }),
    );
  });

  test("a new rule for the same status updates the rule only", () => {
    const blocked = apply(started(), BLOCKED, 3_000).record;
    const step = apply(
      blocked,
      result("blocked", "bash_permission_prompt"),
      5_000,
    );
    expect(step.record.rule).toBe("bash_permission_prompt");
    expect(step.record.changedAt).toBe(3_000);
    expect(step.effects).toEqual([]);
  });
});

describe("done", () => {
  test("idle from working raises done; the push needs 15 s of work in the turn", () => {
    const working = apply(started(), WORKING, 3_000).record;
    const shortTurn = apply(working, VISIBLE_IDLE, 3_000 + 14_999);
    expect(types(shortTurn.effects)).toEqual(["nudge", "raise:done"]);
    expect(shortTurn.effects).toContainEqual({
      type: "raise",
      kind: "done",
      source: "screen",
      rule: "live_prompt_box",
    });

    const again = apply(shortTurn.record, WORKING, 30_000).record;
    const longTurn = apply(
      again,
      VISIBLE_IDLE,
      30_000 + AGENT_DONE_PUSH_MIN_WORK_MS,
    );
    expect(types(longTurn.effects)).toEqual([
      "nudge",
      "raise:done",
      "push:agent",
    ]);
  });

  test("work before and after a blocked prompt counts towards one turn", () => {
    let record = apply(started(), WORKING, 3_000).record;
    record = apply(record, BLOCKED, 13_000).record; // 10 s of work
    record = apply(record, WORKING, 60_000).record; // 47 s waiting for the user
    const done = apply(record, VISIBLE_IDLE, 66_000); // 6 s more work
    expect(types(done.effects)).toEqual(["nudge", "raise:done", "push:agent"]);
    expect(done.record.turnWorkMs).toBe(0);
  });

  test("idle from idle or from the first evaluation raises nothing", () => {
    const idle = apply(started(), VISIBLE_IDLE, 3_000).record;
    expect(apply(idle, NO_MATCH, 5_000).effects).toEqual([]);
  });
});

describe("blocked episode", () => {
  test("pushes once per episode", () => {
    const working = apply(started(), WORKING, 3_000).record;
    const blocked = apply(working, BLOCKED, 5_000);
    expect(types(blocked.effects)).toEqual([
      "nudge",
      "raise:needs-input",
      "push:input",
    ]);
    expect(blocked.effects).toContainEqual({
      type: "raise",
      kind: "needs-input",
      source: "screen",
      rule: "live_blocked_form",
    });
    expect(blocked.record.blockedEpisode).toEqual({
      startedAt: 5_000,
      pushed: true,
    });
    // Still blocked: no second push. A notification in this episode does
    // not push either.
    expect(apply(blocked.record, BLOCKED, 7_000).effects).toEqual([]);
    expect(shouldSendNotificationInputPush(blocked.record)).toBe(false);
    // Leaving blocked ends the episode; the next one pushes again.
    const answered = apply(blocked.record, WORKING, 9_000).record;
    expect(answered.blockedEpisode).toBe(null);
    expect(shouldSendNotificationInputPush(answered)).toBe(true);
    const again = apply(answered, BLOCKED, 30_000, 5_000);
    expect(types(again.effects)).toContain("push:input");
  });

  test("an input push in the last 10 s (the agent's own notification) suppresses the screen push", () => {
    const working = apply(started(), WORKING, 3_000).record;
    const recent = apply(working, BLOCKED, 20_000, 20_000 - 4_000);
    expect(types(recent.effects)).toEqual(["nudge", "raise:needs-input"]);
    expect(recent.record.blockedEpisode?.pushed).toBe(true);
    const old = apply(
      working,
      BLOCKED,
      20_000,
      20_000 - AGENT_INPUT_PUSH_GUARD_MS,
    );
    expect(types(old.effects)).toContain("push:input");
  });

  test("markBlockedEpisodePushed only touches an open episode", () => {
    const none = started();
    expect(markBlockedEpisodePushed(none)).toBe(none);
    const open: AgentStatusRecord = {
      ...none,
      status: "blocked",
      blockedEpisode: { startedAt: 1, pushed: false },
    };
    expect(shouldSendNotificationInputPush(open)).toBe(true);
    const marked = markBlockedEpisodePushed(open);
    expect(marked.blockedEpisode).toEqual({ startedAt: 1, pushed: true });
    expect(shouldSendNotificationInputPush(marked)).toBe(false);
  });

  test("a title idle rule still raises done with source screen", () => {
    const working = apply(started(), WORKING, 3_000).record;
    const step = apply(
      working,
      result("idle", "osc_title_idle", { region: "osc_title", visibleIdle: true }),
      5_000,
    );
    expect(step.effects).toContainEqual({
      type: "raise",
      kind: "done",
      source: "screen",
      rule: "osc_title_idle",
    });
  });

  test("a title rule raises with source title", () => {
    const step = apply(
      started(),
      result("blocked", "osc_title_blocked", { region: "osc_title" }),
      3_000,
    );
    expect(step.effects).toContainEqual({
      type: "raise",
      kind: "needs-input",
      source: "title",
      rule: "osc_title_blocked",
    });
  });
});

describe("agent exit", () => {
  test("clears status, rule, holds, grace and the episode, and raises nothing", () => {
    let record = apply(started(), WORKING, 3_000).record;
    record = apply(record, BLOCKED, 5_000).record;
    const exited = syncAgentStatusAgent(record, null, 6_000);
    expect(exited.record).toEqual(createAgentStatusRecord());
    expect(types(exited.effects)).toEqual(["nudge"]);
    // A late evaluation after exit is ignored.
    expect(apply(exited.record, WORKING, 7_000).effects).toEqual([]);
    // Exit during the grace (nothing committed) needs no nudge.
    expect(syncAgentStatusAgent(started(), null, 1_000).effects).toEqual([]);
  });

  test("a pending hold is cleared on exit", () => {
    const working = apply(started(), WORKING, 3_000).record;
    const held = apply(working, NO_MATCH, 5_000).record;
    expect(held.hold).not.toBe(null);
    expect(syncAgentStatusAgent(held, null, 5_100).record.hold).toBe(null);
  });
});

describe("agents_changed frames", () => {
  test("only agents=1 sockets opt in", () => {
    const url = (query: string) => new URL(`http://x/ws/terminals/id${query}`);
    expect(socketWantsAgentsFrames(url("?agents=1"))).toBe(true);
    expect(socketWantsAgentsFrames(url("?clientId=a&scroll=1&agents=1"))).toBe(
      true,
    );
    expect(socketWantsAgentsFrames(url(""))).toBe(false);
    expect(socketWantsAgentsFrames(url("?agents=true"))).toBe(false);
  });

  test("frames go to open, opted-in sockets of the owner only", () => {
    const sockets = [
      { id: 1, readyState: 1, data: { agents: true, actorUserId: "owner" } },
      { id: 2, readyState: 1, data: { agents: false, actorUserId: "owner" } },
      { id: 3, readyState: 1, data: { actorUserId: "owner" } },
      { id: 4, readyState: 3, data: { agents: true, actorUserId: "owner" } },
      { id: 5, readyState: 1, data: { agents: true, actorUserId: "viewer" } },
    ];
    expect(
      selectAgentsChangedSockets(sockets, "owner").map((ws) => ws.id),
    ).toEqual([1]);
  });

  test("coalesced to at most one per 500 ms per owner", () => {
    let clock = 0;
    const sent: Array<[string, number]> = [];
    const timers: Array<{ at: number; fn: () => void }> = [];
    const coalescer = createAgentsChangedCoalescer({
      send: (owner) => sent.push([owner, clock]),
      now: () => clock,
      setTimer: (fn, ms) => timers.push({ at: clock + ms, fn }),
    });
    coalescer.notify("a");
    coalescer.notify("b");
    expect(sent).toEqual([
      ["a", 0],
      ["b", 0],
    ]);
    clock = 100;
    coalescer.notify("a");
    clock = 200;
    coalescer.notify("a");
    expect(sent).toHaveLength(2);
    expect(timers).toHaveLength(1);
    expect(timers[0].at).toBe(500);
    clock = 500;
    timers.shift()!.fn();
    expect(sent).toEqual([
      ["a", 0],
      ["b", 0],
      ["a", 500],
    ]);
    clock = 1_200;
    coalescer.notify("a");
    expect(sent.at(-1)).toEqual(["a", 1_200]);
  });
});
