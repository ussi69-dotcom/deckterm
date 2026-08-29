import { expect, test } from "bun:test";
import { FileExplorerController, breadcrumbSegments } from "./file-explorer";
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

// Same as makeSkeletonContainer, plus stand-ins for the header × and footer
// Close buttons (A4b) — each a makeFakeElement() so a test can trigger its
// bound click handler via _listeners.click.
function makeCloseSkeletonContainer() {
  const container = makeSkeletonContainer();
  const closeBtn = makeFakeElement();
  const mobileCloseBtn = makeFakeElement();
  // container.nodes is the same object querySelector() closes over, so
  // mutating it here is visible to the container's own querySelector.
  container.nodes["#file-explorer-close"] = closeBtn;
  container.nodes["#file-explorer-mobile-close"] = mobileCloseBtn;
  return { container, closeBtn, mobileCloseBtn };
}

function clickButton(button) {
  (button._listeners.click || []).forEach((fn) => fn());
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

test("openForWorkspace with reveal:false targets the workspace without opening", () => {
  const { controller } = createController();

  controller.openForWorkspace("ws-1", "/tmp/workspace-1", null, {
    reveal: false,
  });

  expect(controller.currentWorkspaceId).toBe("ws-1");
  expect(controller.getWorkspacePath("ws-1")).toBe("/tmp/workspace-1");
  expect(controller.isOpen).toBe(false);

  // An explorer the user already opened stays open.
  controller.openForWorkspace("ws-1", "/tmp/workspace-1");
  expect(controller.isOpen).toBe(true);
  controller.openForWorkspace("ws-2", "/tmp/workspace-2", null, {
    reveal: false,
  });
  expect(controller.isOpen).toBe(true);
  expect(controller.currentWorkspaceId).toBe("ws-2");
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

// --- breadcrumbSegments ---

test("breadcrumbSegments: first crumb is root, no segments above it", () => {
  const crumbs = breadcrumbSegments("/home/deploy/project/src", "/home/deploy");
  // Should NOT have "/" or "home" crumbs — only root + below-root segments
  const labels = crumbs.map((c) => c.label);
  expect(labels).not.toContain("/");
  expect(labels).not.toContain("home");
  expect(labels[0]).toBe("deploy"); // basename of root
  expect(labels).toEqual(["deploy", "project", "src"]);
});

test("breadcrumbSegments: each emitted path is within the root", () => {
  const root = "/home/deploy";
  const crumbs = breadcrumbSegments("/home/deploy/a/b/c", root);
  for (const crumb of crumbs) {
    expect(crumb.path.startsWith(root)).toBe(true);
  }
});

test("breadcrumbSegments: path equal to root emits only the root crumb", () => {
  const crumbs = breadcrumbSegments("/home/deploy", "/home/deploy");
  expect(crumbs).toHaveLength(1);
  expect(crumbs[0]).toEqual({ label: "deploy", path: "/home/deploy" });
});

test("breadcrumbSegments: returns [] when path is not under root", () => {
  const crumbs = breadcrumbSegments("/other/path", "/home/deploy");
  expect(crumbs).toEqual([]);
});

test("breadcrumbSegments: returns [] for empty path or root", () => {
  expect(breadcrumbSegments("", "/home/deploy")).toEqual([]);
  expect(breadcrumbSegments("/home/deploy/foo", "")).toEqual([]);
});

// --- createFile ---

test("createFile PUTs /api/files/content with {path, content:''} and reloads", async () => {
  const fetchCalls = [];
  const fetchImpl = async (url, opts) => {
    fetchCalls.push({ url, opts });
    if (url.includes("/api/browse")) {
      return {
        ok: true,
        json: async () => ({ path: "/home/deploy", dirs: [], files: [] }),
      };
    }
    return { ok: true, json: async () => ({}) };
  };
  const promptImpl = (msg) => (msg.includes("File") ? "hello.txt" : null);

  const controller = new FileExplorerController({
    viewport: { innerWidth: 1280 },
    fetchImpl,
    promptImpl,
  });
  controller.openForWorkspace("ws-a", "/home/deploy");
  controller.store.setWorkspacePath("ws-a", "/home/deploy");

  await controller.createFile(null, null, "ws-a");

  const putCall = fetchCalls.find(
    (c) => c.url === "/api/files/content" && c.opts?.method === "PUT",
  );
  expect(putCall).toBeDefined();
  const body = JSON.parse(putCall.opts.body);
  expect(body.path).toBe("/home/deploy/hello.txt");
  expect(body.content).toBe("");

  // A browse reload must have followed
  const browseCall = fetchCalls.find((c) => c.url?.includes("/api/browse"));
  expect(browseCall).toBeDefined();
});

test("createFile no-ops when this.disposed", async () => {
  const fetchCalls = [];
  const fetchImpl = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return { ok: true, json: async () => ({}) };
  };
  const controller = new FileExplorerController({
    viewport: { innerWidth: 1280 },
    fetchImpl,
    promptImpl: () => "file.txt",
  });
  controller.openForWorkspace("ws-a", "/home/deploy");
  controller.store.setWorkspacePath("ws-a", "/home/deploy");
  controller.dispose();

  const result = await controller.createFile(null, null, "ws-a");
  // fetchImpl may be called for the PUT but the reload must not happen because
  // disposed is checked after the response
  expect(result).toBe(false);
});

// --- renameItem ---

test("renameItem POSTs /api/files/rename with {from, to} in same dir and reloads", async () => {
  const fetchCalls = [];
  const fetchImpl = async (url, opts) => {
    fetchCalls.push({ url, opts });
    if (url.includes("/api/browse")) {
      return {
        ok: true,
        json: async () => ({ path: "/home/deploy", dirs: [], files: [] }),
      };
    }
    return { ok: true, json: async () => ({}) };
  };
  const promptImpl = () => "renamed.txt";

  const controller = new FileExplorerController({
    viewport: { innerWidth: 1280 },
    fetchImpl,
    promptImpl,
  });
  controller.openForWorkspace("ws-a", "/home/deploy");
  controller.store.setWorkspacePath("ws-a", "/home/deploy");

  const item = { path: "/home/deploy/old.txt", name: "old.txt", isDir: false };
  await controller.renameItem(item, "ws-a");

  const renameCall = fetchCalls.find(
    (c) => c.url === "/api/files/rename" && c.opts?.method === "POST",
  );
  expect(renameCall).toBeDefined();
  const body = JSON.parse(renameCall.opts.body);
  expect(body.from).toBe("/home/deploy/old.txt");
  expect(body.to).toBe("/home/deploy/renamed.txt");

  // A browse reload must follow
  const browseCall = fetchCalls.find((c) => c.url?.includes("/api/browse"));
  expect(browseCall).toBeDefined();
});

test("renameItem no-ops when this.disposed", async () => {
  const fetchCalls = [];
  const fetchImpl = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return { ok: true, json: async () => ({}) };
  };
  const controller = new FileExplorerController({
    viewport: { innerWidth: 1280 },
    fetchImpl,
    promptImpl: () => "newname.txt",
  });
  controller.openForWorkspace("ws-a", "/home/deploy");
  controller.store.setWorkspacePath("ws-a", "/home/deploy");
  controller.dispose();

  const item = { path: "/home/deploy/old.txt", name: "old.txt", isDir: false };
  const result = await controller.renameItem(item, "ws-a");
  expect(result).toBe(false);
});

// --- A4b: header × and footer Close both route through onRequestClose ---

test("both close buttons invoke onRequestClose when the host wires it", () => {
  withFakeDocument(() => {
    const { container, closeBtn, mobileCloseBtn } =
      makeCloseSkeletonContainer();
    const controller = new FileExplorerController({
      root: container,
      viewport: { innerWidth: 1280 },
    });
    controller.openForWorkspace("ws-a", "/tmp/workspace-a");
    expect(controller.isOpen).toBe(true);

    const calls = [];
    controller.onRequestClose = () => calls.push("requested");

    clickButton(closeBtn);
    clickButton(mobileCloseBtn);

    expect(calls).toEqual(["requested", "requested"]);
    // The chokepoint callback owns closing — the controller's own close()
    // (isOpen = false) must NOT have run as a side effect of the callback path.
    expect(controller.isOpen).toBe(true);
  });
});

test("both close buttons fall back to close() when no onRequestClose is injected", () => {
  withFakeDocument(() => {
    const { container, closeBtn, mobileCloseBtn } =
      makeCloseSkeletonContainer();
    const controller = new FileExplorerController({
      root: container,
      viewport: { innerWidth: 1280 },
    });
    controller.openForWorkspace("ws-a", "/tmp/workspace-a");
    expect(controller.isOpen).toBe(true);

    clickButton(closeBtn);
    expect(controller.isOpen).toBe(false);

    controller.openForWorkspace("ws-a", "/tmp/workspace-a");
    expect(controller.isOpen).toBe(true);

    clickButton(mobileCloseBtn);
    expect(controller.isOpen).toBe(false);
  });
});

// --- A5a: action icons never crush the filename ---

test("a file row has exactly one .file-actions with 4 buttons and an untruncated .file-name", () => {
  withFakeDocument(() => {
    const controller = new FileExplorerController({
      viewport: { innerWidth: 1280 },
    });
    controller.onOpenFile = () => {};

    const longName =
      "a-very-long-filename-that-must-never-be-crushed-by-action-icons.txt";
    const item = {
      name: longName,
      path: `/tmp/workspace-a/${longName}`,
      isDir: false,
      isParent: false,
      size: 1234,
    };
    const snapshot = {
      workspaceId: "ws-a",
      selectedItem: null,
      decorations: {},
      folderDecorations: {},
    };

    const row = controller.createItemElement(item, snapshot);

    expect(row.className).toBe("file-item");
    const actionsChildren = row.children.filter(
      (child) => child.className === "file-actions",
    );
    expect(actionsChildren.length).toBe(1);
    // edit (onOpenFile wired), download, rename, delete.
    expect(actionsChildren[0].children.length).toBe(4);

    const nameChild = row.children.find(
      (child) => child.className === "file-name",
    );
    expect(nameChild.textContent).toBe(longName);
  });
});
// --- Byte sizes ≥ 1 GiB render as gigabytes, not four-digit megabytes ---

test("the size cell shows GB for files of 1 GiB and up", () => {
  withFakeDocument(() => {
    const controller = new FileExplorerController({
      viewport: { innerWidth: 1280 },
    });
    const snapshot = {
      workspaceId: "ws-a",
      selectedItem: null,
      decorations: {},
      folderDecorations: {},
    };
    const sizeTextFor = (size, extra = {}) => {
      const row = controller.createItemElement(
        {
          name: "blob.bin",
          path: "/tmp/workspace-a/blob.bin",
          isDir: false,
          isParent: false,
          size,
          ...extra,
        },
        snapshot,
      );
      return row.children.find((child) => child.className === "file-size")
        .textContent;
    };

    // The regression: 1.5 GiB used to render as "1536.0 MB".
    expect(sizeTextFor(1536 * 1024 * 1024)).toBe("1.5 GB");
    expect(sizeTextFor(1024 * 1024 * 1024)).toBe("1.0 GB");
    // Smaller tiers are unchanged, and a missing/zero size stays blank.
    expect(sizeTextFor(1234)).toBe("1.2 KB");
    expect(sizeTextFor(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(sizeTextFor(0)).toBe("");
  });
});
