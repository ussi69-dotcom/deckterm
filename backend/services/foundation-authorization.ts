import type { Database } from "bun:sqlite";
import {
  getFoundationUserById,
  getTerminalSession,
  hasScopedGrant,
  type FoundationUserRole,
} from "./foundation-state";

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
