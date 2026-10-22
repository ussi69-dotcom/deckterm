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

const px = (value) => {
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(String(value || ""));
  if (!match) throw new Error(`expected a px length, got ${value}`);
  return Number(match[1]);
};

test("git file-group headers stay sticky (no later rule resets position)", () => {
  expect(resolve(".git-file-group-header", "position")).toBe("sticky");
  expect(resolve(".git-file-group-header", "top")).toBe("0");
});

test("connecting chip clears the touch pane controls", () => {
  const coarse = (media) => media.includes("(pointer: coarse)");
  const chip = '.tile[data-connection-status="reconnecting"]::after';
  const chipRight = px(resolve(chip, "right", coarse));

  // Multi-pane touch layout shows detach + close side by side.
  const containerRight = px(resolve(".tile-close-container", "right", coarse));
  const gap = px(resolve(".tile-close-container", "gap", coarse));
  const closeWidth = px(resolve(".tile-close-btn", "width", coarse));
  const detachWidth = px(resolve(".tile-detach-btn", "width", coarse));
  const controlsReach = containerRight + detachWidth + gap + closeWidth;

  expect(closeWidth).toBe(44);
  expect(chipRight).toBeGreaterThan(controlsReach);
});

test("connecting chip clears the desktop pane controls", () => {
  const chip = '.tile[data-connection-status="connecting"]::after';
  const fine = (media) => media.includes("(pointer: fine)");
  const chipRight = px(resolve(chip, "right", fine));
  // Desktop stacks the 20px controls vertically in the right gutter.
  const containerRight = px(resolve(".tile-close-container", "right", fine));
  const closeWidth = px(resolve(".tile-close-btn", "width", fine));
  expect(chipRight).toBeGreaterThan(containerRight + closeWidth);
});

test("Setup and Sessions lose their overlay chrome inside a desktop window", () => {
  // Setup: no backdrop, no fixed full-screen host, shell fills the window.
  expect(resolve(".surface-window-body > .setup-panel", "position")).toBe(
    "static",
  );
  expect(
    resolve(
      ".surface-window-body > .setup-panel .setup-panel-backdrop",
      "display",
    ),
  ).toBe("none");
  expect(
    resolve(
      ".surface-window-body > .setup-panel .setup-panel-shell",
      "position",
    ),
  ).toBe("static");
  // The window titlebar carries the title and the close button.
  expect(
    resolve(
      ".surface-window-body > .setup-panel .setup-panel-header",
      "display",
    ),
  ).toBe("none");
  // Sessions shares the .task-panel host rules (backdrop hidden, static
  // shell) and drops its own title + close for the titlebar's.
  expect(
    resolve(
      ".surface-window-body > .task-panel .task-panel-backdrop",
      "display",
    ),
  ).toBe("none");
  expect(
    resolve(
      ".surface-window-body > #sessions-panel #sessions-panel-title",
      "display",
    ),
  ).toBe("none");
  expect(
    resolve(
      ".surface-window-body > #sessions-panel #sessions-panel-close",
      "display",
    ),
  ).toBe("none");
});

test("touch layouts pin the xterm helper textarea to the terminal's top-left", () => {
  const coarse = (media) => media.includes("(pointer: coarse)");
  const tablet = "body.touch-input-mode .xterm .xterm-helper-textarea";
  const phone =
    "body.touch-input-mode.chrome-mobile .xterm .xterm-helper-textarea";
  for (const [selector, media] of [
    [tablet, coarse],
    [phone, () => false],
  ]) {
    expect(resolve(selector, "top", media)).toBe("0 !important");
    expect(resolve(selector, "left", media)).toBe("0 !important");
  }
  // Desktop (fine pointer, no phone chrome) leaves xterm's own positioning.
  expect(resolve(tablet, "top")).toBeUndefined();
  expect(resolve(".xterm .xterm-helper-textarea", "top")).toBeUndefined();
});
