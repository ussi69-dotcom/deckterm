import { expect, test } from "bun:test";
import type { CloudflareAccessPayload } from "@hono/cloudflare-access";
import {
  E2E_RUN_ACTOR_PREFIX,
  E2E_RUN_COOKIE_NAME,
  applyE2ERunActorNamespace,
  crossesE2ERunNamespace,
  crossesE2ERunNamespaceForRequest,
  getE2ERunIdFromActorId,
  resolveActorFromAccessPayload,
} from "./services/foundation-actors";

const accessPayload: CloudflareAccessPayload = {
  sub: "cf-user-123",
  email: "admin@example.com",
  aud: ["test-aud"],
  exp: 9999999999,
  iat: 1000000000,
  nbf: 1000000000,
  iss: "https://test.cloudflareaccess.com",
  type: "app",
  identity_nonce: "test-nonce",
  country: "US",
};

test("resolveActorFromAccessPayload uses Cloudflare Access identity when present", () => {
  expect(
    resolveActorFromAccessPayload({
      accessPayload,
      env: { CF_ACCESS_REQUIRED: "1" },
    }),
  ).toEqual({
    ok: true,
    actor: {
      id: "cf-user-123",
      email: "admin@example.com",
      source: "cloudflare_access",
    },
  });
});

test("resolveActorFromAccessPayload rejects missing Cloudflare Access identity when required", () => {
  expect(
    resolveActorFromAccessPayload({
      accessPayload: null,
      env: { CF_ACCESS_REQUIRED: "1" },
    }),
  ).toEqual({
    ok: false,
    status: 401,
    reason: "cloudflare_access_required",
  });
});

test("resolveActorFromAccessPayload allows anonymous actor only for explicit dev or test modes", () => {
  for (const env of [
    { DECKTERM_RUNTIME_ENV: "development" },
    { DECKTERM_RUNTIME_ENV: "dev" },
    { NODE_ENV: "test" },
    { BUN_ENV: "test" },
    { CI: "true" },
    {
      DECKTERM_DEV_INSECURE_LOCAL_ADMIN: "1",
      DECKTERM_RUNTIME_ENV: "development",
    },
  ]) {
    expect(resolveActorFromAccessPayload({ accessPayload: null, env })).toEqual(
      {
        ok: true,
        actor: {
          id: "anonymous",
          email: "anonymous",
          source: "legacy_dev",
        },
      },
    );
  }
});

test("resolveActorFromAccessPayload rejects anonymous actor in production-like mode", () => {
  expect(
    resolveActorFromAccessPayload({
      accessPayload: null,
      env: { NODE_ENV: "production" },
    }),
  ).toEqual({
    ok: false,
    status: 401,
    reason: "cloudflare_access_required",
  });
});

test("resolveActorFromAccessPayload derives a per-user actor from the edge header in cloudflare-tunnel mode", () => {
  expect(
    resolveActorFromAccessPayload({
      accessPayload: null,
      tunnelUserEmail: "lukas@example.com",
      env: {
        DECKTERM_PUBLISH_MODE: "cloudflare-tunnel",
        NODE_ENV: "production",
      },
    }),
  ).toEqual({
    ok: true,
    actor: {
      id: "lukas@example.com",
      email: "lukas@example.com",
      source: "cloudflare_tunnel",
    },
  });
});

test("resolveActorFromAccessPayload falls back to a default tunnel actor when the edge header is missing", () => {
  expect(
    resolveActorFromAccessPayload({
      accessPayload: null,
      env: {
        DECKTERM_PUBLISH_MODE: "cloudflare-tunnel",
        NODE_ENV: "production",
      },
    }),
  ).toEqual({
    ok: true,
    actor: {
      id: "tunnel",
      email: "tunnel",
      source: "tunnel_default",
    },
  });
});

test("resolveActorFromAccessPayload keeps strict 401 for cloudflare-access mode without identity", () => {
  expect(
    resolveActorFromAccessPayload({
      accessPayload: null,
      tunnelUserEmail: "spoofed@example.com",
      env: {
        DECKTERM_PUBLISH_MODE: "cloudflare-access",
        NODE_ENV: "production",
      },
    }),
  ).toEqual({
    ok: false,
    status: 401,
    reason: "cloudflare_access_required",
  });
});

const legacyActor = {
  id: "anonymous",
  email: "anonymous",
  source: "legacy_dev" as const,
};
const RUN_A = "0123456789abcdef0123456789abcdef";
const RUN_B = "fedcba9876543210fedcba9876543210";

test("applyE2ERunActorNamespace derives a synthetic actor only on the explicit loopback dev harness", () => {
  const result = applyE2ERunActorNamespace({
    actor: legacyActor,
    cookieHeader: `other=value; ${E2E_RUN_COOKIE_NAME}=${RUN_A}`,
    requestUrl: "http://127.0.0.1:4174/api/foundation/status",
    env: {
      DECKTERM_RUNTIME_ENV: "development",
      DECKTERM_LEGACY_NO_BOOTSTRAP: "1",
    },
  });

  expect(result).toEqual({
    ok: true,
    actor: {
      ...legacyActor,
      id: `${E2E_RUN_ACTOR_PREFIX}${RUN_A}`,
    },
  });
  if (result.ok) {
    expect(getE2ERunIdFromActorId(result.actor.id)).toBe(RUN_A);
  }
});

test("applyE2ERunActorNamespace leaves cookie-free requests byte-equivalent", () => {
  expect(
    applyE2ERunActorNamespace({
      actor: legacyActor,
      cookieHeader: "ordinary=value",
      requestUrl: "https://deckterm.example/api/foundation/status",
      env: { NODE_ENV: "production" },
    }),
  ).toEqual({ ok: true, actor: legacyActor });
});

test("applyE2ERunActorNamespace rejects malformed and duplicate run cookies", () => {
  for (const cookieHeader of [
    `${E2E_RUN_COOKIE_NAME}=ABC`,
    `${E2E_RUN_COOKIE_NAME}=${RUN_A}; ${E2E_RUN_COOKIE_NAME}=${RUN_A}`,
    `${E2E_RUN_COOKIE_NAME}=${RUN_A}%00`,
  ]) {
    expect(
      applyE2ERunActorNamespace({
        actor: legacyActor,
        cookieHeader,
        requestUrl: "http://localhost:4174/api/terminals",
        env: {
          DECKTERM_RUNTIME_ENV: "dev",
          DECKTERM_LEGACY_NO_BOOTSTRAP: "1",
        },
      }),
    ).toEqual({
      ok: false,
      status: 403,
      reason: "e2e_run_cookie_invalid",
    });
  }
});

test("applyE2ERunActorNamespace rejects a valid cookie outside the exact harness context", () => {
  const cases = [
    {
      requestUrl: "http://127.0.0.1:4173/api/terminals",
      env: {
        DECKTERM_RUNTIME_ENV: "development",
        DECKTERM_LEGACY_NO_BOOTSTRAP: "1",
      },
      actor: legacyActor,
    },
    {
      requestUrl: "https://127.0.0.1:4174/api/terminals",
      env: {
        DECKTERM_RUNTIME_ENV: "development",
        DECKTERM_LEGACY_NO_BOOTSTRAP: "1",
      },
      actor: legacyActor,
    },
    {
      requestUrl: "http://deckterm.example:4174/api/terminals",
      env: {
        DECKTERM_RUNTIME_ENV: "development",
        DECKTERM_LEGACY_NO_BOOTSTRAP: "1",
      },
      actor: legacyActor,
    },
    {
      requestUrl: "http://127.0.0.1:4174/api/terminals",
      env: {
        DECKTERM_RUNTIME_ENV: "production",
        DECKTERM_LEGACY_NO_BOOTSTRAP: "1",
      },
      actor: legacyActor,
    },
    {
      requestUrl: "http://127.0.0.1:4174/api/terminals",
      env: { DECKTERM_RUNTIME_ENV: "development" },
      actor: legacyActor,
    },
    {
      requestUrl: "http://127.0.0.1:4174/api/terminals",
      env: {
        DECKTERM_RUNTIME_ENV: "development",
        DECKTERM_LEGACY_NO_BOOTSTRAP: "1",
      },
      actor: {
        id: accessPayload.sub,
        email: accessPayload.email,
        source: "cloudflare_access" as const,
      },
    },
  ];

  for (const value of cases) {
    expect(
      applyE2ERunActorNamespace({
        ...value,
        cookieHeader: `${E2E_RUN_COOKIE_NAME}=${RUN_A}`,
      }),
    ).toEqual({
      ok: false,
      status: 403,
      reason: "e2e_run_context_invalid",
    });
  }
});

test("crossesE2ERunNamespace is symmetric and isolates different runs", () => {
  const actorA = `${E2E_RUN_ACTOR_PREFIX}${RUN_A}`;
  const actorB = `${E2E_RUN_ACTOR_PREFIX}${RUN_B}`;

  expect(crossesE2ERunNamespace("anonymous", "anonymous")).toBe(false);
  expect(crossesE2ERunNamespace(actorA, actorA)).toBe(false);
  expect(crossesE2ERunNamespace(actorA, actorB)).toBe(true);
  expect(crossesE2ERunNamespace(actorB, actorA)).toBe(true);
  expect(crossesE2ERunNamespace(actorA, "anonymous")).toBe(true);
  expect(crossesE2ERunNamespace("anonymous", actorA)).toBe(true);
});

test("request-aware boundary reserves the synthetic prefix only inside the exact harness", () => {
  const actorA = `${E2E_RUN_ACTOR_PREFIX}${RUN_A}`;
  const harnessEnv = {
    DECKTERM_RUNTIME_ENV: "development",
    DECKTERM_LEGACY_NO_BOOTSTRAP: "1",
  };

  expect(
    crossesE2ERunNamespaceForRequest({
      actorId: actorA,
      resourceOwnerId: "anonymous",
      requestUrl: "http://127.0.0.1:4174/api/terminals/example",
      env: harnessEnv,
    }),
  ).toBe(true);
  expect(
    crossesE2ERunNamespaceForRequest({
      actorId: actorA,
      resourceOwnerId: "anonymous",
      requestUrl: "https://deckterm.example/api/terminals/example",
      env: { NODE_ENV: "production" },
    }),
  ).toBe(false);
});
