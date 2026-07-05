import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  bootstrapFirstAdmin,
  initializeFoundationState,
} from "./services/foundation-state";

const tempDirs: string[] = [];
const ISOLATED_ENV_KEYS = [
  "DECKTERM_STATE_DIR",
  "ALLOWED_FILE_ROOTS",
  "DECKTERM_RUNTIME_ENV",
  "DECKTERM_PUBLISH_MODE",
  "DECKTERM_LEGACY_NO_BOOTSTRAP",
  "CF_ACCESS_REQUIRED",
] as const;
const previousEnv: Record<string, string | undefined> = {};
for (const key of ISOLATED_ENV_KEYS) {
  previousEnv[key] = process.env[key];
}

async function createHomeTempDir(prefix: string) {
  const dir = await mkdtemp(join(process.env.HOME || "/tmp", prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const key of ISOLATED_ENV_KEYS) {
    if (previousEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previousEnv[key];
    }
  }
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

test("task API creates a supervised task and runs checks for the anonymous owner", async () => {
  const stateDir = await createHomeTempDir(".deckterm-task-state-");
  const projectRoot = await createHomeTempDir(".deckterm-task-project-");
  await writeFile(
    join(projectRoot, "package.json"),
    JSON.stringify({ scripts: { "test:unit": "printf ok" } }),
  );
  await writeFile(join(projectRoot, "bun.lock"), "");

  const allowedRoot = process.env.HOME || "/tmp";
  process.env.DECKTERM_STATE_DIR = stateDir;
  process.env.ALLOWED_FILE_ROOTS = allowedRoot;
  process.env.DECKTERM_RUNTIME_ENV = "development";
  process.env.CF_ACCESS_REQUIRED = "0";
  delete process.env.DECKTERM_PUBLISH_MODE;
  delete process.env.DECKTERM_LEGACY_NO_BOOTSTRAP;

  // C2 routes task project roots through the foundation gate, which requires a
  // completed bootstrap. Make the anonymous test actor the first admin.
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [allowedRoot],
    env: {},
  });
  const token = (
    await readFile(join(stateDir, "bootstrap-token"), "utf8")
  ).trim();
  const bootstrapped = await bootstrapFirstAdmin({
    state,
    stateDir,
    actorUserId: "anonymous",
    actorEmail: "anonymous",
    token,
    authIdentity: {
      provider: "cloudflare_access",
      providerSubject: "anonymous",
    },
    env: {},
  });
  if (!bootstrapped.ok) {
    throw new Error(`test bootstrap failed: ${bootstrapped.error}`);
  }
  state.db.close();

  const { createWebApp } = await import("./server");
  const app = createWebApp();

  const createRes = await app.fetch(
    new Request("http://deckterm.test/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "API Task",
        description: "Exercise task API.",
        projectRoot,
        workerProvider: "codex",
        judgeProvider: "codex",
        useWorktree: false,
      }),
    }),
  );

  expect(createRes.status).toBe(200);
  const created = await createRes.json();
  expect(created.status).toBe("ready");
  expect(created.checks[0].command).toBe("bun run test:unit");

  // Isolation guard: the workspace must land under the temp state dir, never
  // the live ~/.deckterm (regression for leaked api-task-* dirs in the real
  // UI). createWebApp resolves the task-runner state dir at call time, so the
  // DECKTERM_STATE_DIR set above is honored even when server.ts was imported
  // (and its module const frozen) by an earlier test. The owner segment is the
  // resolved actor id (e.g. "tunnel"), so scan every owner rather than assume.
  const taskOwners = await readdir(join(stateDir, "tasks"));
  const persistedTaskDirs = (
    await Promise.all(
      taskOwners.map((owner) => readdir(join(stateDir, "tasks", owner))),
    )
  ).flat();
  expect(persistedTaskDirs).toContain(created.slug);

  const listRes = await app.fetch(
    new Request("http://deckterm.test/api/tasks"),
  );
  const listed = await listRes.json();
  expect(listed.map((task: { id: string }) => task.id)).toContain(created.id);

  // S3 (Traycer patterns): the harness listing rides the same auth surface.
  // Availability depends on the machine, so assert ids/shape only — enabled
  // harnesses exactly (claude, codex), disabled ones never exposed.
  const harnessesRes = await app.fetch(
    new Request("http://deckterm.test/api/harnesses"),
  );
  expect(harnessesRes.status).toBe(200);
  const { harnesses } = await harnessesRes.json();
  expect(harnesses.map((h: { id: string }) => h.id).sort()).toEqual([
    "claude",
    "codex",
  ]);
  for (const harness of harnesses) {
    expect(typeof harness.label).toBe("string");
    expect(typeof harness.available).toBe("boolean");
    expect("version" in harness).toBe(true);
    expect("error" in harness).toBe(true);
  }

  const checksRes = await app.fetch(
    new Request(`http://deckterm.test/api/tasks/${created.id}/run-checks`, {
      method: "POST",
    }),
  );
  expect(checksRes.status).toBe(200);
  const checked = await checksRes.json();
  expect(checked.status).toBe("needs-judge");
  expect(checked.lastCheckRun.success).toBe(true);

  // S7 (Traycer patterns): task messages. No live agent terminal exists in
  // this test, so delivery must be recorded as failed — while the message
  // itself is created with the sanitized body as its canonical form.
  const badMsgRes = await app.fetch(
    new Request(`http://deckterm.test/api/tasks/${created.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "nowhere", body: "hi" }),
    }),
  );
  expect(badMsgRes.status).toBe(400);

  const msgRes = await app.fetch(
    new Request(`http://deckterm.test/api/tasks/${created.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: "worker",
        body: "please \x1b[31mfocus\x1b[0m on\x07 the tests",
      }),
    }),
  );
  expect(msgRes.status).toBe(200);
  const posted = await msgRes.json();
  expect(posted.delivery).toBe("failed");
  // The task is not in worker-running here, so the role gate fires before
  // any terminal lookup.
  expect(posted.reason).toBe("role_not_active");
  expect(posted.message.from).toBe("user");
  expect(posted.message.body).toBe("please focus on the tests");
  expect(posted.message.delivery).toBe("failed");

  const msgListRes = await app.fetch(
    new Request(`http://deckterm.test/api/tasks/${created.id}/messages`),
  );
  expect(msgListRes.status).toBe(200);
  const { messages } = await msgListRes.json();
  expect(messages).toHaveLength(1);
  expect(messages[0].id).toBe(posted.message.id);

  const foreignMsgRes = await app.fetch(
    new Request("http://deckterm.test/api/tasks/nonexistent-task/messages"),
  );
  expect(foreignMsgRes.status).toBe(404);
});
