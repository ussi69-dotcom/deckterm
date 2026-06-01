import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTaskRunner,
  detectVerificationCommands,
  slugifyTaskTitle,
} from "./task-runner";

const tempDirs: string[] = [];

async function createTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "deckterm-task-runner-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

test("slugifyTaskTitle produces stable branch-safe slugs", () => {
  expect(slugifyTaskTitle("Add Worker/Judge MVP!")).toBe(
    "add-worker-judge-mvp",
  );
  expect(slugifyTaskTitle("   ")).toBe("task");
});

test("detectVerificationCommands prefers bun package scripts in priority order", async () => {
  const projectRoot = await createTempDir();
  await writeFile(
    join(projectRoot, "package.json"),
    JSON.stringify({
      scripts: {
        build: "vite build",
        "test:unit": "bun test",
        lint: "eslint .",
      },
    }),
  );
  await writeFile(join(projectRoot, "bun.lock"), "");

  expect(await detectVerificationCommands(projectRoot)).toEqual([
    { id: "test-unit", label: "test:unit", command: "bun run test:unit" },
    { id: "lint", label: "lint", command: "bun run lint" },
    { id: "build", label: "build", command: "bun run build" },
  ]);
});

test("detectVerificationCommands falls back to npm for generic package projects", async () => {
  const projectRoot = await createTempDir();
  await writeFile(
    join(projectRoot, "package.json"),
    JSON.stringify({
      scripts: {
        test: "vitest",
      },
    }),
  );

  expect(await detectVerificationCommands(projectRoot)).toEqual([
    { id: "test", label: "test", command: "npm run test" },
  ]);
});

test("createTask writes task metadata and control files under state dir", async () => {
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
      title: "Fix mobile shell",
      description: "Stabilize mobile task workspace.",
      projectRoot,
      workerProvider: "codex",
      judgeProvider: "claude",
      useWorktree: false,
      checks: [{ label: "unit", command: "bun run test:unit" }],
    },
    { ownerId: "user-1" },
  );

  expect(task.status).toBe("ready");
  expect(task.workingDirectory).toBe(projectRoot);
  expect(task.controlFiles.taskFile).toEndWith("/TASK.md");
  expect(await readFile(task.controlFiles.taskFile, "utf8")).toContain(
    "Fix mobile shell",
  );
  expect(await readFile(task.controlFiles.checksFile, "utf8")).toContain(
    "bun run test:unit",
  );
  expect(await runner.listTasks("user-1")).toHaveLength(1);
});

test("createTask rejects project roots outside allowed filesystem roots", async () => {
  const stateDir = await createTempDir();
  const runner = createTaskRunner({
    stateDir,
    resolveAllowedPath: async () => null,
    runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  });

  await expect(
    runner.createTask(
      {
        title: "Unsafe",
        description: "Nope",
        projectRoot: "/etc",
        workerProvider: "codex",
        judgeProvider: "codex",
        useWorktree: false,
      },
      { ownerId: "user-1" },
    ),
  ).rejects.toMatchObject({ status: 403 });
});

test("createTask rejects providers outside the configured allow-list", async () => {
  const projectRoot = await createTempDir();
  const stateDir = await createTempDir();
  const runner = createTaskRunner({
    stateDir,
    allowedProviders: ["codex"],
    resolveAllowedPath: async (value) =>
      value === projectRoot ? projectRoot : null,
    runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  });

  await expect(
    runner.createTask(
      {
        title: "Provider check",
        description: "Reject disabled providers.",
        projectRoot,
        workerProvider: "claude",
        judgeProvider: "codex",
        useWorktree: false,
      },
      { ownerId: "user-1" },
    ),
  ).rejects.toMatchObject({ status: 400 });
});

test("createTask can isolate work in a generated git worktree", async () => {
  const projectRoot = await createTempDir();
  const stateDir = await createTempDir();
  const calls: { cwd: string; args: string[] }[] = [];
  const runner = createTaskRunner({
    stateDir,
    resolveAllowedPath: async (value) =>
      value === projectRoot ? projectRoot : null,
    runCommand: async ({ cwd, args }) => {
      calls.push({ cwd, args });
      if (args.join(" ") === "git rev-parse --show-toplevel") {
        return { exitCode: 0, stdout: `${projectRoot}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  const task = await runner.createTask(
    {
      title: "Agent Loop",
      description: "Use isolated branch.",
      projectRoot,
      workerProvider: "codex",
      judgeProvider: "codex",
      useWorktree: true,
    },
    { ownerId: "user-1" },
  );

  expect(task.useWorktree).toBe(true);
  expect(task.branchName).toStartWith("deckterm/task/agent-loop-");
  expect(task.workingDirectory).toContain("/worktrees/");
  expect(task.workingDirectory).toContain("/agent-loop-");
  expect(
    calls.some((call) => call.args[0] === "git" && call.args[1] === "worktree"),
  ).toBe(true);
});

test("createTask links node_modules into the worktree when the repo has dependencies", async () => {
  const projectRoot = await createTempDir();
  const stateDir = await createTempDir();
  await mkdir(join(projectRoot, "node_modules"));
  const calls: { cwd: string; args: string[] }[] = [];
  const runner = createTaskRunner({
    stateDir,
    resolveAllowedPath: async (value) =>
      value === projectRoot ? projectRoot : null,
    runCommand: async ({ cwd, args }) => {
      calls.push({ cwd, args });
      if (args.join(" ") === "git rev-parse --show-toplevel") {
        return { exitCode: 0, stdout: `${projectRoot}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  const task = await runner.createTask(
    {
      title: "Needs deps",
      description: "Worktree should reuse node_modules.",
      projectRoot,
      workerProvider: "codex",
      judgeProvider: "codex",
      useWorktree: true,
    },
    { ownerId: "user-1" },
  );

  expect(
    calls.some(
      (call) =>
        call.args[0] === "ln" &&
        call.args.includes(join(projectRoot, "node_modules")) &&
        call.args.includes(join(task.workingDirectory, "node_modules")),
    ),
  ).toBe(true);
});

test("createTask skips node_modules link when the repo has no dependencies", async () => {
  const projectRoot = await createTempDir();
  const stateDir = await createTempDir();
  const calls: { cwd: string; args: string[] }[] = [];
  const runner = createTaskRunner({
    stateDir,
    resolveAllowedPath: async (value) =>
      value === projectRoot ? projectRoot : null,
    runCommand: async ({ cwd, args }) => {
      calls.push({ cwd, args });
      if (args.join(" ") === "git rev-parse --show-toplevel") {
        return { exitCode: 0, stdout: `${projectRoot}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  await runner.createTask(
    {
      title: "No deps",
      description: "Nothing to link.",
      projectRoot,
      workerProvider: "codex",
      judgeProvider: "codex",
      useWorktree: true,
    },
    { ownerId: "user-1" },
  );

  expect(calls.some((call) => call.args[0] === "ln")).toBe(false);
});

test("handleTerminalExit advances a stuck worker-running task to needs-user", async () => {
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
      title: "Worker exit",
      description: "Sync status when worker terminal ends.",
      projectRoot,
      workerProvider: "codex",
      judgeProvider: "codex",
      useWorktree: false,
    },
    { ownerId: "user-1" },
  );
  await runner.markWorkerStarted(task.id, { ownerId: "user-1" }, "term-worker");

  const updated = await runner.handleTerminalExit("user-1", "term-worker");

  expect(updated?.status).toBe("needs-user");
  expect(await readFile(task.controlFiles.roundsFile, "utf8")).toContain(
    "worker-exited",
  );
  const reloaded = await runner.getTask(task.id, { ownerId: "user-1" });
  expect(reloaded.status).toBe("needs-user");
});

test("handleTerminalExit advances a stuck judge-running task to needs-user", async () => {
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
      title: "Judge exit",
      description: "Sync status when judge terminal ends.",
      projectRoot,
      workerProvider: "codex",
      judgeProvider: "codex",
      useWorktree: false,
    },
    { ownerId: "user-1" },
  );
  await runner.markJudgeStarted(task.id, { ownerId: "user-1" }, "term-judge");

  const updated = await runner.handleTerminalExit("user-1", "term-judge");

  expect(updated?.status).toBe("needs-user");
});

test("handleTerminalExit ignores terminals not bound to a running task", async () => {
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
      title: "Unrelated exit",
      description: "Other terminals must not move task status.",
      projectRoot,
      workerProvider: "codex",
      judgeProvider: "codex",
      useWorktree: false,
    },
    { ownerId: "user-1" },
  );
  await runner.markWorkerStarted(task.id, { ownerId: "user-1" }, "term-worker");

  const updated = await runner.handleTerminalExit("user-1", "some-other-term");

  expect(updated).toBeNull();
  const reloaded = await runner.getTask(task.id, { ownerId: "user-1" });
  expect(reloaded.status).toBe("worker-running");
});

test("deleteTask removes the git worktree before deleting task metadata", async () => {
  const projectRoot = await createTempDir();
  const stateDir = await createTempDir();
  const calls: { cwd: string; args: string[] }[] = [];
  const runner = createTaskRunner({
    stateDir,
    resolveAllowedPath: async (value) =>
      value === projectRoot ? projectRoot : null,
    runCommand: async ({ cwd, args }) => {
      calls.push({ cwd, args });
      if (args.join(" ") === "git rev-parse --show-toplevel") {
        return { exitCode: 0, stdout: `${projectRoot}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  const task = await runner.createTask(
    {
      title: "Delete isolated task",
      description: "Remove worktree with metadata.",
      projectRoot,
      workerProvider: "codex",
      judgeProvider: "codex",
      useWorktree: true,
    },
    { ownerId: "user-1" },
  );

  await runner.deleteTask(task.id, { ownerId: "user-1" });

  expect(
    calls.some(
      (call) =>
        call.cwd === projectRoot &&
        call.args.join(" ") ===
          `git worktree remove --force ${task.workingDirectory}`,
    ),
  ).toBe(true);
  await expect(
    runner.getTask(task.id, { ownerId: "user-1" }),
  ).rejects.toMatchObject({
    status: 404,
  });
});

test("runChecks records command output and moves successful tasks to needs-judge", async () => {
  const projectRoot = await createTempDir();
  const stateDir = await createTempDir();
  const runner = createTaskRunner({
    stateDir,
    resolveAllowedPath: async (value) =>
      value === projectRoot ? projectRoot : null,
    runCommand: async ({ args }) => ({
      exitCode: 0,
      stdout: `ran ${args.join(" ")}`,
      stderr: "",
    }),
  });

  const task = await runner.createTask(
    {
      title: "Check me",
      description: "Run checks.",
      projectRoot,
      workerProvider: "codex",
      judgeProvider: "codex",
      useWorktree: false,
      checks: [{ label: "unit", command: "bun run test:unit" }],
    },
    { ownerId: "user-1" },
  );

  const checked = await runner.runChecks(task.id, { ownerId: "user-1" });

  expect(checked.status).toBe("needs-judge");
  expect(checked.lastCheckRun?.success).toBe(true);
  expect(checked.lastCheckRun?.results[0]?.stdout).toContain(
    "bun run test:unit",
  );
  expect(await readFile(task.controlFiles.roundsFile, "utf8")).toContain(
    "checks",
  );
});

test("getTask includes persisted round history after checks run", async () => {
  const projectRoot = await createTempDir();
  const stateDir = await createTempDir();
  const runner = createTaskRunner({
    stateDir,
    resolveAllowedPath: async (value) =>
      value === projectRoot ? projectRoot : null,
    runCommand: async () => ({
      exitCode: 0,
      stdout: "unit ok",
      stderr: "",
    }),
  });

  const task = await runner.createTask(
    {
      title: "Rounds",
      description: "Expose history.",
      projectRoot,
      workerProvider: "codex",
      judgeProvider: "codex",
      useWorktree: false,
      checks: [{ label: "unit", command: "bun run test:unit" }],
    },
    { ownerId: "user-1" },
  );
  await runner.runChecks(task.id, { ownerId: "user-1" });

  const loaded = await runner.getTask(task.id, { ownerId: "user-1" });

  expect(loaded.rounds?.map((round) => round.type)).toEqual([
    "created",
    "checks",
  ]);
  expect(loaded.rounds?.[1]?.success).toBe(true);
});
