export type BrowserBoundary = {
  trustedOrigins: readonly string[];
  allowLocalClients: boolean;
};

/** Origins come from operator configuration, never Host or forwarded headers. */
export function browserRequestAllowed(
  request: Request,
  policy: BrowserBoundary,
  websocket = false,
): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null && !policy.trustedOrigins.includes(origin)) return false;
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site" && origin === null) return false;
  if (websocket) {
    // Cookie-only, originless upgrades have no browser provenance. Token clients
    // must supply an explicit Authorization credential, subsequently verified.
    return (
      origin !== null ||
      policy.allowLocalClients ||
      /^Bearer\s+\S+$/i.test(request.headers.get("authorization") || "")
    );
  }
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
  return (
    request.headers.get("x-deckterm-request") === "1" ||
    (policy.allowLocalClients && origin === null && site === null)
  );
}

export function configuredBrowserBoundary(
  env: Record<string, string | undefined>,
): BrowserBoundary {
  const trustedOrigins = (env.TRUSTED_ORIGINS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  for (const value of trustedOrigins) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error("TRUSTED_ORIGINS contains an invalid origin");
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.origin !== value
    ) {
      throw new Error(
        "TRUSTED_ORIGINS must contain exact HTTP(S) origins without paths",
      );
    }
  }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(
    env.HOST || "127.0.0.1",
  );
  const allowLocalClients =
    loopback &&
    env.CF_ACCESS_REQUIRED !== "1" &&
    env.DECKTERM_LEGACY_NO_BOOTSTRAP === "1" &&
    env.DECKTERM_PUBLISH_MODE !== "cloudflare-access" &&
    env.DECKTERM_PUBLISH_MODE !== "cloudflare-tunnel";
  const localBrowser =
    loopback &&
    env.CF_ACCESS_REQUIRED !== "1" &&
    ["local", ""].includes(env.DECKTERM_PUBLISH_MODE || "");
  if (localBrowser) {
    const port = env.PORT || "4174";
    trustedOrigins.push(
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
      `http://[::1]:${port}`,
    );
  }
  return { trustedOrigins: [...new Set(trustedOrigins)], allowLocalClients };
}

export const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
} as const;
