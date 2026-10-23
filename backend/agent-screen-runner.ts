// Running screen-rule evaluations next to the tmux pipe pump (S1 review fixes).
//
// - The pump never waits on a capture: it only schedules an evaluation. A
//   bounded pool runs them (AGENT_SCREEN_CONCURRENCY at a time), one at a time
//   per terminal, so a wedged tmux (3-5 s capture timeouts) cannot stall pipe
//   processing for every other terminal.
// - "The pane printed something" (agentScreenDirty) is consumed by a capture
//   only when that capture is evaluated; a failed or discarded capture gives
//   it back, so the next tick retries a static prompt.
// - A re-attach of the same tmux session keeps the agent's record (blocked
//   episode, last pushes) instead of starting over.

import type {
  RuleAgent,
  ScreenRuleInput,
  ScreenRuleResult,
} from "./agent-screen-rules";
import {
  agentStatusNeedsEvaluation,
  applyAgentStatusEvaluation,
  createAgentStatusRecord,
  syncAgentStatusAgent,
  type AgentStatusEffect,
  type AgentStatusRecord,
} from "./agent-status";

export const AGENT_SCREEN_CONCURRENCY = 4;

/** The Terminal fields an evaluation reads and writes. */
export type AgentScreenTerm = {
  sessionName?: string | null;
  agentName: string | null;
  agentStatusRecord: AgentStatusRecord;
  agentScreenDirty: boolean;
  agentStatusBusy: boolean;
  agentOscTitle: string;
  agentOscProgress: string;
  lastInputPushAt?: number;
};

export type AgentScreenDeps<T extends AgentScreenTerm> = {
  now(): number;
  /** Visible-only capture; null when it failed. May throw. */
  capture(term: T): Promise<string | null>;
  /** The handle is still the registered one for its id. */
  isCurrent(term: T): boolean;
  /** Re-sync the record with term.agentName (new agent: reset + grace). */
  syncRecord(term: T): void;
  /** Throws when the vendored rules cannot be loaded. */
  evaluate(agent: RuleAgent, input: ScreenRuleInput): ScreenRuleResult;
  applyEffects(term: T, effects: AgentStatusEffect[]): void;
  rulesBroken(): boolean;
  onRulesBroken(err: unknown): void;
};

export type AgentScreenOutcome =
  | "skipped"
  | "busy"
  | "capture-failed"
  | "stale"
  | "rules-broken"
  | "evaluated";

/** Whether a capture is due now (cheap; the pump calls it every tick). */
export function agentScreenEvaluationDue<T extends AgentScreenTerm>(
  term: T,
  deps: Pick<AgentScreenDeps<T>, "now" | "syncRecord" | "rulesBroken">,
): boolean {
  const agentName = term.agentName;
  if (!term.sessionName || !agentName || deps.rulesBroken()) return false;
  if (term.agentStatusRecord.agentName !== agentName) deps.syncRecord(term);
  return agentStatusNeedsEvaluation(term.agentStatusRecord, {
    now: deps.now(),
    outputSeen: term.agentScreenDirty,
  });
}

/** One capture + evaluation for a terminal. */
export async function runAgentScreenEvaluation<T extends AgentScreenTerm>(
  term: T,
  deps: AgentScreenDeps<T>,
): Promise<AgentScreenOutcome> {
  const agentName = term.agentName;
  if (term.agentStatusBusy) return "busy";
  if (!agentScreenEvaluationDue(term, deps) || !agentName) return "skipped";
  term.agentStatusBusy = true;
  // Output seen so far is consumed by this capture; output printed during it
  // sets the flag again. Unless the capture is evaluated, it is given back.
  const consumedOutput = term.agentScreenDirty;
  term.agentScreenDirty = false;
  let outcome: AgentScreenOutcome = "capture-failed";
  try {
    const screen = await deps.capture(term);
    if (screen === null) return outcome;
    if (
      !deps.isCurrent(term) ||
      term.agentName !== agentName ||
      term.agentStatusRecord.agentName !== agentName
    ) {
      outcome = "stale";
      return outcome;
    }
    let result: ScreenRuleResult;
    try {
      result = deps.evaluate(agentName as RuleAgent, {
        screen,
        title: term.agentOscTitle,
        progress: term.agentOscProgress,
      });
    } catch (err) {
      deps.onRulesBroken(err);
      outcome = "rules-broken";
      return outcome;
    }
    const step = applyAgentStatusEvaluation(term.agentStatusRecord, result, {
      now: deps.now(),
      lastInputPushAt: term.lastInputPushAt ?? null,
    });
    term.agentStatusRecord = step.record;
    outcome = "evaluated";
    deps.applyEffects(term, step.effects);
    return outcome;
  } finally {
    term.agentStatusBusy = false;
    if (outcome !== "evaluated" && consumedOutput) term.agentScreenDirty = true;
  }
}

/**
 * Runs `run(item)` for scheduled items, at most `concurrency` at once. An item
 * already queued or running is not scheduled again (the per-terminal
 * in-flight guard); `schedule` never waits.
 */
export function createBoundedScheduler<T>({
  concurrency,
  run,
  onError,
}: {
  concurrency: number;
  run: (item: T) => Promise<unknown>;
  onError?: (item: T, err: unknown) => void;
}) {
  const queue: T[] = [];
  const pending = new Set<T>();
  let active = 0;
  const drain = () => {
    while (active < concurrency && queue.length > 0) {
      const item = queue.shift() as T;
      active++;
      Promise.resolve()
        .then(() => run(item))
        .catch((err) => onError?.(item, err))
        .finally(() => {
          active--;
          pending.delete(item);
          drain();
        });
    }
  };
  return {
    schedule(item: T): boolean {
      if (pending.has(item)) return false;
      pending.add(item);
      queue.push(item);
      drain();
      return true;
    },
    isPending(item: T): boolean {
      return pending.has(item);
    },
    get active() {
      return active;
    },
    get queued() {
      return queue.length;
    },
  };
}

/**
 * One pass of the pipe pump: read and process each terminal's pipe delta in
 * order, then schedule (never await) its screen evaluation.
 */
export async function pumpPipeDeltas<T>(
  terms: Iterable<T>,
  deps: {
    readDelta(term: T): Promise<string>;
    isCurrent(term: T): boolean;
    processDelta(term: T, delta: string): void;
    scheduleScreen(term: T): void;
  },
): Promise<void> {
  for (const term of terms) {
    const delta = await deps.readDelta(term).catch(() => "");
    if (!deps.isCurrent(term)) continue;
    if (delta) deps.processDelta(term, delta);
    if (deps.isCurrent(term)) deps.scheduleScreen(term);
  }
}

/** What a dropped attach hands to the next attach of the same session. */
export type AgentScreenResume = {
  agentStatusRecord: AgentStatusRecord;
  lastInputPushAt?: number;
  lastCompletionPushAt?: number;
  attention?: unknown;
  agentOscProgress?: string;
};

/**
 * The agent state of a re-attached handle. The same agent still running keeps
 * its record (committed status, blocked episode and whether it pushed, turn
 * work), the attention it raised and its progress, and the screen is
 * evaluated once more. Otherwise the record starts as for a new agent. Push
 * times belong to the terminal and are always kept.
 */
export function resumeAgentScreenState(
  resume: AgentScreenResume | null | undefined,
  agentName: string | null,
  now: number,
): {
  agentStatusRecord: AgentStatusRecord;
  sameAgent: boolean;
  agentScreenDirty: boolean;
  lastInputPushAt?: number;
  lastCompletionPushAt?: number;
} {
  const sameAgent =
    !!resume &&
    resume.agentStatusRecord.agentName !== null &&
    resume.agentStatusRecord.agentName === agentName;
  return {
    agentStatusRecord: sameAgent
      ? (resume as AgentScreenResume).agentStatusRecord
      : syncAgentStatusAgent(createAgentStatusRecord(), agentName, now).record,
    sameAgent,
    agentScreenDirty: sameAgent,
    lastInputPushAt: resume?.lastInputPushAt,
    lastCompletionPushAt: resume?.lastCompletionPushAt,
  };
}
