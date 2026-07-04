/**
 * Mock Cloudflare Access edge for the Alice/Bob isolation e2e (plan
 * 2026-07-03-alice-bob-isolation-e2e.md §1.1). Serves a JWKS endpoint over
 * HTTPS and mints RS256 JWTs the product's REAL verification path
 * (`@hono/cloudflare-access`, used for both HTTP middleware and WS upgrades)
 * accepts.
 *
 * The trick: `@hono/cloudflare-access` builds the JWKS URL as
 *   https://${CF_ACCESS_TEAM_NAME}.cloudflareaccess.com/cdn-cgi/access/certs
 * and requires `iss === https://${CF_ACCESS_TEAM_NAME}.cloudflareaccess.com`.
 * Setting CF_ACCESS_TEAM_NAME = "127.0.0.1:<port>/e2e" points that fetch at
 *   https://127.0.0.1:<port>/e2e.cloudflareaccess.com/cdn-cgi/access/certs
 * — this mock — with a matching `iss`. No product change, no header-auth
 * bypass: signature/iss/exp are all still verified against our real keypair,
 * and aud is checked server-side against CF_ACCESS_AUD.
 *
 * TLS verification stays ON: the SUT trusts our one-run self-signed CA via
 * NODE_EXTRA_CA_CERTS (never NODE_TLS_REJECT_UNAUTHORIZED). The cert MUST carry
 * subjectAltName=IP:127.0.0.1 or Bun's SAN check rejects it even with the CA
 * trusted.
 */

import { readFileSync } from "node:fs";

const KID = "e2e-mock-kid-1";

function b64url(input: ArrayBuffer | Uint8Array | string): string {
  let bytes: Uint8Array;
  if (typeof input === "string") bytes = new TextEncoder().encode(input);
  else if (input instanceof Uint8Array) bytes = input;
  else bytes = new Uint8Array(input);
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export type Persona = {
  /** Stable JWT `sub` (canonical identity subject). */
  sub: string;
  email: string;
};

export type MintOptions = {
  /** Override the audience (defaults to the edge's configured aud). */
  aud?: string | string[];
  /** Override the issuer (for negative iss tests). */
  iss?: string;
  /** Seconds from now until expiry (negative → already expired). */
  ttlSec?: number;
  /** Sign with the wrong key (for negative signature tests). */
  wrongKey?: boolean;
};

export class MockEdge {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private privateKey!: CryptoKey;
  private publicJwk!: JsonWebKey;
  /** A second, unrelated key used to forge bad-signature tokens. */
  private wrongPrivateKey!: CryptoKey;
  readonly port: number;
  readonly aud: string;
  private certPem: string;
  private keyPem: string;

  constructor(opts: {
    port: number;
    aud: string;
    certPath: string;
    keyPath: string;
  }) {
    this.port = opts.port;
    this.aud = opts.aud;
    this.certPem = readFileSync(opts.certPath, "utf8");
    this.keyPem = readFileSync(opts.keyPath, "utf8");
  }

  /** `CF_ACCESS_TEAM_NAME` value the SUT must run with. */
  get teamName(): string {
    return `127.0.0.1:${this.port}/e2e`;
  }

  /** The exact `iss` string the product will require. */
  get issuer(): string {
    return `https://${this.teamName}.cloudflareaccess.com`;
  }

  async start(): Promise<void> {
    const genKey = () =>
      crypto.subtle.generateKey(
        {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["sign", "verify"],
      ) as Promise<CryptoKeyPair>;

    const pair = await genKey();
    const wrongPair = await genKey();
    this.privateKey = pair.privateKey;
    this.wrongPrivateKey = wrongPair.privateKey;
    this.publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    this.publicJwk.kid = KID;
    this.publicJwk.alg = "RS256";
    this.publicJwk.use = "sig";

    const jwks = JSON.stringify({ keys: [this.publicJwk] });
    this.server = Bun.serve({
      port: this.port,
      hostname: "127.0.0.1",
      tls: { cert: this.certPem, key: this.keyPem },
      fetch: (req) => {
        const url = new URL(req.url);
        // Any path ending in the CF certs suffix returns our JWKS.
        if (url.pathname.endsWith("/cdn-cgi/access/certs")) {
          return new Response(jwks, {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
  }

  async stop(): Promise<void> {
    this.server?.stop(true);
    this.server = null;
  }

  /** Mint a signed JWT for a persona. */
  async mint(persona: Persona, opts: MintOptions = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const ttl = opts.ttlSec ?? 300;
    const header = { alg: "RS256", typ: "JWT", kid: KID };
    const payload = {
      sub: persona.sub,
      email: persona.email,
      aud: opts.aud ?? this.aud,
      iss: opts.iss ?? this.issuer,
      iat: now,
      exp: now + ttl,
    };
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(
      JSON.stringify(payload),
    )}`;
    const key = opts.wrongKey ? this.wrongPrivateKey : this.privateKey;
    const sig = await crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      new TextEncoder().encode(signingInput),
    );
    return `${signingInput}.${b64url(sig)}`;
  }
}
