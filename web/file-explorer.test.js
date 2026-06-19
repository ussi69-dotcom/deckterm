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

// A node stub the explorer's render() can write into: tracks innerHTML resets
// and appendChild() so a test can count rendered children. The store/render
// path only needs dataset + setAttribute + classList beyond that.
function makeNodeStub() {
  return {
    dataset: {},
    innerHTML: "",
    children: [],
    classList: {
      _set: new Set(),
      add(name) {
        this._set.add(name);
      },
      toggle(name, on) {
        if (on) this._set.add(name);
        else this._set.delete(name);
      },
      contains(name) {
        return this._set.has(name);
      },
    },
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) {
      this.children.push(child);
      return child;
    },
  };
}

// A skeleton-bearing container mirroring index.html's #file-explorer markup:
// querySelector returns real list/breadcrumb stubs so mount() actually binds
// and render() draws INTO them (unlike makeFakeElement, whose querySelector is
// null and only proves no-throw). Used to de-mask the unmount→remount test.
function makeSkeletonContainer() {
  const nodes = {
    "#file-explorer-list": makeNodeStub(),
    "#file-explorer-breadcrumb": makeNodeStub(),
  };
  const base = makeFakeElement();
  base.querySelector = (selector) => nodes[selector] || null;
  base.nodes = nodes;
  return base;
}

// render() builds list/breadcrumb rows with document.createElement; bun:test has
// no DOM, so install a minimal element factory for the duration of a callback.
function withFakeDocument(run) {
  const previous = globalThis.document;
  globalThis.document = {
    getElementById() {
      return null;
    },
    createElement() {
      return makeNodeStub();
    },
    createTextNode(text) {
      return { textContent: text };
    },
  };
  try {
    return run();
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
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

test("store model (path/selection/open) survives an unmount — store-level only", () => {
  const { controller } = createController();

  controller.openForWorkspace("ws-a", "/tmp/workspace-a");
  controller.setSelectedItem("ws-a", { path: "/tmp/workspace-a/alpha.txt" });

  controller.unmount();

  // The model lives in the DOM-free store, so it is preserved across unmount().
  // This asserts STORE survival only — not DOM re-render (see next test).
  expect(controller.getWorkspacePath("ws-a")).toBe("/tmp/workspace-a");
  expect(controller.getSelectedItem("ws-a")).toEqual({
    path: "/tmp/workspace-a/alpha.txt",
  });
  expect(controller.isOpen).toBe(true);
});

test("remount into a skeleton-bearing container re-renders restored items into its list", () => {
  withFakeDocument(() => {
    const { controller } = createController();

    // Seed real items so the restored render produces list rows (not a card).
    controller.openForWorkspace("ws-a", "/tmp/workspace-a");
    controller.setWorkspaceItems("ws-a", [
      { name: "alpha.txt", path: "/tmp/workspace-a/alpha.txt", isDir: false },
      { name: "beta.txt", path: "/tmp/workspace-a/beta.txt", isDir: false },
    ]);

    controller.unmount();

    // Mount into a NEW container that carries a real explorer skeleton. The
    // explorer must re-render the restored items INTO that container's list
    // element — proving real re-host, not just no-throw on an empty container.
    const container = makeSkeletonContainer();
    controller.mount(container);

    expect(controller.root).toBe(container);
    const listNode = container.nodes["#file-explorer-list"];
    expect(listNode.dataset.workspaceId).toBe("ws-a");
    expect(listNode.dataset.path).toBe("/tmp/workspace-a");
    // Two restored items -> two row elements appended to the skeleton's list.
    expect(listNode.children.length).toBe(2);
  });
});

test("dispose() mid-load is safe: a fetch resolving after dispose() does not throw", async () => {
  let resolveFetch;
  const fetchImpl = () =>
    new Promise((resolve) => {
      resolveFetch = resolve;
    });

  const controller = new FileExplorerController({
    viewport: { innerWidth: 1280 },
    fetchImpl,
  });
  controller.openForWorkspace("ws-a", "/tmp/workspace-a");

  const loadPromise = controller.loadDir("/tmp/workspace-a", "ws-a");

  // Tear down while the browse is still in flight.
  controller.dispose();
  expect(controller.store).toBe(null);
  expect(controller.disposed).toBe(true);

  // Resolve the fetch AFTER dispose(): the guarded continuation must no-op
  // instead of calling setWorkspaceItems()/render() on the now-null store.
  resolveFetch({
    ok: true,
    json: async () => ({ path: "/tmp/workspace-a", dirs: [], files: [] }),
  });

  await expect(loadPromise).resolves.toBe(null);
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
