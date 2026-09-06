import { expect, test } from "bun:test";
import {
  browserRequestAllowed,
  configuredBrowserBoundary,
} from "./services/browser-boundary";
const policy = {
  trustedOrigins: ["https://terminal.example"],
  allowLocalClients: false,
};
function request(headers: HeadersInit = {}, method = "POST") {
  return new Request("http://127.0.0.1:4174/api/files", { method, headers });
}

test("unsafe API requests require a marker; foreign and opaque Origins always fail", () => {
  expect(
    browserRequestAllowed(
      request({ Origin: policy.trustedOrigins[0] }),
      policy,
    ),
  ).toBe(false);
  expect(
    browserRequestAllowed(
      request({ Origin: policy.trustedOrigins[0], "X-DeckTerm-Request": "1" }),
      policy,
    ),
  ).toBe(true);
  for (const Origin of [
    "https://evil.example",
    "null",
    "https://terminal.example.evil",
    "https://terminal.example/",
  ]) {
    expect(
      browserRequestAllowed(
        request({
          Origin,
          "X-DeckTerm-Request": "1",
          "cf-access-jwt-assertion": "edge-injected",
        }),
        policy,
      ),
    ).toBe(false);
  }
  expect(
    browserRequestAllowed(
      request({ "cf-access-jwt-assertion": "edge-injected" }),
      policy,
    ),
  ).toBe(false);
  expect(
    browserRequestAllowed(request({ "X-DeckTerm-Request": "1" }), policy),
  ).toBe(true);
  expect(
    browserRequestAllowed(
      request({ "X-DeckTerm-Request": "1", "Sec-Fetch-Site": "cross-site" }),
      policy,
    ),
  ).toBe(false);
});

test("WebSocket Origin cannot be bypassed by cookies, edge assertions or another Host", () => {
  expect(
    browserRequestAllowed(
      request(
        { Cookie: "CF_Authorization=token", Host: "terminal.example" },
        "GET",
      ),
      policy,
      true,
    ),
  ).toBe(false);
  expect(
    browserRequestAllowed(
      request(
        { Origin: "https://evil.example", Authorization: "Bearer token" },
        "GET",
      ),
      policy,
      true,
    ),
  ).toBe(false);
  expect(
    browserRequestAllowed(
      request({ Origin: policy.trustedOrigins[0] }, "GET"),
      policy,
      true,
    ),
  ).toBe(true);
  expect(
    browserRequestAllowed(
      request({ Authorization: "Bearer token" }, "GET"),
      policy,
      true,
    ),
  ).toBe(true); // separate JWT verification is still mandatory
});

test("only explicit loopback legacy development has originless compatibility", () => {
  const env = {
    HOST: "127.0.0.1",
    PORT: "4174",
    DECKTERM_LEGACY_NO_BOOTSTRAP: "1",
  };
  expect(configuredBrowserBoundary(env).allowLocalClients).toBe(true);
  for (const override of [
    { HOST: "0.0.0.0" },
    { CF_ACCESS_REQUIRED: "1" },
    { DECKTERM_PUBLISH_MODE: "cloudflare-tunnel" },
    { DECKTERM_LEGACY_NO_BOOTSTRAP: "0" },
  ]) {
    expect(
      configuredBrowserBoundary({ ...env, ...override }).allowLocalClients,
    ).toBe(false);
  }
  expect(() =>
    configuredBrowserBoundary({
      TRUSTED_ORIGINS: "https://terminal.example/path",
    }),
  ).toThrow("exact");
});
