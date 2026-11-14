import { expect, test } from "bun:test";
import { isPrimarySessionHandle } from "./session-handles";

const source = { id: "src", sessionName: "deckterm_ns_src" };
const view = { id: "view", sessionName: "deckterm_ns_src" };
const other = { id: "other", sessionName: "deckterm_ns_other" };
const raw = { id: "raw", sessionName: null };

test("the session's own terminal carries its effects, a linked view does not", () => {
  const handles = [view, source, other];
  expect(isPrimarySessionHandle(source, handles, "src")).toBe(true);
  expect(isPrimarySessionHandle(view, handles, "src")).toBe(false);
  expect(isPrimarySessionHandle(other, handles, "other")).toBe(true);
});

test("after the source closes, its first remaining view takes over", () => {
  const second = { id: "view2", sessionName: "deckterm_ns_src" };
  expect(isPrimarySessionHandle(view, [view, second], "src")).toBe(true);
  expect(isPrimarySessionHandle(second, [view, second], "src")).toBe(false);
});

test("a handle without a tmux session is its own primary", () => {
  expect(isPrimarySessionHandle(raw, [raw, source], null)).toBe(true);
});
