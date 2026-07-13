import type { CloudflareAccessPayload } from "@hono/cloudflare-access";

export type DeckTermActor = {
  id: string;
  email: string;
  source:
    "cloudflare_access" | "cloudflare_tunnel" | "tunnel_default" | "legacy_dev";
};

export type ActorResolutionResult =
  | { ok: true; actor: DeckTermActor }
  | { ok: false; status: 401; reason: "cloudflare_access_required" };

type FoundationActorEnv = Record<string, string | undefined>;

export const E2E_RUN_COOKIE_NAME = "deckterm_e2e_run";
export const E2E_RUN_ACTOR_PREFIX = "__deckterm_e2e_run__";
const E2E_RUN_ID_PATTERN = /^[0-9a-f]{32}$/;

export type E2ERunActorResolutionResult =
  | { ok: true; actor: DeckTermActor }
  | {
      ok: false;
      status: 403;
      reason: "e2e_run_cookie_invalid" | "e2e_run_context_invalid";
    };

function readE2ERunCookie(cookieHeader?: string | null):
  | { present: false }
  | { present: true; valid: true; runId: string }
  | { present: true; valid: false } {
  if (!cookieHeader) return { present: false };

  const values: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== E2E_RUN_COOKIE_NAME) continue;
    values.push(part.slice(separator + 1).trim());
  }

  if (values.length === 0) return { present: false };
  if (values.length !== 1 || !E2E_RUN_ID_PATTERN.test(values[0])) {
    return { present: true, valid: false };
  }
  return { present: true, valid: true, runId: values[0] };
}

function isExactE2EHarnessRequest(
  requestUrl: string | undefined,
  env: FoundationActorEnv,
): boolean {
  if (
    (env.DECKTERM_RUNTIME_ENV !== "development" &&
      env.DECKTERM_RUNTIME_ENV !== "dev") ||
    env.DECKTERM_LEGACY_NO_BOOTSTRAP !== "1" ||
    !requestUrl
  ) {
    return false;
  }

  try {
    const url = new URL(requestUrl);
    return (
      url.protocol === "http:" &&
      url.port === "4174" &&
      ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Applies the Playwright-only actor namespace at the authentication boundary.
 * Cookie-free traffic is intentionally untouched. A present cookie fails
 * closed unless it is both well-formed and received by the exact loopback dev
 * harness, preventing a test marker from ever weakening another deployment.
 */
export function applyE2ERunActorNamespace({
  actor,
  cookieHeader,
  requestUrl,
  env,
}: {
  actor: DeckTermActor;
  cookieHeader?: string | null;
  requestUrl?: string;
  env: FoundationActorEnv;
}): E2ERunActorResolutionResult {
  const cookie = readE2ERunCookie(cookieHeader);
  if (!cookie.present) return { ok: true, actor };
  if (!cookie.valid) {
    return {
      ok: false,
      status: 403,
      reason: "e2e_run_cookie_invalid",
    };
  }
  if (
    actor.source !== "legacy_dev" ||
    !isExactE2EHarnessRequest(requestUrl, env)
  ) {
    return {
      ok: false,
      status: 403,
      reason: "e2e_run_context_invalid",
    };
  }

  return {
    ok: true,
    actor: {
      ...actor,
      id: `${E2E_RUN_ACTOR_PREFIX}${cookie.runId}`,
    },
  };
}

export function getE2ERunIdFromActorId(actorId: string): string | null {
  if (!actorId.startsWith(E2E_RUN_ACTOR_PREFIX)) return null;
  const runId = actorId.slice(E2E_RUN_ACTOR_PREFIX.length);
  return E2E_RUN_ID_PATTERN.test(runId) ? runId : null;
}

/** A test namespace may interact only with resources from the same run. */
export function crossesE2ERunNamespace(
  actorId: string,
  resourceOwnerId: string | null | undefined,
): boolean {
  const actorRunId = getE2ERunIdFromActorId(actorId);
  const resourceRunId = resourceOwnerId
    ? getE2ERunIdFromActorId(resourceOwnerId)
    : null;
  if (!actorRunId && !resourceRunId) return false;
  return actorRunId !== resourceRunId;
}

/**
 * Request-aware boundary used by server routes. The reserved actor prefix has
 * no semantics outside the exact local E2E harness, so production identities
 * that happen to share its shape retain their ordinary authorization path.
 */
export function crossesE2ERunNamespaceForRequest({
  actorId,
  resourceOwnerId,
  requestUrl,
  env,
}: {
  actorId: string;
  resourceOwnerId: string | null | undefined;
  requestUrl: string | undefined;
  env: FoundationActorEnv;
}): boolean {
  return (
    isExactE2EHarnessRequest(requestUrl, env) &&
    crossesE2ERunNamespace(actorId, resourceOwnerId)
  );
}

// In `cloudflare-tunnel` publish mode the Cloudflare Access edge authenticates
// the human before the request reaches DeckTerm; the app does not verify the
// JWT itself. Trusting the forwarded identity header is safe only because such
// deployments bind to a loopback host, so the app is reachable solely through
// the tunnel. The setup doctor warns if HOST is not loopback in this mode.
export function isEdgeProtectedTunnelMode(env: FoundationActorEnv): boolean {
  return env.DECKTERM_PUBLISH_MODE === "cloudflare-tunnel";
}

export function hasExplicitLegacyDevActorMode(
  env: FoundationActorEnv,
): boolean {
  return (
    env.CI === "true" ||
    env.NODE_ENV === "test" ||
    env.BUN_ENV === "test" ||
    env.DECKTERM_RUNTIME_ENV === "development" ||
    env.DECKTERM_RUNTIME_ENV === "dev" ||
    (env.DECKTERM_DEV_INSECURE_LOCAL_ADMIN === "1" &&
      (env.DECKTERM_RUNTIME_ENV === "development" ||
        env.DECKTERM_RUNTIME_ENV === "dev"))
  );
}

export function resolveActorFromAccessPayload({
  accessPayload,
  tunnelUserEmail,
  env,
}: {
  accessPayload?: CloudflareAccessPayload | null;
  tunnelUserEmail?: string | null;
  env: FoundationActorEnv;
}): ActorResolutionResult {
  if (accessPayload?.sub && accessPayload.email) {
    return {
      ok: true,
      actor: {
        id: accessPayload.sub,
        email: accessPayload.email,
        source: "cloudflare_access",
      },
    };
  }

  if (isEdgeProtectedTunnelMode(env)) {
    const email = tunnelUserEmail?.trim();
    if (email) {
      return {
        ok: true,
        actor: { id: email, email, source: "cloudflare_tunnel" },
      };
    }
    console.warn(
      "[auth] cloudflare-tunnel mode: missing Cf-Access-Authenticated-User-Email header; falling back to default tunnel actor",
    );
    return {
      ok: true,
      actor: { id: "tunnel", email: "tunnel", source: "tunnel_default" },
    };
  }

  if (env.CF_ACCESS_REQUIRED === "1" || !hasExplicitLegacyDevActorMode(env)) {
    return {
      ok: false,
      status: 401,
      reason: "cloudflare_access_required",
    };
  }

  return {
    ok: true,
    actor: {
      id: "anonymous",
      email: "anonymous",
      source: "legacy_dev",
    },
  };
}

/**
 * Maps an actor's source to its canonical (provider, issuer, subject)
 * identity triple (B1 §1.1). Actor identity is always this triple — never
 * email — used as the lookup/storage key for `auth_identities`.
 */
export function actorIdentityTriple(
  actor: DeckTermActor,
  env: Record<string, string | undefined>,
): { provider: string; issuer: string; subject: string } {
  switch (actor.source) {
    case "cloudflare_access":
      return {
        provider: "cloudflare_access",
        issuer: env.CF_ACCESS_TEAM_NAME?.trim() ?? "",
        subject: actor.id,
      };
    case "cloudflare_tunnel":
      return {
        provider: "cloudflare_tunnel",
        issuer: "",
        subject: actor.email,
      };
    case "tunnel_default":
      return { provider: "cloudflare_tunnel", issuer: "", subject: "tunnel" };
    case "legacy_dev":
      return { provider: "legacy", issuer: "", subject: "anonymous" };
    default: {
      // Exhaustiveness guard: DeckTermActor["source"] is a closed union — if
      // a new source is ever added without updating this map, fail loudly
      // instead of silently minting an unmapped identity triple.
      const unreachable: never = actor.source;
      throw new Error(`unmapped actor source: ${String(unreachable)}`);
    }
  }
}
