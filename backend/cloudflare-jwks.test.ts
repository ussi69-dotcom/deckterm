import { expect, test } from "bun:test";
import { Hono } from "hono";
import { cloudflareAccess } from "@hono/cloudflare-access";

test("signed Cloudflare JWT validation caches fresh keys, refreshes expiry/rotation, and pins claims", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 2_000_000_000;
  let fetches = 0;
  const pairs = await Promise.all(
    [1, 2].map(() =>
      crypto.subtle.generateKey(
        {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["sign", "verify"],
      ),
    ),
  );
  const keys = await Promise.all(
    pairs.map(async (pair, i) => ({
      ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
      kid: `key-${i}`,
      use: "sig",
    })),
  );
  let servedKeys = [keys[0]];
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  async function token(
    index = 0,
    claims: Record<string, unknown> = {},
    header: Record<string, unknown> = {},
  ) {
    const content = `${encode({ alg: "RS256", kid: `key-${index}`, ...header })}.${encode({ sub: "alice", email: "alice@example.com", iss: "https://test-team.cloudflareaccess.com", aud: ["our-app"], exp: now + 7200, ...claims })}`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      pairs[index].privateKey,
      Buffer.from(content),
    );
    return `${content}.${Buffer.from(signature).toString("base64url")}`;
  }
  try {
    Date.now = () => now * 1000;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(
        "https://test-team.cloudflareaccess.com/cdn-cgi/access/certs",
      );
      fetches++;
      return Response.json({ keys: servedKeys });
    }) as typeof fetch;
    const app = new Hono()
      .use("/*", cloudflareAccess("test-team", "our-app"))
      .get("/", (c) => c.text("accepted"));
    const check = async (jwt: string) =>
      (await app.request("/", { headers: { "cf-access-jwt-assertion": jwt } }))
        .status;
    expect(await check(await token())).toBe(200);
    expect(fetches).toBe(1);
    expect(await check(await token())).toBe(200);
    expect(fetches).toBe(1);
    now += 3601;
    expect(await check(await token())).toBe(200);
    expect(fetches).toBe(2);
    servedKeys = keys;
    expect(await check(await token(1))).toBe(200);
    expect(fetches).toBe(3);
    for (const claims of [
      { aud: ["other-app"] },
      { iss: "https://evil.example" },
      { exp: now - 31 },
      { nbf: now + 31 },
    ]) {
      expect(await check(await token(0, claims))).toBe(401);
    }
    expect(await check(await token(0, {}, { alg: "HS256" }))).toBe(401);
    expect(await check("malformed")).toBe(401);
    const signed = await token();
    expect(await check(signed.slice(0, -8) + "AAAAAAAA")).toBe(401);
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
  }
});
