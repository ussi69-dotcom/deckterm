import { expect, test } from "bun:test";

// /api/health must stay reachable without a Cloudflare Access JWT: the deploy
// pipeline health-gates the candidate (scripts/deploy_release.sh) and verifies
// the promoted release over 127.0.0.1, where no JWT exists. The origin binds
// loopback, so exempting health server-side does not expose it publicly —
// edge requests still pass through the CF Access policy.
//
// CF_ACCESS_* are module-level consts frozen at server.ts import, so this file
// pins the env before its one import and runs as a separate chained bun test
// invocation in package.json (foundation-state singleton constraint).

process.env.CF_ACCESS_REQUIRED = "1";
process.env.CF_ACCESS_TEAM_NAME = "test-team";
process.env.CF_ACCESS_AUD = "test-aud";
delete process.env.DECKTERM_PUBLISH_MODE;
delete process.env.DECKTERM_LEGACY_NO_BOOTSTRAP;

const { createWebApp } = await import("./server");

test("GET /api/health responds 200 without a Cloudflare Access JWT", async () => {
  const app = createWebApp();
  const res = await app.fetch(new Request("http://deckterm.test/api/health"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.status).toBe("ok");
});

test("guarded API routes still demand the JWT", async () => {
  const app = createWebApp();
  const res = await app.fetch(
    new Request("http://deckterm.test/api/terminals"),
  );
  expect(res.status).toBe(401);
});
