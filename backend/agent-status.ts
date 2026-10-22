// Screen-rule agent status: the pure state machine (design section 1.3-1.6).
//
// Hysteresis constants are ported from herdr src/pane/agent_detection.rs:5-13
// (Apache-2.0, commit 2ecf19a; see THIRD_PARTY_NOTICES.md) and adapted to
// DeckTerm's 2 s pipe-pump tick:
// - start grace: 3 s after an agent appears, nothing is evaluated;
// - working -> idle from a rule that is not visible_idle (or no_match) waits
//   for one re-check 700 ms later; still idle commits, anything else drops it;
// - no other hold: visible idle, anything into blocked, blocked -> idle and
//   idle -> working commit at once.
//
// The clock is injected (`now`), so tests drive it without timers. The server
// owns the I/O: captures, pushes, attention and the agents_changed frame.

import type { ScreenRuleResult } from "./agent-screen-rules";

export const AGENT_START_GRACE_MS = 3_000;
export const AGENT_IDLE_HOLD_MS = 700;
/** A "done" push needs at least this much work in the finished turn. */
export const AGENT_DONE_PUSH_MIN_WORK_MS = 15_000;
/** An input push in this window (the agent's own notification) suppresses the screen push. */
export const AGENT_INPUT_PUSH_GUARD_MS = 10_000;
/** agents_changed frames: at most one per owner per this window. */
export const AGENTS_CHANGED_COALESCE_MS = 500;

export type AgentStatus = "working" | "blocked" | "idle";
export type AgentStatusAttentionSource = "screen" | "title";

export type AgentStatusRecord = {
  agentName: string | null;
  /** Committed status; null when no agent runs or during the start grace. */
  status: AgentStatus | null;
  rule: string | null;
  changedAt: number | null;
  rulesVersion: string | null;
  /** Set while the start grace runs (and until the first evaluation after it). */
  graceUntil: number | null;
  /** Pending working -> idle hold. */
  hold: { since: number; recheckAt: number } | null;
  /** Start of the current working stretch. */
  workingSince: number | null;
  /** Working time accumulated in the current turn (since the last idle). */
  turnWorkMs: number;
  /** From the commit of blocked to the commit of any other status. */
  blockedEpisode: { startedAt: number; pushed: boolean } | null;
};

export type AgentStatusEffect =
  | {
      type: "raise";
      kind: "needs-input" | "done";
      source: AgentStatusAttentionSource;
      rule: string;
      /**
       * The screen proved the earlier needs-input is over (blocked -> idle),
       * so this done replaces it even inside the 2 s priority window.
       */
      resolvesBlocked?: boolean;
    }
  | { type: "push"; kind: "input" | "agent" }
  /** A committed change: tell the owner's opted-in pages to refetch. */
  | { type: "nudge" }
  /** Evaluate again at this time (the working -> idle re-check). */
  | { type: "recheck"; at: number };

export type AgentStatusStep = {
  record: AgentStatusRecord;
  effects: AgentStatusEffect[];
};

export function createAgentStatusRecord(): AgentStatusRecord {
  return {
    agentName: null,
    status: null,
    rule: null,
    changedAt: null,
    rulesVersion: null,
    graceUntil: null,
    hold: null,
    workingSince: null,
    turnWorkMs: 0,
    blockedEpisode: null,
  };
}

/**
 * Follows the terminal's agent. A new agent (from none or another agent)
 * resets everything and starts the grace; no agent clears everything and
 * raises nothing (the "command finished" path covers the returned prompt).
 */
export function syncAgentStatusAgent(
  record: AgentStatusRecord,
  agentName: string | null,
  now: number,
): AgentStatusStep {
  if (record.agentName === agentName) return { record, effects: [] };
  const next = createAgentStatusRecord();
  next.agentName = agentName;
  next.graceUntil = agentName ? now + AGENT_START_GRACE_MS : null;
  // The page shows the status, so a cleared status is a change it must see.
  // A changed rule alone is not: the next poll carries it.
  const effects: AgentStatusEffect[] =
    record.status !== null ? [{ type: "nudge" }] : [];
  return { record: next, effects };
}

/**
 * Whether the pump should take a capture now. `outputSeen` is true when the
 * pane printed something since the last evaluation; an unchanged screen cannot
 * change the result unless a grace or a hold is pending.
 */
export function agentStatusNeedsEvaluation(
  record: AgentStatusRecord,
  { now, outputSeen }: { now: number; outputSeen: boolean },
): boolean {
  if (!record.agentName) return false;
  if (record.graceUntil !== null) return now >= record.graceUntil;
  if (record.hold) return outputSeen || now >= record.hold.recheckAt;
  return outputSeen;
}

function attentionSource(result: ScreenRuleResult): AgentStatusAttentionSource {
  return result.region === "osc_title" ? "title" : "screen";
}

/** Applies one rule evaluation. */
export function applyAgentStatusEvaluation(
  record: AgentStatusRecord,
  result: ScreenRuleResult,
  {
    now,
    lastInputPushAt = null,
  }: { now: number; lastInputPushAt?: number | null },
): AgentStatusStep {
  if (!record.agentName) return { record, effects: [] };
  if (record.graceUntil !== null && now < record.graceUntil) {
    return { record, effects: [] };
  }
  const next: AgentStatusRecord = {
    ...record,
    graceUntil: null,
    rulesVersion: result.manifestVersion,
  };
  const effects: AgentStatusEffect[] = [];

  // skip_state_update (and an unknown state) keeps the committed status and
  // rule. It is not idle, so a pending hold is dropped.
  if (result.skip || result.state === "unknown") {
    next.hold = null;
    return { record: next, effects };
  }

  const previous = record.status;
  const target = result.state;

  if (previous === "working" && target === "idle" && !result.visibleIdle) {
    if (!next.hold) {
      const recheckAt = now + AGENT_IDLE_HOLD_MS;
      next.hold = { since: now, recheckAt };
      effects.push({ type: "recheck", at: recheckAt });
      return { record: next, effects };
    }
    if (now < next.hold.recheckAt) return { record: next, effects };
    // The re-check is still idle: commit below.
  }
  next.hold = null;

  if (previous === target) {
    next.rule = result.ruleId;
    return { record: next, effects };
  }

  // Commit.
  if (previous === "working" && next.workingSince !== null) {
    next.turnWorkMs += Math.max(0, now - next.workingSince);
    next.workingSince = null;
  }
  if (target === "working") next.workingSince = now;
  next.status = target;
  next.rule = result.ruleId;
  next.changedAt = now;
  effects.push({ type: "nudge" });

  if (previous === "blocked") next.blockedEpisode = null;

  const source = attentionSource(result);
  if (target === "blocked") {
    effects.push({
      type: "raise",
      kind: "needs-input",
      source,
      rule: result.ruleId,
    });
    const recentInputPush =
      lastInputPushAt !== null &&
      now - lastInputPushAt >= 0 &&
      now - lastInputPushAt < AGENT_INPUT_PUSH_GUARD_MS;
    if (!recentInputPush) effects.push({ type: "push", kind: "input" });
    // Either way this episode has pushed: a later notification for the same
    // prompt must not push again.
    next.blockedEpisode = { startedAt: now, pushed: true };
  } else if (target === "idle") {
    if (previous === "working" || previous === "blocked") {
      // Design 1.4: done is always source "screen" (only needs-input keeps
      // the S1a "title" source for osc_title_blocked).
      effects.push({
        type: "raise",
        kind: "done",
        source: "screen",
        rule: result.ruleId,
        ...(previous === "blocked" ? { resolvesBlocked: true } : {}),
      });
      if (next.turnWorkMs >= AGENT_DONE_PUSH_MIN_WORK_MS) {
        effects.push({ type: "push", kind: "agent" });
      }
    }
    next.turnWorkMs = 0;
  }
  return { record: next, effects };
}

/**
 * The agent printed its own needs-input notification. It pushes as today,
 * unless the terminal is in a blocked episode that already pushed.
 */
export function shouldSendNotificationInputPush(
  record: AgentStatusRecord,
): boolean {
  return !record.blockedEpisode?.pushed;
}

/** Records that a notification push went out during a blocked episode. */
export function markBlockedEpisodePushed(
  record: AgentStatusRecord,
): AgentStatusRecord {
  if (!record.blockedEpisode || record.blockedEpisode.pushed) return record;
  return { ...record, blockedEpisode: { ...record.blockedEpisode, pushed: true } };
}

// ---------------------------------------------------------------------------
// agents_changed coalescing: leading edge at once, then at most one frame per
// owner per AGENTS_CHANGED_COALESCE_MS.
// ---------------------------------------------------------------------------

export function createAgentsChangedCoalescer({
  send,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  intervalMs = AGENTS_CHANGED_COALESCE_MS,
}: {
  send: (ownerId: string) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  intervalMs?: number;
}) {
  const lastSentAt = new Map<string, number>();
  const pending = new Set<string>();
  const fire = (ownerId: string) => {
    lastSentAt.set(ownerId, now());
    send(ownerId);
  };
  return {
    notify(ownerId: string) {
      if (pending.has(ownerId)) return;
      const last = lastSentAt.get(ownerId);
      const wait = last === undefined ? 0 : last + intervalMs - now();
      if (wait <= 0) {
        fire(ownerId);
        return;
      }
      pending.add(ownerId);
      setTimer(() => {
        pending.delete(ownerId);
        fire(ownerId);
      }, wait);
    },
  };
}

/** `agents=1` in the terminal socket URL opts the page in to agents_changed. */
export function socketWantsAgentsFrames(url: URL): boolean {
  return url.searchParams.get("agents") === "1";
}

/**
 * The sockets that get an owner's agents_changed frame: open, opted in with
 * `agents=1`, and opened by the owner (not a shared viewer of the terminal).
 */
export function selectAgentsChangedSockets<
  T extends {
    readyState: number;
    data: { agents?: boolean; actorUserId: string };
  },
>(sockets: Iterable<T>, ownerId: string): T[] {
  const selected: T[] = [];
  for (const ws of sockets) {
    if (ws.readyState !== 1) continue;
    if (ws.data.agents !== true) continue;
    if (ws.data.actorUserId !== ownerId) continue;
    selected.push(ws);
  }
  return selected;
}
