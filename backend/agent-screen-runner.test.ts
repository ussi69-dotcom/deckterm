// S1 review fixes around the screen-rule evaluation: the dirty flag survives a
// failed capture, a re-attach keeps the blocked episode, and the pipe pump
// never waits on a capture.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "./agent-screen-rules";
import {
  AGENT_SCREEN_CONCURRENCY,
  createBoundedScheduler,
  pumpPipeDeltas,
  resumeAgentScreenState,
  runAgentScreenEvaluation,
  type AgentScreenDeps,
  type AgentScreenTerm,
} from "./agent-screen-runner";
import {
  AGENT_INPUT_PUSH_GUARD_MS,
  AGENT_START_GRACE_MS,
  createAgentStatusRecord,
  syncAgentStatusAgent,
  type AgentStatusEffect,
} from "./agent-status";

function fixtureScreen(file: string): string {
  const text = readFileSync(
    join(import.meta.dir, "fixtures/agent-screens", file),
    "utf8",
  );
  return text.slice(text.indexOf("\n---\n", 4) + "\n---\n".length);
}

const BLOCKED = fixtureScreen("claude-2.1.308-blocked-question-form.txt");
const IDLE = fixtureScreen("claude-2.1.308-idle-prompt.txt");

type FakeTerm = AgentScreenTerm & { id: string; effects: AgentStatusEffect[] };

function fakeTerm(id: string, now: number): FakeTerm {
  return {
    id,
    sessionName: `s-${id}`,
    agentName: "claude",
    // Started long ago: the start grace is over.
    agentStatusRecord: syncAgentStatusAgent(
      createAgentStatusRecord(),
      "claude",
      now - AGENT_START_GRACE_MS - 1,
    ).record,
    agentScreenDirty: false,
    agentStatusBusy: false,
    agentOscTitle: "",
    agentOscProgress: "",
    effects: [],
  };
}

function deps(
  clock: { now: number },
  capture: (term: FakeTerm) => Promise<string | null>,
): AgentScreenDeps<FakeTerm> {
  return {
    now: () => clock.now,
    capture,
    isCurrent: () => true,
    syncRecord: (term) => {
      term.agentStatusRecord = syncAgentStatusAgent(
        term.agentStatusRecord,
        term.agentName,
        clock.now,
      ).record;
    },
    evaluate,
    applyEffects: (term, effects) => {
      term.effects.push(...effects);
      for (const effect of effects) {
        if (effect.type === "push" && effect.kind === "input") {
          term.lastInputPushAt = clock.now;
        }
      }
    },
    rulesBroken: () => false,
    onRulesBroken: () => {},
  };
}

const pushes = (term: FakeTerm) =>
  term.effects.filter((effect) => effect.type === "push");

describe("a failed capture keeps the evaluation pending", () => {
  test("a null capture gives the output back; the next tick reads the static prompt", async () => {
    const clock = { now: 1_000_000 };
    const term = fakeTerm("a", clock.now);
    // The first evaluation (the grace just ended) sees the idle prompt.
    expect(
      await runAgentScreenEvaluation(
        term,
        deps(clock, async () => IDLE),
      ),
    ).toBe("evaluated");
    expect(term.agentStatusRecord.status).toBe("idle");

    // The blocked prompt is printed once; that tick's capture fails.
    term.agentScreenDirty = true;
    clock.now += 2_000;
    expect(
      await runAgentScreenEvaluation(
        term,
        deps(clock, async () => null),
      ),
    ).toBe("capture-failed");
    expect(term.agentScreenDirty).toBe(true);
    expect(term.agentStatusBusy).toBe(false);

    // No new output, yet the next tick still evaluates and commits blocked.
    clock.now += 2_000;
    expect(
      await runAgentScreenEvaluation(
        term,
        deps(clock, async () => BLOCKED),
      ),
    ).toBe("evaluated");
    expect(term.agentStatusRecord.status).toBe("blocked");
    expect(term.agentScreenDirty).toBe(false);
    expect(pushes(term)).toEqual([{ type: "push", kind: "input" }]);
  });

  test("a throwing or discarded capture gives the output back too", async () => {
    const clock = { now: 1_000_000 };
    const term = fakeTerm("b", clock.now);
    term.agentScreenDirty = true;
    await expect(
      runAgentScreenEvaluation(
        term,
        deps(clock, async () => {
          throw new Error("tmux timed out");
        }),
      ),
    ).rejects.toThrow("tmux timed out");
    expect(term.agentScreenDirty).toBe(true);
    expect(term.agentStatusBusy).toBe(false);

    const stale = deps(clock, async () => BLOCKED);
    stale.isCurrent = () => false;
    expect(await runAgentScreenEvaluation(term, stale)).toBe("stale");
    expect(term.agentScreenDirty).toBe(true);
  });

  test("output printed during the capture stays pending after an evaluation", async () => {
    const clock = { now: 1_000_000 };
    const term = fakeTerm("c", clock.now);
    term.agentScreenDirty = true;
    await runAgentScreenEvaluation(
      term,
      deps(clock, async () => {
        term.agentScreenDirty = true; // the pump read more output meanwhile
        return IDLE;
      }),
    );
    expect(term.agentScreenDirty).toBe(true);
  });
});

describe("a re-attach of the same session keeps the blocked episode", () => {
  async function blockedAndPushed(clock: { now: number }) {
    const term = fakeTerm("r", clock.now);
    await runAgentScreenEvaluation(
      term,
      deps(clock, async () => BLOCKED),
    );
    expect(term.agentStatusRecord.status).toBe("blocked");
    expect(pushes(term).length).toBe(1);
    return term;
  }

  test("the same agent with the dialog still open does not push again", async () => {
    const clock = { now: 1_000_000 };
    const before = await blockedAndPushed(clock);
    // The attach dies; the next attach comes well after the push guard.
    clock.now += AGENT_INPUT_PUSH_GUARD_MS + 60_000;
    const resumed = resumeAgentScreenState(
      {
        agentStatusRecord: before.agentStatusRecord,
        lastInputPushAt: before.lastInputPushAt,
      },
      "claude",
      clock.now,
    );
    expect(resumed.sameAgent).toBe(true);
    expect(resumed.agentScreenDirty).toBe(true);
    expect(resumed.lastInputPushAt).toBe(before.lastInputPushAt);
    const after: FakeTerm = {
      ...fakeTerm("r", clock.now),
      agentStatusRecord: resumed.agentStatusRecord,
      agentScreenDirty: resumed.agentScreenDirty,
      lastInputPushAt: resumed.lastInputPushAt,
    };
    expect(after.agentStatusRecord.blockedEpisode).toEqual({
      startedAt: expect.any(Number),
      pushed: true,
    });
    for (let tick = 0; tick < 3; tick++) {
      clock.now += 2_000;
      after.agentScreenDirty = true;
      await runAgentScreenEvaluation(
        after,
        deps(clock, async () => BLOCKED),
      );
    }
    expect(after.agentStatusRecord.status).toBe("blocked");
    expect(pushes(after)).toEqual([]);
    expect(after.effects.some((effect) => effect.type === "raise")).toBe(false);

    // Without the hand-over the same screen pushed again (the review finding).
    const fresh = resumeAgentScreenState(null, "claude", clock.now);
    const regressed: FakeTerm = {
      ...fakeTerm("r2", clock.now),
      agentStatusRecord: fresh.agentStatusRecord,
    };
    clock.now += AGENT_START_GRACE_MS;
    await runAgentScreenEvaluation(
      regressed,
      deps(clock, async () => BLOCKED),
    );
    expect(pushes(regressed).length).toBe(1);
  });

  test("the episode still ends when the dialog closes, and a new one pushes", async () => {
    const clock = { now: 1_000_000 };
    const before = await blockedAndPushed(clock);
    clock.now += 60_000;
    const resumed = resumeAgentScreenState(
      { agentStatusRecord: before.agentStatusRecord },
      "claude",
      clock.now,
    );
    const after: FakeTerm = {
      ...fakeTerm("e", clock.now),
      agentStatusRecord: resumed.agentStatusRecord,
      agentScreenDirty: true,
    };
    await runAgentScreenEvaluation(
      after,
      deps(clock, async () => IDLE),
    );
    expect(after.agentStatusRecord.status).toBe("idle");
    expect(after.agentStatusRecord.blockedEpisode).toBe(null);
    clock.now += 60_000;
    after.agentScreenDirty = true;
    await runAgentScreenEvaluation(
      after,
      deps(clock, async () => BLOCKED),
    );
    expect(pushes(after)).toEqual([{ type: "push", kind: "input" }]);
  });

  test("another agent, or none, starts fresh", () => {
    const record = syncAgentStatusAgent(
      createAgentStatusRecord(),
      "claude",
      0,
    ).record;
    const blocked = {
      ...record,
      graceUntil: null,
      status: "blocked" as const,
      blockedEpisode: { startedAt: 1, pushed: true },
    };
    const codex = resumeAgentScreenState(
      { agentStatusRecord: blocked, lastInputPushAt: 5 },
      "codex",
      100,
    );
    expect(codex.sameAgent).toBe(false);
    expect(codex.agentStatusRecord.agentName).toBe("codex");
    expect(codex.agentStatusRecord.blockedEpisode).toBe(null);
    expect(codex.agentStatusRecord.graceUntil).toBe(100 + AGENT_START_GRACE_MS);
    // Push times belong to the terminal, not the agent.
    expect(codex.lastInputPushAt).toBe(5);
    const none = resumeAgentScreenState(
      { agentStatusRecord: blocked },
      null,
      100,
    );
    expect(none.sameAgent).toBe(false);
    expect(none.agentStatusRecord.agentName).toBe(null);
    expect(resumeAgentScreenState(undefined, "claude", 100).sameAgent).toBe(
      false,
    );
  });
});

describe("the pipe pump never waits on a capture", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("a wedged capture does not hold up the other terminals' pipe output", async () => {
    const clock = { now: 1_000_000 };
    const wedged = fakeTerm("wedged", clock.now);
    const others = [fakeTerm("b", clock.now), fakeTerm("c", clock.now)];
    const terms = [wedged, ...others];
    let release: (screen: string) => void = () => {};
    const captures: string[] = [];
    const runDeps = deps(clock, (term) => {
      captures.push(term.id);
      if (term === wedged) {
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      }
      return Promise.resolve(IDLE);
    });
    const scheduler = createBoundedScheduler<FakeTerm>({
      concurrency: AGENT_SCREEN_CONCURRENCY,
      run: (term) => runAgentScreenEvaluation(term, runDeps),
    });
    const processed: string[] = [];
    const pump = () =>
      pumpPipeDeltas(terms, {
        readDelta: async (term) => `out-${term.id}`,
        isCurrent: () => true,
        processDelta: (term, delta) => {
          processed.push(delta);
          term.agentScreenDirty = true;
        },
        scheduleScreen: (term) => scheduler.schedule(term),
      });

    const timeout = (ms: number) =>
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("pump blocked")), ms),
      );
    await Promise.race([pump(), timeout(1_000)]);
    await settle();
    // Second tick while the first capture is still hanging.
    clock.now += 2_000;
    await Promise.race([pump(), timeout(1_000)]);
    await settle();

    expect(processed).toEqual([
      "out-wedged",
      "out-b",
      "out-c",
      "out-wedged",
      "out-b",
      "out-c",
    ]);
    // One capture per terminal per tick, but never a second one for the
    // terminal whose capture is still running.
    expect(captures.filter((id) => id === "wedged").length).toBe(1);
    expect(captures.filter((id) => id === "b").length).toBe(2);
    expect(
      others.every((term) => term.agentStatusRecord.status === "idle"),
    ).toBe(true);
    expect(scheduler.isPending(wedged)).toBe(true);

    release(BLOCKED);
    await settle();
    await settle();
    expect(scheduler.isPending(wedged)).toBe(false);
    expect(wedged.agentStatusRecord.status).toBe("blocked");
  });

  test("captures run at most AGENT_SCREEN_CONCURRENCY at a time", async () => {
    let running = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const scheduler = createBoundedScheduler<number>({
      concurrency: AGENT_SCREEN_CONCURRENCY,
      run: () =>
        new Promise<void>((resolve) => {
          running++;
          peak = Math.max(peak, running);
          releases.push(() => {
            running--;
            resolve();
          });
        }),
    });
    for (let i = 0; i < AGENT_SCREEN_CONCURRENCY + 2; i++) {
      expect(scheduler.schedule(i)).toBe(true);
    }
    expect(scheduler.schedule(0)).toBe(false);
    await settle();
    expect(running).toBe(AGENT_SCREEN_CONCURRENCY);
    expect(scheduler.queued).toBe(2);
    releases.shift()!();
    await settle();
    await settle();
    expect(running).toBe(AGENT_SCREEN_CONCURRENCY);
    expect(scheduler.queued).toBe(1);
    while (releases.length) {
      releases.shift()!();
      await settle();
      await settle();
    }
    expect(peak).toBe(AGENT_SCREEN_CONCURRENCY);
    expect(scheduler.active).toBe(0);
  });

  test("a failing evaluation is reported and frees its terminal", async () => {
    const errors: unknown[] = [];
    const scheduler = createBoundedScheduler<string>({
      concurrency: 1,
      run: async () => {
        throw new Error("boom");
      },
      onError: (_item, err) => errors.push(err),
    });
    scheduler.schedule("t");
    await settle();
    await settle();
    expect(errors.length).toBe(1);
    expect(scheduler.isPending("t")).toBe(false);
    expect(scheduler.schedule("t")).toBe(true);
  });
});
