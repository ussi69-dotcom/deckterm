// Hardening for the read-only git invocations the git panel runs on the
// legacy (service-account) path: status, diff, log, ls-files and friends.
//
// A repository's own .git/config can name programs git runs during a plain
// read — core.fsmonitor, hooks (post-index-change fires when `git status`
// refreshes the index), external diff / textconv drivers. The git panel and
// the live-cwd follow run these reads in whatever directory a terminal
// enters, so an extracted archive with a hostile .git/config must not get
// code execution from them. This mirrors the broker's fixed git profile
// (scripts/broker/deckterm-broker build_git_argv), which already applies the
// same -c options to every brokered git call.
//
// Writes (commit, push, pull, fetch, checkout, add, …) are left alone: users
// rely on their hooks there. Clean/smudge filter drivers can still run during
// status; the frontend only refreshes git while the panel is visible.

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "diff-tree",
  "log",
  "ls-files",
  "show",
  "rev-parse",
]);

// Subcommands that can render a content diff (and so run diff drivers).
const DIFF_RENDERING_SUBCOMMANDS = new Set(["diff", "show"]);

const READ_ONLY_GIT_CONFIG = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
];

export function isReadOnlyGitInvocation(args: string[]): boolean {
  return READ_ONLY_GIT_SUBCOMMANDS.has(args[0] ?? "");
}

/**
 * The argv (after `git`) and extra env for one legacy git run. Read-only
 * subcommands get fsmonitor and hooks disabled, external diff / textconv
 * drivers off, and GIT_OPTIONAL_LOCKS=0 (no opportunistic index write);
 * everything else is returned unchanged.
 */
export function hardenGitInvocation(args: string[]): {
  argv: string[];
  env: Record<string, string>;
} {
  if (!isReadOnlyGitInvocation(args)) return { argv: args, env: {} };
  const [sub, ...rest] = args;
  const subArgs = DIFF_RENDERING_SUBCOMMANDS.has(sub)
    ? [sub, "--no-ext-diff", "--no-textconv", ...rest]
    : args;
  return {
    argv: [...READ_ONLY_GIT_CONFIG, ...subArgs],
    env: { GIT_OPTIONAL_LOCKS: "0" },
  };
}
