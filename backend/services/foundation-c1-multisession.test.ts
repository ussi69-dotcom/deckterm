import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  initializeFoundationState,
  recordTerminalSession,
  getTerminalSession,
  appendTerminalEvent,
  listTerminalEventsAfter,
} from "./foundation-state";
import { authorizeTerminalWrite } from "./foundation-authorization";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function createTempDir(prefix: string): Promise<string> {
  const path = join(
    tmpdir(),
    `${prefix}${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(path, { recursive: true });
  return path;
}

test("foundation C1b: authorizeTerminalWrite", async () => {
  const stateDir = await createTempDir(".deckterm-c1b-test-state-");
  const projectRoot = await createTempDir(".deckterm-c1b-test-root-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [projectRoot],
    env: {},
    now: new Date("2026-05-24T12:00:00Z"),
  });

  const termId = "term-write-test";
  recordTerminalSession(state.db, {
    id: termId,
    actorUserId: "user_owner",
    rootId: state.roots[0]?.id,
    cwd: projectRoot,
    now: new Date("2026-05-24T12:01:00Z"),
  });

  // 1. Owner can write
  const ownerDecision = authorizeTerminalWrite(state.db, {
    actorUserId: "user_owner",
    terminalId: termId,
  });
  expect(ownerDecision.allow).toBe(true);
  expect(ownerDecision.reason).toBe("owner");

  // 2. Non-owner cannot write by default
  const guestDecision = authorizeTerminalWrite(state.db, {
    actorUserId: "user_guest",
    terminalId: termId,
  });
  expect(guestDecision.allow).toBe(false);
  expect(guestDecision.reason).toBe("missing_capability");

  // 3. Admin user or user with grant can write
  state.db
    .query(
      `INSERT INTO users (id, email, display_name, role, created_at, updated_at)
     VALUES (?, ?, ?, 'member', ?, ?)`,
    )
    .run(
      "user_guest",
      "guest@example.com",
      "Guest User",
      new Date().toISOString(),
      new Date().toISOString(),
    );

  state.db
    .query(
      `INSERT INTO scoped_grants (id, user_id, capability, resource_type, resource_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "grant-abc",
      "user_guest",
      "terminal.write",
      "terminal",
      termId,
      new Date().toISOString(),
      new Date().toISOString(),
    );

  const grantedDecision = authorizeTerminalWrite(state.db, {
    actorUserId: "user_guest",
    terminalId: termId,
  });
  expect(grantedDecision.allow).toBe(true);
  expect(grantedDecision.reason).toBe("granted");

  state.db.close();
});

test("foundation C1b: terminal events and sequence log", async () => {
  const stateDir = await createTempDir(".deckterm-c1b-events-state-");
  const projectRoot = await createTempDir(".deckterm-c1b-events-root-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [projectRoot],
    env: {},
    now: new Date("2026-05-24T12:00:00Z"),
  });

  const termId = "term-events-test";
  recordTerminalSession(state.db, {
    id: termId,
    actorUserId: "user_owner",
    rootId: state.roots[0]?.id,
    cwd: projectRoot,
    now: new Date("2026-05-24T12:01:00Z"),
  });

  const sessionBefore = getTerminalSession(state.db, termId);
  expect(sessionBefore?.lastEventId).toBe(0);

  // Append first event
  const evId1 = appendTerminalEvent(state.db, {
    terminalId: termId,
    kind: "output",
    data: "hello world",
  });
  expect(evId1).toBeGreaterThan(0);

  const sessionAfter1 = getTerminalSession(state.db, termId);
  expect(sessionAfter1?.lastEventId).toBe(evId1);

  // Append second event (state update)
  const evId2 = appendTerminalEvent(state.db, {
    terminalId: termId,
    kind: "state",
    dataJson: { running: true, agentName: "Claude" },
  });
  expect(evId2).toBe(evId1 + 1);

  const sessionAfter2 = getTerminalSession(state.db, termId);
  expect(sessionAfter2?.lastEventId).toBe(evId2);

  // List events after 0
  const allEvents = listTerminalEventsAfter(state.db, termId, 0);
  expect(allEvents.length).toBe(2);
  expect(allEvents[0].id).toBe(evId1);
  expect(allEvents[0].kind).toBe("output");
  expect(allEvents[0].data).toBe("hello world");

  expect(allEvents[1].id).toBe(evId2);
  expect(allEvents[1].kind).toBe("state");
  expect(allEvents[1].dataJson).toEqual({ running: true, agentName: "Claude" });

  // List events after evId1
  const remainingEvents = listTerminalEventsAfter(state.db, termId, evId1);
  expect(remainingEvents.length).toBe(1);
  expect(remainingEvents[0].id).toBe(evId2);

  // B6 D-B6-1: kinds filter — the reconnect delta replay asks for state
  // events only, and a stale lastEventId below purged output ids must still
  // return only the requested kinds.
  const stateOnly = listTerminalEventsAfter(state.db, termId, 0, {
    kinds: ["state"],
  });
  expect(stateOnly.length).toBe(1);
  expect(stateOnly[0].id).toBe(evId2);
  expect(stateOnly[0].kind).toBe("state");

  const limited = listTerminalEventsAfter(state.db, termId, 0, { limit: 1 });
  expect(limited.length).toBe(1);
  expect(limited[0].id).toBe(evId1);

  state.db.close();
});

test("foundation C1b: reconcileSessionsOnStartup", async () => {
  const stateDir = await createTempDir(".deckterm-c1b-reconcile-state-");
  const projectRoot = await createTempDir(".deckterm-c1b-reconcile-root-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [projectRoot],
    env: {},
    now: new Date("2026-05-24T12:00:00Z"),
  });

  const termId = "term-reconcile-test";
  recordTerminalSession(state.db, {
    id: termId,
    actorUserId: "user_owner",
    rootId: state.roots[0]?.id,
    cwd: projectRoot,
    now: new Date("2026-05-24T12:01:00Z"),
  });

  const originalBackend = process.env.TMUX_BACKEND;
  process.env.TMUX_BACKEND = "1";

  const { reconcileSessionsOnStartup } = require("../server");
  const reconciled = await reconcileSessionsOnStartup(state.db);

  expect(reconciled).toBe(1);

  const session = getTerminalSession(state.db, termId);
  expect(session?.status).toBe("ended");
  expect(session?.endedAt).not.toBeNull();

  if (originalBackend !== undefined) {
    process.env.TMUX_BACKEND = originalBackend;
  } else {
    delete process.env.TMUX_BACKEND;
  }

  state.db.close();
});
