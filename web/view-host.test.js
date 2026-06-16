import { expect, test } from "bun:test";
import {
  VIEW_HOST_LIFECYCLE_METHODS,
  isViewController,
  rehostView,
} from "./view-host";

function makeFakeView() {
  const calls = [];
  return {
    calls,
    mount(container) {
      calls.push(["mount", container]);
    },
    unmount() {
      calls.push(["unmount"]);
    },
    dispose() {
      calls.push(["dispose"]);
    },
    resize() {
      calls.push(["resize"]);
    },
  };
}

test("lifecycle method names are the documented contract", () => {
  expect(VIEW_HOST_LIFECYCLE_METHODS).toEqual([
    "mount",
    "unmount",
    "dispose",
    "resize",
  ]);
});

test("isViewController accepts a full lifecycle and rejects partials", () => {
  expect(isViewController(makeFakeView())).toBe(true);
  expect(isViewController({ mount() {}, unmount() {} })).toBe(false);
  expect(isViewController(null)).toBe(false);
  expect(isViewController(42)).toBe(false);
});

test("rehostView unmounts then mounts into the new container", () => {
  const view = makeFakeView();
  const containerA = { name: "a" };
  const containerB = { name: "b" };

  rehostView(view, containerA);
  const result = rehostView(view, containerB);

  expect(view.calls).toEqual([
    ["unmount"],
    ["mount", containerA],
    ["unmount"],
    ["mount", containerB],
  ]);
  expect(result).toBe(containerB);
});

test("rehostView no-ops on a non-view", () => {
  expect(rehostView({}, {})).toBe(null);
});
