// Human detail for "path outside the allowed roots" denials (terminal create,
// file/git/search access, task project roots). The 403 status and the
// machine-readable `error` / `reason` fields stay exactly as before; this adds
// `path` (the rejected value), `setting` (what governs it) and a `message` +
// `hint` that say how to fix it. The configured root paths are deliberately NOT
// echoed: /api/onboarding/env hides them from actors without a filesystem
// capability, so a denial must not leak them either.

import { stat as fsStat } from "node:fs/promises";
import { resolve } from "node:path";

export const ALLOWED_ROOTS_SETTING = "ALLOWED_FILE_ROOTS";
export const GRANTED_ROOTS_SETTING = "root_grants";

const MAX_ECHOED_PATH_LENGTH = 512;

export type ForbiddenRootSubject = "terminal" | "path" | "search" | "project";

export interface ForbiddenRootDetail {
  path: string | null;
  setting: string;
  message: string;
  hint: string;
}

function echoPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "");
  if (!clean) return null;
  return clean.length > MAX_ECHOED_PATH_LENGTH
    ? `${clean.slice(0, MAX_ECHOED_PATH_LENGTH)}…`
    : clean;
}

function leadIn(subject: ForbiddenRootSubject, path: string | null): string {
  const quoted = path ? `"${path}"` : null;
  switch (subject) {
    case "terminal":
      return quoted
        ? `Cannot start a terminal in ${quoted}: it`
        : "Cannot start a terminal there: the directory";
    case "search":
      return quoted
        ? `Cannot search ${quoted}: it`
        : "Cannot search there: the directory";
    case "project":
      return quoted ? `Task project root ${quoted}` : "The task project root";
    default:
      return quoted ?? "The requested path";
  }
}

export function forbiddenRootDetail({
  path,
  subject,
  scope = "allowed",
  mayBeMissing = false,
}: {
  path: unknown;
  subject: ForbiddenRootSubject;
  scope?: "allowed" | "granted";
  mayBeMissing?: boolean;
}): ForbiddenRootDetail {
  const echoed = echoPath(path);
  const lead = leadIn(subject, echoed);
  const missing = mayBeMissing ? " or does not exist" : "";

  if (scope === "granted") {
    const hint =
      "Use a path inside one of your roots, or ask an admin to grant this root in Setup.";
    return {
      path: echoed,
      setting: GRANTED_ROOTS_SETTING,
      message: `${lead} is outside the roots granted to you${missing}. ${hint}`,
      hint,
    };
  }

  const where = subject === "terminal" ? "Choose a directory" : "Use a path";
  const hint =
    `${where} inside an allowed root, or add the directory to ` +
    `${ALLOWED_ROOTS_SETTING} in the DeckTerm service environment and restart DeckTerm.`;
  return {
    path: echoed,
    setting: ALLOWED_ROOTS_SETTING,
    message: `${lead} is outside the allowed roots (${ALLOWED_ROOTS_SETTING})${missing}. ${hint}`,
    hint,
  };
}

/** Whether `path` (normalised, no symlink resolution) lies inside a root. */
export function isLexicallyWithinRoots(path: string, roots: string[]): boolean {
  const candidate = resolve(path);
  return roots.some((rawRoot) => {
    const root = resolve(rawRoot);
    if (root === "/") return true;
    return candidate === root || candidate.startsWith(`${root}/`);
  });
}

async function defaultStat(path: string): Promise<void> {
  await fsStat(path);
}

/**
 * Whether a path refused by allowed-roots resolution should be described as
 * "outside the allowed roots or does not exist" (`mayBeMissing`).
 *
 * Only a path that lies lexically INSIDE an allowed root is stat'ed: there the
 * refusal means realpath failed (missing) or a symlink escapes the root. A path
 * outside every root is outside whether or not it exists, so it is never
 * stat'ed — otherwise the wording would tell any caller (before any grant
 * check) whether an arbitrary host path exists as the service account.
 * Legacy (service-account) view only; OS isolation denies earlier.
 */
export async function rejectedPathMayBeMissing(
  inputPath: string,
  roots: string[],
  statPath: (path: string) => Promise<unknown> = defaultStat,
): Promise<boolean> {
  if (typeof inputPath !== "string" || !inputPath) return false;
  if (!isLexicallyWithinRoots(inputPath, roots)) return false;
  try {
    await statPath(resolve(inputPath));
    return false;
  } catch {
    return true;
  }
}
