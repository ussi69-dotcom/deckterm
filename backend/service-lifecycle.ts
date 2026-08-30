// Service-lifecycle self-check.
//
// Persistent sessions depend on three host facts DeckTerm cannot fix by
// itself but can at least *see*: the systemd unit's KillMode (control-group
// kills the tmux server on every restart), needrestart's mode (automatic mode
// restarts the unit after library upgrades), and whether the service account's
// home — the default terminal cwd — is inside ALLOWED_FILE_ROOTS. All of these
// were learned the hard way on one tuned host and then rediscovered on the
// first fresh install. This module detects them once so both the startup log
// and the Setup Doctor can name the gap instead of leaving it to be found
// weeks later. Everything here is best-effort and warning-only: no check ever
// blocks startup, and any I/O failure degrades to "no check".
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DoctorCheck, DoctorCheckStatus } from "./onboarding-doctor";

export type SystemdScope = "user" | "system";

export interface SystemdUnitRef {
  unit: string;
  scope: SystemdScope;
}

export interface ServiceLifecycle extends SystemdUnitRef {
  /** `systemctl show -p KillMode` value, or null when unknown. */
  killMode: string | null;
  /** `EnvironmentFile=` paths of the unit, empty when unknown. */
  environmentFiles: string[];
}

export const CHECK_IDS = {
  tmuxPersistence: "tmux-sessions-survive-service-restart",
  needrestart: "needrestart-does-not-auto-restart-deckterm",
  homeRoot: "service-home-inside-allowed-file-roots",
} as const;

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

/** Reads the owning systemd *service* unit out of `/proc/self/cgroup` (v2). */
export function parseSystemdUnitFromCgroup(
  cgroupText: string,
): SystemdUnitRef | null {
  const line = String(cgroupText || "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("0::"));
  if (!line) return null;
  const path = line.slice("0::".length);
  const segments = path.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last || !last.endsWith(".service")) return null;
  // The user manager itself (`user@1001.service`) is not a unit we can
  // meaningfully restart-check; only services *inside* it are.
  if (/^user@\d+\.service$/.test(last)) return null;
  const scope: SystemdScope = segments.some((s) => /^user@\d+\.service$/.test(s))
    ? "user"
    : "system";
  return { unit: last, scope };
}

/** Parses `systemctl show -p EnvironmentFiles --value` output. */
export function parseEnvironmentFiles(value: string): string[] {
  return String(value || "")
    .split("\n")
    .map((line) => line.replace(/\s*\(ignore_errors=(yes|no)\)\s*$/, "").trim())
    .filter(Boolean);
}

function makeCheck(
  id: string,
  status: DoctorCheckStatus,
  message: string,
): DoctorCheck {
  return {
    id,
    status,
    message,
    raw: `${status.toUpperCase()}: ${message}`,
    source: "config",
  };
}

// ---------------------------------------------------------------------------
// Evaluators (pure)
// ---------------------------------------------------------------------------

export function evaluateTmuxPersistence({
  tmuxBackend,
  unit,
  killMode,
}: {
  tmuxBackend: boolean;
  unit: string | null;
  killMode: string | null;
}): DoctorCheck | null {
  if (!tmuxBackend || !unit || !killMode) return null;
  if (killMode === "process") {
    return makeCheck(
      CHECK_IDS.tmuxPersistence,
      "ok",
      `${unit} keeps the tmux server alive across restarts (KillMode=process)`,
    );
  }
  return makeCheck(
    CHECK_IDS.tmuxPersistence,
    "warning",
    `tmux sessions will NOT survive a service restart: ${unit} uses KillMode=${killMode}; set KillMode=process in the unit (or run the tmux server in its own unit)`,
  );
}

/**
 * needrestart config semantics: `$nrconf{restart} = 'a'` restarts services
 * automatically after library upgrades; `'i'`/`'l'`/commented-out default only
 * lists them when run non-interactively (unattended-upgrades). An
 * `override_rc` entry whose regex matches the unit name disables the restart.
 */
export function evaluateNeedrestartConfig({
  confText,
  unit,
}: {
  confText: string | null;
  unit: string | null;
}): DoctorCheck | null {
  if (confText == null || !unit) return null;
  const active = confText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const modeLine = active
    .filter((l) => /^\$nrconf\{restart\}\s*=/.test(l))
    .pop();
  const mode = modeLine?.match(/=\s*'([a-z])'/)?.[1] ?? null;
  if (mode !== "a") {
    return makeCheck(
      CHECK_IDS.needrestart,
      "ok",
      "needrestart does not restart services automatically after upgrades",
    );
  }
  const overridden = active.some((line) => {
    const m = line.match(
      /^\$nrconf\{override_rc\}\{qr\((.+)\)\}\s*=\s*0\s*;/,
    );
    if (!m) return false;
    try {
      return new RegExp(m[1]).test(unit);
    } catch {
      return false;
    }
  });
  if (overridden) {
    return makeCheck(
      CHECK_IDS.needrestart,
      "ok",
      `needrestart runs in automatic mode but ${unit} is excluded from auto-restart`,
    );
  }
  return makeCheck(
    CHECK_IDS.needrestart,
    "warning",
    `needrestart runs in automatic mode and may restart ${unit} after library upgrades, ending every session; install deploy/needrestart/deckterm.conf into /etc/needrestart/conf.d/`,
  );
}

function normalizeDir(path: string): string {
  const abs = resolve(path);
  return abs === "/" ? "/" : abs.replace(/\/+$/, "");
}

/** Path-boundary-aware containment: `/home/deploy2` is not under `/home/deploy`. */
export function isInsideRoots(path: string, roots: string[]): boolean {
  if (!path) return false;
  const target = normalizeDir(path);
  return roots.some((root) => {
    const r = normalizeDir(root);
    return r === "/" || target === r || target.startsWith(`${r}/`);
  });
}

/**
 * Start directory for a terminal created without an explicit cwd: the service
 * home when it is an allowed root, otherwise the first allowed root. A fresh
 * install with `ALLOWED_FILE_ROOTS=/srv/work` used to default to `$HOME` and
 * reject its own first terminal with "Forbidden terminal root".
 */
export function pickDefaultTerminalCwd({
  home,
  allowedRoots,
}: {
  home: string;
  allowedRoots: string[];
}): string {
  if (home && isInsideRoots(home, allowedRoots)) return normalizeDir(home);
  const first = allowedRoots.find((root) => root && root.trim());
  if (first) return normalizeDir(first);
  return home ? normalizeDir(home) : "/";
}

export function evaluateHomeRootCoverage({
  home,
  allowedRoots,
}: {
  home: string;
  allowedRoots: string[];
}): DoctorCheck | null {
  if (!home || !allowedRoots.length) return null;
  const target = normalizeDir(home);
  if (isInsideRoots(target, allowedRoots)) {
    return makeCheck(
      CHECK_IDS.homeRoot,
      "ok",
      `service home ${target} is inside ALLOWED_FILE_ROOTS`,
    );
  }
  // Informational, not a failure: terminals fall back to the first allowed
  // root, so a deliberately restricted deployment stays green — but the
  // operator should know where new terminals will land.
  const fallback = pickDefaultTerminalCwd({ home: target, allowedRoots });
  return makeCheck(
    CHECK_IDS.homeRoot,
    "ok",
    `service home ${target} is outside ALLOWED_FILE_ROOTS (${allowedRoots.join(", ")}); terminals created without a cwd start in ${fallback} — add ${target} to ALLOWED_FILE_ROOTS if that is not intended`,
  );
}

/**
 * Where the Setup Doctor should read configuration from: an explicit override
 * (option or `DECKTERM_DOCTOR_ENV`), else the running unit's first
 * `EnvironmentFile=` (the config the service *actually* runs with), else
 * `.env` in the working directory.
 */
export function resolveDoctorEnvFile({
  cwd,
  explicit,
  lifecycle,
}: {
  cwd: string;
  explicit: string | undefined;
  lifecycle: Pick<ServiceLifecycle, "environmentFiles"> | null;
}): string {
  if (explicit && explicit.trim()) return resolve(cwd, explicit.trim());
  const fromUnit = lifecycle?.environmentFiles?.[0];
  if (fromUnit) return resolve(cwd, fromUnit);
  return resolve(cwd, ".env");
}

// ---------------------------------------------------------------------------
// I/O (injectable)
// ---------------------------------------------------------------------------

export interface LifecycleIo {
  readCgroup: () => Promise<string>;
  /** Runs `systemctl <args>` and returns stdout ("" on failure). */
  runSystemctl: (args: string[]) => Promise<string>;
}

const SYSTEMCTL_TIMEOUT_MS = 3_000;

async function runSystemctlDefault(args: string[]): Promise<string> {
  const proc = Bun.spawn(["systemctl", ...args], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => proc.kill(), SYSTEMCTL_TIMEOUT_MS);
  try {
    const [out] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return out;
  } finally {
    clearTimeout(timer);
  }
}

const defaultIo: LifecycleIo = {
  readCgroup: () => readFile("/proc/self/cgroup", "utf8"),
  runSystemctl: runSystemctlDefault,
};

export async function detectServiceLifecycle(
  io: Partial<LifecycleIo> = {},
): Promise<ServiceLifecycle | null> {
  const { readCgroup, runSystemctl } = { ...defaultIo, ...io };
  let ref: SystemdUnitRef | null = null;
  try {
    ref = parseSystemdUnitFromCgroup(await readCgroup());
  } catch {
    return null;
  }
  if (!ref) return null;
  const prefix = ref.scope === "user" ? ["--user"] : [];
  const show = async (property: string): Promise<string | null> => {
    try {
      const out = await runSystemctl([
        ...prefix,
        "show",
        "-p",
        property,
        "--value",
        ref.unit,
      ]);
      const value = String(out || "").trim();
      return value || null;
    } catch {
      return null;
    }
  };
  const killMode = await show("KillMode");
  const envFilesRaw = await show("EnvironmentFiles");
  return {
    ...ref,
    killMode,
    environmentFiles: parseEnvironmentFiles(envFilesRaw || ""),
  };
}

let cachedLifecycle: Promise<ServiceLifecycle | null> | null = null;

/** Process-wide cached detection — the unit does not change while we run. */
export function getServiceLifecycle(): Promise<ServiceLifecycle | null> {
  if (!cachedLifecycle) {
    cachedLifecycle = detectServiceLifecycle().catch(() => null);
  }
  return cachedLifecycle;
}

/** Concatenated needrestart config (main file + conf.d), or null if unreadable. */
export async function readNeedrestartConfig(
  etcDir = "/etc/needrestart",
): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(join(etcDir, "needrestart.conf"), "utf8");
  } catch {
    return null;
  }
  try {
    const confDir = join(etcDir, "conf.d");
    const entries = (await readdir(confDir)).filter((f) => f.endsWith(".conf"));
    for (const entry of entries.sort()) {
      try {
        text += `\n${await readFile(join(confDir, entry), "utf8")}`;
      } catch {
        /* unreadable drop-in: skip */
      }
    }
  } catch {
    /* no conf.d */
  }
  return text;
}
