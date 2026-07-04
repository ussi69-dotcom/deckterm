import { expect, test } from "bun:test";
import type { CloudflareAccessPayload } from "@hono/cloudflare-access";
import { resolveActorFromAccessPayload } from "./services/foundation-actors";

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
