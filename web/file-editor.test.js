import { test, expect } from "bun:test";
import {
  detectEditorLanguage,
  isProbablyEditable,
  parseAutosaveMs,
  createAutosaveController,
} from "./file-editor";

test("detectEditorLanguage maps common extensions", () => {
  expect(detectEditorLanguage("/a/app.js")).toBe("javascript");
  expect(detectEditorLanguage("/a/app.mjs")).toBe("javascript");
  expect(detectEditorLanguage("/a/server.ts")).toBe("javascript");
  expect(detectEditorLanguage("/a/comp.tsx")).toBe("javascript");
  expect(detectEditorLanguage("/a/data.json")).toBe("json");
  expect(detectEditorLanguage("/a/README.md")).toBe("markdown");
  expect(detectEditorLanguage("/a/tool.py")).toBe("python");
  expect(detectEditorLanguage("/a/index.html")).toBe("html");
  expect(detectEditorLanguage("/a/styles.css")).toBe("css");
});

test("detectEditorLanguage maps the D5 language additions", () => {
  expect(detectEditorLanguage("/a/config.yaml")).toBe("yaml");
  expect(detectEditorLanguage("/a/config.yml")).toBe("yaml");
  expect(detectEditorLanguage("/a/data.xml")).toBe("xml");
  expect(detectEditorLanguage("/a/icon.svg")).toBe("xml");
  expect(detectEditorLanguage("/a/query.sql")).toBe("sql");
  expect(detectEditorLanguage("/a/main.c")).toBe("cpp");
  expect(detectEditorLanguage("/a/header.h")).toBe("cpp");
  expect(detectEditorLanguage("/a/main.cpp")).toBe("cpp");
  expect(detectEditorLanguage("/a/header.hpp")).toBe("cpp");
  expect(detectEditorLanguage("/a/lib.rs")).toBe("rust");
  expect(detectEditorLanguage("/a/main.go")).toBe("go");
});

test("detectEditorLanguage returns null for unknown/none extensions", () => {
  expect(detectEditorLanguage("/a/Makefile")).toBe(null);
  expect(detectEditorLanguage("/a/script.sh")).toBe(null);
  expect(detectEditorLanguage("")).toBe(null);
});

test("isProbablyEditable rejects obvious binaries by extension", () => {
  expect(isProbablyEditable("notes.txt")).toBe(true);
  expect(isProbablyEditable("app.js")).toBe(true);
  expect(isProbablyEditable("Makefile")).toBe(true);
  expect(isProbablyEditable("photo.png")).toBe(false);
  expect(isProbablyEditable("archive.zip")).toBe(false);
  expect(isProbablyEditable("font.woff2")).toBe(false);
  expect(isProbablyEditable("doc.pdf")).toBe(false);
});

// ── Autosave: parseAutosaveMs ────────────────────────────────────────────

test("parseAutosaveMs turns the schema's select values into a debounce ms", () => {
  expect(parseAutosaveMs("off")).toBe(null);
  expect(parseAutosaveMs("1000")).toBe(1000);
  expect(parseAutosaveMs("5000")).toBe(5000);
});

test("parseAutosaveMs treats anything unrecognized as off", () => {
  expect(parseAutosaveMs(undefined)).toBe(null);
  expect(parseAutosaveMs(null)).toBe(null);
  expect(parseAutosaveMs("")).toBe(null);
  expect(parseAutosaveMs("bogus")).toBe(null);
  expect(parseAutosaveMs("0")).toBe(null);
  expect(parseAutosaveMs("-5")).toBe(null);
});

// ── Autosave: createAutosaveController ───────────────────────────────────
// Injectable scheduler (mirrors settings-store.test.js's fake scheduler) so
// the debounce/failure state machine is deterministically testable without
// real timers.

function createFakeScheduler() {
  const pending = [];
  return {
    schedule(fn, ms) {
      const id = pending.length;
      pending.push({ fn, ms, cancelled: false });
      return id;
    },
    cancel(id) {
      if (pending[id]) pending[id].cancelled = true;
    },
    async runAll() {
      while (pending.length) {
        const job = pending.shift();
        if (!job.cancelled) await job.fn();
      }
    },
    get pendingCount() {
      return pending.filter((j) => !j.cancelled).length;
    },
  };
}

test("notifyChange is a no-op when autosave is off (intervalMs null)", () => {
  const scheduler = createFakeScheduler();
  let saveCalls = 0;
  const autosave = createAutosaveController({
    save: async () => {
      saveCalls += 1;
      return true;
    },
    intervalMs: null,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });
  autosave.notifyChange();
  expect(scheduler.pendingCount).toBe(0);
  expect(saveCalls).toBe(0);
});

test("notifyChange schedules a debounced save that fires after the interval", async () => {
  const scheduler = createFakeScheduler();
  let saveCalls = 0;
  const autosave = createAutosaveController({
    save: async () => {
      saveCalls += 1;
      return true;
    },
    intervalMs: 1000,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });
  autosave.notifyChange();
  expect(scheduler.pendingCount).toBe(1);
  await scheduler.runAll();
  expect(saveCalls).toBe(1);
  expect(autosave.failed).toBe(false);
});

test("repeated notifyChange calls debounce (cancel the previous timer)", async () => {
  const scheduler = createFakeScheduler();
  let saveCalls = 0;
  const autosave = createAutosaveController({
    save: async () => {
      saveCalls += 1;
      return true;
    },
    intervalMs: 1000,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });
  autosave.notifyChange();
  autosave.notifyChange();
  autosave.notifyChange();
  // Only the LAST scheduled timer should still be live.
  expect(scheduler.pendingCount).toBe(1);
  await scheduler.runAll();
  expect(saveCalls).toBe(1);
});

test("a failed save (409 or otherwise) stops further autosaves until a manual save succeeds", async () => {
  const scheduler = createFakeScheduler();
  let saveCalls = 0;
  const autosave = createAutosaveController({
    save: async () => {
      saveCalls += 1;
      return false; // simulates a 409 / failed save
    },
    intervalMs: 1000,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });
  autosave.notifyChange();
  await scheduler.runAll();
  expect(saveCalls).toBe(1);
  expect(autosave.failed).toBe(true);

  // Further edits must NOT schedule another autosave while failed.
  autosave.notifyChange();
  expect(scheduler.pendingCount).toBe(0);
  await scheduler.runAll();
  expect(saveCalls).toBe(1);

  // A manual save reported as successful re-arms autosave.
  autosave.notifySaved(true);
  expect(autosave.failed).toBe(false);
  autosave.notifyChange();
  expect(scheduler.pendingCount).toBe(1);
});

test("notifySaved(false) from a manual save also stops autosave", () => {
  const autosave = createAutosaveController({
    save: async () => true,
    intervalMs: 1000,
  });
  autosave.notifySaved(false);
  expect(autosave.failed).toBe(true);
});

test("setIntervalMs(null) turns autosave off and cancels any pending timer", () => {
  const scheduler = createFakeScheduler();
  const autosave = createAutosaveController({
    save: async () => true,
    intervalMs: 1000,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });
  autosave.notifyChange();
  expect(scheduler.pendingCount).toBe(1);
  autosave.setIntervalMs(null);
  expect(scheduler.pendingCount).toBe(0);
  expect(autosave.enabled).toBe(false);
  autosave.notifyChange();
  expect(scheduler.pendingCount).toBe(0);
});

test("dispose cancels any pending scheduled save", () => {
  const scheduler = createFakeScheduler();
  const autosave = createAutosaveController({
    save: async () => true,
    intervalMs: 1000,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });
  autosave.notifyChange();
  expect(scheduler.pendingCount).toBe(1);
  autosave.dispose();
  expect(scheduler.pendingCount).toBe(0);
});
