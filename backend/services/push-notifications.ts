import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import * as webPush from "web-push";
import {
  deletePushSubscriptionById,
  listPushSubscriptionsForUser,
} from "./foundation-state";

export type WebPushConfig = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

export type ValidatedPushSubscription = {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
};

type PushSender = typeof webPush.sendNotification;

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_KEY_LENGTH = 256;

function decodedByteLength(value: string): number {
  try {
    return Buffer.from(value, "base64url").byteLength;
  } catch {
    return -1;
  }
}

function validVapidSubject(value: string): boolean {
  if (value.startsWith("mailto:")) {
    return /^mailto:[^\s@]+@[^\s@]+$/.test(value);
  }
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function resolveWebPushConfig(
  env: Record<string, string | undefined> = process.env,
): WebPushConfig | null {
  const publicKey = String(env.DECKTERM_VAPID_PUBLIC_KEY || "").trim();
  const privateKey = String(env.DECKTERM_VAPID_PRIVATE_KEY || "").trim();
  const subject = String(env.DECKTERM_VAPID_SUBJECT || "").trim();
  if (!publicKey || !privateKey || !subject) return null;
  if (
    !BASE64URL_RE.test(publicKey) ||
    !BASE64URL_RE.test(privateKey) ||
    decodedByteLength(publicKey) !== 65 ||
    decodedByteLength(privateKey) !== 32 ||
    !validVapidSubject(subject)
  ) {
    return null;
  }
  return { publicKey, privateKey, subject };
}

export function validatePushSubscriptionInput(
  value: unknown,
):
  | { ok: true; subscription: ValidatedPushSubscription }
  | { ok: false; reason: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "subscription_required" };
  }
  const candidate = value as {
    endpoint?: unknown;
    expirationTime?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
  };
  if (
    typeof candidate.endpoint !== "string" ||
    !candidate.endpoint ||
    candidate.endpoint.length > MAX_ENDPOINT_LENGTH
  ) {
    return { ok: false, reason: "invalid_endpoint" };
  }
  try {
    if (new URL(candidate.endpoint).protocol !== "https:") {
      return { ok: false, reason: "invalid_endpoint" };
    }
  } catch {
    return { ok: false, reason: "invalid_endpoint" };
  }
  const p256dh = candidate.keys?.p256dh;
  const auth = candidate.keys?.auth;
  if (
    typeof p256dh !== "string" ||
    typeof auth !== "string" ||
    !p256dh ||
    !auth ||
    p256dh.length > MAX_KEY_LENGTH ||
    auth.length > MAX_KEY_LENGTH ||
    !BASE64URL_RE.test(p256dh) ||
    !BASE64URL_RE.test(auth) ||
    decodedByteLength(p256dh) !== 65 ||
    decodedByteLength(auth) < 16
  ) {
    return { ok: false, reason: "invalid_keys" };
  }
  const rawExpiration = candidate.expirationTime;
  const expirationTime =
    rawExpiration === null || rawExpiration === undefined
      ? null
      : Number(rawExpiration);
  if (
    expirationTime !== null &&
    (!Number.isSafeInteger(expirationTime) || expirationTime < 0)
  ) {
    return { ok: false, reason: "invalid_expiration" };
  }
  return {
    ok: true,
    subscription: {
      endpoint: candidate.endpoint,
      expirationTime,
      keys: { p256dh, auth },
    },
  };
}

function compactHash(value: string): string {
  return createHash("sha256").update(value).digest("base64url").slice(0, 24);
}

export async function dispatchCompletionPush({
  db,
  config,
  userId,
  terminalId,
  kind,
  now = Date.now(),
  send = webPush.sendNotification,
}: {
  db: Database;
  config: WebPushConfig | null;
  userId: string;
  terminalId: string;
  kind: "agent" | "command";
  now?: number;
  send?: PushSender;
}): Promise<{
  configured: boolean;
  attempted: number;
  delivered: number;
  staleRemoved: number;
  failed: number;
}> {
  if (!config) {
    return {
      configured: false,
      attempted: 0,
      delivered: 0,
      staleRemoved: 0,
      failed: 0,
    };
  }

  const subscriptions = listPushSubscriptionsForUser(db, userId);
  const result = {
    configured: true,
    attempted: subscriptions.length,
    delivered: 0,
    staleRemoved: 0,
    failed: 0,
  };
  const payload = JSON.stringify({
    title: "DeckTerm",
    body: kind === "agent" ? "Agent turn finished" : "Command finished",
    tag: `deckterm-${compactHash(terminalId)}`,
    data: { url: "/" },
    silent: false,
  });

  await Promise.all(
    subscriptions.map(async (subscription) => {
      if (
        subscription.expirationTime !== null &&
        subscription.expirationTime <= now
      ) {
        if (deletePushSubscriptionById(db, userId, subscription.id)) {
          result.staleRemoved += 1;
        }
        return;
      }
      try {
        await send(
          {
            endpoint: subscription.endpoint,
            expirationTime: subscription.expirationTime,
            keys: {
              p256dh: subscription.p256dh,
              auth: subscription.auth,
            },
          },
          payload,
          {
            TTL: 300,
            urgency: "high",
            topic: compactHash(terminalId),
            timeout: 10_000,
            vapidDetails: config,
          },
        );
        result.delivered += 1;
      } catch (error) {
        const statusCode = Number(
          (error as { statusCode?: unknown } | null)?.statusCode || 0,
        );
        if (
          (statusCode === 404 || statusCode === 410) &&
          deletePushSubscriptionById(db, userId, subscription.id)
        ) {
          result.staleRemoved += 1;
        } else {
          result.failed += 1;
        }
      }
    }),
  );
  return result;
}
