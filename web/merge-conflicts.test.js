import { test, expect } from "bun:test";
import { parseConflictBlocks, resolveConflicts } from "./merge-conflicts.js";

// ── parseConflictBlocks ───────────────────────────────────────────────────

test("parseConflictBlocks: no markers → ok, hasConflicts false", () => {
  const text = "line one\nline two\n";
  const result = parseConflictBlocks(text);
  expect(result.ok).toBe(true);
  expect(result.hasConflicts).toBe(false);
});

test("parseConflictBlocks: a single standard (2-way) conflict block", () => {
  const text = [
    "before\n",
    "<<<<<<< HEAD\n",
    "our line\n",
    "=======\n",
    "their line\n",
    ">>>>>>> feature\n",
    "after\n",
  ].join("");
  const result = parseConflictBlocks(text);
  expect(result.ok).toBe(true);
  expect(result.hasConflicts).toBe(true);
  const conflict = result.segments.find((s) => s.type === "conflict");
  expect(conflict).toBeTruthy();
  expect(conflict.ours.map((l) => l.content)).toEqual(["our line"]);
  expect(conflict.theirs.map((l) => l.content)).toEqual(["their line"]);
  expect(conflict.base).toBeNull();
});

test("parseConflictBlocks: diff3 conflict block with a base section", () => {
  const text = [
    "<<<<<<< HEAD\n",
    "our line\n",
    "||||||| merged common ancestors\n",
    "base line\n",
    "=======\n",
    "their line\n",
    ">>>>>>> feature\n",
  ].join("");
  const result = parseConflictBlocks(text);
  expect(result.ok).toBe(true);
  expect(result.hasConflicts).toBe(true);
  const conflict = result.segments.find((s) => s.type === "conflict");
  expect(conflict.ours.map((l) => l.content)).toEqual(["our line"]);
  expect(conflict.base.map((l) => l.content)).toEqual(["base line"]);
  expect(conflict.theirs.map((l) => l.content)).toEqual(["their line"]);
});

test("parseConflictBlocks: multiple conflict blocks + surrounding context", () => {
  const text = [
    "ctx1\n",
    "<<<<<<< HEAD\n",
    "a-ours\n",
    "=======\n",
    "a-theirs\n",
    ">>>>>>> branch\n",
    "ctx2\n",
    "<<<<<<< HEAD\n",
    "b-ours\n",
    "=======\n",
    "b-theirs\n",
    ">>>>>>> branch\n",
    "ctx3\n",
  ].join("");
  const result = parseConflictBlocks(text);
  expect(result.ok).toBe(true);
  const conflicts = result.segments.filter((s) => s.type === "conflict");
  expect(conflicts).toHaveLength(2);
  expect(conflicts[0].ours.map((l) => l.content)).toEqual(["a-ours"]);
  expect(conflicts[1].ours.map((l) => l.content)).toEqual(["b-ours"]);
});

test("parseConflictBlocks: CRLF line endings are preserved and parsed", () => {
  const text =
    "before\r\n<<<<<<< HEAD\r\nour line\r\n=======\r\ntheir line\r\n>>>>>>> feature\r\nafter\r\n";
  const result = parseConflictBlocks(text);
  expect(result.ok).toBe(true);
  const conflict = result.segments.find((s) => s.type === "conflict");
  expect(conflict.ours.map((l) => l.content)).toEqual(["our line"]);
  expect(conflict.ours[0].term).toBe("\r\n");
  expect(conflict.theirs.map((l) => l.content)).toEqual(["their line"]);
});

test("parseConflictBlocks: unterminated conflict marker (missing >>>>>>>) is an error, not a throw", () => {
  const text = [
    "<<<<<<< HEAD\n",
    "our line\n",
    "=======\n",
    "their line\n",
  ].join("");
  const result = parseConflictBlocks(text);
  expect(result.ok).toBe(false);
  expect(typeof result.error).toBe("string");
});

test("parseConflictBlocks: missing separator (no =======) before the end marker is malformed", () => {
  const text = ["<<<<<<< HEAD\n", "our line\n", ">>>>>>> feature\n"].join("");
  const result = parseConflictBlocks(text);
  expect(result.ok).toBe(false);
  expect(typeof result.error).toBe("string");
});

test("parseConflictBlocks: a stray end marker with no opening start marker is malformed", () => {
  const text = "just some text\n>>>>>>> feature\nmore text\n";
  const result = parseConflictBlocks(text);
  expect(result.ok).toBe(false);
});

test("parseConflictBlocks: a stray separator with no opening start marker is malformed", () => {
  const text = "just some text\n=======\nmore text\n";
  const result = parseConflictBlocks(text);
  expect(result.ok).toBe(false);
});

test("parseConflictBlocks: a nested start marker before the current block closes is malformed", () => {
  const text = [
    "<<<<<<< HEAD\n",
    "our line\n",
    "<<<<<<< HEAD\n",
    "=======\n",
    "their line\n",
    ">>>>>>> feature\n",
  ].join("");
  const result = parseConflictBlocks(text);
  expect(result.ok).toBe(false);
});

test("parseConflictBlocks: non-string input returns an error result, does not throw", () => {
  expect(() => parseConflictBlocks(undefined)).not.toThrow();
  const result = parseConflictBlocks(undefined);
  expect(result.ok).toBe(false);
});

test("parseConflictBlocks: empty string is ok with no conflicts", () => {
  const result = parseConflictBlocks("");
  expect(result.ok).toBe(true);
  expect(result.hasConflicts).toBe(false);
});

test("parseConflictBlocks: a file with no trailing newline round-trips through resolveConflicts", () => {
  const text = [
    "<<<<<<< HEAD",
    "our line",
    "=======",
    "their line",
    ">>>>>>> feature",
  ].join("\n");
  const result = parseConflictBlocks(text);
  expect(result.ok).toBe(true);
  expect(result.hasConflicts).toBe(true);
});

// ── resolveConflicts ───────────────────────────────────────────────────────

test("resolveConflicts: 'ours' keeps context + our side, drops their side", () => {
  const text = [
    "before\n",
    "<<<<<<< HEAD\n",
    "our line\n",
    "=======\n",
    "their line\n",
    ">>>>>>> feature\n",
    "after\n",
  ].join("");
  const result = resolveConflicts(text, "ours");
  expect(result.ok).toBe(true);
  expect(result.content).toBe("before\nour line\nafter\n");
});

test("resolveConflicts: 'theirs' keeps context + their side, drops our side", () => {
  const text = [
    "before\n",
    "<<<<<<< HEAD\n",
    "our line\n",
    "=======\n",
    "their line\n",
    ">>>>>>> feature\n",
    "after\n",
  ].join("");
  const result = resolveConflicts(text, "theirs");
  expect(result.ok).toBe(true);
  expect(result.content).toBe("before\ntheir line\nafter\n");
});

test("resolveConflicts: 'both' concatenates our side then their side", () => {
  const text = [
    "before\n",
    "<<<<<<< HEAD\n",
    "our line\n",
    "=======\n",
    "their line\n",
    ">>>>>>> feature\n",
    "after\n",
  ].join("");
  const result = resolveConflicts(text, "both");
  expect(result.ok).toBe(true);
  expect(result.content).toBe("before\nour line\ntheir line\nafter\n");
});

test("resolveConflicts: diff3 base section is dropped for all three modes", () => {
  const text = [
    "<<<<<<< HEAD\n",
    "our line\n",
    "||||||| merged common ancestors\n",
    "base line\n",
    "=======\n",
    "their line\n",
    ">>>>>>> feature\n",
  ].join("");
  expect(resolveConflicts(text, "ours").content).toBe("our line\n");
  expect(resolveConflicts(text, "theirs").content).toBe("their line\n");
  expect(resolveConflicts(text, "both").content).toBe("our line\ntheir line\n");
});

test("resolveConflicts: multiple conflict blocks each resolve independently", () => {
  const text = [
    "ctx1\n",
    "<<<<<<< HEAD\n",
    "a-ours\n",
    "=======\n",
    "a-theirs\n",
    ">>>>>>> branch\n",
    "ctx2\n",
    "<<<<<<< HEAD\n",
    "b-ours\n",
    "=======\n",
    "b-theirs\n",
    ">>>>>>> branch\n",
    "ctx3\n",
  ].join("");
  const result = resolveConflicts(text, "ours");
  expect(result.ok).toBe(true);
  expect(result.content).toBe("ctx1\na-ours\nctx2\nb-ours\nctx3\n");
});

test("resolveConflicts: preserves CRLF line endings in the resolved output", () => {
  const text =
    "before\r\n<<<<<<< HEAD\r\nour line\r\n=======\r\ntheir line\r\n>>>>>>> feature\r\nafter\r\n";
  const result = resolveConflicts(text, "ours");
  expect(result.ok).toBe(true);
  expect(result.content).toBe("before\r\nour line\r\nafter\r\n");
});

test("resolveConflicts: never produces output when the parse failed (malformed markers)", () => {
  const text = [
    "<<<<<<< HEAD\n",
    "our line\n",
    "=======\n",
    "their line\n",
  ].join(""); // unterminated
  const result = resolveConflicts(text, "ours");
  expect(result.ok).toBe(false);
  expect(result.content).toBeUndefined();
});

test("resolveConflicts: refuses (error, no throw) when there are no conflict markers at all", () => {
  const result = resolveConflicts("plain text\nno markers\n", "ours");
  expect(result.ok).toBe(false);
  expect(typeof result.error).toBe("string");
});

test("resolveConflicts: rejects an unknown resolution mode without throwing", () => {
  const text = [
    "<<<<<<< HEAD\n",
    "our line\n",
    "=======\n",
    "their line\n",
    ">>>>>>> feature\n",
  ].join("");
  expect(() => resolveConflicts(text, "banana")).not.toThrow();
  const result = resolveConflicts(text, "banana");
  expect(result.ok).toBe(false);
});
