import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  initializeFoundationState,
  listPushSubscriptionsForUser,
} from "./services/foundation-state";

const keys = [
  "DECKTERM_STATE_DIR",
  "ALLOWED_FILE_ROOTS",
  "DECKTERM_RUNTIME_ENV",
  "DECKTERM_PUBLISH_MODE",
  "DECKTERM_LEGACY_NO_BOOTSTRAP",
  "CF_ACCESS_REQUIRED",
  "DECKTERM_VAPID_PUBLIC_KEY",
  "DECKTERM_VAPID_PRIVATE_KEY",
  "DECKTERM_VAPID_SUBJECT",
] as const;
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
let stateDir = "";

afterAll(async () => {
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  if (stateDir) await rm(stateDir, { recursive: true, force: true });
});

test("push API stores only the canonical caller subscription and never echoes secrets", async () => {
  stateDir = await mkdtemp(
    join(process.env.HOME || "/tmp", ".deckterm-push-api-"),
  );
  process.env.DECKTERM_STATE_DIR = stateDir;
  process.env.ALLOWED_FILE_ROOTS = stateDir;
  process.env.DECKTERM_RUNTIME_ENV = "development";
  process.env.DECKTERM_LEGACY_NO_BOOTSTRAP = "1";
  process.env.CF_ACCESS_REQUIRED = "0";
  delete process.env.DECKTERM_PUBLISH_MODE;
  process.env.DECKTERM_VAPID_PUBLIC_KEY = Buffer.alloc(65, 3).toString(
    "base64url",
  );
  process.env.DECKTERM_VAPID_PRIVATE_KEY = Buffer.alloc(32, 4).toString(
    "base64url",
  );
  process.env.DECKTERM_VAPID_SUBJECT = "mailto:deckterm@example.test";

  const seeded = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [stateDir],
    env: process.env,
  });
  const now = new Date().toISOString();
  seeded.db
    .query(
      `INSERT INTO users
        (id, email, display_name, role, disabled, created_at, updated_at)
       VALUES ('anonymous', NULL, 'Local user', 'owner', 0, ?, ?)`,
    )
    .run(now, now);
  seeded.db.close();

  const { createWebApp } = await import("./server");
  const app = createWebApp();
  const configResponse = await app.fetch(
    new Request("http://localhost/api/notifications/push"),
  );
  expect(configResponse.status).toBe(200);
  const config = await configResponse.json();
  expect(config).toEqual({
    configured: true,
    publicKey: process.env.DECKTERM_VAPID_PUBLIC_KEY,
  });

  const subscription = {
    endpoint: "https://push.example.test/api-secret-device",
    expirationTime: null,
    keys: {
      p256dh: Buffer.alloc(65, 1).toString("base64url"),
      auth: Buffer.alloc(16, 2).toString("base64url"),
    },
  };
  const subscribeResponse = await app.fetch(
    new Request("http://localhost/api/notifications/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subscription }),
    }),
  );
  expect(subscribeResponse.status).toBe(200);
  const responseText = await subscribeResponse.text();
  expect(responseText).toBe('{"ok":true}');
  expect(responseText).not.toContain(subscription.endpoint);
  expect(responseText).not.toContain(subscription.keys.auth);

  const check = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [stateDir],
    env: process.env,
  });
  expect(listPushSubscriptionsForUser(check.db, "anonymous")).toHaveLength(1);
  const audit = check.db
    .query(
      `SELECT data_json FROM audit_events
       WHERE action = 'push.subscribe' ORDER BY created_at DESC LIMIT 1`,
    )
    .get() as { data_json: string };
  expect(audit.data_json).toBe("{}");
  expect(audit.data_json).not.toContain(subscription.endpoint);
  check.db.close();
});
