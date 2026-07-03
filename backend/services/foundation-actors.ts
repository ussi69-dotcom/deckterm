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
