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
function makeNodeStub(tagName = "div") {
  const node = {
    tagName: tagName.toUpperCase(),
    dataset: {},
    children: [],
    attrs: {},
    _listeners: {},
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
    setAttribute(key, value) {
      this.attrs[key] = value;
    },
    addEventListener(type, handler) {
      (this._listeners[type] ||= []).push(handler);
    },
    removeEventListener() {},
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    contains(child) {
      return (
        child === this || this.children.some((entry) => entry.contains?.(child))
      );
    },
    closest(selector) {
      if (
        selector.startsWith(".") &&
        this.classList.contains(selector.slice(1))
      )
        return this;
      return this.parentNode?.closest?.(selector) || null;
    },
    querySelectorAll(selector) {
      const matches = (entry) =>
        selector.startsWith(".")
          ? entry.classList?.contains(selector.slice(1))
          : entry.tagName === selector.toUpperCase();
      const found = [];
      const walk = (entry) => {
        for (const child of entry.children || []) {
          if (matches(child)) found.push(child);
          walk(child);
        }
      };
      walk(this);
      return found;
    },
    focus() {
      globalThis.document.activeElement = this;
      for (const handler of this._listeners.focus || [])
        handler({ target: this });
    },
  };
  Object.defineProperty(node, "className", {
    get() {
      return [...this.classList._set].join(" ");
    },
    set(value) {
      this.classList._set = new Set(String(value).split(/\s+/).filter(Boolean));
    },
  });
  Object.defineProperty(node, "innerHTML", {
    get() {
      return "";
    },
    set() {
      if (this.contains(globalThis.document?.activeElement))
        globalThis.document.activeElement = globalThis.document.body;
      for (const child of this.children) child.parentNode = null;
      this.children = [];
    },
  });
  return node;
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
  let asynchronous = false;
  const restore = () => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  };
  globalThis.document = {
    getElementById() {
      return null;
    },
    createElement(tagName) {
      return makeNodeStub(tagName);
    },
    createTextNode(text) {
      return { textContent: text };
    },
  };
  try {
    const result = run();
    if (result && typeof result.then === "function") {
      asynchronous = true;
      return result.finally(restore);
    }
    return result;
  } finally {
    if (!asynchronous) restore();
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

function interactiveExplorer() {
  document.body = makeNodeStub("body");
  const controller = new FileExplorerController();
  controller.listEl = makeNodeStub();
  controller.breadcrumbEl = makeNodeStub();
  document.body.appendChild(controller.listEl);
  document.body.appendChild(controller.breadcrumbEl);
  controller.openForWorkspace("keyboard-workspace", "/workspace");
  controller.setWorkspaceItems("keyboard-workspace", [
    { name: "alpha.txt", path: "/workspace/alpha.txt", isDir: false },
    { name: "beta.txt", path: "/workspace/beta.txt", isDir: false },
  ]);
  return controller;
}

function mobileExplorer() {
  const viewport = { innerWidth: 390 };
  document.body = makeNodeStub("body");
  const opener = makeNodeStub("button");
  opener.tabIndex = 0;
  document.body.appendChild(opener);
  const root = makeNodeStub();
  const shell = makeNodeStub("section");
  shell.ownerDocument = document;
  const first = makeNodeStub("button");
  const hidden = makeNodeStub("button");
  const last = makeNodeStub("button");
  for (const button of [first, hidden, last]) {
    button.tabIndex = 0;
    shell.appendChild(button);
  }
  hidden.hidden = true;
  shell.querySelectorAll = () => [first, hidden, last];
  root.appendChild(shell);
  document.body.appendChild(root);
  const controller = new FileExplorerController({ viewport });
  controller.root = root;
  controller.shellEl = shell;
  controller.backdropEl = makeNodeStub();
  controller.getDefaultOpener = () => opener;
  opener.focus();
  controller.openForWorkspace("mobile", "/workspace");
  return { controller, opener, first, last, viewport };
}

test("mobile Files focuses its controls, traps Tab, and closes through the host for Escape and backdrop", async () => {
  await withFakeDocument(async () => {
    const { controller, opener, first, last } = mobileExplorer();
    expect(document.activeElement).toBe(first);
    expect(controller.modalActive).toBe(true);
    let closes = 0;
    controller.onRequestClose = () => {
      closes += 1;
      controller.close();
    };
    controller.handleModalKeydown({
      key: "Tab",
      shiftKey: true,
      preventDefault() {},
      stopPropagation() {},
    });
    expect(document.activeElement).toBe(last);
    controller.handleModalKeydown({
      key: "Tab",
      shiftKey: false,
      preventDefault() {},
      stopPropagation() {},
    });
    expect(document.activeElement).toBe(first);
    controller.handleModalKeydown({
      key: "Escape",
      preventDefault() {},
      stopPropagation() {},
    });
    expect(closes).toBe(1);
    expect(controller.isOpen).toBe(false);
    await Promise.resolve();
    expect(document.activeElement).toBe(opener);
    controller.openForWorkspace("mobile", "/workspace");
    controller.handleBackdropClick({ target: controller.backdropEl });
    expect(closes).toBe(2);
    await Promise.resolve();
    expect(document.activeElement).toBe(opener);
  });
});

test("mobile focus return never steals another surface's focus and is disabled after desktop resize", async () => {
  await withFakeDocument(async () => {
    const { controller, opener, viewport } = mobileExplorer();
    const destination = makeNodeStub("button");
    document.body.appendChild(destination);
    controller.close();
    destination.focus();
    await Promise.resolve();
    expect(document.activeElement).toBe(destination);
    opener.focus();
    controller.openForWorkspace("mobile", "/workspace");
    viewport.innerWidth = 1280;
    controller.resize();
    expect(controller.modalActive).toBe(false);
    expect(controller.mode).toBe("docked");
    destination.focus();
    controller.close();
    await Promise.resolve();
    expect(document.activeElement).toBe(destination);
  });
});

test("file keyboard navigation keeps one entry point and retains the focused action after refresh", () => {
  withFakeDocument(() => {
    const controller = interactiveExplorer();
    let buttons = controller.listEl.querySelectorAll(".file-open");
    expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1]);
    buttons[0].focus();
    let prevented = false;
    const row = buttons[0].parentNode;
    for (const handler of row._listeners.keydown)
      handler({
        key: "ArrowDown",
        preventDefault() {
          prevented = true;
        },
        stopPropagation() {},
      });
    expect(prevented).toBe(true);
    expect(document.activeElement).toBe(buttons[1]);
    expect(buttons.map((button) => button.tabIndex)).toEqual([-1, 0]);
    const rename = buttons[1].parentNode
      .querySelectorAll("button")
      .find((button) => button.dataset.explorerAction === "rename");
    expect(rename.attrs["aria-label"]).toBe("Rename beta.txt");
    rename.focus();
    controller.renderList();
    expect(document.activeElement.dataset.explorerAction).toBe("rename");
    expect(document.activeElement.closest(".file-item").dataset.path).toBe(
      "/workspace/beta.txt",
    );
    buttons = controller.listEl.querySelectorAll(".file-open");
    expect(buttons.map((button) => button.tabIndex)).toEqual([-1, 0]);
  });
});

test("a directory refresh never steals focus from controls entered during loading", () => {
  withFakeDocument(() => {
    const controller = interactiveExplorer();
    controller.listEl.querySelectorAll(".file-open")[1].focus();
    controller.loading = true;
    controller.renderList();
    expect(document.activeElement).toBe(controller.listEl);
    const toolbar = makeNodeStub("button");
    document.body.appendChild(toolbar);
    toolbar.focus();
    controller.loading = false;
    controller.renderList();
    expect(document.activeElement).toBe(toolbar);
    expect(controller.pendingListFocus).toBeNull();
  });
});

test("breadcrumbs are named buttons and retain keyboard focus when rendered again", () => {
  withFakeDocument(() => {
    const controller = interactiveExplorer();
    controller.setWorkspacePath("keyboard-workspace", "/workspace/folder");
    const button = controller.breadcrumbEl.querySelectorAll("button")[0];
    expect(button.attrs["aria-label"]).toBe("Open folder workspace");
    button.focus();
    controller.renderBreadcrumb();
    expect(document.activeElement.dataset.path).toBe("/workspace");
    expect(document.activeElement.tagName).toBe("BUTTON");
  });
});

test("a delayed name adapter cannot write after the explorer is disposed", async () => {
  let resolveName;
  let writes = 0;
  const controller = new FileExplorerController({
    promptImpl: () =>
      new Promise((resolve) => {
        resolveName = resolve;
      }),
    fetchImpl: async () => {
      writes += 1;
      return { ok: true, json: async () => ({}) };
    },
  });
  controller.openForWorkspace("workspace", "/workspace");
  const pending = controller.createFolder();
  controller.dispose();
  resolveName("new-folder");
  expect(await pending).toBe(false);
  expect(writes).toBe(0);
});

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

test("createFile uses atomic createOnly and reloads", async () => {
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
  expect(body.createOnly).toBe(true);

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

    const nameChild = row.children.find((child) =>
      child.className?.split(" ").includes("file-name"),
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

const trashFixtureItem = {
  id: "trash_fixture_item",
  originalRelPath: "project/notes.txt",
  kind: "file",
  size: 7,
  deletedAt: "2026-09-01T00:00:00Z",
  expiresAt: "2026-10-01T00:00:00Z",
  status: "ready",
  expired: false,
};

function trashResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

function trashController(fetchImpl, confirmImpl = () => true) {
  const controller = new FileExplorerController({ fetchImpl, confirmImpl });
  controller.openForWorkspace("trash-workspace", "/allowed/project");
  return controller;
}

test("delete confirms a reversible move, keeps Undo after refresh, and restores using the server root", async () => {
  const calls = [];
  const confirmations = [];
  const controller = trashController(
    async (url, init) => {
      calls.push({ url, init });
      if (init?.method === "DELETE")
        return trashResponse({
          ok: true,
          root: "/allowed",
          trash: trashFixtureItem,
        });
      if (url === "/api/files/trash/restore")
        return trashResponse({ ok: true, path: "/allowed/project/notes.txt" });
      return trashResponse({ path: "/allowed/project", files: [], dirs: [] });
    },
    (message) => {
      confirmations.push(message);
      return true;
    },
  );
  expect(await controller.deleteItem("/allowed/project/notes.txt")).toBe(true);
  expect(confirmations[0]).toContain("Move file to Trash?");
  expect(controller.fileNotice.undo).toEqual({
    id: trashFixtureItem.id,
    root: "/allowed",
  });
  await controller.loadDir("/allowed/project");
  expect(controller.fileNotice.undo.id).toBe(trashFixtureItem.id);
  expect(await controller.undoDelete()).toBe(true);
  const restore = calls.find((call) => call.url === "/api/files/trash/restore");
  expect(JSON.parse(restore.init.body)).toEqual({
    root: "/allowed",
    id: trashFixtureItem.id,
  });
  expect(controller.fileNotice.message).toBe("Item restored from Trash.");
  expect(controller.fileNotice.undo).toBeUndefined();
});

test("failed Trash move never reports success or attempts a permanent fallback", async () => {
  const calls = [];
  const controller = trashController(async (url, init) => {
    calls.push({ url, init });
    return trashResponse({ error: "Trash helper unavailable" }, 503);
  });
  expect(await controller.deleteItem("/allowed/project/notes.txt")).toBe(false);
  expect(calls).toHaveLength(1);
  expect(calls[0].init.method).toBe("DELETE");
  expect(controller.fileNotice).toEqual({
    error: true,
    message: "Trash helper unavailable",
  });
  expect(controller.fileNotice.undo).toBeUndefined();
});

test("a legacy success without recoverable metadata is not presented as an undoable deletion", async () => {
  const controller = trashController(async () => trashResponse({ ok: true }));
  expect(await controller.deleteItem("/allowed/project/notes.txt")).toBe(false);
  expect(controller.fileNotice.error).toBe(true);
  expect(controller.fileNotice.undo).toBeUndefined();
});

test("a delete completing after navigation cannot reload the old path or show stale Undo", async () => {
  let complete;
  const calls = [];
  const controller = trashController((url) => {
    calls.push(url);
    return new Promise((resolve) => {
      complete = resolve;
    });
  });
  const pending = controller.deleteItem("/allowed/project/notes.txt");
  controller.setWorkspacePath("trash-workspace", "/allowed/other");
  complete(
    trashResponse({ ok: true, root: "/allowed", trash: trashFixtureItem }),
  );
  expect(await pending).toBe(false);
  expect(calls).toHaveLength(1);
  expect(controller.currentPath).toBe("/allowed/other");
  expect(controller.fileNotice).toBeNull();
});

test("opening Trash refetches persisted items and restores the list for its authorized root", async () => {
  let gets = 0;
  const calls = [];
  const controller = trashController(async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith("/api/files/trash?")) {
      gets += 1;
      return trashResponse({ root: "/allowed", items: [trashFixtureItem] });
    }
    if (url === "/api/files/trash/restore") return trashResponse({ ok: true });
    return trashResponse({
      path: "/allowed/project",
      files: [{ name: "notes.txt", size: 7 }],
      dirs: [],
    });
  });
  expect(await controller.openTrash()).toBe(true);
  controller.closeTrash();
  expect(await controller.openTrash()).toBe(true);
  expect(gets).toBe(2);
  const state = controller.trashDialog;
  expect(
    await controller.mutateTrashItem("restore", state.items[0], state),
  ).toBe(true);
  expect(state.items).toEqual([]);
  expect(
    controller
      .getWorkspaceItems("trash-workspace")
      .some((item) => item.name === "notes.txt"),
  ).toBe(true);
  expect(
    JSON.parse(
      calls.find((call) => call.url === "/api/files/trash/restore").init.body,
    ),
  ).toEqual({ root: "/allowed", id: trashFixtureItem.id });
});

test("restore collision keeps the Trash item and a retryable Undo with a visible explanation", async () => {
  const controller = trashController(async (url, init) => {
    if (init?.method === "DELETE")
      return trashResponse({ root: "/allowed", trash: trashFixtureItem });
    if (url === "/api/files/trash/restore")
      return trashResponse(
        { error: "Restore destination already exists" },
        409,
      );
    if (url.startsWith("/api/files/trash?"))
      return trashResponse({ root: "/allowed", items: [trashFixtureItem] });
    return trashResponse({ path: "/allowed/project", dirs: [], files: [] });
  });
  await controller.deleteItem("/allowed/project/notes.txt");
  expect(await controller.undoDelete()).toBe(false);
  expect(controller.fileNotice.undo.id).toBe(trashFixtureItem.id);
  expect(controller.fileNotice.busy).toBe(false);
  expect(controller.fileNotice.message).toContain("already exists");
  await controller.openTrash();
  const state = controller.trashDialog;
  expect(
    await controller.mutateTrashItem("restore", state.items[0], state),
  ).toBe(false);
  expect(state.items).toHaveLength(1);
  expect(state.error).toContain("already exists");
  expect(state.busy).toBe(false);
});

test("permanent deletion requires explicit confirmation and serializes duplicate actions", async () => {
  let allow = false;
  let complete;
  let purgeCalls = 0;
  const controller = trashController(
    (url) => {
      if (url.startsWith("/api/files/trash?"))
        return Promise.resolve(
          trashResponse({ root: "/allowed", items: [trashFixtureItem] }),
        );
      purgeCalls += 1;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
    (message) => {
      expect(message).toContain("This cannot be undone");
      return allow;
    },
  );
  await controller.openTrash();
  const state = controller.trashDialog;
  expect(
    await controller.mutateTrashItem("purge", trashFixtureItem, state),
  ).toBe(false);
  expect(purgeCalls).toBe(0);
  allow = true;
  const pending = controller.mutateTrashItem("purge", trashFixtureItem, state);
  expect(
    await controller.mutateTrashItem("purge", trashFixtureItem, state),
  ).toBe(false);
  expect(purgeCalls).toBe(1);
  complete(trashResponse({ ok: true }));
  expect(await pending).toBe(true);
  expect(state.items).toEqual([]);
});

test("closing or disposing Trash drops pending list results without resurrecting its dialog", async () => {
  let complete;
  const controller = trashController(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const first = controller.openTrash();
  controller.closeTrash();
  complete(trashResponse({ root: "/allowed", items: [trashFixtureItem] }));
  expect(await first).toBe(false);
  expect(controller.trashDialog).toBeNull();
  const second = controller.openTrash();
  controller.dispose();
  complete(trashResponse({ root: "/allowed", items: [trashFixtureItem] }));
  expect(await second).toBe(false);
  expect(controller.trashDialog).toBeNull();
});

test("Undo retains focus while restoring and after a retryable error", async () => {
  await withFakeDocument(async () => {
    document.body = makeNodeStub("body");
    let complete;
    const controller = trashController(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    controller.fileNoticeEl = makeNodeStub();
    document.body.appendChild(controller.fileNoticeEl);
    controller.fileNotice = {
      message: "Moved to Trash.",
      undo: { root: "/allowed", id: trashFixtureItem.id },
      context: controller.fileContext(),
    };
    controller.renderFileNotice();
    controller.fileNoticeEl.querySelectorAll("button")[0].focus();
    const pending = controller.undoDelete();
    expect(document.activeElement).toBe(
      controller.fileNoticeEl.querySelectorAll("button")[0],
    );
    expect(document.activeElement.attrs["aria-disabled"]).toBe("true");
    complete(
      trashResponse({ error: "Restore destination already exists" }, 409),
    );
    expect(await pending).toBe(false);
    expect(document.activeElement).toBe(
      controller.fileNoticeEl.querySelectorAll("button")[0],
    );
    expect(document.activeElement.attrs["aria-disabled"]).toBe("false");
  });
});

test("Undo completion does not steal focus from a new destination", async () => {
  await withFakeDocument(async () => {
    document.body = makeNodeStub("body");
    let complete;
    const controller = trashController(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    controller.loadDir = async () => null;
    controller.fileNoticeEl = makeNodeStub();
    document.body.appendChild(controller.fileNoticeEl);
    const target = makeNodeStub("button");
    document.body.appendChild(target);
    const row = makeNodeStub("button");
    controller.listEl = { querySelector: () => row };
    controller.fileNotice = {
      message: "Moved to Trash.",
      undo: { root: "/allowed", id: trashFixtureItem.id },
      context: controller.fileContext(),
    };
    controller.renderFileNotice();
    controller.fileNoticeEl.querySelectorAll("button")[0].focus();
    const pending = controller.undoDelete();
    target.focus();
    complete(trashResponse({ ok: true }));
    expect(await pending).toBe(true);
    expect(document.activeElement).toBe(target);
  });
});

for (const order of ["success-first", "failure-first"]) {
  test(`overlapping deletes refresh successful A while preserving B's error (${order})`, async () => {
    const pending = new Map();
    let browseCount = 0;
    let firstDeleted = false;
    const controller = trashController((url, init) => {
      if (init?.method === "DELETE") {
        return new Promise((resolve) => {
          pending.set(
            new URL(url, "http://localhost").searchParams.get("path"),
            resolve,
          );
        });
      }
      browseCount += 1;
      return Promise.resolve(
        trashResponse({
          path: "/allowed/project",
          dirs: [],
          files: firstDeleted
            ? [{ name: "second.txt", size: 8 }]
            : [
                { name: "first.txt", size: 7 },
                { name: "second.txt", size: 8 },
              ],
        }),
      );
    });
    controller.setWorkspaceItems("trash-workspace", [
      { name: "first.txt", path: "/allowed/project/first.txt", isDir: false },
      { name: "second.txt", path: "/allowed/project/second.txt", isDir: false },
    ]);
    const first = controller.deleteItem("/allowed/project/first.txt");
    const second = controller.deleteItem("/allowed/project/second.txt");
    const succeedFirst = async () => {
      firstDeleted = true;
      pending.get("/allowed/project/first.txt")(
        trashResponse({ root: "/allowed", trash: trashFixtureItem }),
      );
      expect(await first).toBe(true);
    };
    const failSecond = async () => {
      pending.get("/allowed/project/second.txt")(
        trashResponse({ error: "Second delete failed" }, 500),
      );
      expect(await second).toBe(false);
    };
    if (order === "success-first") {
      await succeedFirst();
      await failSecond();
    } else {
      await failSecond();
      await succeedFirst();
    }
    expect(browseCount).toBe(1);
    expect(
      controller
        .getWorkspaceItems("trash-workspace")
        .filter((item) => !item.isParent)
        .map((item) => item.name),
    ).toEqual(["second.txt"]);
    expect(controller.fileNotice).toEqual({
      error: true,
      message: "Second delete failed",
    });
  });
}

test("navigation away and back still invalidates an older successful delete", async () => {
  let complete;
  const calls = [];
  const controller = trashController((url) => {
    calls.push(url);
    return new Promise((resolve) => {
      complete = resolve;
    });
  });
  const pending = controller.deleteItem("/allowed/project/notes.txt");
  controller.setWorkspacePath("trash-workspace", "/allowed/other");
  controller.setWorkspacePath("trash-workspace", "/allowed/project");
  complete(trashResponse({ root: "/allowed", trash: trashFixtureItem }));
  expect(await pending).toBe(false);
  expect(calls).toHaveLength(1);
  expect(controller.fileNotice).toBeNull();
});

test("a completed restore still refreshes the current folder after closing Trash", async () => {
  let complete;
  let browseCount = 0;
  const controller = trashController((url) => {
    if (url.startsWith("/api/files/trash?"))
      return Promise.resolve(
        trashResponse({ root: "/allowed", items: [trashFixtureItem] }),
      );
    if (url === "/api/files/trash/restore")
      return new Promise((resolve) => {
        complete = resolve;
      });
    browseCount += 1;
    return Promise.resolve(
      trashResponse({
        path: "/allowed/project",
        dirs: [],
        files: [{ name: "notes.txt", size: 7 }],
      }),
    );
  });
  await controller.openTrash();
  const pending = controller.mutateTrashItem("restore", trashFixtureItem);
  controller.closeTrash();
  complete(trashResponse({ ok: true }));
  expect(await pending).toBe(true);
  expect(browseCount).toBe(1);
  expect(controller.trashDialog).toBeNull();
  expect(controller.fileNotice).toBeNull();
});

test("Trash rows show deletion and cleanup eligibility dates without a hard deletion deadline", () => {
  withFakeDocument(() => {
    document.body = makeNodeStub("body");
    const controller = trashController(async () => trashResponse({}));
    const state = {
      context: controller.fileContext(),
      root: "/allowed",
      items: [trashFixtureItem],
      dialog: makeNodeStub(),
      location: makeNodeStub(),
      statusEl: makeNodeStub(),
      errorEl: makeNodeStub(),
      listEl: makeNodeStub(),
      closeButton: makeNodeStub("button"),
      loading: false,
      message: "",
      error: "",
      busy: false,
    };
    controller.trashDialog = state;
    controller.renderTrashDialog(state);
    const detail = state.listEl.querySelectorAll(".file-trash-detail")[0];
    expect(detail.textContent).toContain(
      `Deleted ${new Date(trashFixtureItem.deletedAt).toLocaleString()}`,
    );
    expect(detail.textContent).toContain(
      `Eligible for cleanup from ${new Date(trashFixtureItem.expiresAt).toLocaleString()}`,
    );
    expect(detail.textContent).not.toContain("Deleted automatically");
  });
});

for (const operation of ["restore", "purge"]) {
  test(`reopening Trash during ${operation} blocks duplicates and refreshes after commit`, async () => {
    let finishMutation;
    let committed = false;
    let listCalls = 0;
    let mutationCalls = 0;
    const controller = trashController((url) => {
      if (url.startsWith("/api/files/trash?")) {
        listCalls += 1;
        return Promise.resolve(
          trashResponse({
            root: "/allowed",
            items: committed ? [] : [trashFixtureItem],
          }),
        );
      }
      if (url.startsWith("/api/files/trash/")) {
        mutationCalls += 1;
        return new Promise((resolve) => {
          finishMutation = resolve;
        });
      }
      return Promise.resolve(
        trashResponse({ path: "/allowed/project", dirs: [], files: [] }),
      );
    });
    await controller.openTrash();
    const firstState = controller.trashDialog;
    const pending = controller.mutateTrashItem(
      operation,
      trashFixtureItem,
      firstState,
    );
    controller.closeTrash();
    await controller.openTrash();
    const reopened = controller.trashDialog;
    expect(reopened).not.toBe(firstState);
    expect(reopened.items).toHaveLength(1);
    expect(
      await controller.mutateTrashItem("restore", trashFixtureItem, reopened),
    ).toBe(false);
    expect(
      await controller.mutateTrashItem("purge", trashFixtureItem, reopened),
    ).toBe(false);
    expect(mutationCalls).toBe(1);
    committed = true;
    finishMutation(trashResponse({ ok: true }));
    expect(await pending).toBe(true);
    expect(listCalls).toBe(3);
    expect(controller.trashDialog).toBe(reopened);
    expect(reopened.items).toEqual([]);
    expect(reopened.loading).toBe(false);
    expect(reopened.busy).toBe(false);
  });
}

test("a precommit Trash GET cannot overwrite the newer reconciliation response", async () => {
  let finishMutation;
  let finishOldList;
  let listCalls = 0;
  const controller = trashController((url) => {
    if (url.startsWith("/api/files/trash?")) {
      listCalls += 1;
      if (listCalls === 2)
        return new Promise((resolve) => {
          finishOldList = resolve;
        });
      return Promise.resolve(
        trashResponse({
          root: "/allowed",
          items: listCalls === 1 ? [trashFixtureItem] : [],
        }),
      );
    }
    return new Promise((resolve) => {
      finishMutation = resolve;
    });
  });
  await controller.openTrash();
  const pending = controller.mutateTrashItem("purge", trashFixtureItem);
  controller.closeTrash();
  const reopening = controller.openTrash();
  const reopened = controller.trashDialog;
  finishMutation(trashResponse({ ok: true }));
  expect(await pending).toBe(true);
  expect(reopened.items).toEqual([]);
  finishOldList(trashResponse({ root: "/allowed", items: [trashFixtureItem] }));
  expect(await reopening).toBe(false);
  expect(reopened.items).toEqual([]);
  expect(reopened.loading).toBe(false);
});

test("failed old mutation releases the item for retry from the reopened dialog", async () => {
  let finishMutation;
  let mutationCalls = 0;
  const controller = trashController((url) => {
    if (url.startsWith("/api/files/trash?"))
      return Promise.resolve(
        trashResponse({ root: "/allowed", items: [trashFixtureItem] }),
      );
    mutationCalls += 1;
    if (mutationCalls === 1)
      return new Promise((resolve) => {
        finishMutation = resolve;
      });
    return Promise.resolve(trashResponse({ ok: true }));
  });
  await controller.openTrash();
  const pending = controller.mutateTrashItem("purge", trashFixtureItem);
  controller.closeTrash();
  await controller.openTrash();
  finishMutation(trashResponse({ error: "Retry later" }, 503));
  expect(await pending).toBe(false);
  expect(await controller.mutateTrashItem("purge", trashFixtureItem)).toBe(
    true,
  );
  expect(mutationCalls).toBe(2);
  expect(controller.trashDialog.items).toEqual([]);
});

test("closing and disposing during post-mutation reconciliation cannot resurrect Trash", async () => {
  let finishMutation;
  let finishRefresh;
  let listCalls = 0;
  const controller = trashController((url) => {
    if (url.startsWith("/api/files/trash?")) {
      listCalls += 1;
      if (listCalls === 3)
        return new Promise((resolve) => {
          finishRefresh = resolve;
        });
      return Promise.resolve(
        trashResponse({ root: "/allowed", items: [trashFixtureItem] }),
      );
    }
    return new Promise((resolve) => {
      finishMutation = resolve;
    });
  });
  await controller.openTrash();
  const pending = controller.mutateTrashItem("purge", trashFixtureItem);
  controller.closeTrash();
  await controller.openTrash();
  finishMutation(trashResponse({ ok: true }));
  for (let turn = 0; turn < 6 && !finishRefresh; turn += 1)
    await Promise.resolve();
  expect(typeof finishRefresh).toBe("function");
  controller.dispose();
  finishRefresh(trashResponse({ root: "/allowed", items: [] }));
  expect(await pending).toBe(false);
  expect(controller.trashDialog).toBeNull();
});

test("Trash opened before a pending file deletion commits receives the new item", async () => {
  let complete;
  let deleted = false;
  let listCalls = 0;
  const controller = trashController((url, init) => {
    if (init?.method === "DELETE")
      return new Promise((resolve) => {
        complete = resolve;
      });
    if (url.startsWith("/api/files/trash?")) {
      listCalls += 1;
      return Promise.resolve(
        trashResponse({
          root: "/allowed",
          items: deleted ? [trashFixtureItem] : [],
        }),
      );
    }
    return Promise.resolve(
      trashResponse({ path: "/allowed/project", dirs: [], files: [] }),
    );
  });
  const pending = controller.deleteItem("/allowed/project/notes.txt");
  await controller.openTrash();
  const dialog = controller.trashDialog;
  expect(dialog.items).toEqual([]);
  deleted = true;
  complete(trashResponse({ root: "/allowed", trash: trashFixtureItem }));
  expect(await pending).toBe(true);
  expect(listCalls).toBe(2);
  expect(controller.trashDialog).toBe(dialog);
  expect(dialog.items.map((item) => item.id)).toEqual([trashFixtureItem.id]);
  expect(controller.fileNotice).toBeNull();
});
