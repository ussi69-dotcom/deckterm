import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const roots: string[] = [];
const servicePidFiles: string[] = [];

const FAKE_BACKEND = String.raw`
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const stateDir = process.env.DECKTERM_STATE_DIR;
if (!stateDir) throw new Error("missing state dir");
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
mkdirSync(join(stateDir, "tmux"), { recursive: true, mode: 0o700 });
mkdirSync(join(stateDir, "clipboard"), { recursive: true, mode: 0o700 });
mkdirSync(join(stateDir, "tmux", "pipes"), { recursive: true, mode: 0o700 });
const captureRoot = process.env.DECKTERM_CAPTURE_ROOT || join(stateDir, "capture");
mkdirSync(captureRoot, { recursive: true, mode: 0o700 });
const markerRelease = (() => {
  try { return readFileSync(resolve(import.meta.dir, "../RELEASE_ID"), "utf8").trim(); }
  catch { return "missing"; }
})();
const release = process.env.DECKTERM_RELEASE || markerRelease;
const preflight = process.env.DECKTERM_PREFLIGHT === "1";
const db = new Database(join(stateDir, "deckterm.db"));
db.exec("CREATE TABLE IF NOT EXISTS process_events (release TEXT, preflight INTEGER)");
db.query("INSERT INTO process_events VALUES (?, ?)").run(release, preflight ? 1 : 0);
db.close();
appendFileSync(join(stateDir, "process-events.log"), JSON.stringify({ release, preflight }) + "\n");
writeFileSync(join(stateDir, "tmux", String(process.env.TMUX_SESSION_NAMESPACE) + ".marker"), "tmux");
writeFileSync(join(stateDir, "clipboard", "marker"), "clipboard");
writeFileSync(join(stateDir, "tmux", "pipes", "marker"), "pipe");
writeFileSync(join(captureRoot, release + ".marker"), "capture");

const reportedRelease = process.env.FAKE_HEALTH_RELEASE || release;
const server = Bun.serve({
  hostname: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT),
  fetch(request) {
    if (new URL(request.url).pathname !== "/api/health") return new Response("missing", { status: 404 });
    return Response.json({ status: "ok", release: reportedRelease, preflight });
  },
});
process.on("SIGTERM", () => { server.stop(true); process.exit(0); });
`;

const FAKE_SYSTEMCTL = String.raw`#!/usr/bin/env bash
set -euo pipefail
if [[ "$FAKE_SYSTEMCTL_FAIL_ONCE" == "1" && ! -e "$FAKE_SYSTEMCTL_FAIL_MARKER" ]]; then
  : >"$FAKE_SYSTEMCTL_FAIL_MARKER"
  exit 5
fi
if [[ -f "$FAKE_SERVICE_PID_FILE" ]]; then
  old_pid=$(<"$FAKE_SERVICE_PID_FILE")
  kill -TERM "$old_pid" 2>/dev/null || true
  for _attempt in $(seq 1 50); do
    kill -0 "$old_pid" 2>/dev/null || break
    sleep 0.05
  done
  kill -KILL "$old_pid" 2>/dev/null || true
fi
release_dir=$(readlink -f "$FAKE_CURRENT_LINK")
(
  cd "$release_dir"
  exec env -i \
    HOME="$FAKE_HOME" \
    PATH="$FAKE_PATH" \
    PORT="$FAKE_TARGET_PORT" \
    HOST=127.0.0.1 \
    DECKTERM_STATE_DIR="$FAKE_LIVE_STATE" \
    DECKTERM_CAPTURE_ROOT="$FAKE_LIVE_CAPTURE" \
    TMUX_BACKEND=1 \
    TMUX_SESSION_NAMESPACE=live \
    "$FAKE_REAL_BUN" --env-file="$FAKE_SHARED_ENV" backend/index.ts
) >>"$FAKE_SERVICE_LOG" 2>&1 &
service_pid=$!
printf '%s\n' "$service_pid" >"$FAKE_SERVICE_PID_FILE"
`;

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "deckterm-deploy-test-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

async function twoFreePorts(): Promise<[number, number]> {
  const first = createServer();
  const second = createServer();
  await new Promise<void>((resolveListen) =>
    first.listen(0, "127.0.0.1", resolveListen),
  );
  await new Promise<void>((resolveListen) =>
    second.listen(0, "127.0.0.1", resolveListen),
  );
  const firstPort = (first.address() as { port: number }).port;
  const secondPort = (second.address() as { port: number }).port;
  await Promise.all([
    new Promise<void>((resolveClose) => first.close(() => resolveClose())),
    new Promise<void>((resolveClose) => second.close(() => resolveClose())),
  ]);
  return [firstPort, secondPort];
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: 0o755 });
  chmodSync(path, 0o755);
}

interface DeployFixture {
  root: string;
  deployRoot: string;
  sourceDir: string;
  liveState: string;
  liveCapture: string;
  currentLink: string;
  oldRelease: string;
  sharedEnv: string;
  bunWrapper: string;
  systemctl: string;
  servicePidFile: string;
  serviceLog: string;
  poisonMarker: string;
}

function createDeployFixture(
  wrongCandidateRelease = false,
  poisonCandidateTools = false,
  useServerStateDefault = false,
): DeployFixture {
  const root = fixture();
  const deployRoot = join(root, "deploy");
  const releasesDir = join(deployRoot, "releases");
  const sharedDir = join(deployRoot, "shared");
  const sourceDir = join(root, "source");
  const liveState = join(
    root,
    useServerStateDefault ? ".deckterm" : "live-state",
  );
  const liveCapture = join(root, "live-capture");
  const currentLink = join(deployRoot, "current");
  const oldRelease = join(releasesDir, "old-release");
  const sharedEnv = join(sharedDir, ".env");
  const binDir = join(root, "bin");
  const bunWrapper = join(binDir, "bun-wrapper");
  const systemctl = join(binDir, "systemctl");
  const servicePidFile = join(root, "service.pid");
  const serviceLog = join(root, "service.log");
  const poisonMarker = join(root, "candidate-tool-executed");
  servicePidFiles.push(servicePidFile);

  for (const dir of [
    releasesDir,
    sharedDir,
    join(sourceDir, "scripts"),
    join(sourceDir, "backend"),
    liveState,
    liveCapture,
    binDir,
    join(oldRelease, "backend"),
  ]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const db = new Database(join(liveState, "deckterm.db"));
  db.exec("CREATE TABLE sentinel (value TEXT NOT NULL)");
  db.exec("INSERT INTO sentinel VALUES ('untouched-before-promotion')");
  db.close();
  chmodSync(join(liveState, "deckterm.db"), 0o600);

  for (const name of [
    "backup-state.ts",
    "restore-state.ts",
    "release-state.ts",
    "wait_for_health.sh",
  ]) {
    copyFileSync(
      join(repoRoot, "scripts", name),
      join(sourceDir, "scripts", name),
    );
  }
  chmodSync(join(sourceDir, "scripts", "wait_for_health.sh"), 0o755);
  if (poisonCandidateTools) {
    const poisonTs =
      `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(poisonMarker)}, "candidate tool ran");\n` +
      `throw new Error("candidate release tool must not run");\n`;
    for (const name of [
      "backup-state.ts",
      "restore-state.ts",
      "release-state.ts",
    ]) {
      writeFileSync(join(sourceDir, "scripts", name), poisonTs);
    }
    writeExecutable(
      join(sourceDir, "scripts", "wait_for_health.sh"),
      `#!/usr/bin/env bash\nprintf ran >${JSON.stringify(poisonMarker)}\nexit 99\n`,
    );
  }
  writeFileSync(join(sourceDir, "backend", "index.ts"), FAKE_BACKEND);
  writeFileSync(
    join(sourceDir, "package.json"),
    '{"name":"fake-release","type":"module"}\n',
  );
  writeFileSync(join(sourceDir, "bun.lock"), "");
  writeFileSync(join(oldRelease, "backend", "index.ts"), FAKE_BACKEND);
  writeFileSync(join(oldRelease, "RELEASE_ID"), "old-release\n", {
    mode: 0o600,
  });
  symlinkSync(oldRelease, currentLink);

  writeFileSync(
    sharedEnv,
    [
      ...(useServerStateDefault ? [] : [`DECKTERM_STATE_DIR=${liveState}`]),
      "TMUX_BACKEND=1",
      "TMUX_SESSION_NAMESPACE=live",
      `DECKTERM_CAPTURE_ROOT=${liveCapture}`,
      ...(wrongCandidateRelease ? ["FAKE_HEALTH_RELEASE=wrong-release"] : []),
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  writeExecutable(
    bunWrapper,
    `#!/usr/bin/env bash\nif [[ \"\${1:-}\" == install ]] || [[ \"\${1:-}\" == --no-env-file && \"\${2:-}\" == install ]]; then exit 0; fi\nexec ${process.execPath} \"$@\"\n`,
  );
  writeExecutable(systemctl, FAKE_SYSTEMCTL);

  return {
    root,
    deployRoot,
    sourceDir,
    liveState,
    liveCapture,
    currentLink,
    oldRelease,
    sharedEnv,
    bunWrapper,
    systemctl,
    servicePidFile,
    serviceLog,
    poisonMarker,
  };
}

async function runShell(
  script: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["bash", script, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function deployEnv(
  fixture: DeployFixture,
  targetPort: number,
  candidatePort: number,
): Record<string, string> {
  return {
    SOURCE_DIR: fixture.sourceDir,
    DEPLOY_ROOT: fixture.deployRoot,
    SHARED_ENV: fixture.sharedEnv,
    TARGET_PORT: String(targetPort),
    CANDIDATE_PORT: String(candidatePort),
    SYSTEMD_SERVICE: "fake-deckterm.service",
    SYSTEMCTL_BIN: fixture.systemctl,
    BUN_BIN: fixture.bunWrapper,
    KEEP_RELEASES: "10",
    XDG_RUNTIME_DIR: fixture.root,
    FAKE_SERVICE_PID_FILE: fixture.servicePidFile,
    FAKE_CURRENT_LINK: fixture.currentLink,
    FAKE_HOME: fixture.root,
    FAKE_PATH: process.env.PATH || "/usr/bin:/bin",
    FAKE_TARGET_PORT: String(targetPort),
    FAKE_LIVE_STATE: fixture.liveState,
    FAKE_LIVE_CAPTURE: fixture.liveCapture,
    FAKE_REAL_BUN: process.execPath,
    FAKE_SHARED_ENV: fixture.sharedEnv,
    FAKE_SERVICE_LOG: fixture.serviceLog,
    FAKE_SYSTEMCTL_FAIL_ONCE: "0",
    FAKE_SYSTEMCTL_FAIL_MARKER: join(fixture.root, "systemctl-failed-once"),
  };
}

async function expectPortClosed(port: number): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(100),
      });
      await Bun.sleep(50);
    } catch {
      return;
    }
  }
  throw new Error(`port ${port} still has a candidate listener`);
}

afterEach(async () => {
  for (const pidFile of servicePidFiles.splice(0)) {
    if (!existsSync(pidFile)) continue;
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (Number.isInteger(pid) && pid > 1) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
      await Bun.sleep(50);
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("deploy and rollback share one host lifetime lock before mutations", async () => {
  const setup = createDeployFixture(false);
  const [targetPort, candidatePort] = await twoFreePorts();
  const lockPath = join(setup.deployRoot, "shared", ".release-operation.lock");
  const readyPath = join(setup.root, "lock-ready");
  const locker = Bun.spawn(
    [
      "bash",
      "-c",
      'exec 9>>"$1"; flock -x 9; : >"$2"; exec sleep 30',
      "deckterm-lock-holder",
      lockPath,
      readyPath,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  try {
    for (let attempt = 0; attempt < 100 && !existsSync(readyPath); attempt++) {
      await Bun.sleep(10);
    }
    expect(existsSync(readyPath)).toBe(true);
    const beforeTarget = readlinkSync(setup.currentLink);
    const env = deployEnv(setup, targetPort, candidatePort);

    const deploy = await runShell(
      join(repoRoot, "scripts", "deploy_release.sh"),
      ["locked-release"],
      env,
    );
    expect(deploy.exitCode).toBe(75);
    expect(readlinkSync(setup.currentLink)).toBe(beforeTarget);
    expect(
      existsSync(join(setup.deployRoot, "releases", "locked-release")),
    ).toBe(false);

    const rollback = await runShell(
      join(repoRoot, "scripts", "rollback_release.sh"),
      [],
      env,
    );
    expect(rollback.exitCode).toBe(75);
    expect(readlinkSync(setup.currentLink)).toBe(beforeTarget);
    expect(existsSync(setup.servicePidFile)).toBe(false);
  } finally {
    locker.kill("SIGTERM");
    await locker.exited;
  }
}, 30_000);

test("a wrong candidate identity fails before promotion without live state or process leaks", async () => {
  const setup = createDeployFixture(true);
  const [targetPort, candidatePort] = await twoFreePorts();
  const liveDb = join(setup.liveState, "deckterm.db");
  const beforeHash = sha256(liveDb);

  const result = await runShell(
    join(repoRoot, "scripts", "deploy_release.sh"),
    ["new-release"],
    deployEnv(setup, targetPort, candidatePort),
  );

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toMatch(/Health release mismatch/);
  expect(readlinkSync(setup.currentLink)).toBe(setup.oldRelease);
  expect(sha256(liveDb)).toBe(beforeHash);
  expect(existsSync(join(setup.liveState, "process-events.log"))).toBe(false);
  expect(existsSync(join(setup.liveState, "tmux"))).toBe(false);
  expect(existsSync(join(setup.liveState, "clipboard"))).toBe(false);
  expect(readdirSync(join(setup.deployRoot, "shared"))).not.toContainEqual(
    expect.stringMatching(/^\.candidate-/),
  );
  expect(existsSync(join(setup.deployRoot, "releases", "new-release"))).toBe(
    false,
  );
  await expectPortClosed(candidatePort);
}, 30_000);

test("a production restart failure restores and verifies the prior release", async () => {
  const setup = createDeployFixture(false);
  const [targetPort, candidatePort] = await twoFreePorts();
  const env = deployEnv(setup, targetPort, candidatePort);
  env.FAKE_SYSTEMCTL_FAIL_ONCE = "1";

  const result = await runShell(
    join(repoRoot, "scripts", "deploy_release.sh"),
    ["restart-fails"],
    env,
  );

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Production restart failed");
  expect(readlinkSync(setup.currentLink)).toBe(setup.oldRelease);
  const health = await fetch(`http://127.0.0.1:${targetPort}/api/health`).then(
    (response) => response.json(),
  );
  expect(health).toMatchObject({ status: "ok", release: "old-release" });
  await expectPortClosed(candidatePort);
  expect(
    readdirSync(join(setup.deployRoot, "shared")).filter((name) =>
      name.startsWith(".candidate-"),
    ),
  ).toEqual([]);
}, 30_000);

test("deploy backs up the server default state when legacy env omits the setting", async () => {
  const setup = createDeployFixture(false, false, true);
  const [targetPort, candidatePort] = await twoFreePorts();
  const env = deployEnv(setup, targetPort, candidatePort);
  env.HOME = setup.root;

  const deployed = await runShell(
    join(repoRoot, "scripts", "deploy_release.sh"),
    ["legacy-default-state"],
    env,
  );

  expect(deployed.exitCode).toBe(0);
  expect(readFileSync(setup.sharedEnv, "utf8")).not.toContain(
    "DECKTERM_STATE_DIR",
  );
  expect(readlinkSync(setup.currentLink)).toBe(
    join(setup.deployRoot, "releases", "legacy-default-state"),
  );
  const manifests = readdirSync(join(setup.liveState, "backups")).filter(
    (name) => name.endsWith(".manifest.json"),
  );
  expect(manifests).toHaveLength(1);
  await expectPortClosed(candidatePort);
}, 30_000);

test("successful deploy isolates preflight, persists contracts, and rollback verifies identity", async () => {
  const setup = createDeployFixture(false, true);
  const [targetPort, candidatePort] = await twoFreePorts();
  const env = deployEnv(setup, targetPort, candidatePort);
  env.KEEP_RELEASES = "3";
  const releasesDir = join(setup.deployRoot, "releases");
  const staleA = join(releasesDir, "stale-a");
  const staleB = join(releasesDir, "stale-b");
  const recentExtra = join(releasesDir, "recent-extra");
  for (const path of [staleA, staleB, recentExtra]) {
    mkdirSync(path, { mode: 0o700 });
  }
  utimesSync(staleA, new Date("2020-01-01"), new Date("2020-01-01"));
  utimesSync(staleB, new Date("2021-01-01"), new Date("2021-01-01"));
  utimesSync(recentExtra, new Date("2025-01-01"), new Date("2025-01-01"));

  const deployed = await runShell(
    join(repoRoot, "scripts", "deploy_release.sh"),
    ["new-release"],
    env,
  );
  expect(deployed.exitCode).toBe(0);
  expect(deployed.stdout).toContain(
    "production is serving release new-release",
  );
  expect(existsSync(setup.poisonMarker)).toBe(false);
  expect(resolve(setup.currentLink)).toBe(setup.currentLink);
  expect(readlinkSync(setup.currentLink)).toBe(
    join(setup.deployRoot, "releases", "new-release"),
  );
  expect(readlinkSync(join(setup.deployRoot, "previous"))).toBe(
    setup.oldRelease,
  );
  expect(existsSync(staleA)).toBe(false);
  expect(existsSync(staleB)).toBe(false);
  expect(existsSync(recentExtra)).toBe(true);
  expect(
    readdirSync(join(setup.deployRoot, "shared")).filter((name) =>
      name.startsWith(".candidate-"),
    ),
  ).toEqual([]);
  await expectPortClosed(candidatePort);

  const liveEvents = readFileSync(
    join(setup.liveState, "process-events.log"),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(liveEvents).toEqual([{ release: "new-release", preflight: false }]);
  expect(readdirSync(join(setup.liveState, "tmux"))).toEqual(["live.marker", "pipes"]);
  expect(readdirSync(setup.liveCapture)).toEqual(["new-release.marker"]);
  const oldContract = join(
    setup.deployRoot,
    "shared",
    "schema-contracts",
    "old-release.json",
  );
  const newContract = join(
    setup.deployRoot,
    "shared",
    "schema-contracts",
    "new-release.json",
  );
  expect(existsSync(oldContract)).toBe(true);
  expect(existsSync(newContract)).toBe(true);

  const originalOldContract = readFileSync(oldContract, "utf8");
  const wrongContract = JSON.parse(originalOldContract);
  wrongContract.release = "some-other-release";
  writeFileSync(oldContract, `${JSON.stringify(wrongContract, null, 2)}\n`, {
    mode: 0o600,
  });
  const wrongContractRollback = await runShell(
    join(repoRoot, "scripts", "rollback_release.sh"),
    [],
    env,
  );
  expect(wrongContractRollback.exitCode).not.toBe(0);
  expect(wrongContractRollback.stderr).toContain("contract belongs to");
  expect(readlinkSync(setup.currentLink)).toBe(
    join(setup.deployRoot, "releases", "new-release"),
  );
  writeFileSync(oldContract, originalOldContract, { mode: 0o600 });

  const rolledBack = await runShell(
    join(repoRoot, "scripts", "rollback_release.sh"),
    [],
    env,
  );
  expect(rolledBack.exitCode).toBe(0);
  expect(rolledBack.stdout).toContain("rolled back to release old-release");
  expect(readlinkSync(setup.currentLink)).toBe(setup.oldRelease);

  rmSync(newContract);
  const refused = await runShell(
    join(repoRoot, "scripts", "rollback_release.sh"),
    [],
    env,
  );
  expect(refused.exitCode).not.toBe(0);
  expect(refused.stderr).toContain("contract is missing");
  expect(readlinkSync(setup.currentLink)).toBe(setup.oldRelease);
}, 45_000);
