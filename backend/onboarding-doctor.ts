import { constants } from "node:fs";
import { access, readFile, writeFile, stat, chmod } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";

export type DoctorCheckStatus = "ok" | "warning" | "failed";
export type DoctorPublishMode =
  | "local"
  | "cloudflare"
  | "cloudflare-tunnel"
  | "cloudflare-access"
  | "nginx"
  | "direct";

function isCloudflareMode(mode: DoctorPublishMode): boolean {
  return (
    mode === "cloudflare" ||
    mode === "cloudflare-tunnel" ||
    mode === "cloudflare-access"
  );
}

function isStrictAccessMode(mode: DoctorPublishMode): boolean {
  // Legacy `cloudflare` keeps the historical strict semantics; explicit
  // `cloudflare-access` opts into them; `cloudflare-tunnel` does not.
  return mode === "cloudflare" || mode === "cloudflare-access";
}

export type DoctorCheck = {
  id: string;
  status: DoctorCheckStatus;
  message: string;
  raw: string;
  source?: "script" | "config";
};

export type DoctorConfig = {
  envFile: string;
  envFileExists: boolean;
  host: string;
  port: string;
  tmuxBackend: boolean;
  cfAccessRequired: boolean;
  cfAccessTeamConfigured: boolean;
  cfAccessAudienceConfigured: boolean;
  trustedOrigins: string[];
  trustedOriginsConfigured: boolean;
  allowedFileRoots: string[];
  publishMode: DoctorPublishMode;
};

export type DoctorRequestContext = {
  viaCloudflare: boolean;
  cfAccessJwtPresent: boolean;
  publicOrigin: string;
  host: string;
  forwardedProto: string;
};

export type SetupWizardRemediation = {
  id: string;
  title: string;
  detail: string;
  env?: Record<string, string>;
  commands?: string[];
};

export type SetupWizardSnippet = {
  label: string;
  language: string;
  content: string;
};

export type SetupWizardPlan = {
  profile: DoctorPublishMode;
  profileLabel: string;
  profileOptions: Array<{ value: DoctorPublishMode; label: string }>;
  remediations: SetupWizardRemediation[];
  snippets: {
    env: string;
    systemd: string;
    firewall: string;
    cloudflared?: string;
    nginx?: string;
  };
  snippetList: SetupWizardSnippet[];
};

export type OnboardingDoctorResult = {
  status: DoctorCheckStatus;
  generatedAt: string;
  envFile: string;
  scriptPath: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  checks: DoctorCheck[];
  config: DoctorConfig;
  requestContext: DoctorRequestContext;
  recommendations: string[];
  wizard: SetupWizardPlan;
};

export type OnboardingApplyResult = {
  profile: DoctorPublishMode;
  envFile: string;
  applied: string[];
  manualSteps: string[];
  report: OnboardingDoctorResult;
};

type RunDoctorOptions = {
  cwd?: string;
  envFile?: string;
  scriptPath?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  profile?: string;
  publicOrigin?: string;
  requestContext?: Partial<DoctorRequestContext>;
};

type ApplyOnboardingOptions = RunDoctorOptions & {
  allowedFileRoots?: string;
  publicOrigin?: string;
  cfAccessTeamName?: string;
  cfAccessAud?: string;
};

function slugifyCheckId(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "check"
  );
}

function stripEnvValueQuotes(value: string) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function serializeEnvValue(value: string) {
  if (/^[A-Za-z0-9_./:,@+=-]*$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

export function parseEnvContent(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ")
      ? line.slice(7).trim()
      : line;
    const separatorIndex = withoutExport.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = withoutExport.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    values[key] = stripEnvValueQuotes(withoutExport.slice(separatorIndex + 1));
  }
  return values;
}

function upsertEnvContent(content: string, updates: Record<string, string>) {
  const pending = new Map(Object.entries(updates));
  const lines = content.split(/\r?\n/);
  const nextLines = lines.map((rawLine) => {
    const line = rawLine.trim();
    const withoutExport = line.startsWith("export ")
      ? line.slice(7).trim()
      : line;
    const separatorIndex = withoutExport.indexOf("=");
    if (separatorIndex <= 0) return rawLine;

    const key = withoutExport.slice(0, separatorIndex).trim();
    if (!pending.has(key)) return rawLine;

    const value = pending.get(key) || "";
    pending.delete(key);
    return `${key}=${serializeEnvValue(value)}`;
  });

  while (nextLines.length && nextLines[nextLines.length - 1] === "") {
    nextLines.pop();
  }

  for (const [key, value] of pending) {
    nextLines.push(`${key}=${serializeEnvValue(value)}`);
  }

  return `${nextLines.join("\n")}\n`;
}

export function parseDoctorChecks(output: string): DoctorCheck[] {
  return output
    .split(/\r?\n/)
    .map((line): DoctorCheck | null => {
      const match = line.match(/^(OK|WARN|FAIL):\s*(.+)$/);
      if (!match) return null;

      const [, prefix, message] = match;
      const status =
        prefix === "OK" ? "ok" : prefix === "WARN" ? "warning" : "failed";
      return {
        id: slugifyCheckId(message),
        status,
        message,
        raw: line,
        source: "script",
      };
    })
    .filter((check): check is DoctorCheck => Boolean(check));
}

function splitCsv(value: string | undefined) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizePublicOrigin(value: string | undefined) {
  const origin = String(value || "").trim();
  if (!origin) return "";
  if (/^https?:\/\//i.test(origin)) return origin.replace(/\/+$/, "");
  return `https://${origin.replace(/\/+$/, "")}`;
}

function normalizePublishMode(value: string | undefined): DoctorPublishMode {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (
    normalized === "local" ||
    normalized === "cloudflare" ||
    normalized === "cloudflare-tunnel" ||
    normalized === "cloudflare-access" ||
    normalized === "nginx" ||
    normalized === "direct"
  ) {
    return normalized;
  }
  return "local";
}

function isLocalhostBind(host: string) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

const PROFILE_OPTIONS: SetupWizardPlan["profileOptions"] = [
  { value: "cloudflare-tunnel", label: "Cloudflare Tunnel (edge access only)" },
  {
    value: "cloudflare-access",
    label: "Cloudflare Tunnel + Access JWT (strict)",
  },
  { value: "nginx", label: "nginx reverse proxy" },
  { value: "local", label: "Local only" },
  { value: "direct", label: "Direct LAN" },
];

function getProfileLabel(profile: DoctorPublishMode) {
  return (
    PROFILE_OPTIONS.find((option) => option.value === profile)?.label || profile
  );
}

async function commandExists(command: string, env: NodeJS.ProcessEnv) {
  for (const dir of String(env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    try {
      await access(join(dir, command), constants.X_OK);
      return true;
    } catch {
      // Try the next PATH entry.
    }
  }
  return false;
}

async function readEnvConfig({
  envFile,
  env,
}: {
  envFile: string;
  env: NodeJS.ProcessEnv;
}): Promise<DoctorConfig> {
  let envFileExists = false;
  let envValues: Record<string, string> = {};
  try {
    envValues = parseEnvContent(await readFile(envFile, "utf8"));
    envFileExists = true;
  } catch {
    envValues = {};
  }

  const value = (key: string, fallback = "") =>
    envValues[key] ?? env[key] ?? fallback;

  const trustedOrigins = splitCsv(value("TRUSTED_ORIGINS"));

  return {
    envFile,
    envFileExists,
    host: value("HOST", "127.0.0.1"),
    port: value("PORT", "4174"),
    tmuxBackend: value("TMUX_BACKEND", "0") === "1",
    cfAccessRequired: value("CF_ACCESS_REQUIRED", "0") === "1",
    cfAccessTeamConfigured: Boolean(value("CF_ACCESS_TEAM_NAME")),
    cfAccessAudienceConfigured: Boolean(value("CF_ACCESS_AUD")),
    trustedOrigins,
    trustedOriginsConfigured: trustedOrigins.length > 0,
    allowedFileRoots: splitCsv(value("ALLOWED_FILE_ROOTS")),
    publishMode: normalizePublishMode(value("DECKTERM_PUBLISH_MODE", "")),
  };
}

function createConfigCheck(
  status: DoctorCheckStatus,
  message: string,
): DoctorCheck {
  return {
    id: slugifyCheckId(message),
    status,
    message,
    raw: `${status.toUpperCase()}: ${message}`,
    source: "config",
  };
}

async function buildDeploymentChecks({
  config,
  env,
}: {
  config: DoctorConfig;
  env: NodeJS.ProcessEnv;
}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const proxyMode =
    isCloudflareMode(config.publishMode) || config.publishMode === "nginx";

  checks.push(
    createConfigCheck(
      config.envFileExists ? "ok" : "warning",
      config.envFileExists
        ? "environment file is present"
        : "environment file is missing",
    ),
  );

  if (proxyMode) {
    const localhost = isLocalhostBind(config.host);
    checks.push(
      createConfigCheck(
        localhost ? "ok" : "failed",
        localhost
          ? "DeckTerm app port is bound to localhost for proxy or tunnel publishing"
          : "DeckTerm app port must bind to localhost when published through a proxy or tunnel",
      ),
    );
  } else if (config.host === "0.0.0.0") {
    checks.push(
      createConfigCheck(
        "warning",
        "DeckTerm app port is reachable on every interface",
      ),
    );
  } else {
    checks.push(
      createConfigCheck("ok", "DeckTerm app port is limited to a local bind"),
    );
  }

  if (config.tmuxBackend) {
    const tmuxAvailable = await commandExists("tmux", env);
    checks.push(
      createConfigCheck(
        tmuxAvailable ? "ok" : "failed",
        tmuxAvailable
          ? "tmux is installed"
          : "TMUX_BACKEND=1 but tmux is not installed",
      ),
    );
  } else {
    checks.push(
      createConfigCheck(
        "warning",
        "TMUX_BACKEND is disabled; terminal sessions will not survive server restarts",
      ),
    );
  }

  if (isCloudflareMode(config.publishMode)) {
    const cloudflaredAvailable = await commandExists("cloudflared", env);
    if (isStrictAccessMode(config.publishMode)) {
      const accessConfigured =
        config.cfAccessRequired &&
        config.cfAccessTeamConfigured &&
        config.cfAccessAudienceConfigured;
      checks.push(
        createConfigCheck(
          accessConfigured ? "ok" : "failed",
          accessConfigured
            ? "Cloudflare Access credentials are configured"
            : "Cloudflare Access credentials are incomplete",
        ),
      );
    }
    checks.push(
      createConfigCheck(
        cloudflaredAvailable ? "ok" : "failed",
        cloudflaredAvailable
          ? "cloudflared is installed"
          : "cloudflared is not installed",
      ),
    );
  }

  if (config.publishMode === "nginx") {
    const nginxAvailable = await commandExists("nginx", env);
    checks.push(
      createConfigCheck(
        nginxAvailable ? "ok" : "failed",
        nginxAvailable ? "nginx is installed" : "nginx is not installed",
      ),
    );
  }

  checks.push(
    createConfigCheck(
      config.trustedOriginsConfigured ? "ok" : "warning",
      config.trustedOriginsConfigured
        ? "TRUSTED_ORIGINS is configured"
        : "TRUSTED_ORIGINS is not configured",
    ),
  );

  checks.push(
    createConfigCheck(
      config.allowedFileRoots.length ? "ok" : "warning",
      config.allowedFileRoots.length
        ? "ALLOWED_FILE_ROOTS is configured"
        : "ALLOWED_FILE_ROOTS is not configured",
    ),
  );

  // 1. State Directory Presence and Permissions Check
  const stateDir =
    env.DECKTERM_STATE_DIR || join(env.HOME || "/home/deploy", ".deckterm");
  try {
    const dirStat = await stat(stateDir);
    checks.push(
      createConfigCheck("ok", `State directory exists at ${stateDir}`),
    );
    const isSecureDir = (dirStat.mode & 0o077) === 0;
    checks.push(
      createConfigCheck(
        isSecureDir ? "ok" : "warning",
        isSecureDir
          ? "State directory permissions are secure (0700)"
          : `State directory permissions should be 0700 (currently ${dirStat.mode.toString(8).slice(-3)})`,
      ),
    );
  } catch {
    // First-run: the state dir is created automatically on start, so its
    // absence is expected and must not downgrade the overall doctor status
    // (consistent with the state-DB check below).
    checks.push(
      createConfigCheck(
        "ok",
        `State directory at ${stateDir} will be created automatically on start`,
      ),
    );
  }

  // 2. State DB Writable Check
  const dbPath = join(stateDir, "deckterm.db");
  try {
    await access(dbPath, constants.W_OK);
    checks.push(
      createConfigCheck("ok", "State database file exists and is writable"),
    );
  } catch (err: any) {
    if (err.code === "ENOENT") {
      checks.push(
        createConfigCheck(
          "ok",
          "State database will be initialized automatically on start",
        ),
      );
    } else {
      checks.push(
        createConfigCheck(
          "failed",
          `State database file at ${dbPath} is not writable: ${err.message}`,
        ),
      );
    }
  }

  // 3. Bootstrap Token Check
  const tokenPath = join(stateDir, "bootstrap-token");
  try {
    const tokenStat = await stat(tokenPath);
    const isSecureToken = (tokenStat.mode & 0o077) === 0;
    checks.push(
      createConfigCheck(
        isSecureToken ? "ok" : "failed",
        isSecureToken
          ? "Bootstrap token file permissions are secure (0600)"
          : `Bootstrap token file permissions should be 0600 (currently ${tokenStat.mode.toString(8).slice(-3)})`,
      ),
    );
  } catch {}

  return checks;
}

const LIVE_JWT_DOWNGRADE_IDS = new Set([
  "cf-access-required-1-but-cf-access-team-name-is-empty",
  "cf-access-required-1-but-cf-access-aud-is-empty",
  "cloudflare-access-credentials-are-incomplete",
]);

function applyLiveCloudflareEvidence(
  checks: DoctorCheck[],
  requestContext: DoctorRequestContext,
) {
  if (!(requestContext.viaCloudflare && requestContext.cfAccessJwtPresent)) {
    return;
  }
  for (const check of checks) {
    if (check.status === "failed" && LIVE_JWT_DOWNGRADE_IDS.has(check.id)) {
      check.status = "warning";
      check.raw = check.raw.replace(/^FAIL(ED)?:/i, "WARN:");
    }
  }
  checks.push({
    id: "cloudflare-tunnel-and-access-reach-deckterm",
    status: "ok",
    message: "Cloudflare Tunnel and Access JWT reach DeckTerm right now",
    raw: "OK: Cloudflare Tunnel and Access JWT reach DeckTerm right now",
    source: "config",
  });
}

function buildRecommendations(
  config: DoctorConfig,
  checks: DoctorCheck[],
  requestContext: DoctorRequestContext,
) {
  const recommendations: string[] = [];
  const hasFailedCheck = checks.some((check) => check.status === "failed");
  const liveJwtIncompleteAudience =
    requestContext.viaCloudflare &&
    requestContext.cfAccessJwtPresent &&
    config.cfAccessRequired &&
    (!config.cfAccessTeamConfigured || !config.cfAccessAudienceConfigured);

  if (liveJwtIncompleteAudience) {
    recommendations.push(
      "Cloudflare Tunnel and Access already reach DeckTerm. Set CF_ACCESS_TEAM_NAME and CF_ACCESS_AUD so DeckTerm validates the JWT itself - until then server-side JWT validation stays off and you rely entirely on the Cloudflare edge.",
    );
  }

  if (
    config.host === "0.0.0.0" ||
    ((isCloudflareMode(config.publishMode) || config.publishMode === "nginx") &&
      !isLocalhostBind(config.host))
  ) {
    recommendations.push(
      "Use HOST=127.0.0.1 when DeckTerm is published through Cloudflare Tunnel or nginx.",
    );
  }

  if (isStrictAccessMode(config.publishMode) && !config.cfAccessRequired) {
    recommendations.push(
      "Set CF_ACCESS_REQUIRED=1 for the strict Cloudflare Access profile, or switch DECKTERM_PUBLISH_MODE to cloudflare-tunnel for edge-only protection.",
    );
  } else if (config.cfAccessRequired) {
    if (!config.cfAccessTeamConfigured) {
      recommendations.push(
        "Set CF_ACCESS_TEAM_NAME for Cloudflare Access JWT validation.",
      );
    }
    if (!config.cfAccessAudienceConfigured) {
      recommendations.push(
        "Set CF_ACCESS_AUD to the Cloudflare Access application audience tag.",
      );
    }
  }

  if (!config.trustedOriginsConfigured) {
    recommendations.push(
      "Set TRUSTED_ORIGINS to the public DeckTerm hostname.",
    );
  }

  if (!config.allowedFileRoots.length) {
    recommendations.push(
      "Set ALLOWED_FILE_ROOTS to the directories users may browse or edit.",
    );
  }

  if (!config.tmuxBackend) {
    recommendations.push(
      "Enable TMUX_BACKEND=1 for persistent terminal sessions on a server.",
    );
  }

  if (config.publishMode === "local") {
    recommendations.push(
      "Set DECKTERM_PUBLISH_MODE=cloudflare or DECKTERM_PUBLISH_MODE=nginx before publishing this server.",
    );
  }

  if (hasFailedCheck) {
    recommendations.push(
      "Fix failed doctor checks before opening public access.",
    );
  }

  recommendations.push(
    "Keep only SSH and HTTPS public; do not open the DeckTerm app port directly.",
  );

  return recommendations;
}

function getPrimaryOrigin(config: DoctorConfig, publicOrigin?: string) {
  return (
    normalizePublicOrigin(publicOrigin) ||
    config.trustedOrigins[0] ||
    "https://deckterm.example.com"
  );
}

function getAllowedRoots(config: DoctorConfig, env: NodeJS.ProcessEnv) {
  return config.allowedFileRoots.length
    ? config.allowedFileRoots.join(",")
    : env.HOME || "/home/deploy";
}

function buildApplyEnvUpdates({
  config,
  env,
  profile,
  options,
}: {
  config: DoctorConfig;
  env: NodeJS.ProcessEnv;
  profile: DoctorPublishMode;
  options: ApplyOnboardingOptions;
}) {
  const publicOrigin = normalizePublicOrigin(options.publicOrigin);
  const allowedFileRoots = String(options.allowedFileRoots || "").trim();
  const proxyMode = isCloudflareMode(profile) || profile === "nginx";
  const updates: Record<string, string> = {
    PORT: config.port || "4174",
    HOST:
      profile === "direct"
        ? config.host || "0.0.0.0"
        : proxyMode || profile === "local"
          ? "127.0.0.1"
          : config.host || "127.0.0.1",
    DECKTERM_PUBLISH_MODE: profile,
    TMUX_BACKEND: "1",
    TMUX_SESSION_NAMESPACE: "deckterm",
    ALLOWED_FILE_ROOTS: allowedFileRoots || getAllowedRoots(config, env),
  };

  if (profile !== "local" && publicOrigin) {
    updates.TRUSTED_ORIGINS = publicOrigin;
  }

  if (isStrictAccessMode(profile)) {
    updates.CF_ACCESS_REQUIRED = "1";
    if (options.cfAccessTeamName) {
      updates.CF_ACCESS_TEAM_NAME = String(options.cfAccessTeamName).trim();
    }
    if (options.cfAccessAud) {
      updates.CF_ACCESS_AUD = String(options.cfAccessAud).trim();
    }
  } else {
    updates.CF_ACCESS_REQUIRED = "0";
  }

  return updates;
}

function buildManualSteps({
  profile,
  options,
}: {
  profile: DoctorPublishMode;
  options: ApplyOnboardingOptions;
}) {
  const steps = [
    "Restart the DeckTerm service so the new .env values are used.",
  ];
  if (profile !== "local" && !normalizePublicOrigin(options.publicOrigin)) {
    steps.push("Set the public hostname before exposing the install.");
  }
  if (isCloudflareMode(profile)) {
    if (
      isStrictAccessMode(profile) &&
      (!options.cfAccessTeamName || !options.cfAccessAud)
    ) {
      steps.push("Fill Cloudflare Access team name and application AUD.");
    }
    steps.push("Create the Cloudflare Tunnel and route DNS to this server.");
  }
  if (profile === "nginx") {
    steps.push(
      "Install nginx, configure TLS, and proxy HTTPS to the local DeckTerm port.",
    );
  }
  if (profile === "direct") {
    steps.push(
      "Open only the DeckTerm port you intentionally want available on the LAN.",
    );
  }
  return steps;
}

function buildWizardEnv({
  config,
  env,
  profile,
  publicOrigin,
}: {
  config: DoctorConfig;
  env: NodeJS.ProcessEnv;
  profile: DoctorPublishMode;
  publicOrigin?: string;
}) {
  const proxyMode = isCloudflareMode(profile) || profile === "nginx";
  const origin = getPrimaryOrigin(config, publicOrigin);
  const lines = [
    `PORT=${config.port || "4174"}`,
    `HOST=${proxyMode ? "127.0.0.1" : config.host === "0.0.0.0" ? "127.0.0.1" : config.host || "127.0.0.1"}`,
    `DECKTERM_PUBLISH_MODE=${profile}`,
    "TMUX_BACKEND=1",
    "TMUX_SESSION_NAMESPACE=deckterm",
    `ALLOWED_FILE_ROOTS=${getAllowedRoots(config, env)}`,
    `TRUSTED_ORIGINS=${origin}`,
  ];

  if (isStrictAccessMode(profile)) {
    lines.push(
      "CF_ACCESS_REQUIRED=1",
      "CF_ACCESS_TEAM_NAME=your-team-name",
      "CF_ACCESS_AUD=your-cloudflare-access-application-aud",
    );
  } else {
    lines.push("CF_ACCESS_REQUIRED=0");
  }

  return `${lines.join("\n")}\n`;
}

function buildSystemdSnippet({
  cwd,
  envFile,
}: {
  cwd: string;
  envFile: string;
}) {
  return `[Unit]
Description=DeckTerm
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${cwd}
EnvironmentFile=${envFile}
ExecStart=${process.env.HOME || "/home/deploy"}/.bun/bin/bun run start
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
}

function buildCloudflaredSnippet(config: DoctorConfig, publicOrigin?: string) {
  const origin = getPrimaryOrigin(config, publicOrigin);
  const hostname = origin.replace(/^https?:\/\//, "");
  return `tunnel: deckterm
credentials-file: /home/deploy/.cloudflared/deckterm.json

ingress:
  - hostname: ${hostname}
    service: http://127.0.0.1:${config.port || "4174"}
  - service: http_status:404
`;
}

function buildNginxSnippet(config: DoctorConfig, publicOrigin?: string) {
  const origin = getPrimaryOrigin(config, publicOrigin);
  const hostname = origin.replace(/^https?:\/\//, "");
  return `server {
    listen 443 ssl http2;
    server_name ${hostname};

    location / {
        proxy_pass http://127.0.0.1:${config.port || "4174"};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
`;
}

function buildFirewallSnippet() {
  return `sudo ufw allow OpenSSH
sudo ufw allow 443/tcp
sudo ufw deny 4174/tcp
sudo ufw enable
`;
}

function buildWizardRemediations({
  config,
  env,
  profile,
}: {
  config: DoctorConfig;
  env: NodeJS.ProcessEnv;
  profile: DoctorPublishMode;
}) {
  const remediations: SetupWizardRemediation[] = [];
  const proxyMode = isCloudflareMode(profile) || profile === "nginx";

  if (config.publishMode !== profile) {
    remediations.push({
      id: "publish-mode",
      title: `Use ${getProfileLabel(profile)} profile`,
      detail:
        "Set the publish profile so doctor checks match the intended exposure path.",
      env: { DECKTERM_PUBLISH_MODE: profile },
    });
  }

  if (proxyMode && !isLocalhostBind(config.host)) {
    remediations.push({
      id: "bind-localhost",
      title: "Bind DeckTerm to localhost",
      detail:
        "Cloudflare Tunnel and nginx should proxy to a local-only Bun server.",
      env: { HOST: "127.0.0.1" },
    });
  }

  if (!config.tmuxBackend) {
    remediations.push({
      id: "enable-tmux",
      title: "Enable persistent tmux sessions",
      detail: "Dedicated installs should survive browser and service restarts.",
      env: { TMUX_BACKEND: "1", TMUX_SESSION_NAMESPACE: "deckterm" },
      commands: ["sudo apt-get install -y tmux"],
    });
  }

  if (!config.allowedFileRoots.length) {
    remediations.push({
      id: "allowed-file-roots",
      title: "Restrict file and git roots",
      detail:
        "Files and git APIs should operate only inside explicit workspace roots.",
      env: { ALLOWED_FILE_ROOTS: getAllowedRoots(config, env) },
    });
  }

  if (!config.trustedOriginsConfigured && profile !== "local") {
    remediations.push({
      id: "trusted-origins",
      title: "Set trusted browser origin",
      detail:
        "Published installs should accept browser requests only from the public hostname.",
      env: { TRUSTED_ORIGINS: getPrimaryOrigin(config) },
    });
  }

  if (
    isStrictAccessMode(profile) &&
    (!config.cfAccessRequired ||
      !config.cfAccessTeamConfigured ||
      !config.cfAccessAudienceConfigured)
  ) {
    remediations.push({
      id: "cloudflare-access",
      title: "Configure Cloudflare Access",
      detail:
        "Cloudflare Tunnel should require Access JWT validation before DeckTerm accepts requests.",
      env: {
        CF_ACCESS_REQUIRED: "1",
        CF_ACCESS_TEAM_NAME: "your-team-name",
        CF_ACCESS_AUD: "your-cloudflare-access-application-aud",
      },
    });
  }

  if (isCloudflareMode(profile)) {
    remediations.push({
      id: "cloudflared-service",
      title: "Install and route cloudflared",
      detail:
        "Route the public hostname to the local DeckTerm port through Cloudflare Tunnel.",
      commands: [
        "cloudflared tunnel create deckterm",
        "cloudflared tunnel route dns deckterm deckterm.example.com",
        "sudo systemctl enable --now cloudflared",
      ],
    });
  }

  if (profile === "nginx") {
    remediations.push({
      id: "nginx-proxy",
      title: "Install nginx reverse proxy",
      detail: "Proxy HTTPS and WebSocket traffic to the local DeckTerm port.",
      commands: [
        "sudo apt-get install -y nginx",
        "sudo systemctl enable --now nginx",
      ],
    });
  }

  return remediations;
}

function buildSetupWizard({
  config,
  env,
  cwd,
  envFile,
  requestedProfile,
  publicOrigin,
}: {
  config: DoctorConfig;
  env: NodeJS.ProcessEnv;
  cwd: string;
  envFile: string;
  requestedProfile?: string;
  publicOrigin?: string;
}): SetupWizardPlan {
  const profile = requestedProfile
    ? normalizePublishMode(requestedProfile)
    : config.publishMode;
  const snippets: SetupWizardPlan["snippets"] = {
    env: buildWizardEnv({ config, env, profile, publicOrigin }),
    systemd: buildSystemdSnippet({ cwd, envFile }),
    firewall: buildFirewallSnippet(),
  };

  if (isCloudflareMode(profile)) {
    snippets.cloudflared = buildCloudflaredSnippet(config, publicOrigin);
  }
  if (profile === "nginx") {
    snippets.nginx = buildNginxSnippet(config, publicOrigin);
  }

  const snippetList: SetupWizardSnippet[] = [
    { label: ".env", language: "dotenv", content: snippets.env },
    {
      label: "systemd user service",
      language: "ini",
      content: snippets.systemd,
    },
    { label: "firewall", language: "bash", content: snippets.firewall },
  ];
  if (snippets.cloudflared) {
    snippetList.push({
      label: "cloudflared config",
      language: "yaml",
      content: snippets.cloudflared,
    });
  }
  if (snippets.nginx) {
    snippetList.push({
      label: "nginx server block",
      language: "nginx",
      content: snippets.nginx,
    });
  }

  return {
    profile,
    profileLabel: getProfileLabel(profile),
    profileOptions: PROFILE_OPTIONS,
    remediations: buildWizardRemediations({ config, env, profile }),
    snippets,
    snippetList,
  };
}

function resolveStatus({
  checks,
  exitCode,
  timedOut,
}: {
  checks: DoctorCheck[];
  exitCode: number | null;
  timedOut: boolean;
}): DoctorCheckStatus {
  if (
    timedOut ||
    exitCode !== 0 ||
    checks.some((check) => check.status === "failed")
  ) {
    return "failed";
  }
  if (checks.some((check) => check.status === "warning")) {
    return "warning";
  }
  return "ok";
}

function buildRequestContext({
  config,
  publicOrigin,
  requestContext,
}: {
  config: DoctorConfig;
  publicOrigin?: string;
  requestContext?: Partial<DoctorRequestContext>;
}): DoctorRequestContext {
  return {
    viaCloudflare: Boolean(requestContext?.viaCloudflare),
    cfAccessJwtPresent: Boolean(requestContext?.cfAccessJwtPresent),
    publicOrigin:
      normalizePublicOrigin(publicOrigin) ||
      normalizePublicOrigin(requestContext?.publicOrigin) ||
      config.trustedOrigins[0] ||
      "",
    host: requestContext?.host || "",
    forwardedProto: requestContext?.forwardedProto || "",
  };
}

export async function runOnboardingDoctor(
  options: RunDoctorOptions = {},
): Promise<OnboardingDoctorResult> {
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const envFile = resolve(
    cwd,
    options.envFile || env.DECKTERM_DOCTOR_ENV || ".env",
  );
  const scriptPath = resolve(
    cwd,
    options.scriptPath || env.DECKTERM_DOCTOR_SCRIPT || "scripts/doctor.sh",
  );
  const timeoutMs = Math.max(1_000, options.timeoutMs || 15_000);
  const config = await readEnvConfig({ envFile, env });
  const requestContext = buildRequestContext({
    config,
    publicOrigin: options.publicOrigin,
    requestContext: options.requestContext,
  });

  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let timedOut = false;
  let checks: DoctorCheck[] = [];

  try {
    const proc = Bun.spawn(["bash", scriptPath, envFile], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: env as Record<string, string>,
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timeout);
    checks = parseDoctorChecks(`${stdout}\n${stderr}`);
  } catch (err) {
    stderr = err instanceof Error ? err.message : String(err);
    checks = [
      {
        id: "doctor-script",
        status: "failed",
        message: "doctor script could not be executed",
        raw: stderr,
        source: "script",
      },
    ];
  }

  checks = [...checks, ...(await buildDeploymentChecks({ config, env }))];
  applyLiveCloudflareEvidence(checks, requestContext);
  const liveJwtRescue =
    requestContext.viaCloudflare &&
    requestContext.cfAccessJwtPresent &&
    !checks.some((c) => c.status === "failed");
  const effectiveExitCode = liveJwtRescue ? 0 : exitCode;
  const status = resolveStatus({
    checks,
    exitCode: effectiveExitCode,
    timedOut,
  });
  return {
    status,
    generatedAt: new Date().toISOString(),
    envFile,
    scriptPath,
    exitCode,
    timedOut,
    stdout,
    stderr,
    checks,
    config,
    requestContext,
    recommendations: buildRecommendations(config, checks, requestContext),
    wizard: buildSetupWizard({
      config,
      env,
      cwd,
      envFile,
      requestedProfile: options.profile,
      publicOrigin: requestContext.publicOrigin,
    }),
  };
}

export async function applyOnboardingProfile(
  options: ApplyOnboardingOptions = {},
): Promise<OnboardingApplyResult> {
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const envFile = resolve(
    cwd,
    options.envFile || env.DECKTERM_DOCTOR_ENV || ".env",
  );
  const profile = normalizePublishMode(options.profile);
  const config = await readEnvConfig({ envFile, env });
  const updates = buildApplyEnvUpdates({ config, env, profile, options });

  let currentContent = "";
  try {
    currentContent = await readFile(envFile, "utf8");
  } catch {
    currentContent = "";
  }

  await writeFile(envFile, upsertEnvContent(currentContent, updates));

  return {
    profile,
    envFile,
    applied: Object.keys(updates),
    manualSteps: buildManualSteps({ profile, options }),
    report: await runOnboardingDoctor({
      ...options,
      cwd,
      envFile,
      env,
      profile,
    }),
  };
}

export async function applyOnboardingRemediation(
  remediationId: string,
  options: ApplyOnboardingOptions = {},
): Promise<{
  success: boolean;
  applied: string[];
  report?: OnboardingDoctorResult;
}> {
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const envFile = resolve(
    cwd,
    options.envFile || env.DECKTERM_DOCTOR_ENV || ".env",
  );

  const config = await readEnvConfig({ envFile, env });
  const profile = normalizePublishMode(options.profile || config.publishMode);
  const remediations = buildWizardRemediations({ config, env, profile });
  const found = remediations.find((r) => r.id === remediationId);

  if (!found) {
    return { success: false, applied: [] };
  }

  const updates: Record<string, string> = { ...found.env };

  // Handle placeholders
  if (remediationId === "cloudflare-access") {
    if (options.cfAccessTeamName) {
      updates.CF_ACCESS_TEAM_NAME = String(options.cfAccessTeamName).trim();
    }
    if (options.cfAccessAud) {
      updates.CF_ACCESS_AUD = String(options.cfAccessAud).trim();
    }
  } else if (remediationId === "trusted-origins" && options.publicOrigin) {
    updates.TRUSTED_ORIGINS = String(options.publicOrigin).trim();
  }

  let currentContent = "";
  try {
    currentContent = await readFile(envFile, "utf8");
  } catch {
    currentContent = "";
  }

  await writeFile(envFile, upsertEnvContent(currentContent, updates));

  const report = await runOnboardingDoctor({
    ...options,
    cwd,
    envFile,
    env,
    profile,
  });

  return {
    success: true,
    applied: Object.keys(updates),
    report,
  };
}
