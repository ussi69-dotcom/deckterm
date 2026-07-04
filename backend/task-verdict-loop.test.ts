// S6 (Traycer patterns): D4 verdict-loop semantics — per-round verdict files,
// exact mark-then-increment ordering, idempotency under double-fire, and the
// provider-matched agent-done edge. No foundation state is touched here.
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildWorkerCommand, createTaskRunner } from "./task-runner";
import { readTaskMessages, taskMessagesPath } from "./task-messages";

const tempDirs: string[] = [];

async function createTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "deckterm-verdict-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeJudgeRunningTask(options: { maxRounds?: number } = {}) {
  const projectRoot = await createTempDir();
  const stateDir = await createTempDir();
  const runner = createTaskRunner({
    stateDir,
    maxRounds: options.maxRounds,
    resolveAllowedPath: async (value) =>
      value === projectRoot ? projectRoot : null,
    runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  });
  const created = await runner.createTask(
    {
      title: "Verdict loop",
      description: "Close the loop.",
      projectRoot,
      workerProvider: "claude",
      judgeProvider: "claude",
      useWorktree: false,
    },
    { ownerId: "user-1" },
  );
  await runner.markWorkerStarted(created.id, { ownerId: "user-1" }, "term-w");
  const task = await runner.markJudgeStarted(
    created.id,
    { ownerId: "user-1" },
    "term-j",
  );
  return { runner, task };
}

async function writeVerdict(
  taskDir: string,
  round: number,
  verdict: string,
  summary = "because reasons",
  payloadRound = round,
) {
  await writeFile(
    join(taskDir, `verdict-r${round}.json`),
    JSON.stringify({ round: payloadRound, verdict, summary }),
  );
}

test("PASS verdict completes the task and marks the round processed", async () => {
  const { runner, task } = await makeJudgeRunningTask();
  await writeVerdict(task.taskDir, 0, "PASS");

  const updated = await runner.handleJudgeCompletion(
    "user-1",
    "term-j",
    "claude",
  );

  expect(updated?.status).toBe("complete");
  expect(updated?.round).toBe(0);
  expect(updated?.processedVerdictAtRound).toBe(0);
  const reloaded = await runner.getTask(task.id, { ownerId: "user-1" });
  expect(reloaded.status).toBe("complete");
  expect(reloaded.rounds?.some((round) => round.type === "verdict")).toBe(true);
});

test("BLOCKED verdict moves the task to needs-user without advancing the round", async () => {
  const { runner, task } = await makeJudgeRunningTask();
  await writeVerdict(task.taskDir, 0, "BLOCKED");

  const updated = await runner.handleJudgeCompletion(
    "user-1",
    "term-j",
    "claude",
  );

  expect(updated?.status).toBe("needs-user");
  expect(updated?.round).toBe(0);
  expect(updated?.processedVerdictAtRound).toBe(0);
});

test("NEEDS_WORK with rounds remaining readies the next round with prompt + judge message", async () => {
  const { runner, task } = await makeJudgeRunningTask({ maxRounds: 3 });
  await writeVerdict(task.taskDir, 0, "NEEDS_WORK", "fix the tests");

  const updated = await runner.handleJudgeCompletion(
    "user-1",
    "term-j",
    "claude",
  );

  expect(updated?.status).toBe("ready");
  expect(updated?.round).toBe(1);
  expect(updated?.processedVerdictAtRound).toBe(0);

  const workerPrompt = await readFile(
    join(task.taskDir, "WORKER_PROMPT.md"),
    "utf8",
  );
  expect(workerPrompt).toContain("fix the tests");
  expect(workerPrompt).toContain("Previous judge feedback (round 0)");

  const messages = readTaskMessages(taskMessagesPath(task.taskDir));
  expect(messages).toHaveLength(1);
  expect(messages[0]?.from).toBe("judge");
  expect(messages[0]?.body).toBe("fix the tests");

  // Next round's worker command reads WORKER_PROMPT.md, same command shape.
  const reloaded = await runner.getTask(task.id, { ownerId: "user-1" });
  const command = buildWorkerCommand(reloaded);
  expect(command).toContain(
    `claude "$(cat '${task.taskDir}/WORKER_PROMPT.md')"`,
  );
  expect(command).toContain("export DECKTERM_TASK_ID=");
});

test("NEEDS_WORK at the final round exhausts maxRounds into needs-user", async () => {
  const { runner, task } = await makeJudgeRunningTask({ maxRounds: 1 });
  await writeVerdict(task.taskDir, 0, "NEEDS_WORK");

  const updated = await runner.handleJudgeCompletion(
    "user-1",
    "term-j",
    "claude",
  );

  expect(updated?.status).toBe("needs-user");
  expect(updated?.round).toBe(0);
  expect(updated?.processedVerdictAtRound).toBe(0);
});

test("round-mismatched verdict payload is rejected -> needs-user fallback", async () => {
  const { runner, task } = await makeJudgeRunningTask();
  // File verdict-r0.json claims round 1 inside: a stale/forged payload must
  // never satisfy round 0.
  await writeVerdict(task.taskDir, 0, "PASS", "stale", 1);

  const updated = await runner.handleJudgeCompletion(
    "user-1",
    "term-j",
    "claude",
  );

  expect(updated?.status).toBe("needs-user");
  expect(updated?.processedVerdictAtRound).toBeNull();
});

test("symlinked verdict file is rejected -> needs-user fallback", async () => {
  const { runner, task } = await makeJudgeRunningTask();
  const real = join(await createTempDir(), "outside.json");
  await writeFile(real, JSON.stringify({ round: 0, verdict: "PASS" }));
  symlinkSync(real, join(task.taskDir, "verdict-r0.json"));

  const updated = await runner.handleJudgeCompletion(
    "user-1",
    "term-j",
    "claude",
  );

  expect(updated?.status).toBe("needs-user");
});

test("agent-done with no verdict file falls back to needs-user (judge-done event)", async () => {
  const { runner, task } = await makeJudgeRunningTask();

  const updated = await runner.handleJudgeCompletion(
    "user-1",
    "term-j",
    "claude",
  );

  expect(updated?.status).toBe("needs-user");
  expect(await readFile(task.controlFiles.roundsFile, "utf8")).toContain(
    '"type":"judge-done"',
  );
});

test("provider mismatch and non-judge terminals never trigger verdict processing", async () => {
  const { runner, task } = await makeJudgeRunningTask();
  await writeVerdict(task.taskDir, 0, "PASS");

  // Wrong provider on the judge terminal.
  expect(
    await runner.handleJudgeCompletion("user-1", "term-j", "codex"),
  ).toBeNull();
  // Right provider on a non-judge terminal.
  expect(
    await runner.handleJudgeCompletion("user-1", "term-w", "claude"),
  ).toBeNull();
  // Unknown terminal / empty args.
  expect(
    await runner.handleJudgeCompletion("user-1", "term-x", "claude"),
  ).toBeNull();
  expect(await runner.handleJudgeCompletion("user-1", "", "claude")).toBeNull();

  const reloaded = await runner.getTask(task.id, { ownerId: "user-1" });
  expect(reloaded.status).toBe("judge-running");
});

test("double-fire (agent-done twice, then terminal exit) processes the verdict exactly once", async () => {
  const { runner, task } = await makeJudgeRunningTask({ maxRounds: 3 });
  await writeVerdict(task.taskDir, 0, "NEEDS_WORK", "one more pass");

  // Concurrent double-fire: the mutex serializes, the second call must bail.
  const [first, second] = await Promise.all([
    runner.handleJudgeCompletion("user-1", "term-j", "claude"),
    runner.handleJudgeCompletion("user-1", "term-j", "claude"),
  ]);
  const outcomes = [first, second].filter(Boolean);
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]?.status).toBe("ready");
  expect(outcomes[0]?.round).toBe(1);

  // Late terminal-exit fallback for the same completion: no further change.
  expect(await runner.handleTerminalExit("user-1", "term-j")).toBeNull();

  const reloaded = await runner.getTask(task.id, { ownerId: "user-1" });
  expect(reloaded.status).toBe("ready");
  expect(reloaded.round).toBe(1);
  const messages = readTaskMessages(taskMessagesPath(task.taskDir));
  expect(messages).toHaveLength(1);
});

test("a verdict file pre-created before the judge attempt is discarded on judge start", async () => {
  const projectRoot = await createTempDir();
  const stateDir = await createTempDir();
  const runner = createTaskRunner({
    stateDir,
    resolveAllowedPath: async (value) =>
      value === projectRoot ? projectRoot : null,
    runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  });
  const created = await runner.createTask(
    {
      title: "Freshness",
      description: "Stale verdicts must not survive judge start.",
      projectRoot,
      workerProvider: "claude",
      judgeProvider: "claude",
      useWorktree: false,
    },
    { ownerId: "user-1" },
  );
  // A verdict planted BEFORE the judge attempt (e.g. by the worker, or left
  // over from an aborted run) — markJudgeStarted must remove it.
  await writeVerdict(created.taskDir, 0, "PASS", "forged");
  await runner.markJudgeStarted(created.id, { ownerId: "user-1" }, "term-j");

  const updated = await runner.handleJudgeCompletion(
    "user-1",
    "term-j",
    "claude",
  );

  // No verdict left on disk for round 0 -> needs-user fallback, NOT complete.
  expect(updated?.status).toBe("needs-user");
  expect(updated?.processedVerdictAtRound).toBeNull();
});

test("terminal-exit fallback processes an on-disk verdict when there was no agent-done", async () => {
  const { runner, task } = await makeJudgeRunningTask();
  await writeVerdict(task.taskDir, 0, "PASS");

  const updated = await runner.handleTerminalExit("user-1", "term-j");

  expect(updated?.status).toBe("complete");
  expect(updated?.processedVerdictAtRound).toBe(0);
});

test("legacy task.json without round fields loads as round 0 / unprocessed", async () => {
  const { runner, task } = await makeJudgeRunningTask();
  // Strip the new fields from the persisted record to simulate a legacy task.
  const taskJsonPath = join(task.taskDir, "task.json");
  const persisted = JSON.parse(await readFile(taskJsonPath, "utf8"));
  delete persisted.round;
  delete persisted.processedVerdictAtRound;
  await writeFile(taskJsonPath, JSON.stringify(persisted, null, 2));

  const reloaded = await runner.getTask(task.id, { ownerId: "user-1" });
  expect(reloaded.round).toBe(0);
  expect(reloaded.processedVerdictAtRound).toBeNull();

  await writeVerdict(task.taskDir, 0, "PASS");
  const updated = await runner.handleJudgeCompletion(
    "user-1",
    "term-j",
    "claude",
  );
  expect(updated?.status).toBe("complete");
});

test("judge prompt renders the round-scoped verdict path and schema", async () => {
  const { runner, task } = await makeJudgeRunningTask();

  const prompt = await runner.buildJudgePrompt(task.id, { ownerId: "user-1" });

  expect(prompt).toContain(join(task.taskDir, "verdict-r0.json"));
  expect(prompt).toContain('"round": 0');
  expect(prompt).toContain("NEEDS_WORK");
  // Composed sections still present (git status/diff/check run).
  expect(prompt).toContain("## Git Status");
  expect(prompt).toContain("## Last Check Run");
});
