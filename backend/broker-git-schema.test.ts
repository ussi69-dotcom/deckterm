import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * B4-S2 broker git/search SCHEMA tests. These exercise the broker's pure argv
 * REBUILD logic (`build_git_argv` / `build_search_argv`) directly — no root, no
 * installed broker — by importing the broker script via a Python SourceFileLoader
 * and monkeypatching `die` to raise. So the injection-refusal matrix runs in CI
 * (the full end-to-end drop + fd-cwd path stays in the host-only broker-contract
 * suite). The guarantee under test: no caller token reaches git/grep unchecked;
 * every argv is rebuilt from the fixed schema (B4 §3/§4, invariant §8.5).
 */

const BROKER = join(
  import.meta.dir,
  "..",
  "scripts",
  "broker",
  "deckterm-broker",
);

// One python invocation runs the whole matrix and emits JSON: for each case,
// either {ok:true, argv:[...]} or {ok:false, reason:"..."}.
const DRIVER = `
import importlib.machinery, json, sys
b = importlib.machinery.SourceFileLoader('b', ${JSON.stringify(BROKER)}).load_module()
class Refused(Exception):
    pass
b.die = lambda reason, code=71: (_ for _ in ()).throw(Refused(reason))
cases = json.load(sys.stdin)
out = {}
for name, kind, ops in cases:
    try:
        if kind == 'git':
            argv = b.build_git_argv('/usr/bin/git', ops)
        else:
            argv = b.build_search_argv('/usr/bin/grep', ops, {
                'search_secret_excludes': ['.env', '*.pem'],
                'search_exclude_dirs': ['.git', 'node_modules'],
            })
        out[name] = {'ok': True, 'argv': argv}
    except Refused as e:
        out[name] = {'ok': False, 'reason': str(e)}
    except SystemExit as e:
        out[name] = {'ok': False, 'reason': 'exit:%s' % e}
sys.stdout.write(json.dumps(out))
`;

type Case = [string, "git" | "search", string[]];
type Result = { ok: boolean; argv?: string[]; reason?: string };

function runMatrix(cases: Case[]): Record<string, Result> {
  const proc = Bun.spawnSync(["python3", "-c", DRIVER], {
    stdin: Buffer.from(JSON.stringify(cases), "utf8"),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = new TextDecoder().decode(proc.stdout);
  try {
    return JSON.parse(out) as Record<string, Result>;
  } catch {
    throw new Error(
      `driver failed: ${new TextDecoder().decode(proc.stderr)} :: ${out}`,
    );
  }
}

const ACCEPT: Case[] = [
  ["status", "git", ["status", "--porcelain", "-uall", "-b"]],
  ["status_paths", "git", ["status", "--porcelain", "--", "a.txt"]],
  ["rev_parse", "git", ["rev-parse", "--show-toplevel"]],
  ["diff_staged", "git", ["diff", "--staged", "--color=never", "--", "x/y.ts"]],
  ["show_diffroute", "git", ["show", "--format=", "--color=never", "HEAD~1"]],
  ["show_file", "git", ["show", "HEAD:a.txt", "--"]],
  ["show_index", "git", ["show", ":0:a.txt", "--"]],
  [
    "diff_tree",
    "git",
    ["diff-tree", "--no-commit-id", "--name-status", "-r", "--root", "abc123"],
  ],
  ["add", "git", ["add", "--", "a.txt", "b/c.ts"]],
  ["restore_staged", "git", ["restore", "--staged", "--", "a.txt"]],
  ["restore_worktree", "git", ["restore", "--worktree", "--", "a.txt"]],
  ["commit", "git", ["commit", "-m", "hello world"]],
  ["commit_amend", "git", ["commit", "--amend", "-m", "m"]],
  ["branch_list", "git", ["branch", "-a", "--format=%(refname:short)"]],
  ["branch_create", "git", ["branch", "feature/x"]],
  ["branch_del", "git", ["branch", "-D", "feature/x"]],
  ["checkout", "git", ["checkout", "main", "--"]],
  ["checkout_b", "git", ["checkout", "-b", "feature/x"]],
  [
    "log",
    "git",
    ["log", "--max-count=50", "--format=%h|%H|%s|%an|%aI", "--graph"],
  ],
  [
    "log_path",
    "git",
    [
      "log",
      "--max-count=50",
      "--format=%h|%H|%s|%an|%aI",
      "--graph",
      "--",
      "a.txt",
    ],
  ],
  ["stash_list", "git", ["stash", "list", "--format=%gd%x09%s"]],
  ["stash_push", "git", ["stash", "push", "--include-untracked", "-m", "wip"]],
  ["stash_pop", "git", ["stash", "pop", "stash@{2}"]],
  ["clean", "git", ["clean", "-f", "--", "junk.txt"]],
  ["search_literal", "search", ["-F", "needle"]],
  ["search_regex", "search", ["-E", "foo.*bar"]],
];

const REFUSE: Case[] = [
  ["config_c", "git", ["-c", "core.pager=sh", "status"]],
  [
    "no_index",
    "git",
    ["diff", "--no-index", "--color=never", "--", "/dev/null", "/etc/passwd"],
  ],
  ["dash_path", "git", ["add", "--", "-rf"]],
  ["magic_pathspec", "git", ["add", "--", ":(top)/etc/x"]],
  ["escape_dotdot", "git", ["add", "--", "../x"]],
  [
    "upload_pack",
    "git",
    ["show", "--format=", "--color=never", "--upload-pack=sh"],
  ],
  ["checkout_dash", "git", ["checkout", "-hax", "--"]],
  [
    "bad_format",
    "git",
    ["log", "--max-count=5", "--format=%x(evil)", "--graph"],
  ],
  ["unknown_sub", "git", ["gc"]],
  ["exec_flag", "git", ["status", "--porcelain", "--exec=sh"]],
  ["status_no_porcelain", "git", ["status", "-b"]],
  [
    "log_huge_count",
    "git",
    ["log", "--max-count=999999999", "--format=%h|%H|%s|%an|%aI"],
  ],
  ["search_bad_flag", "search", ["-x", "pat"]],
  ["search_extra_arg", "search", ["-F", "a", "b"]],
];

describe("broker git/search schema — accepts canonical route argv", () => {
  const res = runMatrix(ACCEPT);
  for (const [name] of ACCEPT) {
    test(name, () => {
      expect(res[name]?.ok).toBe(true);
      // The rebuilt argv always starts with the tool binary; git carries the
      // fixed hardening -c options, never a caller-supplied -c.
      const argv = res[name]!.argv!;
      if (name.startsWith("search")) {
        expect(argv[0]).toBe("/usr/bin/grep");
        expect(argv).toContain("--exclude-dir=.git");
      } else {
        expect(argv.slice(0, 7)).toEqual([
          "/usr/bin/git",
          "-c",
          "core.pager=cat",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.hooksPath=/dev/null",
        ]);
        // A caller-supplied -c can never appear (schema rebuilds argv).
        const callerC = argv
          .slice(7)
          .some((a, idx, arr) => a === "-c" && arr[idx - 1] !== undefined);
        expect(callerC).toBe(false);
      }
    });
  }
});

describe("broker git/search schema — refuses injection / escape vectors", () => {
  const res = runMatrix(REFUSE);
  for (const [name] of REFUSE) {
    test(name, () => {
      expect(res[name]?.ok).toBe(false);
    });
  }
});
