import { afterEach, test, expect } from "bun:test";
import { ActionRegistry } from "./action-registry";
import { CommandPaletteController } from "./command-palette";

function createClassList() {
  const classes = new Set();
  return {
    add(...tokens) {
      tokens.forEach((token) => classes.add(token));
    },
    remove(...tokens) {
      tokens.forEach((token) => classes.delete(token));
    },
    contains(token) {
      return classes.has(token);
    },
    setFromString(value) {
      classes.clear();
      String(value || "")
        .split(/\s+/)
        .filter(Boolean)
        .forEach((token) => classes.add(token));
    },
    toString() {
      return [...classes].join(" ");
    },
  };
}

function createFakeElement(tagName, ownerDocument) {
  const classList = createClassList();
  const listeners = new Map();
  const element = {
    tagName: String(tagName || "div").toUpperCase(),
    ownerDocument,
    children: [],
    dataset: {},
    style: {},
    value: "",
    textContent: "",
    type: "",
    parentNode: null,
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return this.attributes[name] ?? null;
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    scrollIntoView() {
      this.wasScrolledIntoView = true;
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    dispatchEvent(event) {
      const handlers = listeners.get(event.type) || [];
      handlers.forEach((handler) => handler(event));
      return true;
    },
    focus() {
      ownerDocument.activeElement = this;
    },
    querySelectorAll(selector) {
      const results = [];
      const matcher = selector.startsWith(".")
        ? (node) =>
            selector
              .slice(1)
              .split(".")
              .every((name) => node.classList.contains(name))
        : () => false;

      const walk = (node) => {
        if (matcher(node)) results.push(node);
        node.children.forEach(walk);
      };

      this.children.forEach(walk);
      return results;
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    classList,
  };

  Object.defineProperty(element, "className", {
    get() {
      return classList.toString();
    },
    set(value) {
      classList.setFromString(value);
    },
  });

  Object.defineProperty(element, "innerHTML", {
    get() {
      return "";
    },
    set(value) {
      if (value === "") {
        this.children = [];
        this.textContent = "";
      }
    },
  });

  return element;
}

function createFakeDocument() {
  const document = {
    activeElement: null,
    createElement(tagName) {
      return createFakeElement(tagName, document);
    },
  };
  document.body = createFakeElement("body", document);
  return document;
}

function createPaletteDom() {
  const document = createFakeDocument();
  globalThis.document = document;

  const root = document.createElement("div");
  root.className = "command-palette hidden";
  document.body.appendChild(root);

  const panel = document.createElement("div");
  panel.className = "command-palette-panel";
  root.appendChild(panel);

  const header = document.createElement("div");
  header.className = "command-palette-header";
  panel.appendChild(header);

  const input = document.createElement("input");
  input.id = "command-palette-input";
  header.appendChild(input);

  const results = document.createElement("div");
  results.id = "command-palette-results";
  results.className = "command-palette-results";
  panel.appendChild(results);

  const footer = document.createElement("div");
  footer.className = "command-palette-footer";
  panel.appendChild(footer);

  return { document, root, input, results };
}

function createRegistry(runLog = []) {
  const registry = new ActionRegistry();

  registry.register({
    id: "open-git",
    title: "Open Git",
    group: "Actions",
    run: () => runLog.push("open-git"),
  });

  registry.register({
    id: "open-file-manager",
    title: "Open File Manager",
    group: "Actions",
    run: () => runLog.push("open-file-manager"),
  });

  return registry;
}

afterEach(() => {
  delete globalThis.document;
});

test("open and close update hidden state and focus the input", () => {
  const dom = createPaletteDom();
  const controller = new CommandPaletteController({
    ...dom,
    registry: createRegistry(),
  });

  controller.open();

  expect(dom.root.classList.contains("hidden")).toBeFalse();
  expect(document.activeElement).toBe(dom.input);

  controller.close();

  expect(dom.root.classList.contains("hidden")).toBeTrue();
});

test("ArrowDown changes the selected item and Enter runs it", () => {
  const runLog = [];
  const dom = createPaletteDom();
  const controller = new CommandPaletteController({
    ...dom,
    registry: createRegistry(runLog),
  });

  controller.open();

  dom.input.dispatchEvent({
    type: "keydown",
    key: "ArrowDown",
    preventDefault() {},
  });
  dom.input.dispatchEvent({
    type: "keydown",
    key: "Enter",
    preventDefault() {},
  });

  expect(runLog).toEqual(["open-file-manager"]);
  expect(dom.root.classList.contains("hidden")).toBeTrue();
});

test("Escape closes the palette from the keyboard", () => {
  const dom = createPaletteDom();
  const controller = new CommandPaletteController({
    ...dom,
    registry: createRegistry(),
  });

  controller.open();
  dom.input.dispatchEvent({
    type: "keydown",
    key: "Escape",
    preventDefault() {},
  });

  expect(dom.root.classList.contains("hidden")).toBeTrue();
});

test("empty query renders default results", () => {
  const dom = createPaletteDom();
  const controller = new CommandPaletteController({
    ...dom,
    registry: createRegistry(),
  });

  controller.open();

  const resultItems = Array.from(
    dom.results.querySelectorAll(".command-palette-item-title"),
  ).map((node) => node.textContent?.trim());

  expect(resultItems).toEqual(["Open Git", "Open File Manager"]);
});

test("combobox exposes the selected option and clears it on empty results and close", () => {
  const dom = createPaletteDom();
  const controller = new CommandPaletteController({
    ...dom,
    registry: createRegistry(),
  });
  controller.open();
  expect(dom.input.getAttribute("role")).toBe("combobox");
  expect(dom.input.getAttribute("aria-controls")).toBe(dom.results.id);
  expect(dom.input.getAttribute("aria-expanded")).toBe("true");
  controller.moveSelection(1);
  const options = dom.results.querySelectorAll(".command-palette-item");
  expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual(
    ["false", "true"],
  );
  expect(options[1].getAttribute("role")).toBe("option");
  expect(options[1].tabIndex).toBe(-1);
  expect(dom.input.getAttribute("aria-activedescendant")).toBe(options[1].id);
  expect(options[1].wasScrolledIntoView).toBe(true);
  expect(dom.document.activeElement).toBe(dom.input);
  controller.setQuery("does not exist");
  expect(dom.input.getAttribute("aria-activedescendant")).toBeNull();
  controller.close();
  expect(dom.input.getAttribute("aria-expanded")).toBe("false");
});

test("arrow navigation follows visual group order and Tab stays inside the modal", () => {
  const dom = createPaletteDom();
  const runLog = [];
  const registry = {
    getResults: () => [
      {
        id: "workspace",
        title: "Workspace",
        group: "Workspaces",
        run: () => runLog.push("workspace"),
      },
      {
        id: "file",
        title: "File",
        group: "Files",
        run: () => runLog.push("file"),
      },
    ],
  };
  const controller = new CommandPaletteController({ ...dom, registry });
  controller.open();
  expect(
    dom.results
      .querySelectorAll(".command-palette-item-title")
      .map((node) => node.textContent),
  ).toEqual(["File", "Workspace"]);
  expect(controller.visibleResults.map((result) => result.id)).toEqual([
    "file",
    "workspace",
  ]);
  let prevented = false;
  let stopped = false;
  controller.handleKeydown({
    key: "Tab",
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {
      stopped = true;
    },
  });
  expect(prevented && stopped).toBe(true);
  expect(dom.document.activeElement).toBe(dom.input);
  controller.handleKeydown({
    key: "Enter",
    preventDefault() {},
    stopPropagation() {},
  });
  expect(runLog).toEqual(["file"]);
});

test("IME Enter does not execute a command", () => {
  const dom = createPaletteDom();
  const runLog = [];
  const controller = new CommandPaletteController({
    ...dom,
    registry: createRegistry(runLog),
  });
  controller.open();
  controller.handleKeydown({
    key: "Enter",
    isComposing: true,
    preventDefault() {},
  });
  expect(runLog).toEqual([]);
  expect(dom.root.classList.contains("hidden")).toBe(false);
});

test("commands that leave focus in the palette return focus to their opener", () => {
  const dom = createPaletteDom();
  const opener = dom.document.createElement("button");
  dom.document.body.appendChild(opener);
  opener.focus();
  const runLog = [];
  const controller = new CommandPaletteController({
    ...dom,
    registry: createRegistry(runLog),
  });
  controller.open();
  controller.runSelected();
  expect(runLog).toEqual(["open-git"]);
  expect(dom.document.activeElement).toBe(opener);
  expect(dom.root.classList.contains("hidden")).toBe(true);
});

test("command focus destinations win both synchronously and after an await", async () => {
  const dom = createPaletteDom();
  const opener = dom.document.createElement("button");
  const destination = dom.document.createElement("input");
  dom.document.body.appendChild(opener);
  dom.document.body.appendChild(destination);
  let asynchronous = false;
  const controller = new CommandPaletteController({
    ...dom,
    registry: {
      getResults: () => [
        {
          id: "focus",
          title: "Focus editor",
          run: () => {
            if (asynchronous)
              return Promise.resolve().then(() => destination.focus());
            destination.focus();
          },
        },
      ],
    },
  });
  opener.focus();
  controller.open();
  controller.runSelected();
  expect(dom.document.activeElement).toBe(destination);
  asynchronous = true;
  opener.focus();
  controller.open();
  controller.runSelected();
  expect(dom.document.activeElement).toBe(opener);
  await Promise.resolve();
  expect(dom.document.activeElement).toBe(destination);
});
