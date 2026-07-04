// Phase 0 parity snapshots (Traycer patterns plan, docs/plans/2026-07-04-traycer-patterns.md).
// These capture TODAY's exact behavior before the harness-registry / verdict-loop
// refactors (S1/S2/S6). If one of these fails after a refactor, the refactor broke
// the byte-identical legacy invariant — fix the code, never the expected strings.
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildJudgeCommand,
  buildWorkerCommand,
  createTaskRunner,
  type TaskProvider,
  type TaskRecord,
  type TaskStatus,
} from "./task-runner";

const tempDirs: string[] = [];

async function createTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "deckterm-task-golden-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

// -- Command-builder golden strings ------------------------------------------

// Hostile path: spaces, single quote, double quotes, and a $ that must never expand.
const HOSTILE_DIR = `/tmp/deck term/it's a "task" $HOME`;

function makeTask(
  workerProvider: TaskProvider,
  judgeProvider: TaskProvider,
  taskDir: string,
  title: string,
): TaskRecord {
  return {
    id: "task-golden-1",
    slug: "golden",
    title,
    description: "golden snapshot",
    projectRoot: taskDir,
    workingDirectory: taskDir,
    ownerId: "user-1",
    workerProvider,
    judgeProvider,
    useWorktree: false,
    branchName: null,
    status: "ready",
    checks: [],
    controlFiles: {
      taskFile: `${taskDir}/TASK.md`,
      todoFile: `${taskDir}/TODO.md`,
      judgePromptFile: `${taskDir}/JUDGE_PROMPT.md`,
      checksFile: `${taskDir}/checks.json`,
      roundsFile: `${taskDir}/rounds.jsonl`,
    },
    taskDir,
    terminalId: null,
    judgeTerminalId: null,
    lastCheckRun: null,
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
  };
}

// shellQuote today: wrap in single quotes, ' -> '\''
const Q_DIR = `/tmp/deck term/it'\\''s a "task" $HOME`;

test("buildWorkerCommand golden string (claude, hostile path)", () => {
  const task = makeTask("claude", "claude", HOSTILE_DIR, 'Fix "quoted" thing');
  expect(buildWorkerCommand(task)).toBe(
    [
      `export DECKTERM_TASK_ID='task-golden-1'`,
      `export DECKTERM_TASK_FILE='${Q_DIR}/TASK.md'`,
      `export DECKTERM_TODO_FILE='${Q_DIR}/TODO.md'`,
      `export DECKTERM_CHECKS_FILE='${Q_DIR}/checks.json'`,
      `echo "DeckTerm task: Fix \\"quoted\\" thing"`,
      `echo "Task file: ${HOSTILE_DIR}/TASK.md"`,
      `claude "$(cat '${Q_DIR}/TASK.md')"`,
    ].join("\n"),
  );
});

test("buildWorkerCommand golden string (codex, plain path)", () => {
  const task = makeTask("codex", "codex", "/home/deploy/proj", "Plain task");
  expect(buildWorkerCommand(task)).toBe(
    [
      `export DECKTERM_TASK_ID='task-golden-1'`,
      `export DECKTERM_TASK_FILE='/home/deploy/proj/TASK.md'`,
      `export DECKTERM_TODO_FILE='/home/deploy/proj/TODO.md'`,
      `export DECKTERM_CHECKS_FILE='/home/deploy/proj/checks.json'`,
      `echo "DeckTerm task: Plain task"`,
      `echo "Task file: /home/deploy/proj/TASK.md"`,
      `codex "$(cat '/home/deploy/proj/TASK.md')"`,
    ].join("\n"),
  );
});

test("buildJudgeCommand golden string (claude, hostile path)", () => {
  const task = makeTask("codex", "claude", HOSTILE_DIR, 'Fix "quoted" thing');
  expect(buildJudgeCommand(task)).toBe(
    [
      `export DECKTERM_TASK_ID='task-golden-1'`,
      `export DECKTERM_JUDGE_PROMPT_FILE='${Q_DIR}/JUDGE_PROMPT.md'`,
      `echo "DeckTerm judge: Fix \\"quoted\\" thing"`,
      `echo "Judge prompt: ${HOSTILE_DIR}/JUDGE_PROMPT.md"`,
      `claude "$(cat '${Q_DIR}/JUDGE_PROMPT.md')"`,
    ].join("\n"),
  );
});

test("buildJudgeCommand golden string (codex, plain path)", () => {
  const task = makeTask("claude", "codex", "/home/deploy/proj", "Plain task");
  expect(buildJudgeCommand(task)).toBe(
    [
      `export DECKTERM_TASK_ID='task-golden-1'`,
      `export DECKTERM_JUDGE_PROMPT_FILE='/home/deploy/proj/JUDGE_PROMPT.md'`,
      `echo "DeckTerm judge: Plain task"`,
      `echo "Judge prompt: /home/deploy/proj/JUDGE_PROMPT.md"`,
      `codex "$(cat '/home/deploy/proj/JUDGE_PROMPT.md')"`,
    ].join("\n"),
  );
});

// -- handleTerminalExit behavior matrix ---------------------------------------

async function makeRunnerWithTask() {
  const projectRoot = await createTempDir();
  const stateDir = await createTempDir();
  const runner = createTaskRunner({
    stateDir,
    resolveAllowedPath: async (value) =>
      value === projectRoot ? projectRoot : null,
    runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  });
  const task = await runner.createTask(
    {
      title: "Exit matrix",
      description: "Golden exit behavior.",
      projectRoot,
      workerProvider: "claude",
      judgeProvider: "claude",
      useWorktree: false,
    },
    { ownerId: "user-1" },
  );
  return { runner, task };
}

test("exit matrix: worker terminal on worker-running -> needs-user + worker-exited event", async () => {
  const { runner, task } = await makeRunnerWithTask();
  await runner.markWorkerStarted(task.id, { ownerId: "user-1" }, "term-w");

  const updated = await runner.handleTerminalExit("user-1", "term-w");

  expect(updated?.status).toBe("needs-user");
  expect(await readFile(task.controlFiles.roundsFile, "utf8")).toContain(
    '"type":"worker-exited"',
  );
});

test("exit matrix: judge terminal on judge-running -> needs-user + judge-exited event", async () => {
  const { runner, task } = await makeRunnerWithTask();
  await runner.markJudgeStarted(task.id, { ownerId: "user-1" }, "term-j");

  const updated = await runner.handleTerminalExit("user-1", "term-j");

  expect(updated?.status).toBe("needs-user");
  expect(await readFile(task.controlFiles.roundsFile, "utf8")).toContain(
    '"type":"judge-exited"',
  );
});

test("exit matrix: worker terminal exit in a non-running status is a no-op", async () => {
  const nonRunning: TaskStatus[] = ["needs-judge", "needs-user", "paused"];
  for (const status of nonRunning) {
    const { runner, task } = await makeRunnerWithTask();
    await runner.markWorkerStarted(task.id, { ownerId: "user-1" }, "term-w");
    await runner.updateTask(task.id, { ownerId: "user-1" }, { status });

    const updated = await runner.handleTerminalExit("user-1", "term-w");

    expect(updated).toBeNull();
    const reloaded = await runner.getTask(task.id, { ownerId: "user-1" });
    expect(reloaded.status).toBe(status);
  }
});

test("exit matrix: worker terminal exit while judge-running is a no-op", async () => {
  const { runner, task } = await makeRunnerWithTask();
  await runner.markWorkerStarted(task.id, { ownerId: "user-1" }, "term-w");
  await runner.markJudgeStarted(task.id, { ownerId: "user-1" }, "term-j");

  const updated = await runner.handleTerminalExit("user-1", "term-w");

  expect(updated).toBeNull();
  const reloaded = await runner.getTask(task.id, { ownerId: "user-1" });
  expect(reloaded.status).toBe("judge-running");
});

test("exit matrix: judge terminal exit while worker-running is a no-op", async () => {
  const { runner, task } = await makeRunnerWithTask();
  // record the judge terminal id first, then put the task back into worker-running
  await runner.markJudgeStarted(task.id, { ownerId: "user-1" }, "term-j");
  await runner.markWorkerStarted(task.id, { ownerId: "user-1" }, "term-w");

  const updated = await runner.handleTerminalExit("user-1", "term-j");

  expect(updated).toBeNull();
  const reloaded = await runner.getTask(task.id, { ownerId: "user-1" });
  expect(reloaded.status).toBe("worker-running");
});

test("exit matrix: unknown and empty terminal ids are no-ops", async () => {
  const { runner, task } = await makeRunnerWithTask();
  await runner.markWorkerStarted(task.id, { ownerId: "user-1" }, "term-w");

  expect(await runner.handleTerminalExit("user-1", "term-nope")).toBeNull();
  expect(await runner.handleTerminalExit("user-1", "")).toBeNull();
  const reloaded = await runner.getTask(task.id, { ownerId: "user-1" });
  expect(reloaded.status).toBe("worker-running");
});
