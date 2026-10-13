import { test, expect } from "bun:test";
import { ActionRegistry } from "./action-registry";

test("registers static actions and returns title matches", () => {
  const registry = new ActionRegistry();

  registry.register({
    id: "open-git",
    title: "Open Git",
    group: "Actions",
    keywords: ["repo", "branch"],
    run: () => {},
  });

  const results = registry.getResults("git");

  expect(results).toHaveLength(1);
  expect(results[0]?.id).toBe("open-git");
  expect(results[0]?.group).toBe("Actions");
});

test("deduplicates repeated action ids across static and provider results", () => {
  const registry = new ActionRegistry();

  registry.register({
    id: "open-git",
    title: "Open Git",
    group: "Actions",
    run: () => {},
  });

  registry.register({
    id: "open-git",
    title: "Open Git Duplicate",
    group: "Actions",
    run: () => {},
  });

  registry.registerProvider(() => [
    {
      id: "open-git",
      title: "Provider Git Duplicate",
      group: "Actions",
      run: () => {},
    },
  ]);

  const results = registry.getResults("git");

  expect(results).toHaveLength(1);
  expect(results[0]?.title).toBe("Open Git");
});

test("filters on keywords as well as title text", () => {
  const registry = new ActionRegistry();

  registry.register({
    id: "open-files",
    title: "Open File Manager",
    group: "Actions",
    keywords: ["explorer", "files"],
    run: () => {},
  });

  const results = registry.getResults("explorer");

  expect(results).toHaveLength(1);
  expect(results[0]?.id).toBe("open-files");
});

test("sorts exact prefix matches before looser matches and groups results by section", () => {
  const registry = new ActionRegistry();

  registry.register({
    id: "workspace",
    title: "deckterm_dev",
    group: "Workspaces",
    run: () => {},
  });

  registry.register({
    id: "git-open-secondary",
    title: "Git Open in History",
    group: "Actions",
    run: () => {},
  });

  registry.register({
    id: "open-git",
    title: "Open Git",
    group: "Actions",
    run: () => {},
  });

  const filtered = registry.getResults("open");

  expect(filtered.map((result) => result.id)).toEqual([
    "open-git",
    "git-open-secondary",
  ]);

  const grouped = registry.getResults("");

  expect(grouped.map((result) => result.group)).toEqual([
    "Actions",
    "Actions",
    "Workspaces",
  ]);
});

test("passes icon and keybinding display metadata through to results", () => {
  const registry = new ActionRegistry();
  registry.register({
    id: "new-terminal",
    title: "New Terminal",
    group: "Actions",
    icon: "square-terminal",
    keybinding: "Ctrl+N",
    run: () => {},
  });
  registry.registerProvider(() => [
    { id: "plain", title: "Plain", group: "Actions", run: () => {} },
  ]);

  const [first, second] = registry.getResults("");
  expect(first.icon).toBe("square-terminal");
  expect(first.keybinding).toBe("Ctrl+N");
  expect(second.icon).toBeNull();
  expect(second.keybinding).toBeNull();
});

test("passes a one-line description through to results", () => {
  const registry = new ActionRegistry();
  registry.register({
    id: "open-tasks",
    title: "Open Tasks",
    group: "Actions",
    description: "  Give an agent a job  ",
    run: () => {},
  });
  registry.register({ id: "plain", title: "Plain", run: () => {} });

  const results = registry.getResults("");
  expect(results.find((r) => r.id === "open-tasks").description).toBe(
    "Give an agent a job",
  );
  expect(results.find((r) => r.id === "plain").description).toBeNull();
});
