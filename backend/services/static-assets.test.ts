import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  acceptsGzip,
  cacheControlForPolicy,
  createBuildFingerprint,
  createStaticAssetServer,
  staticCachePolicyForPath,
} from "./static-assets";

let root: string;
const bigScript = "console.log('deckterm');\n".repeat(200); // > 1 KB

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "deckterm-static-"));
  mkdirSync(join(root, "assets", "font-1.2.3-files"), { recursive: true });
  mkdirSync(join(root, "vendor"));
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>x</title>");
  writeFileSync(join(root, "sub", "index.html"), "<p>sub</p>");
  writeFileSync(join(root, "app.js"), bigScript);
  writeFileSync(join(root, "tiny.css"), "body{}");
  writeFileSync(join(root, "assets", "lib-1.41.0.min.js"), bigScript);
  writeFileSync(join(root, "assets", "font-1.2.3-files", "a.woff2"), "woff2");
  writeFileSync(join(root, "assets", "manifest.json"), "{}");
  writeFileSync(join(root, "vendor", "x.png"), Buffer.alloc(4096, 1));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// Test gzip stand-in: a real gzip stream, so responses stay decodable.
function realGzip(bytes: Uint8Array): Uint8Array {
  return gzipSync(bytes);
}

function get(path: string, headers: Record<string, string> = {}) {
  return new Request(`http://deckterm.test${path}`, { headers });
}

describe("staticCachePolicyForPath", () => {
  test("HTML documents are never stored", () => {
    expect(staticCachePolicyForPath("/")).toBe("no-store");
    expect(staticCachePolicyForPath("/index.html")).toBe("no-store");
    expect(staticCachePolicyForPath("/sub/page.html")).toBe("no-store");
    expect(staticCachePolicyForPath("/sub/")).toBe("no-store");
  });

  test("versioned files under /assets/ are immutable", () => {
    expect(staticCachePolicyForPath("/assets/lucide-1.41.0.min.js")).toBe(
      "immutable",
    );
    expect(staticCachePolicyForPath("/assets/diff2html-3.4.56.min.css")).toBe(
      "immutable",
    );
    expect(staticCachePolicyForPath("/assets/nerd-fonts-v3.4.0.css")).toBe(
      "immutable",
    );
    expect(
      staticCachePolicyForPath(
        "/assets/jetbrains-mono-5.0.0-files/jetbrains-mono-latin-400-normal.woff2",
      ),
    ).toBe("immutable");
  });

  test("everything else revalidates", () => {
    expect(staticCachePolicyForPath("/app.js")).toBe("revalidate");
    expect(staticCachePolicyForPath("/assets/manifest.json")).toBe(
      "revalidate",
    );
    expect(staticCachePolicyForPath("/vendor/xterm.min.js")).toBe("revalidate");
    // A version-looking name outside /assets/ is not trusted as immutable.
    expect(staticCachePolicyForPath("/lib-1.2.3.js")).toBe("revalidate");
  });

  test("cache-control values keep Cloudflare out (private / no-store)", () => {
    expect(cacheControlForPolicy("revalidate")).toBe("private, no-cache");
    expect(cacheControlForPolicy("immutable")).toBe(
      "private, max-age=31536000, immutable",
    );
    expect(cacheControlForPolicy("no-store")).toContain("no-store");
  });
});

describe("acceptsGzip", () => {
  test("parses Accept-Encoding including q-values", () => {
    expect(acceptsGzip("gzip, deflate, br")).toBe(true);
    expect(acceptsGzip("br;q=1.0, gzip;q=0.8")).toBe(true);
    expect(acceptsGzip("GZIP")).toBe(true);
    expect(acceptsGzip("*")).toBe(true);
    expect(acceptsGzip("gzip;q=0")).toBe(false);
    expect(acceptsGzip("identity")).toBe(false);
    expect(acceptsGzip("")).toBe(false);
    expect(acceptsGzip(null)).toBe(false);
  });
});

describe("createStaticAssetServer", () => {
  test("serves a revalidating file with a strong ETag and answers 304", async () => {
    const server = createStaticAssetServer({ root });
    const first = await server.handle(get("/app.js"));
    expect(first?.status).toBe(200);
    expect(first?.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(first?.headers.get("Content-Type")).toContain("javascript");
    const etag = first?.headers.get("ETag") || "";
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(await first?.text()).toBe(bigScript);

    const second = await server.handle(
      get("/app.js", { "If-None-Match": etag }),
    );
    expect(second?.status).toBe(304);
    expect(second?.headers.get("ETag")).toBe(etag);
    expect(second?.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(await second?.text()).toBe("");

    const listed = await server.handle(
      get("/app.js", { "If-None-Match": `"nope", W/${etag}` }),
    );
    expect(listed?.status).toBe(304);

    const stale = await server.handle(
      get("/app.js", { "If-None-Match": '"something-else"' }),
    );
    expect(stale?.status).toBe(200);
  });

  test("the ETag follows content changes (keyed by mtime + size)", async () => {
    const server = createStaticAssetServer({ root });
    const path = join(root, "changing.js");
    writeFileSync(path, "a");
    utimesSync(path, new Date(1_000_000), new Date(1_000_000));
    const before = (await server.handle(get("/changing.js")))?.headers.get(
      "ETag",
    );
    writeFileSync(path, "bb");
    utimesSync(path, new Date(2_000_000), new Date(2_000_000));
    const after = (await server.handle(get("/changing.js")))?.headers.get(
      "ETag",
    );
    expect(before).toBeTruthy();
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
  });

  test("versioned assets are immutable", async () => {
    const server = createStaticAssetServer({ root });
    const res = await server.handle(get("/assets/lib-1.41.0.min.js"));
    expect(res?.status).toBe(200);
    expect(res?.headers.get("Cache-Control")).toBe(
      "private, max-age=31536000, immutable",
    );
    expect(res?.headers.get("ETag")).toBeTruthy();
  });

  test("gzips compressible bodies when the client accepts it", async () => {
    const server = createStaticAssetServer({ root });
    const res = await server.handle(
      get("/app.js", { "Accept-Encoding": "gzip, br" }),
    );
    expect(res?.status).toBe(200);
    expect(res?.headers.get("Content-Encoding")).toBe("gzip");
    expect(res?.headers.get("Vary")).toContain("Accept-Encoding");
    const gzEtag = res?.headers.get("ETag") || "";
    const body = new Uint8Array(await res!.arrayBuffer());
    expect(Number(res?.headers.get("Content-Length"))).toBe(body.byteLength);
    expect(body.byteLength).toBeLessThan(bigScript.length);
    expect(gunzipSync(body).toString("utf8")).toBe(bigScript);

    // The identity and gzip representations carry distinct strong tags…
    const plain = await server.handle(get("/app.js"));
    const plainEtag = plain?.headers.get("ETag") || "";
    expect(plain?.headers.get("Content-Encoding")).toBeNull();
    expect(plain?.headers.get("Vary")).toContain("Accept-Encoding");
    expect(gzEtag).not.toBe(plainEtag);

    // …and either one revalidates.
    const revalidated = await server.handle(
      get("/app.js", { "Accept-Encoding": "gzip", "If-None-Match": gzEtag }),
    );
    expect(revalidated?.status).toBe(304);
    expect(revalidated?.headers.get("ETag")).toBe(gzEtag);
  });

  test("gzip runs off the event loop (no Bun.gzipSync)", async () => {
    // A synchronous gzip of the 2.5 MB font or the 1 MB CodeMirror bundle
    // stalls every terminal WebSocket frame for tens of milliseconds.
    const original = Bun.gzipSync;
    let syncCalls = 0;
    (Bun as { gzipSync: unknown }).gzipSync = (...args: unknown[]) => {
      syncCalls++;
      return (original as (...a: unknown[]) => unknown)(...args);
    };
    try {
      const server = createStaticAssetServer({ root });
      const res = await server.handle(
        get("/app.js", { "Accept-Encoding": "gzip" }),
      );
      expect(res?.headers.get("Content-Encoding")).toBe("gzip");
      const body = new Uint8Array(await res!.arrayBuffer());
      expect(gunzipSync(body).toString("utf8")).toBe(bigScript);
      expect(syncCalls).toBe(0);
    } finally {
      (Bun as { gzipSync: unknown }).gzipSync = original;
    }
  });

  test("concurrent cold requests read, hash and gzip a file once", async () => {
    let reads = 0;
    let gzips = 0;
    const server = createStaticAssetServer({
      root,
      readFile: async (abs) => {
        reads++;
        await Bun.sleep(20);
        return new Uint8Array(await Bun.file(abs).arrayBuffer());
      },
      gzip: async (bytes) => {
        gzips++;
        await Bun.sleep(20);
        return new Uint8Array(realGzip(bytes));
      },
    });
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        server.handle(get("/app.js", { "Accept-Encoding": "gzip" })),
      ),
    );
    expect(reads).toBe(1);
    expect(gzips).toBe(1);
    const etags = new Set(responses.map((r) => r?.headers.get("ETag")));
    expect(etags.size).toBe(1);
    for (const res of responses) {
      const body = new Uint8Array(await res!.arrayBuffer());
      expect(gunzipSync(body).toString("utf8")).toBe(bigScript);
    }

    // Warm: neither runs again.
    await server.handle(get("/app.js", { "Accept-Encoding": "gzip" }));
    expect(reads).toBe(1);
    expect(gzips).toBe(1);
  });

  test("a failed gzip is not cached; the next request retries", async () => {
    let gzips = 0;
    const server = createStaticAssetServer({
      root,
      gzip: async (bytes) => {
        gzips++;
        if (gzips === 1) throw new Error("boom");
        return new Uint8Array(realGzip(bytes));
      },
    });
    const failed = await server.handle(
      get("/app.js", { "Accept-Encoding": "gzip" }),
    );
    // Falls back to the identity body instead of failing the request.
    expect(failed?.status).toBe(200);
    expect(failed?.headers.get("Content-Encoding")).toBeNull();
    expect(await failed?.text()).toBe(bigScript);
    const retried = await server.handle(
      get("/app.js", { "Accept-Encoding": "gzip" }),
    );
    expect(retried?.headers.get("Content-Encoding")).toBe("gzip");
    expect(gzips).toBe(2);
  });

  test("small bodies and non-compressible types are not gzipped", async () => {
    const server = createStaticAssetServer({ root });
    const tiny = await server.handle(
      get("/tiny.css", { "Accept-Encoding": "gzip" }),
    );
    expect(tiny?.headers.get("Content-Encoding")).toBeNull();
    expect(await tiny?.text()).toBe("body{}");

    const png = await server.handle(
      get("/vendor/x.png", { "Accept-Encoding": "gzip" }),
    );
    expect(png?.status).toBe(200);
    expect(png?.headers.get("Content-Encoding")).toBeNull();
    expect(png?.headers.get("Content-Type")).toBe("image/png");
  });

  test("HTML is no-store, without an ETag, and / maps to index.html", async () => {
    const server = createStaticAssetServer({ root });
    for (const path of ["/", "/index.html"]) {
      const res = await server.handle(get(path));
      expect(res?.status).toBe(200);
      expect(res?.headers.get("Cache-Control")).toContain("no-store");
      expect(res?.headers.get("ETag")).toBeNull();
      expect(res?.headers.get("Content-Type")).toContain("text/html");
      expect(await res?.text()).toContain("<title>x</title>");
    }
    const dir = await server.handle(get("/sub"));
    expect(await dir?.text()).toBe("<p>sub</p>");
    expect(dir?.headers.get("Cache-Control")).toContain("no-store");
  });

  test("missing files, traversal and non-GET methods fall through", async () => {
    const server = createStaticAssetServer({ root });
    expect(await server.handle(get("/missing.js"))).toBeNull();
    expect(await server.handle(get("/../etc/passwd"))).toBeNull();
    expect(await server.handle(get("/%2e%2e/etc/passwd"))).toBeNull();
    expect(await server.handle(get("/sub/..%2F..%2Fetc%2Fpasswd"))).toBeNull();
    expect(await server.handle(get("//etc/passwd"))).toBeNull();
    expect(
      await server.handle(
        new Request("http://deckterm.test/app.js", { method: "POST" }),
      ),
    ).toBeNull();
  });

  test("HEAD returns headers including Content-Length", async () => {
    const server = createStaticAssetServer({ root });
    const res = await server.handle(
      new Request("http://deckterm.test/app.js", { method: "HEAD" }),
    );
    expect(res?.status).toBe(200);
    expect(res?.headers.get("Content-Length")).toBe(String(bigScript.length));
    expect(res?.headers.get("ETag")).toBeTruthy();
  });
});

describe("createBuildFingerprint", () => {
  test("is stable, short, cached for the TTL, and changes when a file changes", async () => {
    let clock = 0;
    const fingerprint = createBuildFingerprint({
      root,
      ttlMs: 5000,
      now: () => clock,
    });
    const first = await fingerprint.get();
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    expect(await fingerprint.get()).toBe(first);

    const path = join(root, "app.js");
    writeFileSync(path, bigScript + "// edit\n");
    utimesSync(path, new Date(3_000_000), new Date(3_000_000));

    clock = 4999; // still inside the TTL → cached value
    expect(await fingerprint.get()).toBe(first);
    clock = 5001;
    const second = await fingerprint.get();
    expect(second).toMatch(/^[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
  });

  test("ignores co-located unit tests", async () => {
    let clock = 0;
    const fingerprint = createBuildFingerprint({
      root,
      ttlMs: 1,
      now: () => clock,
    });
    const before = await fingerprint.get();
    writeFileSync(join(root, "app.test.js"), "test()");
    clock = 10;
    expect(await fingerprint.get()).toBe(before);
  });

  test("concurrent callers share one scan", async () => {
    const fingerprint = createBuildFingerprint({ root, ttlMs: 5000 });
    const [a, b] = await Promise.all([fingerprint.get(), fingerprint.get()]);
    expect(a).toBe(b);
  });
});
