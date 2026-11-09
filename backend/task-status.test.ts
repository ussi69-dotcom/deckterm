import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  RUNNING_TASK_STATUSES,
  TASK_STATUSES,
  TASK_TRANSITIONS,
  canSetTaskStatusManually,
  nextTaskStatus,
  type TaskStatus,
} from "./task-status";
import { createTaskRunner, type CommandResult } from "./task-runner";

// The browser modules are plain JS with no type declarations.
const { taskActionAvailability, RUNNING_STATUSES } = require("../web/task-signals.js") as {
  taskActionAvailability: (status: string) => Record<string, boolean>;
  RUNNING_STATUSES: Set<string>;
};
const { TASK_BOARD_COLUMNS } = require("../web/task-board.js") as {
  TASK_BOARD_COLUMNS: Array<{ id: string; statuses: string[] }>;
};

const tempDirs: string[] = [];
const OWNER = { ownerId: "user-1" };
const OK: CommandResult = { exitCode: 0, stdout: "", stderr: "" };

async function createTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "deckterm-task-status-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(condition()).toBe(true);
}

async function makeRunner(
  runCommand: () => Promise<CommandResult> = async () => OK,
  stateDir?: string,
) {
  const projectRoot = await createTempDir();
  const resolvedStateDir = stateDir ?? (await createTempDir());
  const runner = createTaskRunner({
    stateDir: resolvedStateDir,
    resolveAllowedPath: async (value) =>
      value === projectRoot ? projectRoot : null,
    runCommand,
  });
  const task = await runner.createTask(
    {
      title: "Lifecycle",
      description: "Lifecycle table behaviour.",
      projectRoot,
      workerProvider: "claude",
      judgeProvider: "claude",
      useWorktree: false,
      checks: [{ label: "unit", command: "true" }],
    },
    OWNER,
  );
  return { runner, task, stateDir: resolvedStateDir, projectRoot };
}

// Holds the check command open, so a test can act while checks are running.
async function makeRunnerWithBlockedChecks() {
  const gate = deferred<CommandResult>();
  let commandStarted = false;
  const made = await makeRunner(() => {
    commandStarted = true;
    return gate.promise;
  });
  const checks = made.runner.runChecks(made.task.id, OWNER);
  await waitFor(() => commandStarted);
  return { ...made, gate, checks };
}

async function writeStoredStatus(task: { taskDir: string }, status: string) {
  const path = join(task.taskDir, "task.json");
  const stored = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...stored, status }));
}

const launch = async () => ({ terminalId: "term-new" });

// -- The table ---------------------------------------------------------------

test("the table only names known statuses", () => {
  const known = new Set<string>(TASK_STATUSES);
  for (const rule of Object.values(TASK_TRANSITIONS)) {
    expect(known.has(rule.to)).toBe(true);
    for (const from of rule.from) expect(known.has(from)).toBe(true);
  }
});

test("a running phase can only be left by its own finishing events", () => {
  expect(nextTaskStatus("worker-running", "start-judge")).toBeNull();
  expect(nextTaskStatus("judge-running", "start-checks")).toBeNull();
  expect(nextTaskStatus("checks-running", "start-worker")).toBeNull();
  expect(nextTaskStatus("checks-running", "checks-passed")).toBe("needs-judge");
  expect(nextTaskStatus("worker-running", "worker-exited")).toBe("needs-user");
});

test("manual status changes cannot claim that a phase is running", () => {
  for (const status of RUNNING_TASK_STATUSES) {
    expect(canSetTaskStatusManually(status)).toBe(false);
  }
  expect(canSetTaskStatusManually("paused")).toBe(true);
  expect(canSetTaskStatusManually("nonsense")).toBe(false);
});

// -- Browser and server agree ------------------------------------------------

test("browser buttons match the server's table for every status", () => {
  for (const status of TASK_STATUSES) {
    expect(taskActionAvailability(status)).toEqual({
      start: nextTaskStatus(status, "start-worker") !== null,
      checks: nextTaskStatus(status, "start-checks") !== null,
      judge: nextTaskStatus(status, "start-judge") !== null,
    });
  }
});

test("the browser's running list and board columns cover the table", () => {
  expect([...RUNNING_STATUSES].sort()).toEqual([...RUNNING_TASK_STATUSES].sort());
  const running = TASK_BOARD_COLUMNS.find((column) => column.id === "running");
  expect([...running!.statuses].sort()).toEqual([...RUNNING_TASK_STATUSES].sort());
  const onBoard = TASK_BOARD_COLUMNS.flatMap((column) => column.statuses);
  expect([...onBoard].sort()).toEqual([...TASK_STATUSES].sort());
});

// -- Starting phases ---------------------------------------------------------

test.each([...RUNNING_TASK_STATUSES] as TaskStatus[])(
  "launchWorker refuses a task on %s and creates no terminal",
  async (status) => {
    const gate = deferred<CommandResult>();
    let commandStarted = false;
    const { runner, task } = await makeRunner(() => {
      commandStarted = true;
      return gate.promise;
    });
    if (status === "checks-running") {
      void runner.runChecks(task.id, OWNER).catch(() => undefined);
      await waitFor(() => commandStarted);
    } else if (status === "worker-running") {
      await runner.markWorkerStarted(task.id, OWNER, "term-1");
    } else {
      await runner.markJudgeStarted(task.id, OWNER, "term-1");
    }

    let launched = 0;
    await expect(
      runner.launchWorker(task.id, OWNER, async () => {
        launched += 1;
        return { terminalId: "term-2" };
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(launched).toBe(0);
    gate.resolve(OK);
  },
);

test("two concurrent starts launch exactly one worker", async () => {
  const { runner, task } = await makeRunner();
  let launched = 0;
  const startOne = () =>
    runner.launchWorker(task.id, OWNER, async () => {
      launched += 1;
      return { terminalId: `term-${launched}` };
    });
  const outcomes = await Promise.allSettled([startOne(), startOne()]);
  expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect(launched).toBe(1);
});

test("a complete task cannot start a worker but can be judged again", async () => {
  const { runner, task } = await makeRunner();
  await runner.updateTask(task.id, OWNER, { status: "complete" });
  await expect(
    runner.launchWorker(task.id, OWNER, launch),
  ).rejects.toMatchObject({ status: 409 });
  const { task: judged, launched } = await runner.launchJudge(
    task.id,
    OWNER,
    launch,
  );
  expect(judged.status).toBe("judge-running");
  expect(judged.judgeTerminalId).toBe(launched.terminalId);
});

test("a failed launch leaves the task where it was", async () => {
  const { runner, task } = await makeRunner();
  await expect(
    runner.launchWorker(task.id, OWNER, async () => {
      throw new Error("terminal limit");
    }),
  ).rejects.toThrow("terminal limit");
  expect((await runner.getTask(task.id, OWNER)).status).toBe("ready");
});

test("a repeated check run is refused while one is running", async () => {
  const { runner, task, gate, checks } = await makeRunnerWithBlockedChecks();
  await expect(runner.runChecks(task.id, OWNER)).rejects.toMatchObject({
    status: 409,
  });
  gate.resolve(OK);
  expect((await checks).status).toBe("needs-judge");
});

// -- Status edits ------------------------------------------------------------

test("updateTask rejects unknown and running statuses without touching the task", async () => {
  const { runner, task } = await makeRunner();
  for (const status of ["nonsense", "worker-running"]) {
    await expect(
      runner.updateTask(task.id, OWNER, { status: status as TaskStatus }),
    ).rejects.toMatchObject({ status: 400 });
  }
  expect((await runner.getTask(task.id, OWNER)).status).toBe("ready");
});

test("a stored status outside the table reads as needs-user", async () => {
  const { runner, task } = await makeRunner();
  await writeStoredStatus(task, "nonsense");
  expect((await runner.getTask(task.id, OWNER)).status).toBe("needs-user");
});

// -- Checks that outlive their claim -----------------------------------------

test("pausing during checks is not overwritten when they finish", async () => {
  const { runner, task, gate, checks } = await makeRunnerWithBlockedChecks();
  await runner.updateTask(task.id, OWNER, { status: "paused" });
  gate.resolve(OK);
  const finished = await checks;
  expect(finished.status).toBe("paused");
  expect(finished.lastCheckRun?.success).toBe(true);
});

test("an edit made during checks survives the end of the run", async () => {
  const { runner, task, gate, checks } = await makeRunnerWithBlockedChecks();
  await runner.updateTask(task.id, OWNER, { title: "Renamed meanwhile" });
  gate.resolve(OK);
  const finished = await checks;
  expect(finished.title).toBe("Renamed meanwhile");
  expect(finished.status).toBe("needs-judge");
});

test("a superseded check run cannot finish the newer run", async () => {
  const gates = [deferred<CommandResult>(), deferred<CommandResult>()];
  let started = 0;
  const { runner, task } = await makeRunner(() => gates[started++].promise);
  const first = runner.runChecks(task.id, OWNER);
  await waitFor(() => started === 1);
  await runner.updateTask(task.id, OWNER, { status: "ready" });
  const second = runner.runChecks(task.id, OWNER);
  await waitFor(() => started === 2);

  gates[0].resolve({ ...OK, exitCode: 1 });
  expect((await first).status).toBe("checks-running");

  gates[1].resolve(OK);
  const finished = await second;
  expect(finished.status).toBe("needs-judge");
  expect(finished.lastCheckRun?.success).toBe(true);
});

test("a check command that cannot start fails the run instead of locking the task", async () => {
  const { runner, task } = await makeRunner(async () => {
    throw new Error("cwd is gone");
  });
  const finished = await runner.runChecks(task.id, OWNER);
  expect(finished.status).toBe("needs-user");
  expect(finished.lastCheckRun?.success).toBe(false);
  expect(finished.lastCheckRun?.results[0].stderr).toContain("cwd is gone");
});

test("a task deleted during checks stays deleted", async () => {
  const { runner, task, gate, checks } = await makeRunnerWithBlockedChecks();
  await runner.deleteTask(task.id, OWNER);
  gate.resolve(OK);
  await expect(checks).rejects.toMatchObject({ status: 404 });
  await expect(runner.getTask(task.id, OWNER)).rejects.toMatchObject({
    status: 404,
  });
});

// -- Restart -----------------------------------------------------------------

test("checks abandoned by a restart unlock the task when it is next read", async () => {
  const { task, stateDir, gate, checks, projectRoot } =
    await makeRunnerWithBlockedChecks();
  const restarted = createTaskRunner({
    stateDir,
    resolveAllowedPath: async (value) =>
      value === projectRoot ? projectRoot : null,
    runCommand: async () => OK,
  });

  const [listed] = await restarted.listTasks(OWNER.ownerId);
  expect(listed.status).toBe("needs-user");
  expect(listed.activeCheckRunId).toBeNull();
  const reloaded = await restarted.getTask(task.id, OWNER);
  expect(reloaded.status).toBe("needs-user");
  expect(
    reloaded.rounds?.filter((round) => round.type === "checks-interrupted"),
  ).toHaveLength(1);

  gate.resolve(OK);
  await checks.catch(() => undefined);
});

test("a record from before the run id existed recovers too", async () => {
  const { runner, task } = await makeRunner();
  await writeStoredStatus(task, "checks-running");
  expect((await runner.getTask(task.id, OWNER)).status).toBe("needs-user");
});

test("checks running in this process are left alone by reads", async () => {
  const { runner, task, gate, checks } = await makeRunnerWithBlockedChecks();
  expect((await runner.getTask(task.id, OWNER)).status).toBe("checks-running");
  const [listed] = await runner.listTasks(OWNER.ownerId);
  expect(listed.status).toBe("checks-running");
  gate.resolve(OK);
  expect((await checks).status).toBe("needs-judge");
});

test("a worker terminal surviving a restart stays running", async () => {
  const { task, stateDir, projectRoot, runner } = await makeRunner();
  await runner.markWorkerStarted(task.id, OWNER, "term-1");
  const restarted = createTaskRunner({
    stateDir,
    resolveAllowedPath: async (value) =>
      value === projectRoot ? projectRoot : null,
    runCommand: async () => OK,
  });
  expect((await restarted.getTask(task.id, OWNER)).status).toBe("worker-running");
});
