import { test, expect } from "bun:test";
import { hashCwdToColor, blendWorkspaceColors } from "./terminal-colors";

test("hashCwdToColor is stable", () => {
  expect(hashCwdToColor("/home/user")).toBe(hashCwdToColor("/home/user"));
});

test("blendWorkspaceColors dedupes and caps to 3", () => {
  const colors = blendWorkspaceColors(["#111", "#111", "#222", "#333", "#444"]);
  expect(colors.length).toBe(3);
  expect(colors).toEqual(["#111", "#222", "#333"]);
});
