import { describe, expect, test } from "bun:test";
import {
  ALLOWED_ROOTS_SETTING,
  GRANTED_ROOTS_SETTING,
  forbiddenRootDetail,
  isLexicallyWithinRoots,
  rejectedPathMayBeMissing,
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

describe("rejectedPathMayBeMissing", () => {
  const roots = ["/home/u", "/srv/data"];

  function statSpy(existing: string[]) {
    const calls: string[] = [];
    const stat = async (path: string) => {
      calls.push(path);
      if (!existing.includes(path)) throw new Error("ENOENT");
    };
    return { calls, stat };
  }

  test("lexical containment honours segment boundaries and normalises ..", () => {
    expect(isLexicallyWithinRoots("/home/u", roots)).toBe(true);
    expect(isLexicallyWithinRoots("/home/u/a/b", roots)).toBe(true);
    expect(isLexicallyWithinRoots("/home/user2/x", roots)).toBe(false);
    expect(isLexicallyWithinRoots("/home/u/../other/x", roots)).toBe(false);
    expect(isLexicallyWithinRoots("/etc/passwd", roots)).toBe(false);
    expect(isLexicallyWithinRoots("/x", ["/"])).toBe(true);
  });

  test("outside the roots it never stats, so existence is not an oracle", async () => {
    const { calls, stat } = statSpy(["/etc/passwd"]);
    // Missing and existing outside paths give the SAME answer.
    expect(
      await rejectedPathMayBeMissing("/home/other/.ssh/id_ed25519", roots, stat),
    ).toBe(false);
    expect(await rejectedPathMayBeMissing("/etc/passwd", roots, stat)).toBe(
      false,
    );
    expect(
      await rejectedPathMayBeMissing("/home/u/../other/nope", roots, stat),
    ).toBe(false);
    expect(calls).toEqual([]);
  });

  test("inside a root, a missing path may be missing; an existing one (symlink escape) is not", async () => {
    const { calls, stat } = statSpy(["/home/u/link-out"]);
    expect(await rejectedPathMayBeMissing("/home/u/gone.txt", roots, stat)).toBe(
      true,
    );
    expect(await rejectedPathMayBeMissing("/home/u/link-out", roots, stat)).toBe(
      false,
    );
    expect(calls).toEqual(["/home/u/gone.txt", "/home/u/link-out"]);
  });

  test("an empty or non-string path is never reported as missing", async () => {
    const { calls, stat } = statSpy([]);
    expect(await rejectedPathMayBeMissing("", roots, stat)).toBe(false);
    expect(
      await rejectedPathMayBeMissing(undefined as unknown as string, roots, stat),
    ).toBe(false);
    expect(calls).toEqual([]);
  });
});
