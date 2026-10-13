import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

// End-to-end cache policy through createWebApp(): API and HTML stay
// no-store, static web files revalidate with an ETag (304), versioned
// /assets/ files are immutable, compressible files are gzipped, and the
// security headers (CSP etc.) survive on every one of them.
//
// server.ts freezes env at import, so pin it first. The state dir is a
// private temp dir (never the developer's real ~/.deckterm*). No route here
// touches the foundation-state singleton.
const stateDir = mkdtempSync(join(tmpdir(), "deckterm-static-cache-"));
process.env.DECKTERM_STATE_DIR = stateDir;
process.env.CF_ACCESS_REQUIRED = "0";
delete process.env.DECKTERM_PUBLISH_MODE;
delete process.env.DECKTERM_LEGACY_NO_BOOTSTRAP;

const { createWebApp } = await import("./server");
const { SECURITY_HEADERS } = await import("./services/browser-boundary");

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

const app = createWebApp();
const fetchPath = (path: string, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`http://localhost:4174${path}`, { headers }));

function expectSecurityHeaders(res: Response) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    expect(res.headers.get(name)).toBe(value);
  }
  expect(res.headers.get("CDN-Cache-Control")).toBe("no-store");
  expect(res.headers.get("Cloudflare-CDN-Cache-Control")).toBe("no-store");
}

test("API responses stay no-store and /api/health reports a build fingerprint", async () => {
  const res = await fetchPath("/api/health");
  expect(res.status).toBe(200);
  expect(res.headers.get("Cache-Control")).toContain("no-store");
  expect(res.headers.get("Pragma")).toBe("no-cache");
  expect(res.headers.get("ETag")).toBeNull();
  expectSecurityHeaders(res);
  const body = await res.json();
  expect(body.build).toMatch(/^[0-9a-f]{12}$/);
});

test("HTML documents stay no-store", async () => {
  for (const path of ["/", "/index.html"]) {
    const res = await fetchPath(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(res.headers.get("ETag")).toBeNull();
    expectSecurityHeaders(res);
  }
});

test("static files revalidate with a strong ETag and answer 304", async () => {
  const res = await fetchPath("/app.js");
  expect(res.status).toBe(200);
  expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
  expect(res.headers.get("Pragma")).toBeNull();
  const etag = res.headers.get("ETag");
  expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
  expectSecurityHeaders(res);

  const revalidated = await fetchPath("/app.js", { "If-None-Match": etag! });
  expect(revalidated.status).toBe(304);
  expect(revalidated.headers.get("Cache-Control")).toBe("private, no-cache");
  expectSecurityHeaders(revalidated);
});

test("versioned /assets/ files are immutable", async () => {
  const res = await fetchPath("/assets/lucide-1.41.0.min.js");
  expect(res.status).toBe(200);
  expect(res.headers.get("Cache-Control")).toBe(
    "private, max-age=31536000, immutable",
  );
  expectSecurityHeaders(res);
});

test("compressible static files are gzipped when accepted", async () => {
  const plain = await fetchPath("/styles.css");
  const plainBody = await plain.text();
  const res = await fetchPath("/styles.css", { "Accept-Encoding": "gzip" });
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Encoding")).toBe("gzip");
  expect(res.headers.get("Vary")).toContain("Accept-Encoding");
  expectSecurityHeaders(res);
  const bytes = new Uint8Array(await res.arrayBuffer());
  expect(bytes.byteLength).toBeLessThan(plainBody.length);
  expect(gunzipSync(bytes).toString("utf8")).toBe(plainBody);
});

test("unknown paths still 404 with no-store", async () => {
  const res = await fetchPath("/definitely-missing.js");
  expect(res.status).toBe(404);
  expect(res.headers.get("Cache-Control")).toContain("no-store");
});
