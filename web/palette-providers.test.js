import { test, expect } from "bun:test";
import {
  parsePrefixQuery,
  filterSessions,
  createSavedCommandsStore,
  filterSavedCommands,
} from "./palette-providers";

// --- parsePrefixQuery -------------------------------------------------------

test("parsePrefixQuery returns the text after a matching prefix", () => {
  expect(parsePrefixQuery("@dev", "@")).toBe("dev");
  expect(parsePrefixQuery("@ dev ", "@")).toBe("dev");
  expect(parsePrefixQuery("@", "@")).toBe("");
  expect(parsePrefixQuery("$logs", "$")).toBe("logs");
});

test("parsePrefixQuery returns null when the query is not in that mode", () => {
  expect(parsePrefixQuery("dev", "@")).toBe(null);
  expect(parsePrefixQuery("", "@")).toBe(null);
  expect(parsePrefixQuery("$x", "@")).toBe(null);
  expect(parsePrefixQuery(null, "@")).toBe(null);
});

// --- filterSessions ---------------------------------------------------------

const planAction = (session, { isLocallyOpen }) => {
  const live =
    session.sessionStatus !== "ended" && session.status !== "inactive";
  if (isLocallyOpen)
    return {
      kind: "focus",
      label: "Focus",
      statusClass: live ? "active" : "ended",
    };
  if (live) return { kind: "attach", label: "Attach", statusClass: "active" };
  return { kind: "open-here", label: "Open here", statusClass: "ended" };
};

const catalog = [
  { id: "t-aaa", cwd: "/home/deploy/projects/guide", status: "active" },
  { id: "t-bbb", cwd: "/home/deploy/deckterm_dev", status: "active" },
  { id: "t-ccc", cwd: "/home/deploy/old-thing", status: "inactive" },
];

test("filterSessions with empty text returns all sessions, open-first then live", () => {
  const out = filterSessions({
    sessions: catalog,
    text: "",
    isLocallyOpen: (id) => id === "t-bbb",
    planAction,
  });
  expect(out.map((e) => e.session.id)).toEqual(["t-bbb", "t-aaa", "t-ccc"]);
  expect(out[0].plan.kind).toBe("focus");
  expect(out[1].plan.kind).toBe("attach");
  expect(out[2].plan.kind).toBe("open-here");
});

test("filterSessions matches text against cwd and id, case-insensitive", () => {
  const byCwd = filterSessions({
    sessions: catalog,
    text: "GUIDE",
    isLocallyOpen: () => false,
    planAction,
  });
  expect(byCwd.map((e) => e.session.id)).toEqual(["t-aaa"]);

  const byId = filterSessions({
    sessions: catalog,
    text: "t-ccc",
    isLocallyOpen: () => false,
    planAction,
  });
  expect(byId.map((e) => e.session.id)).toEqual(["t-ccc"]);
});

// --- saved commands store ---------------------------------------------------

function makeStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v);
    },
    _data: data,
  };
}

test("saved commands store starts empty and persists saves as JSON", () => {
  const storage = makeStorage();
  const store = createSavedCommandsStore(storage);
  expect(store.list()).toEqual([]);

  store.save("deploy", "git push origin dev");
  store.save("logs", "journalctl -f");
  expect(store.list()).toEqual([
    { name: "deploy", command: "git push origin dev" },
    { name: "logs", command: "journalctl -f" },
  ]);

  const reloaded = createSavedCommandsStore(storage);
  expect(reloaded.list().length).toBe(2);
});

test("saving an existing name overwrites it; remove deletes it", () => {
  const store = createSavedCommandsStore(makeStorage());
  store.save("deploy", "old");
  store.save("deploy", "new");
  expect(store.list()).toEqual([{ name: "deploy", command: "new" }]);

  store.remove("deploy");
  expect(store.list()).toEqual([]);
});

test("save ignores blank input; corrupt storage JSON degrades to empty list", () => {
  const store = createSavedCommandsStore(makeStorage());
  store.save("", "x");
  store.save("  ", "x");
  store.save("name", "");
  expect(store.list()).toEqual([]);

  const corrupt = createSavedCommandsStore(
    makeStorage({ "deckterm-saved-commands": "{not json" }),
  );
  expect(corrupt.list()).toEqual([]);
});

// --- filterSavedCommands ----------------------------------------------------

test("filterSavedCommands matches name and command text", () => {
  const commands = [
    { name: "deploy", command: "git push origin dev" },
    { name: "logs", command: "journalctl --user -u deckterm-dev -f" },
  ];
  expect(filterSavedCommands(commands, "").length).toBe(2);
  expect(filterSavedCommands(commands, "dep").map((c) => c.name)).toEqual([
    "deploy",
  ]);
  expect(filterSavedCommands(commands, "journal").map((c) => c.name)).toEqual([
    "logs",
  ]);
  expect(filterSavedCommands(commands, "zzz")).toEqual([]);
});
