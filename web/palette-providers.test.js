import { test, expect } from "bun:test";
import {
  parsePrefixQuery,
  filterSessions,
  createSavedCommandsStore,
  filterSavedCommands,
  fuzzyScoreFilePath,
  filterQuickOpenFiles,
  matchPositions,
  highlightSegments,
  truncatePathMiddle,
  splitFilePath,
  describePaletteSession,
  createPaletteMruStore,
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

// --- fuzzyScoreFilePath ------------------------------------------------------

test("fuzzyScoreFilePath returns null when the query is not a subsequence", () => {
  expect(fuzzyScoreFilePath("xyz", "web/app.js")).toBe(null);
  expect(fuzzyScoreFilePath("zzz", "backend/server.ts")).toBe(null);
});

test("fuzzyScoreFilePath matches a scattered subsequence across path segments", () => {
  // "wapjs" is a subsequence of "web/app.js" (w-e-b-a-p-p-.-j-s).
  expect(fuzzyScoreFilePath("wapjs", "web/app.js")).not.toBe(null);
  expect(fuzzyScoreFilePath("wapjs", "web/app.js")).toBeGreaterThan(0);
});

test("fuzzyScoreFilePath treats an empty query as a neutral match (score 0)", () => {
  expect(fuzzyScoreFilePath("", "web/app.js")).toBe(0);
  expect(fuzzyScoreFilePath("   ", "web/app.js")).toBe(0);
});

test("fuzzyScoreFilePath is case-insensitive", () => {
  expect(fuzzyScoreFilePath("APP", "web/app.js")).toBe(
    fuzzyScoreFilePath("app", "web/app.js"),
  );
});

test("fuzzyScoreFilePath scores a basename match higher than the same query scattered through a longer directory prefix", () => {
  const basenameScore = fuzzyScoreFilePath("app", "web/app.js");
  const directoryScore = fuzzyScoreFilePath(
    "app",
    "app/some/other/place/index.js",
  );
  // "app" hits the basename in the first path (bonus'd); in the second it only
  // matches inside a leading directory segment, no basename bonus.
  expect(basenameScore).toBeGreaterThan(0);
  expect(directoryScore).toBeGreaterThan(0);
});

test("fuzzyScoreFilePath prefers consecutive characters over the same letters scattered apart", () => {
  // Both hit the basename after "/" with the same boundary shape (a right
  // after "/", p/p not right after a boundary char) — the only difference is
  // that "app" is consecutive in the first and split by filler "x"s in the
  // second, isolating the consecutive-run bonus.
  const consecutive = fuzzyScoreFilePath("app", "web/app.js");
  const scattered = fuzzyScoreFilePath("app", "web/axpxp.js");
  expect(consecutive).toBeGreaterThan(scattered);
});

test("fuzzyScoreFilePath prefers a boundary match (after / or _ or -) over a mid-word match", () => {
  const boundary = fuzzyScoreFilePath("tabs", "editor-tabs.js");
  const midword = fuzzyScoreFilePath("tabs", "editortabsxxxx.js");
  expect(boundary).toBeGreaterThan(midword);
});

// --- filterQuickOpenFiles ----------------------------------------------------

const filesFixture = [
  { path: "/root/web/app.js", relativePath: "web/app.js" },
  { path: "/root/web/editor-tabs.js", relativePath: "web/editor-tabs.js" },
  { path: "/root/backend/server.ts", relativePath: "backend/server.ts" },
  {
    path: "/root/backend/task-runner.ts",
    relativePath: "backend/task-runner.ts",
  },
];

test("filterQuickOpenFiles returns only files whose relativePath matches, best score first", () => {
  const results = filterQuickOpenFiles("apjs", filesFixture);
  expect(results.map((f) => f.relativePath)).toEqual(["web/app.js"]);
});

test("filterQuickOpenFiles with an empty query returns the input capped at the limit, order preserved", () => {
  const results = filterQuickOpenFiles("", filesFixture, 2);
  expect(results.length).toBe(2);
  expect(results).toEqual(filesFixture.slice(0, 2));
});

test("filterQuickOpenFiles returns an empty array when nothing matches", () => {
  expect(filterQuickOpenFiles("zzzzz", filesFixture)).toEqual([]);
});

test("filterQuickOpenFiles respects the limit and ranks a tighter/basename match above a looser one", () => {
  const results = filterQuickOpenFiles("server", filesFixture, 1);
  expect(results.length).toBe(1);
  expect(results[0].relativePath).toBe("backend/server.ts");
});

test("filterQuickOpenFiles tolerates a non-array input", () => {
  expect(filterQuickOpenFiles("app", null)).toEqual([]);
  expect(filterQuickOpenFiles("app", undefined)).toEqual([]);
});

test("filterSessions also matches the session name", () => {
  const out = filterSessions({
    sessions: [
      { id: "t-1", name: "api server", cwd: "/srv/a", status: "active" },
      { id: "t-2", cwd: "/srv/b", status: "active" },
    ],
    text: "api",
    isLocallyOpen: () => false,
    planAction,
  });
  expect(out.map((e) => e.session.id)).toEqual(["t-1"]);
});

// --- match highlighting -----------------------------------------------------

test("matchPositions prefers a contiguous match at a word start", () => {
  expect(matchPositions("git", "Open Git")).toEqual([5, 6, 7]);
  expect(matchPositions("GIT", "digit git")).toEqual([6, 7, 8]);
  expect(matchPositions("it", "digit")).toEqual([3, 4]);
});

test("matchPositions falls back to a subsequence and returns null on no match", () => {
  expect(matchPositions("ogt", "Open Git")).toEqual([0, 5, 7]);
  expect(matchPositions("xyz", "Open Git")).toBe(null);
  expect(matchPositions("", "Open Git")).toEqual([]);
  expect(matchPositions("  ", "Open Git")).toEqual([]);
});

test("highlightSegments merges consecutive matched characters", () => {
  expect(highlightSegments("Open Git", [5, 6, 7])).toEqual([
    { text: "Open ", match: false },
    { text: "Git", match: true },
  ]);
  expect(highlightSegments("abc", [0, 2])).toEqual([
    { text: "a", match: true },
    { text: "b", match: false },
    { text: "c", match: true },
  ]);
  expect(highlightSegments("abc", null)).toEqual([
    { text: "abc", match: false },
  ]);
});

// --- path presentation ------------------------------------------------------

test("truncatePathMiddle keeps short paths and the tail of long ones", () => {
  expect(truncatePathMiddle("/home/deploy/app", 40)).toBe("/home/deploy/app");
  expect(
    truncatePathMiddle("/home/deploy/llama.cpp/models/templates/x.jinja", 32),
  ).toBe("/home/…/models/templates/x.jinja");
  const long = truncatePathMiddle(`/${"a".repeat(80)}`, 20);
  expect(long.length).toBe(20);
  expect(long).toContain("…");
  expect(truncatePathMiddle("", 20)).toBe("");
});

test("splitFilePath separates the basename from its directory", () => {
  expect(splitFilePath("web/app.js")).toEqual({ dir: "web", base: "app.js" });
  expect(splitFilePath("README.md")).toEqual({ dir: "", base: "README.md" });
});

test("describePaletteSession never shows the raw session id", () => {
  const id = "b540c3ae-6a12-4210-9ba8-dd4d2559128d";
  const described = describePaletteSession(
    {
      id,
      cwd: "/home/deploy/deckterm_dev",
      agentName: "claude",
      agentState: "thinking",
    },
    { kind: "focus", label: "Focus", statusClass: "active" },
  );
  expect(described.title).toBe("deckterm_dev");
  expect(described.detail).toBe("claude · thinking · /home/deploy/deckterm_dev");
  expect(described.hint).toBe("Focus");
  expect(JSON.stringify(described)).not.toContain(id);

  const named = describePaletteSession(
    { id, name: "api", cwd: "/srv/api", running: true },
    { kind: "attach", label: "Attach", statusClass: "active" },
  );
  expect(named.title).toBe("api");
  expect(named.detail).toBe("running · /srv/api");

  const ended = describePaletteSession(
    { id, cwd: "" },
    { kind: "open-here", label: "Open here", statusClass: "ended" },
  );
  expect(ended.title).toBe("Terminal");
  expect(ended.detail).toBe("ended");
});

// --- MRU --------------------------------------------------------------------

test("MRU store keeps most recent first, dedupes and caps each kind", () => {
  const storage = makeStorage();
  const mru = createPaletteMruStore(storage, { limit: 3 });
  mru.touch("files", "/a", 1);
  mru.touch("files", "/b", 2);
  mru.touch("files", "/a", 3);
  mru.touch("files", "/c", 4);
  mru.touch("files", "/d", 5);
  mru.touch("commands", "open-git", 6);
  expect(mru.list("files")).toEqual(["/d", "/c", "/a"]);
  expect(mru.rankOf("files", "/d")).toBe(0);
  expect(mru.rankOf("files", "/b")).toBe(-1);
  expect(createPaletteMruStore(storage).list("commands")).toEqual(["open-git"]);
});

test("MRU store survives corrupt storage and ignores blank ids", () => {
  const storage = makeStorage({ "deckterm-palette-mru": "{not json" });
  const mru = createPaletteMruStore(storage);
  expect(mru.list("files")).toEqual([]);
  mru.touch("files", "", 1);
  expect(mru.list("files")).toEqual([]);
  const throwing = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
  };
  const safe = createPaletteMruStore(throwing);
  safe.touch("files", "/a", 1);
  expect(safe.list("files")).toEqual([]);
});

test("filterQuickOpenFiles ranks recently opened files above equal matches", () => {
  const files = [
    { path: "/r/src/alpha.js", relativePath: "src/alpha.js" },
    { path: "/r/lib/alpha.js", relativePath: "lib/alpha.js" },
  ];
  const plain = filterQuickOpenFiles("alpha", files, 10);
  expect(plain[0].relativePath).toBe("lib/alpha.js");
  const boosted = filterQuickOpenFiles("alpha", files, 10, {
    mruRank: (file) => (file.path === "/r/src/alpha.js" ? 0 : -1),
  });
  expect(boosted[0].relativePath).toBe("src/alpha.js");
});
