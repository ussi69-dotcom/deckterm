import { describe, expect, test } from "bun:test";
import {
  ALLOWED_ROOTS_SETTING,
  GRANTED_ROOTS_SETTING,
  forbiddenRootDetail,
} from "./forbidden-root";

describe("forbiddenRootDetail", () => {
  test("terminal cwd outside the allowed roots names the path, the setting and the fix", () => {
    const out = forbiddenRootDetail({
      path: "/srv/elsewhere",
      subject: "terminal",
    });
    expect(out.path).toBe("/srv/elsewhere");
    expect(out.setting).toBe(ALLOWED_ROOTS_SETTING);
    expect(ALLOWED_ROOTS_SETTING).toBe("ALLOWED_FILE_ROOTS");
    expect(out.message).toContain('"/srv/elsewhere"');
    expect(out.message).toContain("ALLOWED_FILE_ROOTS");
    expect(out.message).toContain("terminal");
    expect(out.hint).toContain("ALLOWED_FILE_ROOTS");
    expect(out.hint.toLowerCase()).toContain("restart");
    // The full message carries the fix too, so a client that only shows
    // `message` still tells the user what to do.
    expect(out.message.endsWith(out.hint)).toBe(true);
  });

  test("file paths that may simply be missing say so instead of blaming the roots", () => {
    const out = forbiddenRootDetail({
      path: "/home/u/proj/gone.txt",
      subject: "path",
      mayBeMissing: true,
    });
    expect(out.message).toContain('"/home/u/proj/gone.txt"');
    expect(out.message).toContain("does not exist");
    expect(out.message).toContain("ALLOWED_FILE_ROOTS");
  });

  test("search and task project roots get their own lead-in", () => {
    expect(
      forbiddenRootDetail({ path: "/opt/x", subject: "search" }).message,
    ).toContain('Cannot search "/opt/x"');
    expect(
      forbiddenRootDetail({ path: "/opt/x", subject: "project" }).message,
    ).toContain('project root "/opt/x"');
  });

  test("granted-roots scope points at an admin grant, not the server env", () => {
    const out = forbiddenRootDetail({
      path: "/home/bob",
      subject: "path",
      scope: "granted",
    });
    expect(out.setting).toBe(GRANTED_ROOTS_SETTING);
    expect(out.message).toContain('"/home/bob"');
    expect(out.message).not.toContain("ALLOWED_FILE_ROOTS");
    expect(out.hint.toLowerCase()).toContain("admin");
    expect(out.hint).toContain("Setup");
  });

  test("a missing or non-string path still explains without naming a value", () => {
    const out = forbiddenRootDetail({ path: undefined, subject: "terminal" });
    expect(out.path).toBe(null);
    expect(out.message).not.toContain('""');
    expect(out.message).toContain("ALLOWED_FILE_ROOTS");
    expect(forbiddenRootDetail({ path: 42, subject: "path" }).path).toBe(null);
  });

  test("echoed paths are stripped of control characters and bounded", () => {
    const out = forbiddenRootDetail({
      path: "/tmp/a\u0000b\nc\u001b[31m",
      subject: "path",
    });
    expect(out.path).toBe("/tmp/abc[31m");
    const long = "/x".repeat(1000);
    const bounded = forbiddenRootDetail({ path: long, subject: "path" });
    expect(bounded.path!.length).toBeLessThanOrEqual(513);
    expect(bounded.path!.endsWith("…")).toBe(true);
  });
});
