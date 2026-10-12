import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const readText = (relativePath) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

test("app bootstrap does not redeclare the standalone input fallback helper", () => {
  const indexHtml = readText("./index.html");
  const appJs = readText("./app.js");

  expect(indexHtml).toContain("/input-fallback.js?v=");
  expect(appJs).not.toContain("const InputFallback =");
});

// Regression guard: every browser module (a web/*.js that publishes a `window.X`
// global, i.e. is meant to load via a <script> tag — there is no bundler) MUST be
// referenced in index.html. This catches "added a new module but forgot to wire
// the <script> tag" — exactly what stranded git-history-view.js (History view
// rendered "unavailable" because window.GitHistoryView never loaded).
test("every browser module is wired with a <script> tag in index.html", () => {
  const dir = fileURLToPath(new URL("./", import.meta.url));
  const indexHtml = readText("./index.html");
  // Modules that are NOT loaded by their own tag (the entry bundle / inlined).
  const allow = new Set(["app.js"]); // app.js IS tagged, but keep explicit anyway
  const missing = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".js") || name.endsWith(".test.js")) continue;
    if (allow.has(name)) continue;
    const src = readText(`./${name}`);
    // A browser module assigns a window global behind the standard guard.
    if (!/window\.[A-Za-z0-9_]+\s*=/.test(src)) continue;
    if (
      !indexHtml.includes(`/${name}?v=`) &&
      !indexHtml.includes(`/${name}"`)
    ) {
      missing.push(name);
    }
  }
  expect(missing).toEqual([]);
});

// Regression guard: index.html loads every web module as a classic <script>,
// so all of them share ONE global scope. A top-level `function foo` in two
// scripts silently resolves to whichever loaded last (this broke the Tasks
// view icons: tasks-view.js called a no-argument renderLucideIcons() and got
// file-explorer.js's root-required one); a duplicate top-level const/let/class
// is a SyntaxError that stops the later script entirely. Modules wrapped in an
// IIFE keep their helpers indented, so only column-0 declarations are global.
test("classic scripts in index.html declare no clashing top-level names", () => {
  const indexHtml = readText("./index.html");
  const scripts = [...indexHtml.matchAll(/<script\b[^>]*\bsrc="\/([^"?]+\.js)/g)]
    .map((m) => m[1])
    .filter((name) => !name.startsWith("vendor/") && !name.startsWith("assets/"));
  expect(scripts.length).toBeGreaterThan(20);

  const declPattern =
    /^(?:async\s+)?(?:function\*?\s+([A-Za-z_$][\w$]*)|(?:const|let|var|class)\s+([A-Za-z_$][\w$]*))/gm;
  // ident -> Map(file -> source text of a top-level function, or null for a
  // lexical/var binding). Byte-identical copies of one helper function (e.g.
  // resolveEscapeHtml) are harmless: whichever wins behaves the same.
  const owners = new Map();
  for (const name of scripts) {
    const src = readText(`./${name}`);
    for (const match of src.matchAll(declPattern)) {
      const ident = match[1] || match[2];
      let body = null;
      if (match[1]) {
        const end = src.indexOf("\n}", match.index);
        body = src.slice(match.index, end < 0 ? undefined : end + 2);
      }
      if (!owners.has(ident)) owners.set(ident, new Map());
      owners.get(ident).set(name, body);
    }
  }
  const clashes = [...owners]
    .filter(([, files]) => {
      if (files.size < 2) return false;
      const bodies = new Set(files.values());
      return bodies.size > 1 || bodies.has(null);
    })
    .map(([ident, files]) => `${ident}: ${[...files.keys()].join(", ")}`);
  expect(clashes).toEqual([]);
});
