// Static web asset serving with browser revalidation and gzip.
//
// DeckTerm used to send `no-store` on every response (commit 42dae5e: keep
// Cloudflare from caching anything behind Access), so each reload refetched
// ~2 MB of scripts, styles and fonts. This module keeps that guarantee —
// every cacheable response is `private`, which shared caches (Cloudflare)
// must not store — while letting the browser keep a copy:
//
// - HTML documents (`/`, `*.html`) stay `no-store` so a deploy is picked up
//   on the next load.
// - Other files get `private, no-cache` plus a strong content-hash ETag, so
//   the browser revalidates every time and gets a cheap 304 when unchanged.
// - Files under /assets/ whose path carries a version (lucide-1.41.0.min.js,
//   jetbrains-mono-5.0.0-files/…) never change in place and are `immutable`.
//
// The ETag is computed from the file bytes and cached per path keyed by
// mtime + size, so live edits on dev show up immediately.
//
// Cold loads are single-flight per path + mtime/size: parallel first requests
// share one read + hash. The gzip copy is built asynchronously (node:zlib on
// the thread pool) and memoised as a promise, so a cold 2.5 MB font or the
// 1 MB CodeMirror bundle never blocks the event loop that carries terminal
// WebSocket traffic.

import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { gzip as zlibGzip } from "node:zlib";
import { COMPRESSIBLE_CONTENT_TYPE_REGEX } from "hono/utils/compress";
import { getMimeType } from "hono/utils/mime";

export type StaticCachePolicy = "no-store" | "revalidate" | "immutable";

export const NO_STORE_CACHE_CONTROL =
  "no-store, no-cache, must-revalidate, max-age=0";

const IMMUTABLE_MAX_AGE_SECONDS = 31_536_000;
const DEFAULT_GZIP_MIN_BYTES = 1024;
// A semver-like version in a file or directory name: -1.41.0, -v3.4.0, @5.0.0
const VERSIONED_SEGMENT = /[-_.@]v?\d+\.\d+(?:\.\d+)+(?=[-_.]|$)/;
// Same traversal guard Hono's serveStatic applies to the decoded path.
const UNSAFE_PATH = /(?:^|[\/\\])\.{1,2}(?:$|[\/\\])|[\/\\]{2,}|\\|\0/;

export function staticCachePolicyForPath(pathname: string): StaticCachePolicy {
  if (
    pathname === "/" ||
    pathname.endsWith("/") ||
    pathname.endsWith(".html")
  ) {
    return "no-store";
  }
  if (pathname.startsWith("/assets/")) {
    const segments = pathname.slice("/assets/".length).split("/");
    if (segments.some((segment) => VERSIONED_SEGMENT.test(segment))) {
      return "immutable";
    }
  }
  return "revalidate";
}

export function cacheControlForPolicy(policy: StaticCachePolicy): string {
  switch (policy) {
    case "immutable":
      return `private, max-age=${IMMUTABLE_MAX_AGE_SECONDS}, immutable`;
    case "revalidate":
      return "private, no-cache";
    default:
      return NO_STORE_CACHE_CONTROL;
  }
}

/** True when an Accept-Encoding header allows gzip (q > 0, or `*`). */
export function acceptsGzip(header: string | null | undefined): boolean {
  if (!header) return false;
  let wildcard: boolean | null = null;
  for (const part of header.split(",")) {
    const [rawName, ...params] = part.trim().split(";");
    const name = (rawName || "").trim().toLowerCase();
    if (!name) continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.trim().split("=");
      if (key?.trim().toLowerCase() === "q") {
        const parsed = Number.parseFloat(value || "");
        q = Number.isFinite(parsed) ? parsed : 0;
      }
    }
    if (name === "gzip" || name === "x-gzip") return q > 0;
    if (name === "*") wildcard = q > 0;
  }
  return wildcard === true;
}

function etagMatches(header: string | null, candidates: string[]): boolean {
  if (!header) return false;
  for (const raw of header.split(",")) {
    const tag = raw.trim();
    if (tag === "*") return true;
    const opaque = tag.startsWith("W/") ? tag.slice(2) : tag;
    if (candidates.includes(opaque)) return true;
  }
  return false;
}

type Bytes = Uint8Array<ArrayBuffer>;
type AssetEntry = {
  key: string;
  body: Bytes;
  etag: string;
  // undefined = not started; a rejected build is cleared so the next
  // request retries.
  gzip: Promise<Bytes> | undefined;
};

const gzipAsync = promisify(zlibGzip);

async function defaultGzip(bytes: Uint8Array): Promise<Uint8Array> {
  return gzipAsync(bytes);
}

async function defaultReadFile(abs: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(abs).arrayBuffer());
}

export function createStaticAssetServer({
  root,
  gzipMinBytes = DEFAULT_GZIP_MIN_BYTES,
  gzip = defaultGzip,
  readFile = defaultReadFile,
}: {
  root: string;
  gzipMinBytes?: number;
  /** Async gzip (injectable for tests). Must not block the event loop. */
  gzip?: (bytes: Uint8Array) => Promise<Uint8Array>;
  /** File reader (injectable for tests). */
  readFile?: (abs: string) => Promise<Uint8Array>;
}) {
  const rootAbs = resolve(root);
  const entries = new Map<string, AssetEntry>();
  // Cold loads in progress, keyed by path + mtime/size.
  const loading = new Map<string, Promise<AssetEntry>>();

  async function resolveFile(
    pathname: string,
  ): Promise<{ abs: string; size: number; mtimeMs: number } | null> {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (!decoded.startsWith("/") || UNSAFE_PATH.test(decoded)) return null;
    let abs = resolve(rootAbs, `.${decoded === "/" ? "/index.html" : decoded}`);
    if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return null;
    try {
      let info = await stat(abs);
      if (info.isDirectory()) {
        abs = join(abs, "index.html");
        info = await stat(abs);
      }
      if (!info.isFile()) return null;
      return { abs, size: info.size, mtimeMs: info.mtimeMs };
    } catch {
      return null;
    }
  }

  async function loadEntry(file: {
    abs: string;
    size: number;
    mtimeMs: number;
  }): Promise<AssetEntry> {
    const key = `${file.mtimeMs}:${file.size}`;
    const cached = entries.get(file.abs);
    if (cached && cached.key === key) return cached;
    const flightKey = `${file.abs}\0${key}`;
    const inFlight = loading.get(flightKey);
    if (inFlight) return inFlight;
    const flight = (async () => {
      const body = (await readFile(file.abs)) as Bytes;
      const hash = createHash("sha256")
        .update(body)
        .digest("base64url")
        .slice(0, 27);
      const entry: AssetEntry = {
        key,
        body,
        etag: `"${hash}"`,
        gzip: undefined,
      };
      // Only remember the entry when the bytes match the stat we keyed it by;
      // a file rewritten mid-read is re-hashed on the next request.
      if (body.byteLength === file.size) entries.set(file.abs, entry);
      return entry;
    })().finally(() => {
      loading.delete(flightKey);
    });
    loading.set(flightKey, flight);
    return flight;
  }

  /** The gzip copy of `entry`, built once; null when compression failed. */
  async function gzipFor(entry: AssetEntry): Promise<Bytes | null> {
    if (!entry.gzip) {
      const build = gzip(entry.body).then((out) => out as Bytes);
      entry.gzip = build;
      build.catch(() => {
        if (entry.gzip === build) entry.gzip = undefined;
      });
    }
    try {
      return await entry.gzip;
    } catch {
      return null;
    }
  }

  async function handle(request: Request): Promise<Response | null> {
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") return null;
    const file = await resolveFile(new URL(request.url).pathname);
    if (!file) return null;

    const relPath = `/${relative(rootAbs, file.abs).split(sep).join("/")}`;
    const policy = staticCachePolicyForPath(relPath);
    const mimeType = getMimeType(file.abs);
    const entry = await loadEntry(file);

    const compressible =
      !!mimeType &&
      COMPRESSIBLE_CONTENT_TYPE_REGEX.test(mimeType) &&
      entry.body.byteLength >= gzipMinBytes;
    const wantsGzip =
      compressible && acceptsGzip(request.headers.get("Accept-Encoding"));
    const gzipEtag = `${entry.etag.slice(0, -1)}-gz"`;
    const conditional =
      policy !== "no-store" &&
      etagMatches(request.headers.get("If-None-Match"), [entry.etag, gzipEtag]);
    // A 304 needs no body, so it never waits for (or starts) compression.
    const gzipped =
      wantsGzip && !conditional ? await gzipFor(entry) : null;
    const useGzip = wantsGzip && (conditional || gzipped !== null);
    const etag = useGzip ? gzipEtag : entry.etag;

    const headers = new Headers({
      "Content-Type": mimeType || "application/octet-stream",
      "Cache-Control": cacheControlForPolicy(policy),
    });
    if (policy === "no-store") {
      headers.set("Pragma", "no-cache");
      headers.set("Expires", "0");
    } else {
      headers.set("ETag", etag);
    }
    if (compressible) headers.set("Vary", "Accept-Encoding");

    if (conditional) {
      headers.delete("Content-Type");
      return new Response(null, { status: 304, headers });
    }

    let body = entry.body;
    if (gzipped) {
      body = gzipped;
      headers.set("Content-Encoding", "gzip");
    }
    headers.set("Content-Length", String(body.byteLength));
    return new Response(method === "HEAD" ? null : body, {
      status: 200,
      headers,
    });
  }

  return { handle };
}

/**
 * Short fingerprint of the served web files (relative path + size + mtime),
 * cached for `ttlMs` so live edits on dev show up within a few seconds.
 * Exposed as `build` on /api/health; open tabs compare it to the value they
 * loaded with and offer a reload when it changes.
 */
export function createBuildFingerprint({
  root,
  ttlMs = 5000,
  now = Date.now,
}: {
  root: string;
  ttlMs?: number;
  now?: () => number;
}) {
  const rootAbs = resolve(root);
  let cached: { value: string; at: number } | null = null;
  let inflight: Promise<string> | null = null;

  async function compute(): Promise<string> {
    const dirents = await readdir(rootAbs, {
      recursive: true,
      withFileTypes: true,
    });
    const lines: string[] = [];
    await Promise.all(
      dirents.map(async (dirent) => {
        if (!dirent.isFile()) return;
        if (/\.test\.[cm]?[jt]s$/.test(dirent.name)) return;
        const parent =
          (dirent as { parentPath?: string }).parentPath ?? rootAbs;
        const abs = join(parent, dirent.name);
        try {
          const info = await stat(abs);
          const rel = relative(rootAbs, abs).split(sep).join("/");
          lines.push(`${rel}\0${info.size}\0${info.mtimeMs}`);
        } catch {
          // Deleted between readdir and stat — skip.
        }
      }),
    );
    lines.sort();
    return createHash("sha256")
      .update(lines.join("\n"))
      .digest("hex")
      .slice(0, 12);
  }

  function get(): Promise<string> {
    if (cached && now() - cached.at < ttlMs)
      return Promise.resolve(cached.value);
    if (inflight) return inflight;
    inflight = compute()
      .then((value) => {
        cached = { value, at: now() };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  return { get };
}
