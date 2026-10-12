import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hardenGitInvocation, isReadOnlyGitInvocation } from "./git-readonly";

describe("hardenGitInvocation", () => {
  test("read-only subcommands get fsmonitor/hooks off and no optional locks", () => {
    const out = hardenGitInvocation(["status", "--porcelain", "-uall", "-b"]);
    expect(out.argv).toEqual([
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "status",
      "--porcelain",
      "-uall",
      "-b",
    ]);
    expect(out.env).toEqual({ GIT_OPTIONAL_LOCKS: "0" });
    for (const sub of ["log", "ls-files", "diff-tree", "rev-parse"]) {
      expect(isReadOnlyGitInvocation([sub])).toBe(true);
    }
  });

  test("diff and show also disable external diff and textconv drivers", () => {
    expect(
      hardenGitInvocation(["diff", "--staged", "--color=never", "--", "a"]).argv,
    ).toEqual([
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--staged",
      "--color=never",
      "--",
      "a",
    ]);
    expect(hardenGitInvocation(["show", "HEAD:a.txt", "--"]).argv).toEqual([
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "show",
      "--no-ext-diff",
      "--no-textconv",
      "HEAD:a.txt",
      "--",
    ]);
  });

  test("writes keep the user's hooks (commit, push, pull, fetch, add, checkout)", () => {
    for (const args of [
      ["commit", "-m", "x"],
      ["push"],
      ["pull", "--ff-only"],
      ["fetch"],
      ["add", "--", "a"],
      ["checkout", "main", "--"],
      ["stash", "push"],
    ]) {
      const out = hardenGitInvocation(args);
      expect(out.argv).toEqual(args);
      expect(out.env).toEqual({});
    }
  });
});

const GIT_AVAILABLE = Boolean(Bun.which("git"));

describe("hardened git status in a hostile repository", () => {
  let repo: string;
  let marker: string;

  beforeAll(async () => {
    if (!GIT_AVAILABLE) return;
    repo = mkdtempSync(join(tmpdir(), "deckterm-git-ro-"));
    marker = join(repo, "..", `${repo.split("/").pop()}-pwned`);
    const env = {
      PATH: process.env.PATH || "/usr/bin:/bin",
      HOME: repo,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    };
    const run = async (args: string[]) => {
      const proc = Bun.spawn(["git", ...args], { cwd: repo, env });
      expect(await proc.exited).toBe(0);
    };
    await run(["init", "-q"]);
    writeFileSync(join(repo, "a.txt"), "a\n");
    await run(["add", "a.txt"]);
    await run([
      "-c",
      "user.email=t@example.test",
      "-c",
      "user.name=t",
      "commit",
      "-qm",
      "init",
    ]);
    const payload = `sh -c 'touch ${marker}'`;
    await run(["config", "core.fsmonitor", payload]);
    // Touch the file so status refreshes the index (post-index-change).
    writeFileSync(join(repo, "a.txt"), "a\n");
  });

  afterAll(() => {
    if (!GIT_AVAILABLE) return;
    rmSync(repo, { recursive: true, force: true });
    rmSync(marker, { force: true });
  });

  test.skipIf(!GIT_AVAILABLE)(
    "a repo-local core.fsmonitor command does not run",
    async () => {
      const { argv, env } = hardenGitInvocation([
        "status",
        "--porcelain",
        "-uall",
        "-b",
      ]);
      const proc = Bun.spawn(["git", ...argv], {
        cwd: repo,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: process.env.PATH || "/usr/bin:/bin",
          HOME: repo,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          ...env,
        },
      });
      expect(await proc.exited).toBe(0);
      expect(existsSync(marker)).toBe(false);
    },
  );
});
