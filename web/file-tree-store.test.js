import { expect, test } from "bun:test";
import { FileTreeStore } from "./file-tree-store";

test("per-workspace path and selection are isolated", () => {
  const store = new FileTreeStore();

  store.setWorkspacePath("ws-a", "/tmp/a");
  store.setWorkspacePath("ws-b", "/tmp/b");
  store.setSelectedItem("ws-a", { path: "/tmp/a/x.txt" });
  store.setSelectedItem("ws-b", { path: "/tmp/b/y.txt" });

  expect(store.getWorkspacePath("ws-a")).toBe("/tmp/a");
  expect(store.getWorkspacePath("ws-b")).toBe("/tmp/b");
  expect(store.getSelectedItem("ws-a")).toEqual({ path: "/tmp/a/x.txt" });
  expect(store.getSelectedItem("ws-b")).toEqual({ path: "/tmp/b/y.txt" });
});

test("items and decorations clone on read and write", () => {
  const store = new FileTreeStore();
  const items = [{ name: "x", path: "/x" }];

  store.setWorkspaceItems("ws", items);
  items[0].name = "mutated";
  const read = store.getWorkspaceItems("ws");
  expect(read[0].name).toBe("x");
  read[0].name = "again";
  expect(store.getWorkspaceItems("ws")[0].name).toBe("x");

  store.setDecorations("ws", { "/x": { letter: "M" } });
  expect(store.getDecorations("ws")).toEqual({ "/x": { letter: "M" } });
});

test("global flags update and selection clears on null", () => {
  const store = new FileTreeStore();

  store.setCurrentWorkspaceId("ws");
  store.setOpen(true);
  store.setMode("overlay");
  store.setLoading(true);
  store.setError("boom");
  store.setDragActive(true);

  expect(store.currentWorkspaceId).toBe("ws");
  expect(store.isOpen).toBe(true);
  expect(store.mode).toBe("overlay");
  expect(store.loading).toBe(true);
  expect(store.error).toBe("boom");
  expect(store.dragActive).toBe(true);

  store.setSelectedItem("ws", { path: "/a" });
  store.setSelectedItem("ws", null);
  expect(store.getSelectedItem("ws")).toBe(null);
});

test("onChange fires on mutation and unsubscribe stops it", () => {
  const store = new FileTreeStore();
  let count = 0;
  const unsubscribe = store.onChange(() => {
    count += 1;
  });

  store.setLoading(true);
  store.setWorkspacePath("ws", "/tmp");
  expect(count).toBe(2);

  unsubscribe();
  store.setLoading(false);
  expect(count).toBe(2);
});
