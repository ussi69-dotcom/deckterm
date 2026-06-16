const { test, expect, describe } = require("bun:test");
const {
  EMPTY_TREE_SHA,
  relativeDate,
  buildTimelineEntries,
  revPairForCommit,
} = require("./git-timeline.js");

// Sample /api/git/log?path= response shape (newest first), per backend.
const LOG = [
  {
    hash: "aaaaaaa",
    fullHash: "aaaaaaa1111111111111111111111111111aaaa",
    message: "third change",
    author: "Alice",
    date: "2026-06-16T10:00:00Z",
    graph: "*",
  },
  {
    hash: "bbbbbbb",
    fullHash: "bbbbbbb2222222222222222222222222222bbbb",
    message: "second change",
    author: "Bob",
    date: "2026-06-10T10:00:00Z",
    graph: "*",
  },
  {
    hash: "ccccccc",
    fullHash: "ccccccc3333333333333333333333333333cccc",
    message: "add file",
    author: "Carol",
    date: "2026-06-01T10:00:00Z",
    graph: "*",
  },
];

describe("buildTimelineEntries", () => {
  test("maps commits to display rows with full + short hash", () => {
    const rows = buildTimelineEntries(LOG);
    expect(rows.length).toBe(3);
    expect(rows[0].hash).toBe(LOG[0].fullHash);
    expect(rows[0].shortHash).toBe("aaaaaaa");
    expect(rows[0].message).toBe("third change");
    expect(rows[0].author).toBe("Alice");
    expect(typeof rows[0].relativeDate).toBe("string");
  });

  test("only the last (oldest) entry is the root commit", () => {
    const rows = buildTimelineEntries(LOG);
    expect(rows[0].isRoot).toBe(false);
    expect(rows[1].isRoot).toBe(false);
    expect(rows[2].isRoot).toBe(true);
  });

  test("derives short hash from full hash when hash field missing", () => {
    const rows = buildTimelineEntries([
      { fullHash: "deadbeef0000000000000000000000000000beef", message: "x" },
    ]);
    expect(rows[0].shortHash).toBe("deadbee");
    expect(rows[0].hash).toBe("deadbeef0000000000000000000000000000beef");
  });

  test("handles empty / non-array input", () => {
    expect(buildTimelineEntries([])).toEqual([]);
    expect(buildTimelineEntries(null)).toEqual([]);
    expect(buildTimelineEntries(undefined)).toEqual([]);
  });
});

describe("revPairForCommit", () => {
  test("non-root commit diffs against the previous (older) revision", () => {
    const rows = buildTimelineEntries(LOG);
    const pair = revPairForCommit(rows[0], rows[0].isRoot, rows[1]);
    expect(pair.ref).toBe(LOG[0].fullHash);
    expect(pair.prevRef).toBe(LOG[1].fullHash);
  });

  test("root commit diffs against the empty tree", () => {
    const rows = buildTimelineEntries(LOG);
    const root = rows[2];
    expect(root.isRoot).toBe(true);
    const pair = revPairForCommit(root, root.isRoot, undefined);
    expect(pair.ref).toBe(LOG[2].fullHash);
    expect(pair.prevRef).toBe(EMPTY_TREE_SHA);
    expect(pair.prevRef).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  });

  test("never uses ~1 / ^ parent expressions (backend rejects them)", () => {
    const rows = buildTimelineEntries(LOG);
    for (let i = 0; i < rows.length; i++) {
      const pair = revPairForCommit(rows[i], rows[i].isRoot, rows[i + 1]);
      expect(pair.prevRef).not.toContain("~");
      expect(pair.prevRef).not.toContain("^");
    }
  });

  test("falls back to empty tree when prevCommit is missing on a non-root", () => {
    const pair = revPairForCommit({ hash: "abc1234" }, false, undefined);
    expect(pair.ref).toBe("abc1234");
    expect(pair.prevRef).toBe(EMPTY_TREE_SHA);
  });
});

describe("relativeDate", () => {
  test("empty / invalid input -> empty string", () => {
    expect(relativeDate("")).toBe("");
    expect(relativeDate(null)).toBe("");
    expect(relativeDate("not-a-date")).toBe("");
  });

  test("recent date -> today", () => {
    expect(relativeDate(new Date().toISOString())).toBe("today");
  });

  test("days / weeks / months ago", () => {
    const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
    expect(relativeDate(ago(1))).toBe("yesterday");
    expect(relativeDate(ago(3))).toBe("3d ago");
    expect(relativeDate(ago(14))).toBe("2w ago");
    expect(relativeDate(ago(60))).toBe("2mo ago");
  });
});
