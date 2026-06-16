import { expect, test } from "bun:test";
import { FileExplorerController } from "./file-explorer";
import { FileTreeStore } from "./file-tree-store";
import { isViewController } from "./view-host";

// Minimal DOM-free element stub: enough surface for bindDom()/syncDom() to run
// without a browser. querySelector returns null (no inner nodes) so render()
// short-circuits the innerHTML work but still drives the injected renderers.
function makeFakeElement() {
  const listeners = {};
  return {
    dataset: {},
    classList: {
      _set: new Set(),
      toggle(name, on) {
        if (on) this._set.add(name);
        else this._set.delete(name);
      },
      contains(name) {
        return this._set.has(name);
      },
    },
    querySelector() {
      return null;
    },
    setAttribute() {},
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = listeners[type] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    _listeners: listeners,
  };
}

function createController(viewportWidth = 1280) {
  const calls = {
    breadcrumb: [],
    list: [],
    status: [],
  };

  const controller = new FileExplorerController({
    viewport: { innerWidth: viewportWidth },
    renderers: {
      breadcrumb: (payload) => calls.breadcrumb.push(payload),
      list: (payload) => calls.list.push(payload),
      status: (payload) => calls.status.push(payload),
    },
  });

  return { controller, calls };
}

test("openForWorkspace chooses docked on desktop and overlay on mobile", () => {
  const desktop = createController(1280).controller;
  desktop.openForWorkspace("ws-1", "/tmp/desktop");
  expect(desktop.mode).toBe("docked");
  expect(desktop.isOpen).toBe(true);

  const mobile = createController(390).controller;
  mobile.openForWorkspace("ws-2", "/tmp/mobile");
  expect(mobile.mode).toBe("overlay");
  expect(mobile.isOpen).toBe(true);
});

test("currentPathByWorkspace stores separate paths", () => {
  const { controller } = createController();

  controller.setWorkspacePath("ws-a", "/tmp/workspace-a");
  controller.setWorkspacePath("ws-b", "/tmp/workspace-b");

  expect(controller.getWorkspacePath("ws-a")).toBe("/tmp/workspace-a");
  expect(controller.getWorkspacePath("ws-b")).toBe("/tmp/workspace-b");
});

test("selected items are isolated per workspace", () => {
  const { controller } = createController();

  controller.setSelectedItem("ws-a", { path: "/tmp/workspace-a/alpha.txt" });
  controller.setSelectedItem("ws-b", { path: "/tmp/workspace-b/beta.txt" });

  expect(controller.getSelectedItem("ws-a")).toEqual({
    path: "/tmp/workspace-a/alpha.txt",
  });
  expect(controller.getSelectedItem("ws-b")).toEqual({
    path: "/tmp/workspace-b/beta.txt",
  });
});

test("openForWorkspace initializes from cwd only when no prior path exists", () => {
  const { controller } = createController();

  controller.openForWorkspace("ws-a", "/tmp/workspace-a");
  expect(controller.getWorkspacePath("ws-a")).toBe("/tmp/workspace-a");

  controller.setWorkspacePath("ws-a", "/tmp/workspace-a/saved");
  controller.openForWorkspace("ws-a", "/tmp/workspace-a/ignored");
  expect(controller.getWorkspacePath("ws-a")).toBe("/tmp/workspace-a/saved");

  controller.openForWorkspace("ws-b", "/tmp/workspace-b");
  expect(controller.getWorkspacePath("ws-b")).toBe("/tmp/workspace-b");
});

test("render hooks receive workspace path and loading state updates", () => {
  const { controller, calls } = createController();

  controller.openForWorkspace("ws-a", "/tmp/workspace-a");
  controller.setLoading(true);
  controller.setError("Browse failed");

  expect(calls.breadcrumb.at(-1)).toMatchObject({
    workspaceId: "ws-a",
    path: "/tmp/workspace-a",
  });
  expect(calls.list.at(-1)).toMatchObject({
    workspaceId: "ws-a",
    path: "/tmp/workspace-a",
  });
  expect(calls.status.at(-1)).toMatchObject({
    workspaceId: "ws-a",
    loading: true,
    error: "Browse failed",
  });
});

test("controller conforms to the ViewHost lifecycle contract", () => {
  const { controller } = createController();
  expect(isViewController(controller)).toBe(true);
});

test("model state survives unmount and remounts into a new container", () => {
  const { controller } = createController();

  controller.openForWorkspace("ws-a", "/tmp/workspace-a");
  controller.setSelectedItem("ws-a", { path: "/tmp/workspace-a/alpha.txt" });

  controller.unmount();

  // Model is preserved across the unmount (lives in the store).
  expect(controller.getWorkspacePath("ws-a")).toBe("/tmp/workspace-a");
  expect(controller.getSelectedItem("ws-a")).toEqual({
    path: "/tmp/workspace-a/alpha.txt",
  });
  expect(controller.isOpen).toBe(true);

  // Remounting into a fresh container re-renders from the store without error.
  const container = makeFakeElement();
  controller.mount(container);
  expect(controller.root).toBe(container);
  expect(controller.getSelectedItem("ws-a")).toEqual({
    path: "/tmp/workspace-a/alpha.txt",
  });
});

test("mount binds a container and resize re-renders without throwing", () => {
  const { controller, calls } = createController();
  const container = makeFakeElement();

  controller.mount(container);
  controller.openForWorkspace("ws-a", "/tmp/workspace-a");
  const before = calls.list.length;
  controller.resize();
  expect(calls.list.length).toBeGreaterThan(before);
});

test("an injected store backs the controller's model surface", () => {
  const store = new FileTreeStore();
  const controller = new FileExplorerController({
    viewport: { innerWidth: 1280 },
    store,
  });

  controller.setWorkspacePath("ws-a", "/tmp/shared");
  expect(store.getWorkspacePath("ws-a")).toBe("/tmp/shared");
});
