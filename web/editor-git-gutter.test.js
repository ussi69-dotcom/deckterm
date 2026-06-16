import { test, expect } from "bun:test";
import { headOriginalFor } from "./file-editor";

test("headOriginalFor returns HEAD text for a tracked, changed file", () => {
  const showResponse = { ok: true, content: "line 1\nline 2\n" };
  expect(headOriginalFor(showResponse, true)).toBe("line 1\nline 2\n");
});

test("headOriginalFor returns empty-string HEAD content as-is (tracked, empty file)", () => {
  const showResponse = { ok: true, content: "" };
  expect(headOriginalFor(showResponse, true)).toBe("");
});

test("headOriginalFor returns null for an untracked file", () => {
  const showResponse = { ok: true, content: "whatever" };
  expect(headOriginalFor(showResponse, false)).toBe(null);
});

test("headOriginalFor returns null when the git show fetch failed", () => {
  expect(
    headOriginalFor({ ok: false, error: "File not found at commit" }, true),
  ).toBe(null);
  expect(headOriginalFor(null, true)).toBe(null);
});

test("headOriginalFor returns null when content is not a string", () => {
  expect(headOriginalFor({ ok: true }, true)).toBe(null);
  expect(headOriginalFor({ ok: true, content: 123 }, true)).toBe(null);
});
