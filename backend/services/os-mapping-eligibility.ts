import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";

/**
 * B2 OS-isolation account eligibility (design: docs/plans/2026-07-03-b2-run-as-user-broker.md
 * §2; B1 §2.1). A DeckTerm user may only be mapped to a unix account that positively passes
 * EVERY rule below. The rules are expressed over NUMERIC uid/gids — never group names alone —
 * so a renamed group can't slip past (Codex #2).
 *
 * The module is split into a PURE decision core (`evaluateOsAccountEligibility`, a fully
 * testable matrix over already-gathered facts) and a SYSTEM probe (`gatherOsAccountFacts`,
 * which shells out to `getent`/stat). The same policy is enforced in three independent places
 * (Codex #2): app mapping-time, app use-time re-probe, and the root broker on every call — this
 * module is the app-side half; the broker re-implements the identical checks in Python.
 */

export type OsAccountFacts = {
  /** Did the account resolve at all (getpwnam succeeded). */
  exists: boolean;
  username: string;
  uid: number;
  /** Primary gid. */
  gid: number;
  loginShell: string;
  /** All group gids (primary + supplementary), numeric. */
  groupGids: number[];
  /**
   * True if the account can write ANY DeckTerm-protected path (state dir, repo/config,
   * broker binary, /etc/deckterm, sudoers drop-in). Derived by ownership/mode inspection —
   * NOT an access(2) probe as the service account (Codex #2). Fail-closed: if writeability
   * cannot be positively disproven, this is true.
   */
  canWriteProtectedPath: boolean;
};

export type EligibilityPolicy = {
  /** Floor for a mappable uid (default 1000). */
  minUid: number;
  /** gid of the required opt-in group (`deckterm-users`); must be a group member. */
  requiredGroupGid: number;
  /** The DeckTerm service account's uid — never mappable. */
  serviceUid: number;
  /** The service account's primary gid — no mapped account may have it as a group. */
  servicePrimaryGid: number;
  /** gids that make an account privileged: root(0), sudo, wheel, admin, + configured. */
  privilegedGids: number[];
  /** Login shells that mean "no interactive login" — reject them. */
  nologinShells: string[];
};

export type EligibilityReason =
  | "account_missing"
  | "uid_zero"
  | "uid_below_min"
  | "gid_zero"
  | "is_service_account"
  | "service_group_member"
  | "nologin_shell"
  | "missing_required_group"
  | "privileged_group_member"
  | "protected_path_writable";

export type EligibilityResult =
  { ok: true } | { ok: false; reason: EligibilityReason };

/**
 * Pure eligibility matrix. Every rule must hold; the FIRST failing rule's reason is returned
 * (order chosen so the most security-load-bearing checks surface first). No I/O — feed it
 * facts from `gatherOsAccountFacts` (app) or the equivalent Python probe (broker).
 */
export function evaluateOsAccountEligibility(
  facts: OsAccountFacts,
  policy: EligibilityPolicy,
): EligibilityResult {
  if (!facts.exists) return { ok: false, reason: "account_missing" };
  if (facts.uid === 0) return { ok: false, reason: "uid_zero" };
  if (facts.uid < policy.minUid) return { ok: false, reason: "uid_below_min" };
  if (facts.gid === 0) return { ok: false, reason: "gid_zero" };

  if (facts.uid === policy.serviceUid) {
    return { ok: false, reason: "is_service_account" };
  }
  // The service account's primary group must not appear anywhere in the target's group set —
  // otherwise the mapped user shares the service account's group-readable/writable surface.
  if (facts.groupGids.includes(policy.servicePrimaryGid)) {
    return { ok: false, reason: "service_group_member" };
  }

  const shell = facts.loginShell.trim();
  if (!shell || policy.nologinShells.some((s) => shell.endsWith(s))) {
    return { ok: false, reason: "nologin_shell" };
  }

  if (!facts.groupGids.includes(policy.requiredGroupGid)) {
    return { ok: false, reason: "missing_required_group" };
  }

  if (facts.groupGids.some((g) => policy.privilegedGids.includes(g))) {
    return { ok: false, reason: "privileged_group_member" };
  }

  if (facts.canWriteProtectedPath) {
    return { ok: false, reason: "protected_path_writable" };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// System probe (impure) — kept out of the pure core so the matrix is testable
// without root or real accounts.
// ---------------------------------------------------------------------------

function getentPasswd(username: string): {
  uid: number;
  gid: number;
  shell: string;
  home: string;
} | null {
  // getent, not /etc/passwd parsing, so NSS-backed accounts (LDAP/SSSD) resolve too.
  const res = spawnSync("getent", ["passwd", username], { encoding: "utf8" });
  if (res.status !== 0 || !res.stdout) return null;
  // name:passwd:uid:gid:gecos:home:shell
  const parts = res.stdout.trim().split(":");
  if (parts.length < 7) return null;
  const uid = Number(parts[2]);
  const gid = Number(parts[3]);
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) return null;
  return { uid, gid, home: parts[5] ?? "", shell: parts[6] ?? "" };
}

/** Resolve a group NAME to its numeric gid via getent; null if it doesn't exist. */
export function resolveGroupGid(groupName: string): number | null {
  const res = spawnSync("getent", ["group", groupName], { encoding: "utf8" });
  if (res.status !== 0 || !res.stdout) return null;
  // name:passwd:gid:members
  const gid = Number(res.stdout.trim().split(":")[2]);
  return Number.isInteger(gid) ? gid : null;
}

function memberGroupGids(username: string, primaryGid: number): number[] {
  // `id -G` prints all group ids (primary + supplementary) space-separated.
  const res = spawnSync("id", ["-G", username], { encoding: "utf8" });
  const gids = new Set<number>([primaryGid]);
  if (res.status === 0 && res.stdout) {
    for (const tok of res.stdout.trim().split(/\s+/)) {
      const g = Number(tok);
      if (Number.isInteger(g)) gids.add(g);
    }
  }
  return [...gids];
}

/**
 * True if `account` (uid/gids) can write `path`, derived from ownership+mode (Codex #2): the
 * account is the owner with an owner-write bit, OR is in the owning group with a group-write
 * bit, OR the path is world-writable. Fail-closed: if the path can't be stat'd we return TRUE
 * for a path that EXISTS but errored; a genuinely-absent path is not writable-through-here.
 */
function accountCanWritePath(
  path: string,
  uid: number,
  groupGids: number[],
): boolean {
  let st;
  try {
    st = statSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT ⇒ the protected path isn't present on this host ⇒ not a write surface.
    if (code === "ENOENT") return false;
    // EACCES/EPERM ⇒ the SERVICE account itself cannot even traverse to the
    // path — it lives in a root-restricted subtree (e.g. /etc/sudoers.d, 0750
    // root:root). An unprivileged mapped account cannot reach it either, and
    // the ROOT broker re-checks every protected path authoritatively on each
    // call (Codex #2, the "three places" rule), so this is not a
    // service-account-provable write surface. Treating it as writable here
    // would fail-closed so hard that NO account is ever mappable.
    if (code === "EACCES" || code === "EPERM") return false;
    // Any other stat error ⇒ we cannot prove non-writability ⇒ fail closed.
    return true;
  }
  const mode = st.mode;
  if (mode & 0o002) return true; // world-writable
  if (st.uid === uid && mode & 0o200) return true; // owner + owner-write
  if (groupGids.includes(st.gid) && mode & 0o020) return true; // group + group-write
  return false;
}

/**
 * Gather the system facts the pure matrix needs. `protectedPaths` are the DeckTerm-protected
 * locations the account must not be able to write (state dir, config/repo dir, broker binary,
 * /etc/deckterm, sudoers drop-in). Returns `exists:false` facts (which the matrix rejects) if
 * the account can't be resolved.
 */
export function gatherOsAccountFacts(
  username: string,
  protectedPaths: string[],
): OsAccountFacts {
  const pw = getentPasswd(username);
  if (!pw) {
    return {
      exists: false,
      username,
      uid: -1,
      gid: -1,
      loginShell: "",
      groupGids: [],
      canWriteProtectedPath: true,
    };
  }
  const groupGids = memberGroupGids(username, pw.gid);
  const canWriteProtectedPath = protectedPaths.some((p) =>
    accountCanWritePath(p, pw.uid, groupGids),
  );
  return {
    exists: true,
    username,
    uid: pw.uid,
    gid: pw.gid,
    loginShell: pw.shell,
    groupGids,
    canWriteProtectedPath,
  };
}

/**
 * Build the eligibility policy from env + the live process identity. The service account is the
 * uid the server runs as (`process.getuid()`), never a client-supplied value.
 */
export function resolveEligibilityPolicy(
  env: Record<string, string | undefined> = process.env,
  getuid: () => number = () => process.getuid?.() ?? -1,
  getgid: () => number = () => process.getgid?.() ?? -1,
): EligibilityPolicy {
  const minUid = Number(env.DECKTERM_MIN_UID || "1000");
  const requiredGroupName = env.DECKTERM_OS_USERS_GROUP || "deckterm-users";
  const requiredGroupGid = resolveGroupGid(requiredGroupName) ?? -1;

  const privilegedGids = new Set<number>([0]);
  for (const name of ["sudo", "wheel", "admin"]) {
    const gid = resolveGroupGid(name);
    if (gid !== null) privilegedGids.add(gid);
  }
  for (const tok of (env.DECKTERM_PRIVILEGED_GIDS || "").split(",")) {
    const g = Number(tok.trim());
    if (tok.trim() && Number.isInteger(g)) privilegedGids.add(g);
  }

  return {
    minUid: Number.isInteger(minUid) ? minUid : 1000,
    requiredGroupGid,
    serviceUid: getuid(),
    servicePrimaryGid: getgid(),
    privilegedGids: [...privilegedGids],
    nologinShells: ["/nologin", "nologin", "/false", "false"],
  };
}
