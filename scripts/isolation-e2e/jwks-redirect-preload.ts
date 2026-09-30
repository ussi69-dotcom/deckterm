/**
 * Test-only Bun preload for the isolation e2e SUT (never loaded by the product).
 *
 * `@hono/cloudflare-access` >= 0.4.0 accepts only [A-Za-z0-9-] in the team
 * name and always fetches keys from
 *   https://<team>.cloudflareaccess.com/cdn-cgi/access/certs
 * so the old trick of putting "127.0.0.1:<port>/e2e" into the team name no
 * longer works. This preload sends exactly that one URL to the local mock edge
 * instead. Signature, iss, exp and aud are still verified by the real library;
 * TLS to the mock still uses NODE_EXTRA_CA_CERTS.
 */
const from = process.env.DECKTERM_E2E_JWKS_FROM;
const to = process.env.DECKTERM_E2E_JWKS_TO;

if (from && to) {
  const realFetch = globalThis.fetch;
  const redirected = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return realFetch(url === from ? to : input, init);
  }) as typeof fetch;
  globalThis.fetch = Object.assign(redirected, realFetch);
}
