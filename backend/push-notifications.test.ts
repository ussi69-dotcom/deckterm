import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  deletePushSubscriptionForUser,
  initializeFoundationState,
  listPushSubscriptionsForUser,
  upsertPushSubscription,
} from "./services/foundation-state";
import {
  dispatchCompletionPush,
  resolveWebPushConfig,
  validatePushSubscriptionInput,
  type WebPushConfig,
} from "./services/push-notifications";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function base64urlBytes(length: number, fill: number): string {
  return Buffer.alloc(length, fill).toString("base64url");
}

function validSubscription(endpoint = "https://push.example.test/device-a") {
  return {
    endpoint,
    expirationTime: null,
    keys: {
      p256dh: base64urlBytes(65, 1),
      auth: base64urlBytes(16, 2),
    },
  };
}

function validConfig(): WebPushConfig {
  return {
    publicKey: base64urlBytes(65, 3),
    privateKey: base64urlBytes(32, 4),
    subject: "mailto:deckterm@example.test",
  };
}

async function createState() {
  const stateDir = await mkdtemp(join(tmpdir(), "deckterm-push-test-"));
  tempDirs.push(stateDir);
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [stateDir],
    env: {
      DECKTERM_RUNTIME_ENV: "test",
      DECKTERM_AUTH_MODE: "legacy",
      DECKTERM_LEGACY_NO_BOOTSTRAP: "1",
    },
  });
  const now = new Date().toISOString();
  for (const userId of ["user-a", "user-b"]) {
    state.db
      .query(
        `INSERT INTO users
          (id, email, display_name, role, disabled, created_at, updated_at)
         VALUES (?, ?, ?, 'member', 0, ?, ?)`,
      )
      .run(userId, `${userId}@example.test`, userId, now, now);
  }
  return state;
}

describe("push subscription persistence", () => {
  test("migration 10 is present and initialization is idempotent", async () => {
    const state = await createState();
    expect(
      state.db
        .query("SELECT version FROM schema_migrations WHERE version = 10")
        .get(),
    ).toBeTruthy();
    expect(
      state.db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'push_subscriptions'",
        )
        .get(),
    ).toBeTruthy();
  });

  test("same-user upsert rotates keys but a second user cannot claim an endpoint", async () => {
    const state = await createState();
    const first = validSubscription();
    expect(
      upsertPushSubscription(state.db, {
        userId: "user-a",
        endpoint: first.endpoint,
        p256dh: first.keys.p256dh,
        auth: first.keys.auth,
      }).ok,
    ).toBe(true);
    expect(
      upsertPushSubscription(state.db, {
        userId: "user-a",
        endpoint: first.endpoint,
        p256dh: base64urlBytes(65, 5),
        auth: first.keys.auth,
      }).ok,
    ).toBe(true);
    expect(
      upsertPushSubscription(state.db, {
        userId: "user-b",
        endpoint: first.endpoint,
        p256dh: first.keys.p256dh,
        auth: first.keys.auth,
      }),
    ).toEqual({ ok: false, reason: "endpoint_conflict" });
    expect(listPushSubscriptionsForUser(state.db, "user-a")).toHaveLength(1);
    expect(listPushSubscriptionsForUser(state.db, "user-b")).toHaveLength(0);
  });

  test("delete is scoped to the authenticated user", async () => {
    const state = await createState();
    const subscription = validSubscription();
    upsertPushSubscription(state.db, {
      userId: "user-a",
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    });
    expect(
      deletePushSubscriptionForUser(state.db, "user-b", subscription.endpoint),
    ).toBe(false);
    expect(listPushSubscriptionsForUser(state.db, "user-a")).toHaveLength(1);
  });
});

describe("push validation and delivery", () => {
  test("configuration fails closed unless all VAPID values are structurally valid", () => {
    const config = validConfig();
    expect(
      resolveWebPushConfig({
        DECKTERM_VAPID_PUBLIC_KEY: config.publicKey,
        DECKTERM_VAPID_PRIVATE_KEY: config.privateKey,
        DECKTERM_VAPID_SUBJECT: config.subject,
      }),
    ).toEqual(config);
    expect(
      resolveWebPushConfig({
        DECKTERM_VAPID_PUBLIC_KEY: config.publicKey,
        DECKTERM_VAPID_PRIVATE_KEY: "bad",
        DECKTERM_VAPID_SUBJECT: config.subject,
      }),
    ).toBeNull();
  });

  test("subscription validation enforces HTTPS and browser key sizes", () => {
    expect(validatePushSubscriptionInput(validSubscription()).ok).toBe(true);
    expect(
      validatePushSubscriptionInput({
        ...validSubscription(),
        endpoint: "http://push.example.test/device-a",
      }),
    ).toEqual({ ok: false, reason: "invalid_endpoint" });
    expect(
      validatePushSubscriptionInput({
        ...validSubscription(),
        keys: { p256dh: "short", auth: "short" },
      }),
    ).toEqual({ ok: false, reason: "invalid_keys" });
  });

  test("delivery is generic, removes 410 rows, and retains transient failures", async () => {
    const state = await createState();
    for (const suffix of ["ok", "gone", "retry"]) {
      const subscription = validSubscription(
        `https://push.example.test/${suffix}`,
      );
      upsertPushSubscription(state.db, {
        userId: "user-a",
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
      });
    }
    const payloads: string[] = [];
    const result = await dispatchCompletionPush({
      db: state.db,
      config: validConfig(),
      userId: "user-a",
      terminalId: "secret-terminal-id",
      kind: "agent",
      send: (async (subscription, payload) => {
        payloads.push(String(payload));
        if (subscription.endpoint.endsWith("/gone")) {
          throw Object.assign(new Error("gone"), { statusCode: 410 });
        }
        if (subscription.endpoint.endsWith("/retry")) {
          throw Object.assign(new Error("retry"), { statusCode: 503 });
        }
        return { statusCode: 201, headers: {}, body: "" };
      }) as typeof import("web-push").sendNotification,
    });
    expect(result).toEqual({
      configured: true,
      attempted: 3,
      delivered: 1,
      staleRemoved: 1,
      failed: 1,
    });
    expect(payloads).toHaveLength(3);
    for (const payload of payloads) {
      expect(payload).toContain("Agent turn finished");
      expect(payload).not.toContain("secret-terminal-id");
      expect(payload).not.toContain("example.test/ok");
    }
    expect(
      listPushSubscriptionsForUser(state.db, "user-a").map(
        (row) => row.endpoint,
      ),
    ).toEqual([
      "https://push.example.test/ok",
      "https://push.example.test/retry",
    ]);
  });
});
