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
