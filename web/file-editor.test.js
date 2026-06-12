import { test, expect } from "bun:test";
import { detectEditorLanguage, isProbablyEditable } from "./file-editor";

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
