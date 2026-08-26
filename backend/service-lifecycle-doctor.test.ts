// Integration of the host lifecycle self-check with the Setup Doctor: the
// doctor must surface KillMode / needrestart / home-root facts from injected
// lifecycle data, and read the env file the running unit actually uses.
import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runOnboardingDoctor } from "./onboarding-doctor";
import { CHECK_IDS } from "./service-lifecycle";

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixture() {
  const dir = await mkdtemp(
    join(process.env.HOME || "/tmp", ".deckterm-lifecycle-doctor-"),
  );
  tempDirs.push(dir);
  const binDir = join(dir, "bin");
  await mkdir(binDir, { recursive: true });
  await Bun.write(join(binDir, "tmux"), "#!/usr/bin/env bash\nexit 0\n");
  await chmod(join(binDir, "tmux"), 0o755);
  const script = join(dir, "doctor.sh");
  await writeFile(
    script,
    "#!/usr/bin/env bash\necho 'OK: doctor checks completed'\n",
  );
  await chmod(script, 0o755);
  const unitEnv = join(dir, "unit.env");
  await writeFile(
    unitEnv,
    [
      "PORT=4174",
      "HOST=127.0.0.1",
      "TMUX_BACKEND=1",
      "TRUSTED_ORIGINS=http://localhost:4174",
      `ALLOWED_FILE_ROOTS=${dir}`,
      "",
    ].join("\n"),
  );
  const needrestartDir = join(dir, "needrestart");
  await mkdir(join(needrestartDir, "conf.d"), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: `${binDir}:/usr/bin:/bin`,
    HOME: dir,
    DECKTERM_RUNTIME_ENV: "development",
  };
  return { dir, script, unitEnv, needrestartDir, env };
}

describe("Setup Doctor × service lifecycle", () => {
  test("KillMode=control-group under the tmux backend degrades the report to warning", async () => {
    const f = await fixture();
    await writeFile(join(f.needrestartDir, "needrestart.conf"), "#$nrconf{restart} = 'i';\n");
    const report = await runOnboardingDoctor({
      cwd: f.dir,
      scriptPath: f.script,
      envFile: f.unitEnv,
      env: f.env,
      needrestartConfigDir: f.needrestartDir,
      lifecycle: {
        unit: "deckterm.service",
        scope: "system",
        killMode: "control-group",
        environmentFiles: [f.unitEnv],
      },
    });
    const tmux = report.checks.find((c) => c.id === CHECK_IDS.tmuxPersistence);
    expect(tmux?.status).toBe("warning");
    expect(tmux?.message).toContain("KillMode=control-group");
    expect(report.status).toBe("warning");
    expect(report.checks.find((c) => c.id === CHECK_IDS.needrestart)?.status).toBe("ok");
    expect(report.checks.find((c) => c.id === CHECK_IDS.homeRoot)?.status).toBe("ok");
  });

  test("KillMode=process with needrestart auto mode and no override warns about needrestart only", async () => {
    const f = await fixture();
    await writeFile(join(f.needrestartDir, "needrestart.conf"), "$nrconf{restart} = 'a';\n");
    const report = await runOnboardingDoctor({
      cwd: f.dir,
      scriptPath: f.script,
      envFile: f.unitEnv,
      env: f.env,
      needrestartConfigDir: f.needrestartDir,
      lifecycle: {
        unit: "deckterm.service",
        scope: "system",
        killMode: "process",
        environmentFiles: [],
      },
    });
    expect(report.checks.find((c) => c.id === CHECK_IDS.tmuxPersistence)?.status).toBe("ok");
    const nr = report.checks.find((c) => c.id === CHECK_IDS.needrestart);
    expect(nr?.status).toBe("warning");
    expect(nr?.message).toContain("deckterm.conf");
  });

  test("a conf.d override for the unit turns the needrestart check green", async () => {
    const f = await fixture();
    await writeFile(join(f.needrestartDir, "needrestart.conf"), "$nrconf{restart} = 'a';\n");
    await writeFile(
      join(f.needrestartDir, "conf.d", "deckterm.conf"),
      "$nrconf{override_rc}{qr(^deckterm(-dev|-tmux)?\\.service$)} = 0;\n",
    );
    const report = await runOnboardingDoctor({
      cwd: f.dir,
      scriptPath: f.script,
      envFile: f.unitEnv,
      env: f.env,
      needrestartConfigDir: f.needrestartDir,
      lifecycle: { unit: "deckterm.service", scope: "system", killMode: "process", environmentFiles: [] },
    });
    expect(report.checks.find((c) => c.id === CHECK_IDS.needrestart)?.status).toBe("ok");
    expect(report.status).toBe("ok");
  });

  test("without an explicit env file the doctor reads the unit's EnvironmentFile", async () => {
    const f = await fixture();
    await writeFile(join(f.needrestartDir, "needrestart.conf"), "#$nrconf{restart} = 'i';\n");
    // A stale .env in cwd must NOT win over the unit's file.
    await writeFile(join(f.dir, ".env"), "PORT=9999\nHOST=0.0.0.0\nTMUX_BACKEND=0\n");
    const report = await runOnboardingDoctor({
      cwd: f.dir,
      scriptPath: f.script,
      env: f.env,
      needrestartConfigDir: f.needrestartDir,
      lifecycle: {
        unit: "deckterm.service",
        scope: "system",
        killMode: "process",
        environmentFiles: [f.unitEnv],
      },
    });
    expect(report.envFile).toBe(f.unitEnv);
    expect(report.config.port).toBe("4174");
    expect(report.config.tmuxBackend).toBe(true);
  });

  test("outside systemd (lifecycle null) the doctor falls back to .env in cwd", async () => {
    const f = await fixture();
    await writeFile(
      join(f.dir, ".env"),
      "PORT=4174\nHOST=127.0.0.1\nTMUX_BACKEND=1\nTRUSTED_ORIGINS=http://localhost:4174\n",
    );
    const report = await runOnboardingDoctor({
      cwd: f.dir,
      scriptPath: f.script,
      env: f.env,
      lifecycle: null,
    });
    expect(report.envFile).toBe(join(f.dir, ".env"));
  });

  test("outside systemd (lifecycle null) no host checks are emitted", async () => {
    const f = await fixture();
    const report = await runOnboardingDoctor({
      cwd: f.dir,
      scriptPath: f.script,
      envFile: f.unitEnv,
      env: f.env,
      lifecycle: null,
    });
    expect(report.checks.find((c) => c.id === CHECK_IDS.tmuxPersistence)).toBeUndefined();
    expect(report.checks.find((c) => c.id === CHECK_IDS.needrestart)).toBeUndefined();
  });

  test("DECKTERM_DOCTOR_LIFECYCLE=0 wins over injected lifecycle data", async () => {
    const f = await fixture();
    const report = await runOnboardingDoctor({
      cwd: f.dir,
      scriptPath: f.script,
      envFile: f.unitEnv,
      env: { ...f.env, DECKTERM_DOCTOR_LIFECYCLE: "0" },
      lifecycle: { unit: "deckterm.service", scope: "system", killMode: "control-group", environmentFiles: [] },
    });
    expect(report.checks.find((c) => c.id === CHECK_IDS.tmuxPersistence)).toBeUndefined();
    expect(report.status).toBe("ok");
  });
});
