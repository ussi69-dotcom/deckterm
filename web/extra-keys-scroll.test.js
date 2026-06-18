import { expect, test } from "bun:test";
import { shouldScrollToPromptForKey } from "./extra-keys-scroll.js";

test("shouldScrollToPromptForKey returns false for PGUP (scrollback key)", () => {
  expect(shouldScrollToPromptForKey("PGUP")).toBe(false);
});

test("shouldScrollToPromptForKey returns false for PGDN (scrollback key)", () => {
  expect(shouldScrollToPromptForKey("PGDN")).toBe(false);
});

test("shouldScrollToPromptForKey returns true for TAB (normal key)", () => {
  expect(shouldScrollToPromptForKey("TAB")).toBe(true);
});

test("shouldScrollToPromptForKey returns true for ESC (normal key)", () => {
  expect(shouldScrollToPromptForKey("ESC")).toBe(true);
});

test("shouldScrollToPromptForKey returns true for Enter (normal key)", () => {
  expect(shouldScrollToPromptForKey("Enter")).toBe(true);
});

test("shouldScrollToPromptForKey returns true for arrow keys (UP/DOWN/LEFT/RIGHT)", () => {
  expect(shouldScrollToPromptForKey("UP")).toBe(true);
  expect(shouldScrollToPromptForKey("DOWN")).toBe(true);
  expect(shouldScrollToPromptForKey("LEFT")).toBe(true);
  expect(shouldScrollToPromptForKey("RIGHT")).toBe(true);
});

test("shouldScrollToPromptForKey returns true for DEL and INS", () => {
  expect(shouldScrollToPromptForKey("DEL")).toBe(true);
  expect(shouldScrollToPromptForKey("INS")).toBe(true);
});
