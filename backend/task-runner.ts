import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentHarness } from "./services/agent-harnesses";
import { writeTaskFileAtomic } from "./task-file-io";
import {
  appendTaskMessageEvent,
  readVerdictFile,
  renderWorkerPrompt,
  sanitizeMessageBody,
  taskMessagesPath,
  workerPromptPath,
} from "./task-messages";

export type TaskProvider = "codex" | "claude";
export type TaskStatus =
  | "draft"
  | "ready"
  | "worker-running"
  | "checks-running"
  | "needs-judge"
  | "judge-running"
  | "needs-user"
  | "complete"
  | "failed"
  | "paused";

export interface VerificationCommand {
  id?: string;
  label: string;
  command: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunCommandInput {
  cwd: string;
  args: string[];
  timeoutMs?: number;
}

export interface TaskControlFiles {
  taskFile: string;
  todoFile: string;
  judgePromptFile: string;
  checksFile: string;
  roundsFile: string;
}

export interface TaskRecord {
  id: string;
  slug: string;
  title: string;
  description: string;
  projectRoot: string;
  workingDirectory: string;
  ownerId: string;
  workerProvider: TaskProvider;
  judgeProvider: TaskProvider;
  useWorktree: boolean;
  branchName: string | null;
  status: TaskStatus;
  checks: Required<VerificationCommand>[];
  controlFiles: TaskControlFiles;
  taskDir: string;
  terminalId: string | null;
  judgeTerminalId: string | null;
  // D4 verdict loop: 0-based worker round + the last round whose verdict was
  // processed (idempotency marker). Legacy records normalize to 0/null on load.
  round: number;
  processedVerdictAtRound: number | null;
  lastCheckRun: {
    startedAt: string;
    finishedAt: string;
    success: boolean;
    results: Array<Required<VerificationCommand> & CommandResult>;
  } | null;
  rounds?: TaskRound[];
  createdAt: string;
  updatedAt: string;
}

export type TaskRound = {
  type: string;
  at?: string;
  status?: TaskStatus;
  success?: boolean;
  terminalId?: string;
  results?: unknown;
};

export class TaskRunnerError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "TaskRunnerError";
    this.status = status;
  }
}

type ResolveAllowedPath = (
  path: string,
  opts?: { allowMissing?: boolean },
) => Promise<string | null>;
type RunCommand = (input: RunCommandInput) => Promise<CommandResult>;

interface TaskRunnerOptions {
  stateDir: string;
  resolveAllowedPath: ResolveAllowedPath;
  runCommand?: RunCommand;
  maxRounds?: number;
  allowedProviders?: TaskProvider[];
}

interface ActorContext {
  ownerId: string;
}

export function slugifyTaskTitle(value: string): string {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "task";
}

function sanitizePathSegment(value: string): string {
  return slugifyTaskTitle(value).replace(/-/g, "_");
}

function normalizeProvider(
  value: unknown,
  fallback: TaskProvider,
  allowedProviders: TaskProvider[],
): TaskProvider {
  // Missing/empty falls back to the default; an EXPLICIT id must resolve to
  // an enabled registry harness AND pass the configured allow-list (D2:
  // unknown or disabled ids are rejected server-side, never coerced).
  const provider =
    value === undefined || value === null || value === ""
      ? fallback
      : String(value);
  if (
    !getAgentHarness(provider) ||
    !allowedProviders.includes(provider as TaskProvider)
  ) {
    throw new TaskRunnerError(`Task provider is not enabled: ${provider}`, 400);
  }
  return provider as TaskProvider;
}

function normalizeChecks(
  checks: VerificationCommand[] = [],
): Required<VerificationCommand>[] {
  return checks
    .map((check) => ({
      id: slugifyTaskTitle(check.id || check.label || check.command),
      label: String(check.label || check.command || "").trim(),
      command: String(check.command || "").trim(),
    }))
    .filter((check) => check.label && check.command);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolvePackageRunner(
  projectRoot: string,
  packageJson: { packageManager?: string },
): Promise<string> {
  const manager = String(packageJson.packageManager || "").toLowerCase();
  if (
    manager.startsWith("bun@") ||
    (await pathExists(join(projectRoot, "bun.lock"))) ||
    (await pathExists(join(projectRoot, "bun.lockb")))
  ) {
    return "bun run";
  }
  if (
    manager.startsWith("pnpm@") ||
    (await pathExists(join(projectRoot, "pnpm-lock.yaml")))
  ) {
    return "pnpm run";
  }
  if (
    manager.startsWith("yarn@") ||
    (await pathExists(join(projectRoot, "yarn.lock")))
  ) {
    return "yarn run";
  }
  return "npm run";
}

export async function detectVerificationCommands(
  projectRoot: string,
): Promise<Required<VerificationCommand>[]> {
  const packageJsonPath = join(projectRoot, "package.json");
  if (!(await pathExists(packageJsonPath))) return [];

  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const scripts = packageJson?.scripts || {};
  const runner = await resolvePackageRunner(projectRoot, packageJson);
  const priority = ["test:unit", "test", "lint", "build"];

  return priority
    .filter((script) => typeof scripts[script] === "string")
    .map((script) => ({
      id: slugifyTaskTitle(script),
      label: script,
      command: `${runner} ${script}`,
    }));
}

async function defaultRunCommand({
  cwd,
  args,
  timeoutMs = 120_000,
}: RunCommandInput): Promise<CommandResult> {
  const proc = Bun.spawn(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timeout);
  return { stdout, stderr, exitCode };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tempPath, path);
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, { flag: "a" });
}

async function readJsonLines(path: string): Promise<TaskRound[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TaskRound);
  } catch {
    return [];
  }
}

function buildControlFiles(taskDir: string): TaskControlFiles {
  return {
    taskFile: join(taskDir, "TASK.md"),
    todoFile: join(taskDir, "TODO.md"),
    judgePromptFile: join(taskDir, "JUDGE_PROMPT.md"),
    checksFile: join(taskDir, "CHECKS.md"),
    roundsFile: join(taskDir, "rounds.jsonl"),
  };
}

function renderTaskFile(
  task: Pick<
    TaskRecord,
    "title" | "description" | "projectRoot" | "workingDirectory" | "checks"
  >,
): string {
  return [
    `# ${task.title}`,
    "",
    task.description,
    "",
    "## Context",
    "",
    `- Project root: ${task.projectRoot}`,
    `- Working directory: ${task.workingDirectory}`,
    "",
    "## Required Checks",
    "",
    ...(task.checks.length
      ? task.checks.map((check) => `- ${check.label}: \`${check.command}\``)
      : [
          "- No automatic checks detected. Update CHECKS.md before verification.",
        ]),
    "",
  ].join("\n");
}

function renderTodoFile(task: Pick<TaskRecord, "title">): string {
  return [
    `# TODO: ${task.title}`,
    "",
    "- [ ] Inspect the requested change",
    "- [ ] Implement the smallest complete fix",
    "- [ ] Run required checks",
    "- [ ] Summarize risks and remaining work",
    "",
  ].join("\n");
}

function renderChecksFile(checks: Required<VerificationCommand>[]): string {
  return [
    "# Checks",
    "",
    ...(checks.length
      ? checks.map((check) => `- [ ] ${check.label}: \`${check.command}\``)
      : ["- [ ] Add project-specific verification commands"]),
    "",
  ].join("\n");
}

function renderJudgePromptFile(
  task: Pick<TaskRecord, "title" | "description" | "taskDir" | "round">,
): string {
  const round =
    Number.isInteger(task.round) && task.round >= 0 ? task.round : 0;
  const verdictPath = join(task.taskDir, `verdict-r${round}.json`);
  return [
    `# Judge Prompt: ${task.title}`,
    "",
    "Review the worker result against the original task, changed files, and verification output.",
    "Return one of: PASS, NEEDS_WORK, or BLOCKED.",
    "",
    "## Original Task",
    "",
    task.description,
    "",
    "## Mandatory Final Step",
    "",
    `You are judging round ${round}. As your FINAL action, write your verdict to exactly this file:`,
    "",
    "```",
    verdictPath,
    "```",
    "",
    `The file must contain a single JSON object with exactly this shape, where "round" MUST be the number ${round} and "verdict" MUST be one of "PASS", "NEEDS_WORK", or "BLOCKED":`,
    "",
    "```json",
    `{"round": ${round}, "verdict": "NEEDS_WORK", "summary": "<short reasoning for the worker>"}`,
    "```",
    "",
    "Do not skip this step: the task pipeline reads this file to decide what happens next.",
    "",
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function buildPromptCommand(
  provider: TaskProvider,
  promptFile: string,
): string {
  const harness = getAgentHarness(provider);
  if (!harness) {
    throw new TaskRunnerError(`Task provider is not enabled: ${provider}`, 400);
  }
  return harness.buildPromptCommand(promptFile);
}

export function buildWorkerCommand(task: TaskRecord): string {
  // Round 0 reads TASK.md (byte-identical to the pre-verdict-loop command,
  // guarded by golden tests); later rounds read the server-rendered
  // WORKER_PROMPT.md carrying the previous judge feedback (D4).
  const promptFile =
    Number.isInteger(task.round) && task.round > 0
      ? workerPromptPath(task.taskDir)
      : task.controlFiles.taskFile;
  return [
    `export DECKTERM_TASK_ID=${shellQuote(task.id)}`,
    `export DECKTERM_TASK_FILE=${shellQuote(task.controlFiles.taskFile)}`,
    `export DECKTERM_TODO_FILE=${shellQuote(task.controlFiles.todoFile)}`,
    `export DECKTERM_CHECKS_FILE=${shellQuote(task.controlFiles.checksFile)}`,
    `echo "DeckTerm task: ${task.title.replace(/"/g, '\\"')}"`,
    `echo "Task file: ${promptFile}"`,
    buildPromptCommand(task.workerProvider, promptFile),
  ].join("\n");
}

export function buildJudgeCommand(task: TaskRecord): string {
  return [
    `export DECKTERM_TASK_ID=${shellQuote(task.id)}`,
    `export DECKTERM_JUDGE_PROMPT_FILE=${shellQuote(task.controlFiles.judgePromptFile)}`,
    `echo "DeckTerm judge: ${task.title.replace(/"/g, '\\"')}"`,
    `echo "Judge prompt: ${task.controlFiles.judgePromptFile}"`,
    buildPromptCommand(task.judgeProvider, task.controlFiles.judgePromptFile),
  ].join("\n");
}

export function createTaskRunner(options: TaskRunnerOptions) {
  const stateDir = resolve(options.stateDir);
  const tasksDir = join(stateDir, "tasks");
  const worktreesDir = join(stateDir, "worktrees");
  const runCommand = options.runCommand || defaultRunCommand;
  const allowedProviders: TaskProvider[] = options.allowedProviders?.length
    ? options.allowedProviders
    : ["codex", "claude"];
  const maxRounds =
    Number.isInteger(options.maxRounds) && (options.maxRounds as number) >= 1
      ? (options.maxRounds as number)
      : 5;

  // Per-task promise-chain mutex: serializes every task mutation
  // (start/exit/verdict/message) so duplicate triggers — agent-done plus the
  // terminal-exit fallback firing for the same completion — cannot interleave
  // load-mutate-save cycles. Callers RE-LOAD the task inside the critical
  // section; state read before the lock is treated as a hint only.
  const taskLocks = new Map<string, Promise<unknown>>();
  async function runExclusive<T>(
    taskId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = taskLocks.get(taskId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const guard = run.then(
      () => undefined,
      () => undefined,
    );
    taskLocks.set(taskId, guard);
    try {
      return await run;
    } finally {
      if (taskLocks.get(taskId) === guard) {
        taskLocks.delete(taskId);
      }
    }
  }

  async function findTaskJsonPath(
    ownerId: string,
    id: string,
  ): Promise<string | null> {
    const ownerDir = join(tasksDir, sanitizePathSegment(ownerId));
    const entries = await readdir(ownerDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(ownerDir, entry.name, "task.json");
      try {
        const raw = await readFile(candidate, "utf8");
        const task = JSON.parse(raw) as { id?: string };
        if (task.id === id) return candidate;
      } catch {
        // Ignore malformed task directories and keep scanning.
      }
    }
    return null;
  }

  async function saveTask(task: TaskRecord): Promise<TaskRecord> {
    task.updatedAt = new Date().toISOString();
    await mkdir(task.taskDir, { recursive: true });
    const { rounds: _rounds, ...persistedTask } = task;
    await writeJson(join(task.taskDir, "task.json"), persistedTask);
    return task;
  }

  async function hydrateTask(task: TaskRecord): Promise<TaskRecord> {
    return {
      ...task,
      // Legacy records (pre-verdict-loop) lack the round fields.
      round: Number.isInteger(task.round) && task.round >= 0 ? task.round : 0,
      processedVerdictAtRound:
        Number.isInteger(task.processedVerdictAtRound) &&
        (task.processedVerdictAtRound as number) >= 0
          ? task.processedVerdictAtRound
          : null,
      rounds: await readJsonLines(task.controlFiles.roundsFile),
    };
  }

  async function loadTask(id: string, ownerId: string): Promise<TaskRecord> {
    try {
      const path = await findTaskJsonPath(ownerId, id);
      if (!path) throw new Error("missing");
      const raw = await readFile(path, "utf8");
      return hydrateTask(JSON.parse(raw) as TaskRecord);
    } catch {
      throw new TaskRunnerError("Task not found", 404);
    }
  }

  async function scanOwnerTasks(ownerId: string): Promise<TaskRecord[]> {
    const ownerDir = join(tasksDir, sanitizePathSegment(ownerId));
    try {
      const entries = await readdir(ownerDir, { withFileTypes: true });
      const tasks = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => {
            const raw = await readFile(
              join(ownerDir, entry.name, "task.json"),
              "utf8",
            );
            return hydrateTask(JSON.parse(raw) as TaskRecord);
          }),
      );
      return tasks.sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
    } catch {
      return [];
    }
  }

  async function writeControlFiles(task: TaskRecord): Promise<void> {
    await mkdir(task.taskDir, { recursive: true });
    await writeFile(task.controlFiles.taskFile, renderTaskFile(task));
    await writeFile(task.controlFiles.todoFile, renderTodoFile(task));
    await writeFile(
      task.controlFiles.judgePromptFile,
      renderJudgePromptFile(task),
    );
    await writeFile(
      task.controlFiles.checksFile,
      renderChecksFile(task.checks),
    );
    await writeFile(task.controlFiles.roundsFile, "", { flag: "a" });
  }

  async function createWorktree({
    projectRoot,
    ownerId,
    slug,
    branchName,
  }: {
    projectRoot: string;
    ownerId: string;
    slug: string;
    branchName: string;
  }): Promise<string> {
    const repoResult = await runCommand({
      cwd: projectRoot,
      args: ["git", "rev-parse", "--show-toplevel"],
      timeoutMs: 10_000,
    });
    if (repoResult.exitCode !== 0) {
      throw new TaskRunnerError("Task worktree requires a git repository", 400);
    }

    const repoRoot = repoResult.stdout.trim() || projectRoot;
    const worktreeDir = join(worktreesDir, sanitizePathSegment(ownerId), slug);
    await mkdir(join(worktreesDir, sanitizePathSegment(ownerId)), {
      recursive: true,
    });
    const result = await runCommand({
      cwd: repoRoot,
      args: ["git", "worktree", "add", "-b", branchName, worktreeDir],
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0) {
      throw new TaskRunnerError(
        result.stderr.trim() || "Failed to create task worktree",
        400,
      );
    }

    // git worktree add does not copy node_modules, so any dependency-importing
    // check (e.g. `bun run test:unit`) fails with "Cannot find package ...".
    // Symlink the repo's installed dependencies into the worktree so checks see
    // them without a slow per-task `bun install`.
    const repoModules = join(repoRoot, "node_modules");
    const hasModules = await access(repoModules).then(
      () => true,
      () => false,
    );
    if (hasModules) {
      await runCommand({
        cwd: worktreeDir,
        args: ["ln", "-s", repoModules, join(worktreeDir, "node_modules")],
        timeoutMs: 10_000,
      });
    }

    return worktreeDir;
  }

  // D4 verdict processing — MUST run inside runExclusive on a freshly loaded
  // task. Exact ordering (Codex v2 HIGH 1): snapshot judgedRound → idempotency
  // bail → read the per-round verdict file → apply transitions → mark
  // processedVerdictAtRound → only then increment round on NEEDS_WORK-continue
  // (marking after incrementing would skip the next round's verdict).
  // Returns null when there is no valid verdict for the judged round (missing,
  // malformed, round-mismatched, or already processed) — the caller then
  // applies the legacy no-verdict fallback.
  async function applyJudgeVerdict(
    task: TaskRecord,
    terminalId: string,
  ): Promise<TaskRecord | null> {
    const judgedRound = task.round;
    if (task.processedVerdictAtRound === judgedRound) return null;
    const verdict = readVerdictFile(task.taskDir, judgedRound);
    if (!verdict) return null;

    let continueRound = false;
    if (verdict.verdict === "PASS") {
      task.status = "complete";
    } else if (verdict.verdict === "BLOCKED") {
      task.status = "needs-user";
    } else if (judgedRound + 1 < maxRounds) {
      // NEEDS_WORK with rounds remaining: hand the judge feedback to the next
      // worker round via the server-rendered prompt + an internal judge
      // message (D1: judge→worker feedback is a server event, not HTTP).
      const feedback = sanitizeMessageBody(verdict.summary || "");
      writeTaskFileAtomic(
        workerPromptPath(task.taskDir),
        renderWorkerPrompt({
          task: { title: task.title, description: task.description },
          feedback,
          round: judgedRound + 1,
        }),
      );
      // Deterministic id: if saveTask fails after this append and the
      // trigger retries, the re-appended event folds into the same message
      // instead of duplicating it (Codex S6 review, MED).
      appendTaskMessageEvent(taskMessagesPath(task.taskDir), {
        type: "message-created",
        id: `judge-feedback-r${judgedRound}`,
        at: new Date().toISOString(),
        from: "judge",
        to: "worker",
        body: feedback,
      });
      task.status = "ready";
      continueRound = true;
    } else {
      task.status = "needs-user";
    }

    task.processedVerdictAtRound = judgedRound;
    if (continueRound) {
      task.round = judgedRound + 1;
    }
    await appendJsonLine(task.controlFiles.roundsFile, {
      type: "verdict",
      at: new Date().toISOString(),
      terminalId,
      status: task.status,
      results: { round: judgedRound, verdict: verdict.verdict },
    });
    return saveTask(task);
  }

  return {
    async createTask(
      input: {
        title?: string;
        description?: string;
        projectRoot?: string;
        workerProvider?: TaskProvider;
        judgeProvider?: TaskProvider;
        useWorktree?: boolean;
        branchName?: string;
        checks?: VerificationCommand[];
      },
      actor: ActorContext,
    ): Promise<TaskRecord> {
      const title = String(input.title || "").trim();
      const description = String(input.description || "").trim();
      const ownerId = String(actor.ownerId || "anonymous");
      if (!title) throw new TaskRunnerError("Task title is required", 400);
      if (!description) {
        throw new TaskRunnerError("Task description is required", 400);
      }

      const requestedRoot = String(input.projectRoot || "").trim();
      const projectRoot = requestedRoot
        ? await options.resolveAllowedPath(requestedRoot)
        : null;
      if (!projectRoot) {
        throw new TaskRunnerError("Forbidden project root", 403);
      }

      const id = crypto.randomUUID();
      const slug = `${slugifyTaskTitle(title)}-${id.slice(0, 8)}`;
      const taskDir = join(tasksDir, sanitizePathSegment(ownerId), slug);
      const useWorktree = Boolean(input.useWorktree);
      const branchName = useWorktree
        ? input.branchName?.trim() || `deckterm/task/${slug}`
        : null;
      const checks =
        normalizeChecks(input.checks) ||
        (await detectVerificationCommands(projectRoot));
      const normalizedChecks = checks.length
        ? checks
        : await detectVerificationCommands(projectRoot);
      const workingDirectory =
        useWorktree && branchName
          ? await createWorktree({ projectRoot, ownerId, slug, branchName })
          : projectRoot;
      const now = new Date().toISOString();
      const task: TaskRecord = {
        id,
        slug,
        title,
        description,
        projectRoot,
        workingDirectory,
        ownerId,
        // Default provider is claude (2026-06-10 decision: codex has no
        // credits); explicit workerProvider/judgeProvider still win.
        workerProvider: normalizeProvider(
          input.workerProvider,
          "claude",
          allowedProviders,
        ),
        judgeProvider: normalizeProvider(
          input.judgeProvider,
          "claude",
          allowedProviders,
        ),
        useWorktree,
        branchName,
        status: "ready",
        checks: normalizedChecks,
        controlFiles: buildControlFiles(taskDir),
        taskDir,
        terminalId: null,
        judgeTerminalId: null,
        round: 0,
        processedVerdictAtRound: null,
        lastCheckRun: null,
        createdAt: now,
        updatedAt: now,
      };

      await writeControlFiles(task);
      await appendJsonLine(task.controlFiles.roundsFile, {
        type: "created",
        at: now,
        status: task.status,
      });
      return saveTask(task);
    },

    async listTasks(ownerId: string): Promise<TaskRecord[]> {
      return scanOwnerTasks(ownerId);
    },

    // A worker/judge terminal that exits never moves the task off its *-running
    // status on its own (status only changes on explicit actions), so tasks get
    // stuck on worker-running/judge-running after the agent session ends. The
    // server calls this when any terminal exits; we advance the owning task so
    // the user can run checks / re-engage.
    async handleTerminalExit(
      ownerId: string,
      terminalId: string,
    ): Promise<TaskRecord | null> {
      if (!terminalId) return null;
      const tasks = await scanOwnerTasks(ownerId);
      const candidate = tasks.find(
        (task) =>
          (task.terminalId === terminalId &&
            task.status === "worker-running") ||
          (task.judgeTerminalId === terminalId &&
            task.status === "judge-running"),
      );
      if (!candidate) return null;
      return runExclusive(candidate.id, async () => {
        let task: TaskRecord;
        try {
          task = await loadTask(candidate.id, ownerId);
        } catch {
          return null; // deleted while queued behind the lock
        }
        const isWorkerExit =
          task.terminalId === terminalId && task.status === "worker-running";
        const isJudgeExit =
          task.judgeTerminalId === terminalId &&
          task.status === "judge-running";
        if (!isWorkerExit && !isJudgeExit) return null;
        if (isJudgeExit) {
          // Fallback verdict trigger: the judge terminal died (or has no
          // shell integration). If a valid verdict for the current round is
          // on disk, process it; otherwise fall through to the legacy
          // needs-user path, byte-identical to the pre-verdict-loop behavior.
          const processed = await applyJudgeVerdict(task, terminalId);
          if (processed) return processed;
        }
        task.status = "needs-user";
        await appendJsonLine(task.controlFiles.roundsFile, {
          type: isWorkerExit ? "worker-exited" : "judge-exited",
          at: new Date().toISOString(),
          terminalId,
        });
        return saveTask(task);
      });
    },

    // Primary verdict trigger (D1): the shell-integration `agent-done` edge.
    // Accepted ONLY for the task's recorded judgeTerminalId while the task is
    // judge-running AND the finishing agent matches the task's judgeProvider
    // (Codex v2 HIGH 3 — a worker or unrelated agent finishing in that
    // terminal must not trigger verdict processing). Idempotent under the
    // per-task mutex; safe to double-fire alongside handleTerminalExit.
    async handleJudgeCompletion(
      ownerId: string,
      terminalId: string,
      agentName: string,
    ): Promise<TaskRecord | null> {
      if (!terminalId || !agentName) return null;
      const tasks = await scanOwnerTasks(ownerId);
      const candidate = tasks.find(
        (task) =>
          task.judgeTerminalId === terminalId &&
          task.status === "judge-running",
      );
      if (!candidate || candidate.judgeProvider !== agentName) return null;
      return runExclusive(candidate.id, async () => {
        let task: TaskRecord;
        try {
          task = await loadTask(candidate.id, ownerId);
        } catch {
          return null;
        }
        if (
          task.judgeTerminalId !== terminalId ||
          task.status !== "judge-running" ||
          task.judgeProvider !== agentName
        ) {
          return null;
        }
        const processed = await applyJudgeVerdict(task, terminalId);
        if (processed) return processed;
        // Judge finished without a valid verdict for this round: same
        // needs-user semantics as today's no-verdict exit path, recorded as
        // its own event type (the terminal is still alive here).
        task.status = "needs-user";
        await appendJsonLine(task.controlFiles.roundsFile, {
          type: "judge-done",
          at: new Date().toISOString(),
          terminalId,
          status: task.status,
        });
        return saveTask(task);
      });
    },

    async getTask(id: string, actor: ActorContext): Promise<TaskRecord> {
      return loadTask(id, actor.ownerId);
    },

    async updateTask(
      id: string,
      actor: ActorContext,
      input: {
        title?: string;
        description?: string;
        status?: TaskStatus;
        checks?: VerificationCommand[];
      },
    ): Promise<TaskRecord> {
      const task = await loadTask(id, actor.ownerId);
      if (typeof input.title === "string" && input.title.trim()) {
        task.title = input.title.trim();
      }
      if (typeof input.description === "string" && input.description.trim()) {
        task.description = input.description.trim();
      }
      if (typeof input.status === "string") {
        task.status = input.status;
      }
      if (Array.isArray(input.checks)) {
        task.checks = normalizeChecks(input.checks);
      }
      await writeControlFiles(task);
      await appendJsonLine(task.controlFiles.roundsFile, {
        type: "updated",
        at: new Date().toISOString(),
        status: task.status,
      });
      return saveTask(task);
    },

    async deleteTask(id: string, actor: ActorContext): Promise<{ ok: true }> {
      const task = await loadTask(id, actor.ownerId);
      if (task.useWorktree && task.workingDirectory !== task.projectRoot) {
        const removeResult = await runCommand({
          cwd: task.projectRoot,
          args: ["git", "worktree", "remove", "--force", task.workingDirectory],
          timeoutMs: 60_000,
        });
        if (removeResult.exitCode !== 0) {
          throw new TaskRunnerError(
            removeResult.stderr.trim() || "Failed to remove task worktree",
            400,
          );
        }
      }
      await rm(task.taskDir, { recursive: true, force: true });
      return { ok: true };
    },

    async markWorkerStarted(
      id: string,
      actor: ActorContext,
      terminalId: string,
    ): Promise<TaskRecord> {
      return runExclusive(id, async () => {
        const task = await loadTask(id, actor.ownerId);
        task.terminalId = terminalId;
        task.status = "worker-running";
        await appendJsonLine(task.controlFiles.roundsFile, {
          type: "worker-started",
          at: new Date().toISOString(),
          terminalId,
        });
        return saveTask(task);
      });
    },

    async markJudgeStarted(
      id: string,
      actor: ActorContext,
      terminalId: string,
    ): Promise<TaskRecord> {
      return runExclusive(id, async () => {
        const task = await loadTask(id, actor.ownerId);
        // Freshness: a verdict file left over from an aborted judge attempt
        // (or pre-created by another agent) must never satisfy THIS attempt —
        // strict round matching alone can't prove freshness (Codex S6
        // review, HIGH). rm handles symlinks by removing the link itself.
        await rm(join(task.taskDir, `verdict-r${task.round}.json`), {
          force: true,
        });
        task.judgeTerminalId = terminalId;
        task.status = "judge-running";
        await appendJsonLine(task.controlFiles.roundsFile, {
          type: "judge-started",
          at: new Date().toISOString(),
          terminalId,
        });
        return saveTask(task);
      });
    },

    async runChecks(id: string, actor: ActorContext): Promise<TaskRecord> {
      const task = await loadTask(id, actor.ownerId);
      const startedAt = new Date().toISOString();
      task.status = "checks-running";
      await saveTask(task);

      const results = [];
      for (const check of task.checks) {
        const result = await runCommand({
          cwd: task.workingDirectory,
          args: ["bash", "-lc", check.command],
          timeoutMs: 120_000,
        });
        results.push({ ...check, ...result });
      }

      const success = results.every((result) => result.exitCode === 0);
      task.lastCheckRun = {
        startedAt,
        finishedAt: new Date().toISOString(),
        success,
        results,
      };
      task.status = success ? "needs-judge" : "needs-user";
      await appendJsonLine(task.controlFiles.roundsFile, {
        type: "checks",
        at: task.lastCheckRun.finishedAt,
        success,
        results,
      });
      return saveTask(task);
    },

    async buildJudgePrompt(id: string, actor: ActorContext): Promise<string> {
      const task = await loadTask(id, actor.ownerId);
      const status = await runCommand({
        cwd: task.workingDirectory,
        args: ["git", "status", "--porcelain", "-b"],
        timeoutMs: 10_000,
      }).catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
      const diffStat = await runCommand({
        cwd: task.workingDirectory,
        args: ["git", "diff", "--stat"],
        timeoutMs: 10_000,
      }).catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));

      // Render the base prompt fresh (not from the file on disk): the judge
      // route overwrites judgePromptFile with THIS composed output, so
      // re-reading it would accumulate git/check sections across rounds and
      // pin the verdict path to a stale round.
      return [
        renderJudgePromptFile(task),
        "## Git Status",
        "",
        "```",
        status.stdout.trim() ||
          status.stderr.trim() ||
          "No git status available.",
        "```",
        "",
        "## Diff Stat",
        "",
        "```",
        diffStat.stdout.trim() ||
          diffStat.stderr.trim() ||
          "No diff stat available.",
        "```",
        "",
        "## Last Check Run",
        "",
        "```json",
        JSON.stringify(task.lastCheckRun, null, 2),
        "```",
        "",
      ].join("\n");
    },

    buildWorkerCommand,
    buildJudgeCommand,

    // Expose the per-task mutex so route-level task mutations (e.g. message
    // creation/delivery in S7) serialize with start/exit/verdict processing.
    withTaskLock: runExclusive,
  };
}
