import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  E2E_RUN_ACTOR_PREFIX,
  E2E_RUN_COOKIE_NAME,
} from "./services/foundation-actors";

// This suite owns one isolated server module because server.ts keeps foundation
// state and live terminals in module globals. Keep it as a separate `bun test`
// invocation in package.json.
const RUN_A = "0123456789abcdef0123456789abcdef";
const RUN_B = "fedcba9876543210fedcba9876543210";
const preservedEnvKeys = [
  "DECKTERM_STATE_DIR",
  "ALLOWED_FILE_ROOTS",
  "TMUX_BACKEND",
  "CF_ACCESS_REQUIRED",
  "CF_ACCESS_TEAM_NAME",
  "CF_ACCESS_AUD",
  "DECKTERM_RUNTIME_ENV",
  "DECKTERM_PUBLISH_MODE",
  "DECKTERM_LEGACY_NO_BOOTSTRAP",
  "DECKTERM_OS_ISOLATION",
  "PORT",
  "SHELL",
] as const;
const previousEnv: Record<string, string | undefined> = {};
let stateDir: string;
let allowedRoot: string;
let app: { fetch: (request: Request) => Response | Promise<Response> };
let restoreRecordedBoundary: <T>(options: {
  actorId: string;
  recordedOwnerId: string | null | undefined;
  requestUrl: string;
  restore: () => Promise<T>;
}) => Promise<{ ok: false } | { ok: true; terminal: T }>;

function headers(runId?: string, malformed = false): HeadersInit {
  const result: Record<string, string> = {};
  if (runId) {
    result.cookie = `${E2E_RUN_COOKIE_NAME}=${malformed ? "invalid" : runId}`;
  }
  return result;
}

async function request(
  pathname: string,
  options: RequestInit = {},
  runId?: string,
): Promise<Response> {
  const requestHeaders = new Headers(options.headers);
  for (const [key, value] of Object.entries(headers(runId))) {
    requestHeaders.set(key, value);
  }
  return app.fetch(
    new Request(`http://127.0.0.1:4174${pathname}`, {
      ...options,
      headers: requestHeaders,
    }),
  );
}

async function createTerminal(runId?: string): Promise<string> {
  const response = await request(
    "/api/terminals",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: allowedRoot, cols: 80, rows: 24 }),
    },
    runId,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

async function catalog(runId?: string): Promise<Array<Record<string, any>>> {
  const response = await request("/api/terminals", {}, runId);
  expect(response.status).toBe(200);
  return response.json();
}

beforeAll(async () => {
  for (const key of preservedEnvKeys) previousEnv[key] = process.env[key];
  const home = process.env.HOME || "/tmp";
  stateDir = await mkdtemp(join(home, ".deckterm-e2e-run-state-"));
  allowedRoot = await mkdtemp(join(home, ".deckterm-e2e-run-root-"));

  process.env.DECKTERM_STATE_DIR = stateDir;
  process.env.ALLOWED_FILE_ROOTS = allowedRoot;
  process.env.TMUX_BACKEND = "0";
  process.env.CF_ACCESS_REQUIRED = "0";
  delete process.env.CF_ACCESS_TEAM_NAME;
  delete process.env.CF_ACCESS_AUD;
  process.env.DECKTERM_RUNTIME_ENV = "development";
  delete process.env.DECKTERM_PUBLISH_MODE;
  process.env.DECKTERM_LEGACY_NO_BOOTSTRAP = "1";
  delete process.env.DECKTERM_OS_ISOLATION;
  process.env.PORT = "4174";
  process.env.SHELL = "/bin/bash";

  const serverModule = await import("./server");
  app = serverModule.createWebApp();
  restoreRecordedBoundary =
    serverModule.restoreRecordedTerminalAfterE2ERunBoundary;
});

afterAll(async () => {
  await Promise.all(
    [stateDir, allowedRoot]
      .filter(Boolean)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
  for (const key of preservedEnvKeys) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

test("server-enforced run actors isolate catalogs and terminal mutations", async () => {
  const cleanup: Array<{ id: string; runId?: string }> = [];
  try {
    const status = await request("/api/foundation/status", {}, RUN_A);
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      auth: { actor: { id: `${E2E_RUN_ACTOR_PREFIX}${RUN_A}` } },
    });

    const externalId = await createTerminal();
    cleanup.push({ id: externalId });
    const runAId = await createTerminal(RUN_A);
    cleanup.push({ id: runAId, runId: RUN_A });
    const runBId = await createTerminal(RUN_B);
    cleanup.push({ id: runBId, runId: RUN_B });

    expect((await catalog()).map((entry) => entry.id)).toContain(externalId);
    expect((await catalog()).map((entry) => entry.id)).not.toContain(runAId);
    expect((await catalog(RUN_A)).map((entry) => entry.id)).toEqual([runAId]);
    expect((await catalog(RUN_B)).map((entry) => entry.id)).toEqual([runBId]);

    for (const [pathname, method, body] of [
      [`/api/terminals/${externalId}/linked-view`, "POST", undefined],
      [
        `/api/terminals/${externalId}/resize`,
        "POST",
        JSON.stringify({ cols: 99, rows: 33 }),
      ],
      [`/api/terminals/${externalId}`, "DELETE", undefined],
    ] as const) {
      const response = await request(
        pathname,
        {
          method,
          headers: body ? { "content-type": "application/json" } : undefined,
          body,
        },
        RUN_A,
      );
      expect(response.status).toBe(404);
    }

    const external = (await catalog()).find(
      (entry) => entry.id === externalId,
    );
    expect(external).toMatchObject({ id: externalId, active: true });
    expect((await catalog(RUN_A)).map((entry) => entry.id)).toEqual([runAId]);

    const ownResize = await request(
      `/api/terminals/${runAId}/resize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cols: 91, rows: 31 }),
      },
      RUN_A,
    );
    expect(ownResize.status).toBe(200);
  } finally {
    for (const item of cleanup.reverse()) {
      await request(`/api/terminals/${item.id}`, { method: "DELETE" }, item.runId)
        .then(() => {})
        .catch(() => {});
    }
  }
});

test("malformed namespace cookies preserve 403 through shared auth wrappers", async () => {
  const malformedCookie = `${E2E_RUN_COOKIE_NAME}=invalid`;
  const foundationStatus = await app.fetch(
    new Request("http://127.0.0.1:4174/api/foundation/status", {
      headers: { cookie: malformedCookie },
    }),
  );
  expect(foundationStatus.status).toBe(403);

  const users = await app.fetch(
    new Request("http://127.0.0.1:4174/api/users", {
      headers: { cookie: malformedCookie },
    }),
  );
  expect(users.status).toBe(403);
  await expect(users.json()).resolves.toMatchObject({
    reason: "e2e_run_cookie_invalid",
  });
});

test("foreign recorded-only WebSocket ownership is rejected before restore", async () => {
  let restoreCalls = 0;
  const result = await restoreRecordedBoundary({
    actorId: `${E2E_RUN_ACTOR_PREFIX}${RUN_A}`,
    recordedOwnerId: "anonymous",
    requestUrl: "http://127.0.0.1:4174/ws/terminals/recorded-only",
    restore: async () => {
      restoreCalls += 1;
      return { id: "must-not-restore" };
    },
  });

  expect(result).toEqual({ ok: false });
  expect(restoreCalls).toBe(0);
});

test("cookie-free 401 wrapper response remains unchanged", async () => {
  const previous = {
    runtime: process.env.DECKTERM_RUNTIME_ENV,
    bypass: process.env.DECKTERM_LEGACY_NO_BOOTSTRAP,
    nodeEnv: process.env.NODE_ENV,
    bunEnv: process.env.BUN_ENV,
    ci: process.env.CI,
  };
  process.env.DECKTERM_RUNTIME_ENV = "production";
  delete process.env.DECKTERM_LEGACY_NO_BOOTSTRAP;
  process.env.NODE_ENV = "production";
  process.env.BUN_ENV = "production";
  process.env.CI = "false";
  try {
    const response = await app.fetch(
      new Request("http://127.0.0.1:4174/api/users"),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  } finally {
    for (const [key, value] of [
      ["DECKTERM_RUNTIME_ENV", previous.runtime],
      ["DECKTERM_LEGACY_NO_BOOTSTRAP", previous.bypass],
      ["NODE_ENV", previous.nodeEnv],
      ["BUN_ENV", previous.bunEnv],
      ["CI", previous.ci],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
