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

test("no_matching_root shows the server's detail naming the path and setting", () => {
  const out = describeAccessDenied({
    error: "Forbidden path",
    reason: "no_matching_root",
    path: "/srv/elsewhere",
    setting: "ALLOWED_FILE_ROOTS",
    message:
      '"/srv/elsewhere" is outside the allowed roots (ALLOWED_FILE_ROOTS) or does not exist. Use a path inside an allowed root, or add the directory to ALLOWED_FILE_ROOTS in the DeckTerm service environment and restart DeckTerm.',
  });
  expect(out.showSetupCta).toBe(true);
  expect(out.text).toContain("/srv/elsewhere");
  expect(out.text).toContain("ALLOWED_FILE_ROOTS");
  expect(out.text.toLowerCase()).toContain("restart");
});

test("forbidden_root (terminal/search/task) is explained like no_matching_root", () => {
  const out = describeAccessDenied({
    error: "Forbidden terminal root",
    reason: "forbidden_root",
    path: "/opt/x",
    setting: "ALLOWED_FILE_ROOTS",
    message:
      'Cannot start a terminal in "/opt/x": it is outside the allowed roots (ALLOWED_FILE_ROOTS). Choose a directory inside an allowed root, or add the directory to ALLOWED_FILE_ROOTS in the DeckTerm service environment and restart DeckTerm.',
  });
  expect(out.showSetupCta).toBe(true);
  expect(out.text).toContain('"/opt/x"');
  expect(out.text).toContain("ALLOWED_FILE_ROOTS");

  const bare = describeAccessDenied({
    error: "Forbidden search root",
    reason: "forbidden_root",
  });
  expect(bare.showSetupCta).toBe(true);
  expect(bare.text.toLowerCase()).toContain("allowed root");
});

test("a server message without a setting is not trusted as the root explanation", () => {
  // foundation capability denials also carry a generic `message`; only the
  // root-detail payload (with `setting`) replaces the client wording.
  const out = describeAccessDenied({
    error: "Forbidden path",
    reason: "no_matching_root",
    path: "/srv/elsewhere",
    message: "something unrelated",
  });
  expect(out.text).not.toContain("something unrelated");
  expect(out.text).toContain("/srv/elsewhere");
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
