import { test, expect } from "bun:test";
import {
  scmSections,
  scmTotalCount,
  scmDiffModeForSection,
} from "./git-scm-view.js";

test("scmSections returns the three groups in render order with files + actions", () => {
  const groups = {
    staged: [{ path: "a.js" }],
    changes: [{ path: "b.js" }, { path: "c.js" }],
    untracked: [{ path: "d.js" }],
  };
  const sections = scmSections(groups);
  expect(sections.map((s) => s.key)).toEqual([
    "staged",
    "changes",
    "untracked",
  ]);
  expect(sections[0].label).toBe("Staged Changes");
  expect(sections[0].groupAction).toBe("unstage-all");
  expect(sections[0].mode).toBe("staged");
  expect(sections[1].groupAction).toBe("stage-all");
  expect(sections[1].mode).toBe("working");
  expect(sections[2].mode).toBe("working");
  expect(sections[1].files).toHaveLength(2);
});

test("scmSections tolerates a missing / partial groups map", () => {
  expect(scmSections(undefined).every((s) => Array.isArray(s.files))).toBe(
    true,
  );
  expect(scmSections({}).every((s) => s.files.length === 0)).toBe(true);
  const partial = scmSections({ staged: [{ path: "x" }] });
  expect(partial[0].files).toHaveLength(1);
  expect(partial[1].files).toHaveLength(0);
});

test("scmTotalCount sums files across all groups", () => {
  expect(
    scmTotalCount({
      staged: [{ path: "a" }],
      changes: [{ path: "b" }, { path: "c" }],
      untracked: [],
    }),
  ).toBe(3);
  expect(scmTotalCount({})).toBe(0);
  expect(scmTotalCount(undefined)).toBe(0);
});

test("scmDiffModeForSection maps staged → staged, others → working", () => {
  expect(scmDiffModeForSection("staged")).toBe("staged");
  expect(scmDiffModeForSection("changes")).toBe("working");
  expect(scmDiffModeForSection("untracked")).toBe("working");
  expect(scmDiffModeForSection("whatever")).toBe("working");
});
