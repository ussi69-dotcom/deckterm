import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Cascade guards for styles.css. styles.css is one large hand-edited sheet, so
// a later same-specificity rule can silently cancel a newer one. These tests
// parse the sheet into ordered rules (top level plus one level of @media) and
// resolve a property the way the cascade does for equal specificity: the last
// matching declaration wins.

const css = readFileSync(
  fileURLToPath(new URL("./styles.css", import.meta.url)),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

function parseRules(text, media = null, out = []) {
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    const prelude = text.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === "{") depth += 1;
      else if (text[j] === "}") depth -= 1;
      j += 1;
    }
    const body = text.slice(open + 1, j - 1);
    if (prelude.startsWith("@media")) {
      parseRules(body, prelude.replace(/^@media\s*/, ""), out);
    } else if (!prelude.startsWith("@")) {
      const decls = {};
      for (const part of body.split(";")) {
        const colon = part.indexOf(":");
        if (colon < 0) continue;
        decls[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
      }
      out.push({
        media,
        selectors: prelude.split(",").map((s) => s.replace(/\s+/g, " ").trim()),
        decls,
      });
    }
    i = j;
  }
  return out;
}

const rules = parseRules(css);

// Last value of `prop` for an exact `selector`, considering top-level rules and
// rules inside any @media whose condition `mediaMatches` accepts.
function resolve(selector, prop, mediaMatches = () => false) {
  let value;
  for (const rule of rules) {
    if (rule.media !== null && !mediaMatches(rule.media)) continue;
    if (!rule.selectors.includes(selector)) continue;
    if (prop in rule.decls) value = rule.decls[prop];
  }
  return value;
}

test("git file-group headers stay sticky (no later rule resets position)", () => {
  expect(resolve(".git-file-group-header", "position")).toBe("sticky");
  expect(resolve(".git-file-group-header", "top")).toBe("0");
});
