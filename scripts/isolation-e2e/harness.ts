/**
 * Isolation e2e harness (plan 2026-07-03-alice-bob-isolation-e2e.md §1). Boots
 * a dedicated DeckTerm instance under DECKTERM_OS_ISOLATION=1 with a mock CF
 * Access edge, seeds an owner offline (the isolation startup gate requires an
 * owner at boot), and exposes persona-authenticated HTTP/WS helpers to the
 * spec. Never touches the running dev/prod services — its own temp state dir
 * and a probed free loopback port.
 *
 * The product is booted as a CHILD PROCESS with an explicit allowlisted env
 * (`env -i` semantics — we build the env map from scratch) so Bun's .env
 * auto-load / the dev service env cannot leak in (Codex #1/#5).
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeFoundationState,
  bootstrapFirstAdmin,
} from "../../backend/services/foundation-state.ts";
import { MockEdge, type Persona } from "./mock-edge.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const AUD = "e2e-fixed-aud";

export const PERSONAS = {
  owner: { sub: "e2e-owner-sub", email: "owner@e2e.local" },
  alice: { sub: "e2e-alice-sub", email: "alice@e2e.local" },
  bob: { sub: "e2e-bob-sub", email: "bob@e2e.local" },
  charlie: { sub: "e2e-charlie-sub", email: "charlie@e2e.local" },
  mallory: { sub: "e2e-mallory-sub", email: "mallory@e2e.local" },
} satisfies Record<string, Persona>;

export type BootMode = "cf" | "tunnel";

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {}, open() {}, close() {}, error() {} },
    });
    const port = srv.port;
    srv.stop();
    if (port) resolve(port);
    else reject(new Error("could not probe a free port"));
  });
}

function genCert(dir: string): { certPath: string; keyPath: string } {
  const certPath = join(dir, "mock-cert.pem");
  const keyPath = join(dir, "mock-key.pem");
  // SAN=IP:127.0.0.1 is mandatory (Codex #3) — Bun's TLS SAN check rejects the
  // cert otherwise even with the CA trusted.
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "2",
    "-subj",
    "/CN=deckterm-e2e",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
  ]);
  return { certPath, keyPath };
}

/** Base env every SUT boot gets — nothing inherited from the parent. */
function baseEnv(overrides: Record<string, string>): Record<string, string> {
  return {
    PATH:
      process.env.PATH ??
      "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: process.env.HOME ?? "/home/deploy",
    LANG: "C.UTF-8",
    ...overrides,
  };
}

export type SutHandle = {
  baseUrl: string;
  port: number;
  stop: () => Promise<void>;
  logPath: string;
};

async function waitForHealth(
  baseUrl: string,
  timeoutMs = 20000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await Bun.sleep(200);
  }
  throw new Error(
    `SUT health check timed out at ${baseUrl}: ${String(lastErr)}`,
  );
}

export class Harness {
  edge!: MockEdge;
  stateDir!: string;
  private tmpRoot!: string;
  private certPath!: string;
  private keyPath!: string;
  private sut: SutHandle | null = null;
  readonly aud = AUD;

  get baseUrl(): string {
    if (!this.sut) throw new Error("SUT not booted");
    return this.sut.baseUrl;
  }

  get teamName(): string {
    return this.edge.teamName;
  }

  /** One-time setup: temp dirs, cert, mock edge, offline owner seed. */
  async setup(): Promise<void> {
    this.tmpRoot = mkdtempSync(join(tmpdir(), "deckterm-iso-e2e-"));
    this.stateDir = join(this.tmpRoot, "state");
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });

    const cert = genCert(this.tmpRoot);
    this.certPath = cert.certPath;
    this.keyPath = cert.keyPath;

    const port = await findFreePort();
    this.edge = new MockEdge({
      port,
      aud: AUD,
      certPath: this.certPath,
      keyPath: this.keyPath,
    });
    await this.edge.start();

    await this.seedOwner();
  }

  /**
   * Bootstrap the owner offline so the isolation startup gate finds an owner.
   * Writes directly to the shared sqlite file the SUT will later open.
   */
  private async seedOwner(): Promise<void> {
    const env = {
      DECKTERM_STATE_DIR: this.stateDir,
      DECKTERM_BOOTSTRAP_ADMIN_EMAIL: PERSONAS.owner.email,
      CF_ACCESS_TEAM_NAME: this.edge.teamName,
    };
    const state = await initializeFoundationState({
      stateDir: this.stateDir,
      allowedFileRoots: [this.stateDir],
      env,
    });
    const result = await bootstrapFirstAdmin({
      state,
      stateDir: this.stateDir,
      actorUserId: PERSONAS.owner.sub,
      actorEmail: PERSONAS.owner.email,
      authIdentity: {
        provider: "cloudflare_access",
        providerSubject: PERSONAS.owner.sub,
      },
      env,
    });
    if (!("ok" in result) || !result.ok) {
      throw new Error(`offline owner seed failed: ${JSON.stringify(result)}`);
    }
    state.db.close();
  }

  /** Spawn the SUT in the given mode; resolves once healthy. */
  async boot(mode: BootMode): Promise<SutHandle> {
    if (this.sut) await this.stop();
    const port = await findFreePort();
    const logPath = join(this.tmpRoot, `sut-${mode}-${port}.log`);

    const common: Record<string, string> = {
      PORT: String(port),
      DECKTERM_STATE_DIR: this.stateDir,
      ALLOWED_FILE_ROOTS: "/home/dtalice:/home/dtbob",
      DECKTERM_OS_ISOLATION: "1",
      TMUX_BACKEND: "1",
      NODE_EXTRA_CA_CERTS: this.certPath,
      DECKTERM_MIN_UID: "1000",
      DECKTERM_OS_USERS_GROUP: "deckterm-users",
    };
    const modeEnv =
      mode === "cf"
        ? {
            CF_ACCESS_REQUIRED: "1",
            CF_ACCESS_TEAM_NAME: this.edge.teamName,
            CF_ACCESS_AUD: AUD,
            DECKTERM_BOOTSTRAP_ADMIN_EMAIL: PERSONAS.owner.email,
          }
        : {
            DECKTERM_PUBLISH_MODE: "cloudflare-tunnel",
          };

    const env = baseEnv({ ...common, ...modeEnv });
    const child = spawn(
      "bun",
      ["run", join(REPO_ROOT, "backend", "index.ts")],
      {
        cwd: REPO_ROOT,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d) => chunks.push(Buffer.from(d)));
    child.stderr.on("data", (d) => chunks.push(Buffer.from(d)));
    const writeLog = () => writeFileSync(logPath, Buffer.concat(chunks));

    const baseUrl = `http://127.0.0.1:${port}`;
    const stop = async () => {
      writeLog();
      child.kill("SIGTERM");
      await new Promise<void>((r) => {
        const t = setTimeout(() => {
          child.kill("SIGKILL");
          r();
        }, 4000);
        child.on("exit", () => {
          clearTimeout(t);
          r();
        });
      });
    };

    const exited = new Promise<never>((_, reject) => {
      child.on("exit", (code) => {
        writeLog();
        reject(
          new Error(
            `SUT exited early (code ${code}); log: ${logPath}\n${Buffer.concat(chunks).toString().slice(-2000)}`,
          ),
        );
      });
    });

    try {
      await Promise.race([waitForHealth(baseUrl), exited]);
    } catch (err) {
      await stop().catch(() => {});
      throw err;
    }

    this.sut = { baseUrl, port, stop, logPath };
    return this.sut;
  }

  /**
   * Attempt a boot that is EXPECTED to fail the startup gate. Returns the
   * captured stderr/stdout so the caller can assert on the refusal reason. Uses
   * a throwaway state dir unless one is supplied.
   */
  async expectBootFailure(
    extraEnv: Record<string, string>,
    stateDir?: string,
  ): Promise<string> {
    const port = await findFreePort();
    const env = baseEnv({
      PORT: String(port),
      DECKTERM_STATE_DIR:
        stateDir ?? mkdtempSync(join(this.tmpRoot, "negstate-")),
      ALLOWED_FILE_ROOTS: "/home/dtalice:/home/dtbob",
      DECKTERM_OS_ISOLATION: "1",
      CF_ACCESS_REQUIRED: "1",
      CF_ACCESS_TEAM_NAME: this.edge.teamName,
      CF_ACCESS_AUD: AUD,
      ...extraEnv,
    });
    const child = spawn(
      "bun",
      ["run", join(REPO_ROOT, "backend", "index.ts")],
      {
        cwd: REPO_ROOT,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d) => chunks.push(Buffer.from(d)));
    child.stderr.on("data", (d) => chunks.push(Buffer.from(d)));
    const baseUrl = `http://127.0.0.1:${port}`;
    const outcome = await Promise.race([
      new Promise<{ exited: true; code: number | null }>((r) =>
        child.on("exit", (code) => r({ exited: true, code })),
      ),
      waitForHealth(baseUrl, 8000)
        .then(() => ({ exited: false as const }))
        .catch(() => ({ exited: false as const })),
    ]);
    if (!("exited" in outcome) || !outcome.exited) {
      child.kill("SIGKILL");
      throw new Error(`expected boot to fail, but it became healthy or hung`);
    }
    return Buffer.concat(chunks).toString();
  }

  // ---- HTTP / WS helpers ----------------------------------------------------

  async mint(
    persona: Persona,
    opts?: Parameters<MockEdge["mint"]>[1],
  ): Promise<string> {
    return this.edge.mint(persona, opts);
  }

  /** HTTP request authenticated as a CF-Access persona (mode "cf"). */
  async fetchAs(
    persona: Persona | null,
    path: string,
    init: RequestInit & { rawJwt?: string } = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.rawJwt) headers.set("cf-access-jwt-assertion", init.rawJwt);
    else if (persona)
      headers.set("cf-access-jwt-assertion", await this.mint(persona));
    return fetch(`${this.baseUrl}${path}`, { ...init, headers });
  }

  /** HTTP request as a cloudflare-tunnel actor (mode "tunnel", phase B). */
  async fetchTunnel(
    email: string | null,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (email) headers.set("cf-access-authenticated-user-email", email);
    return fetch(`${this.baseUrl}${path}`, { ...init, headers });
  }

  async stop(): Promise<void> {
    if (this.sut) {
      await this.sut.stop();
      this.sut = null;
    }
  }

  /** Full teardown: stop SUT, stop edge, GC broker sessions, remove temp dirs. */
  async teardown(): Promise<void> {
    await this.stop().catch(() => {});
    await this.edge?.stop().catch(() => {});
    // Best-effort broker GC for any leftover isolated sessions (collects all).
    try {
      execFileSync(
        "sudo",
        ["-n", "/usr/local/lib/deckterm/deckterm-broker", "gc"],
        { stdio: "ignore" },
      );
    } catch {
      // ignore — GC is best-effort cleanup
    }
    if (this.tmpRoot) rmSync(this.tmpRoot, { recursive: true, force: true });
  }
}
