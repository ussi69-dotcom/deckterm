import type { Database } from "bun:sqlite";
import type { DeckTermActor } from "./foundation-actors";
import {
  getFoundationUserById,
  getOsMapping,
  getTerminalSession,
  hasScopedGrant,
  resolveUserForActor,
  suspendOsMapping,
  type FoundationUserRole,
} from "./foundation-state";
import {
  evaluateOsAccountEligibility,
  gatherOsAccountFacts,
  resolveEligibilityPolicy,
} from "./os-mapping-eligibility";

export type FoundationEnv = Record<string, string | undefined>;

export type FoundationCapability =
  | "terminal.create"
  | "terminal.attach"
  | "terminal.write"
  | "terminal.manage"
  | "root.use";

// The check-time role bundle (plan §3): owner/admin imply exactly these five
// capabilities on ANY resource. This replaces materialized `*/*` grant rows
// as the wildcard mechanism — member gets no wildcards, ever (invariant §9.3).
const ROLE_BUNDLE_CAPABILITIES: ReadonlySet<string> = new Set([
  "terminal.create",
  "terminal.attach",
  "terminal.write",
  "terminal.manage",
  "root.use",
]);

export function roleImpliesCapability(
  role: FoundationUserRole,
  capability: string,
): boolean {
  if (role === "owner" || role === "admin") {
    return ROLE_BUNDLE_CAPABILITIES.has(capability);
  }
  return false;
}

export type RouteCapability = {
  capability: FoundationCapability;
  resourceType: "terminal" | "root";
  resourceId?: string;
};

export function isLegacyBootstrapBypassAllowed(env: FoundationEnv): boolean {
  if (env.DECKTERM_LEGACY_NO_BOOTSTRAP !== "1") return false;

  return (
    env.CI === "true" ||
    env.NODE_ENV === "test" ||
    env.BUN_ENV === "test" ||
    env.DECKTERM_RUNTIME_ENV === "development" ||
    env.DECKTERM_RUNTIME_ENV === "dev"
  );
}

export function authorizeTerminalSessionAccess(
  db: Database,
  request: {
    actorUserId: string;
    terminalId: string;
    capability: "terminal.attach" | "terminal.write" | "terminal.manage";
  },
):
  | { allow: true; reason: "owner" | "role_bundle" | "granted" }
  | {
      allow: false;
      reason:
        "user_disabled" | "missing_capability" | "terminal_session_not_found";
    } {
  // Precedence (plan §3, invariant §9.2): disabled wins over everything —
  // checked before the owner short-circuit, before the role bundle, before
  // grants. Today a disabled user would otherwise still pass as "owner" of
  // their own terminal.
  const user = getFoundationUserById(db, request.actorUserId);
  if (user?.disabled) {
    return { allow: false, reason: "user_disabled" };
  }

  const session = getTerminalSession(db, request.terminalId);
  if (!session) {
    return { allow: false, reason: "terminal_session_not_found" };
  }
  if (session.actorUserId === request.actorUserId) {
    return { allow: true, reason: "owner" };
  }
  // Role bundle, evaluated at check time — not materialized (invariant §9.3):
  // owner/admin imply the five capabilities on any resource; member gets no
  // wildcards, scoped grants only.
  if (user && roleImpliesCapability(user.role, request.capability)) {
    return { allow: true, reason: "role_bundle" };
  }
  if (
    hasScopedGrant(db, {
      userId: request.actorUserId,
      capability: request.capability,
      resourceType: "terminal",
      resourceId: request.terminalId,
    })
  ) {
    return { allow: true, reason: "granted" };
  }
  return { allow: false, reason: "missing_capability" };
}

export function authorizeTerminalAttach(
  db: Database,
  request: { actorUserId: string; terminalId: string },
) {
  return authorizeTerminalSessionAccess(db, {
    ...request,
    capability: "terminal.attach",
  });
}

export function authorizeTerminalWrite(
  db: Database,
  request: { actorUserId: string; terminalId: string },
) {
  return authorizeTerminalSessionAccess(db, {
    ...request,
    capability: "terminal.write",
  });
}

// ---------------------------------------------------------------------------
// B2 — OS-isolation execution context (design §4.2). The SINGLE chokepoint
// every execution surface calls to decide legacy vs brokered vs deny. There is
// no third state and no fallback to the service account (invariant §7.4).
// ---------------------------------------------------------------------------

export type ExecutionContext =
  | { kind: "legacy" }
  | { kind: "brokered"; uid: number; gid: number; osUsername: string }
  | {
      kind: "deny";
      reason:
        | "actor_source_untrusted"
        | "user_disabled"
        | "os_mapping_required"
        | "os_mapping_suspended"
        | "os_mapping_drift"
        | "os_mapping_ineligible";
      /** When set, the caller must run the revocation kill path for this user
       *  (drift/ineligibility just suspended the mapping — Codex #6). */
      suspendedUserId?: string;
    };

export function isOsIsolationEnabled(env: FoundationEnv): boolean {
  return env.DECKTERM_OS_ISOLATION === "1";
}

/** Actor sources whose identity is NOT server-verified must never select a
 *  unix account in isolation mode (B1 §1.2, invariant §7.3). Exported so
 *  execution surfaces can deny untrusted sources BEFORE resolving a cwd/root
 *  (so the deny is attributed to the trust boundary, not a path check). */
export function isTrustedActorSourceForIsolation(
  source: DeckTermActor["source"],
): boolean {
  return source === "cloudflare_access";
}

/** DeckTerm-protected paths a mapped account must not be able to write. */
function protectedPaths(env: FoundationEnv): string[] {
  const stateDir =
    env.DECKTERM_STATE_DIR || `${env.HOME || "/home/deploy"}/.deckterm`;
  return [
    stateDir,
    "/usr/local/lib/deckterm/deckterm-broker",
    "/etc/deckterm",
    "/etc/deckterm/broker.json",
    "/etc/sudoers.d/deckterm-broker",
  ];
}

/**
 * Resolve the execution context for an actor on a PTY/exec surface. In legacy
 * mode always `legacy`. In isolation mode: untrusted source ⇒ deny; unknown/
 * disabled user ⇒ deny; no/suspended mapping ⇒ deny; a use-time eligibility
 * re-probe that fails or shows uid/gid drift ⇒ SUSPEND the mapping (the caller
 * then runs the kill path via `suspendedUserId`) + deny; otherwise `brokered`.
 */
export function resolveExecutionContext(
  db: Database,
  request: { actor: DeckTermActor; env?: FoundationEnv },
  deps: {
    gatherFacts?: typeof gatherOsAccountFacts;
    resolvePolicy?: typeof resolveEligibilityPolicy;
  } = {},
): ExecutionContext {
  const env = request.env ?? process.env;
  if (!isOsIsolationEnabled(env)) return { kind: "legacy" };

  if (!isTrustedActorSourceForIsolation(request.actor.source)) {
    return { kind: "deny", reason: "actor_source_untrusted" };
  }

  const resolved = resolveUserForActor(db, request.actor, env);
  if (!resolved) return { kind: "deny", reason: "os_mapping_required" };
  if (resolved.user.disabled) return { kind: "deny", reason: "user_disabled" };

  const mapping = getOsMapping(db, resolved.user.id);
  if (!mapping) return { kind: "deny", reason: "os_mapping_required" };
  if (mapping.status !== "active") {
    return { kind: "deny", reason: "os_mapping_suspended" };
  }

  // Use-time re-validation (Codex #2/#4): the stored triple must still match a
  // fresh probe (catches UID reuse / rename), and the account must still pass
  // the full eligibility policy. Any failure suspends the mapping + denies.
  const gatherFacts = deps.gatherFacts ?? gatherOsAccountFacts;
  const resolvePolicy = deps.resolvePolicy ?? resolveEligibilityPolicy;
  const facts = gatherFacts(mapping.osUsername, protectedPaths(env));
  const policy = resolvePolicy(env);

  if (
    !facts.exists ||
    facts.uid !== mapping.osUid ||
    facts.gid !== mapping.osGid
  ) {
    suspendOsMapping(db, {
      userId: resolved.user.id,
      reason: "os_mapping_drift",
    });
    return {
      kind: "deny",
      reason: "os_mapping_drift",
      suspendedUserId: resolved.user.id,
    };
  }

  const eligibility = evaluateOsAccountEligibility(facts, policy);
  if (!eligibility.ok) {
    suspendOsMapping(db, {
      userId: resolved.user.id,
      reason: `ineligible:${eligibility.reason}`,
    });
    return {
      kind: "deny",
      reason: "os_mapping_ineligible",
      suspendedUserId: resolved.user.id,
    };
  }

  return {
    kind: "brokered",
    uid: mapping.osUid,
    gid: mapping.osGid,
    osUsername: mapping.osUsername,
  };
}

export function getRouteCapability(
  method: string,
  pathname: string,
): RouteCapability | null {
  const normalizedMethod = method.toUpperCase();
  let normalizedPath = pathname;
  try {
    normalizedPath = new URL(pathname).pathname;
  } catch {
    // `pathname` is already a path, not a full URL.
  }

  if (normalizedMethod === "POST" && normalizedPath === "/api/terminals") {
    return { capability: "terminal.create", resourceType: "terminal" };
  }

  const terminalApiMatch = normalizedPath.match(
    /^\/api\/terminals\/([^/]+)(?:\/([^/]+))?$/,
  );
  if (terminalApiMatch) {
    const resourceId = terminalApiMatch[1]?.trim();
    const action = terminalApiMatch[2]?.trim();
    if (!resourceId) return null;
    if (normalizedMethod === "DELETE" && !action) {
      return {
        capability: "terminal.manage",
        resourceType: "terminal",
        resourceId,
      };
    }
    if (normalizedMethod === "POST" && action === "resize") {
      return {
        capability: "terminal.manage",
        resourceType: "terminal",
        resourceId,
      };
    }
  }

  if (
    normalizedMethod === "GET" &&
    normalizedPath.startsWith("/ws/terminals/")
  ) {
    const resourceId = normalizedPath.split("/").pop()?.trim();
    if (!resourceId) return null;
    return {
      capability: "terminal.attach",
      resourceType: "terminal",
      resourceId,
    };
  }

  return null;
}
