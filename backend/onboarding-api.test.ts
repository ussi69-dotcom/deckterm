import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

const tempDirs: string[] = [];
const ISOLATED_ENV_KEYS = [
  "DECKTERM_DOCTOR_SCRIPT",
  "DECKTERM_DOCTOR_ENV",
  "DECKTERM_PUBLISH_MODE",
  "TRUSTED_ORIGINS",
  "ALLOWED_FILE_ROOTS",
  "TMUX_BACKEND",
  "CF_ACCESS_REQUIRED",
  "CF_ACCESS_TEAM_NAME",
  "CF_ACCESS_AUD",
  "DECKTERM_RUNTIME_ENV",
  "DECKTERM_LEGACY_NO_BOOTSTRAP",
  "PATH",
] as const;
const previousEnv: Record<string, string | undefined> = {};
for (const key of ISOLATED_ENV_KEYS) {
  previousEnv[key] = process.env[key];
}
const previousPath = process.env.PATH;

async function createTempDir(prefix: string) {
  const dir = await mkdtemp(join(process.env.HOME || "/tmp", prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const key of ISOLATED_ENV_KEYS) {
    if (previousEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previousEnv[key];
    }
  }
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function clearInheritedDoctorEnv() {
  // Bun auto-loads `.env` from cwd into process.env. Tests must clear keys that
  // would otherwise leak the dev install's publishing config into the doctor.
  delete process.env.DECKTERM_PUBLISH_MODE;
  delete process.env.TRUSTED_ORIGINS;
  delete process.env.ALLOWED_FILE_ROOTS;
  delete process.env.TMUX_BACKEND;
  delete process.env.CF_ACCESS_REQUIRED;
  delete process.env.CF_ACCESS_TEAM_NAME;
  delete process.env.CF_ACCESS_AUD;
  process.env.DECKTERM_RUNTIME_ENV = "development";
  process.env.DECKTERM_LEGACY_NO_BOOTSTRAP = "1";
}

test("onboarding doctor API runs the configured doctor script and parses deployment warnings", async () => {
  clearInheritedDoctorEnv();
  const dir = await createTempDir(".deckterm-onboarding-api-");
  const envFile = join(dir, ".env");
  const doctorScript = join(dir, "doctor.sh");

  await writeFile(
    envFile,
    [
      "PORT=4174",
      "HOST=0.0.0.0",
      "CF_ACCESS_REQUIRED=0",
      `ALLOWED_FILE_ROOTS=${dir}`,
      "",
    ].join("\n"),
  );
  await writeFile(
    doctorScript,
    [
      "#!/usr/bin/env bash",
      "echo 'DeckTerm doctor'",
      'echo "env_file=$1"',
      "echo 'host=0.0.0.0'",
      "echo 'port=4174'",
      "echo 'WARN: HOST=0.0.0.0 exposes DeckTerm on every interface'",
      "echo 'OK: health endpoint responded'",
      "",
    ].join("\n"),
  );
  await chmod(doctorScript, 0o755);

  process.env.DECKTERM_DOCTOR_SCRIPT = doctorScript;
  process.env.DECKTERM_DOCTOR_ENV = envFile;

  const { createWebApp } = await import("./server");
  const app = createWebApp();
  const res = await app.fetch(
    new Request("http://deckterm.test/api/onboarding/doctor"),
  );

  expect(res.status).toBe(200);
  const payload = await res.json();
  expect(payload.status).toBe("warning");
  expect(payload.exitCode).toBe(0);
  expect(payload.envFile).toBe(envFile);
  expect(payload.config.host).toBe("0.0.0.0");
  expect(payload.checks).toContainEqual(
    expect.objectContaining({
      status: "warning",
      message: "HOST=0.0.0.0 exposes DeckTerm on every interface",
    }),
  );
  expect(payload.checks).toContainEqual(
    expect.objectContaining({
      status: "ok",
      message: "health endpoint responded",
    }),
  );
  expect(payload.recommendations.join("\n")).toContain("HOST=127.0.0.1");
  expect(payload.stdout).toContain("DeckTerm doctor");
});

test("onboarding doctor API validates a Cloudflare Tunnel publishing profile", async () => {
  clearInheritedDoctorEnv();
  const dir = await createTempDir(".deckterm-onboarding-cloudflare-");
  const binDir = join(dir, "bin");
  const envFile = join(dir, ".env");
  const doctorScript = join(dir, "doctor.sh");

  await mkdir(binDir, { recursive: true });
  await writeFile(
    envFile,
    [
      "PORT=4174",
      "HOST=127.0.0.1",
      "TMUX_BACKEND=1",
      "DECKTERM_PUBLISH_MODE=cloudflare",
      "CF_ACCESS_REQUIRED=1",
      "CF_ACCESS_TEAM_NAME=example-team",
      "CF_ACCESS_AUD=example-audience",
      "TRUSTED_ORIGINS=https://deckterm.example.com",
      `ALLOWED_FILE_ROOTS=${dir}`,
      "",
    ].join("\n"),
  );
  await writeFile(
    doctorScript,
    [
      "#!/usr/bin/env bash",
      "echo 'DeckTerm doctor'",
      "echo 'OK: health endpoint responded'",
      "echo 'OK: doctor checks completed'",
      "",
    ].join("\n"),
  );
  await chmod(doctorScript, 0o755);
  await Bun.write(join(binDir, "tmux"), "#!/usr/bin/env bash\nexit 0\n");
  await Bun.write(join(binDir, "cloudflared"), "#!/usr/bin/env bash\nexit 0\n");
  await chmod(join(binDir, "tmux"), 0o755);
  await chmod(join(binDir, "cloudflared"), 0o755);

  process.env.DECKTERM_DOCTOR_SCRIPT = doctorScript;
  process.env.DECKTERM_DOCTOR_ENV = envFile;
  process.env.PATH = `${binDir}:${previousPath || ""}`;

  const { createWebApp } = await import("./server");
  const app = createWebApp();
  const res = await app.fetch(
    new Request("http://deckterm.test/api/onboarding/doctor"),
  );

  expect(res.status).toBe(200);
  const payload = await res.json();
  expect(payload.status).toBe("ok");
  expect(payload.config.publishMode).toBe("cloudflare");
  expect(payload.checks).toContainEqual(
    expect.objectContaining({
      status: "ok",
      message:
        "DeckTerm app port is bound to localhost for proxy or tunnel publishing",
    }),
  );
  expect(payload.checks).toContainEqual(
    expect.objectContaining({
      status: "ok",
      message: "Cloudflare Access credentials are configured",
    }),
  );
  expect(payload.checks).toContainEqual(
    expect.objectContaining({
      status: "ok",
      message: "cloudflared is installed",
    }),
  );
  expect(payload.recommendations.join("\n")).toContain(
    "Keep only SSH and HTTPS public",
  );
});

test("onboarding doctor API validates an nginx publishing profile without Cloudflare Access", async () => {
  clearInheritedDoctorEnv();
  const dir = await createTempDir(".deckterm-onboarding-nginx-");
  const binDir = join(dir, "bin");
  const envFile = join(dir, ".env");
  const doctorScript = join(dir, "doctor.sh");

  await mkdir(binDir, { recursive: true });
  await writeFile(
    envFile,
    [
      "PORT=4174",
      "HOST=127.0.0.1",
      "TMUX_BACKEND=1",
      "DECKTERM_PUBLISH_MODE=nginx",
      "CF_ACCESS_REQUIRED=0",
      "TRUSTED_ORIGINS=https://deckterm.example.com",
      `ALLOWED_FILE_ROOTS=${dir}`,
      "",
    ].join("\n"),
  );
  await writeFile(
    doctorScript,
    [
      "#!/usr/bin/env bash",
      "echo 'DeckTerm doctor'",
      "echo 'OK: health endpoint responded'",
      "echo 'OK: doctor checks completed'",
      "",
    ].join("\n"),
  );
  await chmod(doctorScript, 0o755);
  await Bun.write(join(binDir, "tmux"), "#!/usr/bin/env bash\nexit 0\n");
  await Bun.write(join(binDir, "nginx"), "#!/usr/bin/env bash\nexit 0\n");
  await chmod(join(binDir, "tmux"), 0o755);
  await chmod(join(binDir, "nginx"), 0o755);

  process.env.DECKTERM_DOCTOR_SCRIPT = doctorScript;
  process.env.DECKTERM_DOCTOR_ENV = envFile;
  process.env.PATH = `${binDir}:${previousPath || ""}`;

  const { createWebApp } = await import("./server");
  const app = createWebApp();
  const res = await app.fetch(
    new Request("http://deckterm.test/api/onboarding/doctor"),
  );

  expect(res.status).toBe(200);
  const payload = await res.json();
  expect(payload.status).toBe("ok");
  expect(payload.config.publishMode).toBe("nginx");
  expect(payload.checks).toContainEqual(
    expect.objectContaining({
      status: "ok",
      message: "nginx is installed",
    }),
  );
  expect(payload.checks).not.toContainEqual(
    expect.objectContaining({
      message: "Cloudflare Access credentials are incomplete",
    }),
  );
});

test("onboarding doctor API returns a Cloudflare setup wizard plan", async () => {
  clearInheritedDoctorEnv();
  const dir = await createTempDir(".deckterm-onboarding-wizard-");
  const envFile = join(dir, ".env");
  const doctorScript = join(dir, "doctor.sh");

  await writeFile(
    envFile,
    [
      "PORT=4174",
      "HOST=0.0.0.0",
      "TMUX_BACKEND=0",
      "CF_ACCESS_REQUIRED=0",
      "",
    ].join("\n"),
  );
  await writeFile(
    doctorScript,
    [
      "#!/usr/bin/env bash",
      "echo 'DeckTerm doctor'",
      "echo 'OK: health endpoint responded'",
      "",
    ].join("\n"),
  );
  await chmod(doctorScript, 0o755);

  process.env.DECKTERM_DOCTOR_SCRIPT = doctorScript;
  process.env.DECKTERM_DOCTOR_ENV = envFile;

  const { createWebApp } = await import("./server");
  const app = createWebApp();
  const res = await app.fetch(
    new Request(
      "http://deckterm.test/api/onboarding/doctor?profile=cloudflare",
    ),
  );

  expect(res.status).toBe(200);
  const payload = await res.json();
  expect(payload.wizard.profile).toBe("cloudflare");
  expect(payload.wizard.snippets.env).toContain(
    "DECKTERM_PUBLISH_MODE=cloudflare",
  );
  expect(payload.wizard.snippets.env).toContain("HOST=127.0.0.1");
  expect(payload.wizard.snippets.cloudflared).toContain(
    "service: http://127.0.0.1:4174",
  );
  expect(payload.wizard.snippets.systemd).toContain("ExecStart=");
  expect(payload.wizard.remediations).toContainEqual(
    expect.objectContaining({
      id: "bind-localhost",
      env: expect.objectContaining({ HOST: "127.0.0.1" }),
    }),
  );
  expect(payload.wizard.remediations).toContainEqual(
    expect.objectContaining({
      id: "cloudflare-access",
      env: expect.objectContaining({ CF_ACCESS_REQUIRED: "1" }),
    }),
  );
});

test("onboarding doctor distinguishes Cloudflare request path from server Access validation", async () => {
  clearInheritedDoctorEnv();
  const dir = await createTempDir(".deckterm-onboarding-cf-request-");
  const envFile = join(dir, ".env");
  const doctorScript = join(dir, "doctor.sh");

  await writeFile(
    envFile,
    [
      "PORT=4174",
      "HOST=0.0.0.0",
      "TMUX_BACKEND=1",
      "CF_ACCESS_REQUIRED=0",
      "",
    ].join("\n"),
  );
  await writeFile(
    doctorScript,
    [
      "#!/usr/bin/env bash",
      "echo 'DeckTerm doctor'",
      "echo 'OK: health endpoint responded'",
      "",
    ].join("\n"),
  );
  await chmod(doctorScript, 0o755);

  process.env.DECKTERM_DOCTOR_SCRIPT = doctorScript;
  process.env.DECKTERM_DOCTOR_ENV = envFile;

  const { createWebApp } = await import("./server");
  const app = createWebApp();
  const res = await app.fetch(
    new Request(
      "https://deckterm.dev.learnai.cz/api/onboarding/doctor?profile=cloudflare&publicOrigin=https%3A%2F%2Fdeckterm.dev.learnai.cz",
      {
        headers: {
          "cf-ray": "example-ray",
          "cf-connecting-ip": "203.0.113.10",
          "x-forwarded-proto": "https",
        },
      },
    ),
  );

  expect(res.status).toBe(200);
  const payload = await res.json();
  expect(payload.requestContext).toEqual(
    expect.objectContaining({
      viaCloudflare: true,
      cfAccessJwtPresent: false,
      publicOrigin: "https://deckterm.dev.learnai.cz",
    }),
  );
  expect(payload.config.cfAccessRequired).toBe(false);
  expect(payload.wizard.snippets.env).toContain(
    "TRUSTED_ORIGINS=https://deckterm.dev.learnai.cz",
  );
  expect(payload.wizard.snippets.cloudflared).toContain(
    "hostname: deckterm.dev.learnai.cz",
  );
});

test("onboarding doctor reports cloudflare-tunnel profile as ok when only the edge protects DeckTerm", async () => {
  clearInheritedDoctorEnv();
  const dir = await createTempDir(".deckterm-onboarding-tunnel-profile-");
  const binDir = join(dir, "bin");
  const envFile = join(dir, ".env");
  const doctorScript = join(dir, "doctor.sh");

  await mkdir(binDir, { recursive: true });
  await writeFile(
    envFile,
    [
      "PORT=4174",
      "HOST=127.0.0.1",
      "TMUX_BACKEND=1",
      "DECKTERM_PUBLISH_MODE=cloudflare-tunnel",
      "CF_ACCESS_REQUIRED=0",
      "TRUSTED_ORIGINS=https://deckterm.example.com",
      `ALLOWED_FILE_ROOTS=${dir}`,
      "",
    ].join("\n"),
  );
  await writeFile(
    doctorScript,
    [
      "#!/usr/bin/env bash",
      "echo 'DeckTerm doctor'",
      "echo 'OK: health endpoint responded'",
      "",
    ].join("\n"),
  );
  await chmod(doctorScript, 0o755);
  await Bun.write(join(binDir, "tmux"), "#!/usr/bin/env bash\nexit 0\n");
  await Bun.write(join(binDir, "cloudflared"), "#!/usr/bin/env bash\nexit 0\n");
  await chmod(join(binDir, "tmux"), 0o755);
  await chmod(join(binDir, "cloudflared"), 0o755);

  process.env.DECKTERM_DOCTOR_SCRIPT = doctorScript;
  process.env.DECKTERM_DOCTOR_ENV = envFile;
  process.env.PATH = `${binDir}:${previousPath || ""}`;

  const { createWebApp } = await import("./server");
  const app = createWebApp();
  const res = await app.fetch(
    new Request("http://deckterm.test/api/onboarding/doctor"),
  );

  expect(res.status).toBe(200);
  const payload = await res.json();
  expect(payload.config.publishMode).toBe("cloudflare-tunnel");
  expect(payload.status).toBe("ok");
  // Tunnel-only profile must not surface Access-credential checks at all.
  expect(payload.checks).not.toContainEqual(
    expect.objectContaining({
      message: "Cloudflare Access credentials are incomplete",
    }),
  );
  // Wizard must not push the Configure-Access remediation for tunnel-only.
  expect(payload.wizard.remediations).not.toContainEqual(
    expect.objectContaining({ id: "cloudflare-access" }),
  );
  // .env snippet should NOT set CF_ACCESS_REQUIRED=1 for the tunnel profile.
  expect(payload.wizard.snippets.env).toContain("CF_ACCESS_REQUIRED=0");
  expect(payload.wizard.snippets.env).not.toContain("CF_ACCESS_REQUIRED=1");
});

test("onboarding apply API for cloudflare-tunnel profile leaves CF_ACCESS_REQUIRED=0", async () => {
  clearInheritedDoctorEnv();
  const dir = await createTempDir(".deckterm-onboarding-tunnel-apply-");
  const envFile = join(dir, ".env");
  const doctorScript = join(dir, "doctor.sh");

  await writeFile(
    envFile,
    ["PORT=4174", "HOST=0.0.0.0", "CF_ACCESS_REQUIRED=0", ""].join("\n"),
  );
  await writeFile(
    doctorScript,
    [
      "#!/usr/bin/env bash",
      "echo 'DeckTerm doctor'",
      "echo 'OK: health endpoint responded'",
      "",
    ].join("\n"),
  );
  await chmod(doctorScript, 0o755);

  process.env.DECKTERM_DOCTOR_SCRIPT = doctorScript;
  process.env.DECKTERM_DOCTOR_ENV = envFile;

  const { createWebApp } = await import("./server");
  const app = createWebApp();
  const res = await app.fetch(
    new Request("http://deckterm.test/api/onboarding/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile: "cloudflare-tunnel",
        allowedFileRoots: dir,
      }),
    }),
  );

  expect(res.status).toBe(200);
  const payload = await res.json();
  expect(payload.profile).toBe("cloudflare-tunnel");

  const content = await readFile(envFile, "utf8");
  expect(content).toContain("DECKTERM_PUBLISH_MODE=cloudflare-tunnel");
  expect(content).toContain("HOST=127.0.0.1");
  expect(content).toContain("CF_ACCESS_REQUIRED=0");
  expect(content).not.toContain("CF_ACCESS_REQUIRED=1");
});

test("legacy DECKTERM_PUBLISH_MODE=cloudflare keeps strict Access semantics for backward compatibility", async () => {
  clearInheritedDoctorEnv();
  const dir = await createTempDir(".deckterm-onboarding-legacy-cloudflare-");
  const binDir = join(dir, "bin");
  const envFile = join(dir, ".env");
  const doctorScript = join(dir, "doctor.sh");

  await mkdir(binDir, { recursive: true });
  await writeFile(
    envFile,
    [
      "PORT=4174",
      "HOST=127.0.0.1",
      "TMUX_BACKEND=1",
      "DECKTERM_PUBLISH_MODE=cloudflare",
      "CF_ACCESS_REQUIRED=1",
      "CF_ACCESS_TEAM_NAME=example-team",
      "CF_ACCESS_AUD=example-audience",
      "TRUSTED_ORIGINS=https://deckterm.example.com",
      `ALLOWED_FILE_ROOTS=${dir}`,
      "",
    ].join("\n"),
  );
  await writeFile(
    doctorScript,
    [
      "#!/usr/bin/env bash",
      "echo 'DeckTerm doctor'",
      "echo 'OK: health endpoint responded'",
      "echo 'OK: doctor checks completed'",
      "",
    ].join("\n"),
  );
  await chmod(doctorScript, 0o755);
  await Bun.write(join(binDir, "tmux"), "#!/usr/bin/env bash\nexit 0\n");
  await Bun.write(join(binDir, "cloudflared"), "#!/usr/bin/env bash\nexit 0\n");
  await chmod(join(binDir, "tmux"), 0o755);
  await chmod(join(binDir, "cloudflared"), 0o755);

  process.env.DECKTERM_DOCTOR_SCRIPT = doctorScript;
  process.env.DECKTERM_DOCTOR_ENV = envFile;
  process.env.PATH = `${binDir}:${previousPath || ""}`;

  const { createWebApp } = await import("./server");
  const app = createWebApp();
  const res = await app.fetch(
    new Request("http://deckterm.test/api/onboarding/doctor"),
  );

  expect(res.status).toBe(200);
  const payload = await res.json();
  expect(payload.status).toBe("ok");
  expect(payload.checks).toContainEqual(
    expect.objectContaining({
      status: "ok",
      message: "Cloudflare Access credentials are configured",
    }),
  );
});

test("onboarding doctor downgrades incomplete Access creds when a live JWT request reaches DeckTerm", async () => {
  clearInheritedDoctorEnv();
  const dir = await createTempDir(".deckterm-onboarding-live-jwt-");
  const binDir = join(dir, "bin");
  const envFile = join(dir, ".env");
  const doctorScript = join(dir, "doctor.sh");

  await mkdir(binDir, { recursive: true });
  await writeFile(
    envFile,
    [
      "PORT=4174",
      "HOST=127.0.0.1",
      "TMUX_BACKEND=1",
      "DECKTERM_PUBLISH_MODE=cloudflare",
      "CF_ACCESS_REQUIRED=1",
      "TRUSTED_ORIGINS=https://deckterm.example.com",
      `ALLOWED_FILE_ROOTS=${dir}`,
      "",
    ].join("\n"),
  );
  await writeFile(
    doctorScript,
    [
      "#!/usr/bin/env bash",
      "echo 'DeckTerm doctor'",
      "echo 'FAIL: CF_ACCESS_REQUIRED=1 but CF_ACCESS_TEAM_NAME is empty'",
      "echo 'FAIL: CF_ACCESS_REQUIRED=1 but CF_ACCESS_AUD is empty'",
      "exit 1",
      "",
    ].join("\n"),
  );
  await chmod(doctorScript, 0o755);
  await Bun.write(join(binDir, "tmux"), "#!/usr/bin/env bash\nexit 0\n");
  await Bun.write(join(binDir, "cloudflared"), "#!/usr/bin/env bash\nexit 0\n");
  await chmod(join(binDir, "tmux"), 0o755);
  await chmod(join(binDir, "cloudflared"), 0o755);

  process.env.DECKTERM_DOCTOR_SCRIPT = doctorScript;
  process.env.DECKTERM_DOCTOR_ENV = envFile;
  process.env.PATH = `${binDir}:${previousPath || ""}`;

  const { createWebApp } = await import("./server");
  const app = createWebApp();
  const res = await app.fetch(
    new Request(
      "https://deckterm.example.com/api/onboarding/doctor?profile=cloudflare",
      {
        headers: {
          "cf-ray": "live-ray",
          "cf-connecting-ip": "203.0.113.10",
          "cf-access-jwt-assertion": "header.payload.signature",
          "x-forwarded-proto": "https",
        },
      },
    ),
  );

  expect(res.status).toBe(200);
  const payload = await res.json();
  expect(payload.requestContext.viaCloudflare).toBe(true);
  expect(payload.requestContext.cfAccessJwtPresent).toBe(true);
  expect(payload.status).toBe("warning");

  const teamCheck = payload.checks.find(
    (c: { id: string }) =>
      c.id === "cf-access-required-1-but-cf-access-team-name-is-empty",
  );
  expect(teamCheck?.status).toBe("warning");
  const audCheck = payload.checks.find(
    (c: { id: string }) =>
      c.id === "cf-access-required-1-but-cf-access-aud-is-empty",
  );
  expect(audCheck?.status).toBe("warning");
  const credsCheck = payload.checks.find(
    (c: { id: string }) =>
      c.id === "cloudflare-access-credentials-are-incomplete",
  );
  expect(credsCheck?.status).toBe("warning");

  expect(payload.checks).toContainEqual(
    expect.objectContaining({
      status: "ok",
      message: expect.stringMatching(/Cloudflare Tunnel.*Access JWT.*reach/i),
    }),
  );

  expect(payload.recommendations.join("\n")).toMatch(
    /server-side JWT validation stays off/i,
  );
});

test("onboarding apply API writes safe Cloudflare settings without placeholders", async () => {
  clearInheritedDoctorEnv();
  const dir = await createTempDir(".deckterm-onboarding-apply-");
  const envFile = join(dir, ".env");
  const doctorScript = join(dir, "doctor.sh");

  await writeFile(
    envFile,
    [
      "PORT=4174",
      "HOST=0.0.0.0",
      "TMUX_BACKEND=0",
      "CF_ACCESS_REQUIRED=0",
      "",
    ].join("\n"),
  );
  await writeFile(
    doctorScript,
    [
      "#!/usr/bin/env bash",
      "echo 'DeckTerm doctor'",
      "echo 'OK: health endpoint responded'",
      "",
    ].join("\n"),
  );
  await chmod(doctorScript, 0o755);

  process.env.DECKTERM_DOCTOR_SCRIPT = doctorScript;
  process.env.DECKTERM_DOCTOR_ENV = envFile;

  const { createWebApp } = await import("./server");
  const app = createWebApp();
  const res = await app.fetch(
    new Request("http://deckterm.test/api/onboarding/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile: "cloudflare",
        allowedFileRoots: dir,
      }),
    }),
  );

  expect(res.status).toBe(200);
  const payload = await res.json();
  expect(payload.profile).toBe("cloudflare");
  expect(payload.applied).toContain("DECKTERM_PUBLISH_MODE");
  expect(payload.applied).toContain("HOST");
  expect(payload.manualSteps.join("\n")).toContain("public hostname");
  expect(payload.manualSteps.join("\n")).toContain("Cloudflare Access");

  const content = await readFile(envFile, "utf8");
  expect(content).toContain("DECKTERM_PUBLISH_MODE=cloudflare");
  expect(content).toContain("HOST=127.0.0.1");
  expect(content).toContain("TMUX_BACKEND=1");
  expect(content).toContain(`ALLOWED_FILE_ROOTS=${dir}`);
  expect(content).toContain("CF_ACCESS_REQUIRED=1");
  expect(content).not.toContain("deckterm.example.com");
  expect(content).not.toContain("your-team-name");
  expect(content).not.toContain("your-cloudflare-access-application-aud");
});
