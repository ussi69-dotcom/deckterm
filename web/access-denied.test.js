import { test, expect } from "bun:test";
import { describeAccessDenied } from "./access-denied";

test("no_matching_root explains the path and offers Setup", () => {
  const out = describeAccessDenied({
    error: "Forbidden path (no matching registered root)",
    reason: "no_matching_root",
    path: "/srv/elsewhere",
  });
  expect(out.showSetupCta).toBe(true);
  expect(out.text).toContain("/srv/elsewhere");
  expect(out.text.toLowerCase()).toContain("root");
});

test("no_matching_root without a path still explains", () => {
  const out = describeAccessDenied({
    error: "Forbidden path",
    reason: "no_matching_root",
  });
  expect(out.showSetupCta).toBe(true);
  expect(out.text.toLowerCase()).toContain("registered");
});

test("bootstrap_required points at finishing setup", () => {
  const out = describeAccessDenied({
    error: "DeckTerm bootstrap required",
    reason: "bootstrap_required",
  });
  expect(out.showSetupCta).toBe(true);
  expect(out.text.toLowerCase()).toContain("bootstrap");
});

test("missing_capability names the grant and resource", () => {
  const out = describeAccessDenied({
    error: "DeckTerm capability denied",
    reason: "missing_capability",
    capability: "root.use",
    resourceType: "root",
    resourceId: "root-7",
  });
  expect(out.showSetupCta).toBe(true);
  expect(out.text).toContain("root.use");
  expect(out.text).toContain("root-7");
});

test("non-access payloads return null so callers keep their own formatting", () => {
  expect(describeAccessDenied({ error: "nothing to commit" })).toBe(null);
  expect(describeAccessDenied(null)).toBe(null);
  expect(describeAccessDenied({ reason: "weird_unknown" })).toBe(null);
});
