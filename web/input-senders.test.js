import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Regression guard: every terminal-input sender in app.js must go through
// ReconnectingWebSocket.sendInput (the bounded input queue), so input typed or
// tapped while the socket reconnects is held instead of silently dropped.
// Only the queue itself (sendInput / flushQueuedInput) may build the raw
// `{ type: "input" }` frame.
const source = readFileSync(join(import.meta.dir, "app.js"), "utf8");

function classBody(name) {
  const start = source.indexOf(`class ${name} {`);
  if (start < 0) throw new Error(`class ${name} not found in app.js`);
  const next = source.indexOf("\nclass ", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

test("only ReconnectingWebSocket builds raw input frames", () => {
  const frame = /type:\s*"input"/g;
  const total = source.match(frame)?.length ?? 0;
  const inQueue = classBody("ReconnectingWebSocket").match(frame)?.length ?? 0;
  expect(inQueue).toBeGreaterThan(0);
  expect(total).toBe(inQueue);
});

test("extra keys, paste fallback and saved commands use the queued send", () => {
  expect(classBody("ExtraKeysManager")).toContain(
    "active.ws.sendInput(sequence)",
  );
  expect(classBody("ClipboardManager")).toContain(
    "terminalWs?.sendInput?.(text)",
  );
  expect(source).toContain("active.ws.sendInput(`${command}\\r`)");
});
