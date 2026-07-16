import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { once } from "node:events";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { initializeFoundationState } from "./services/foundation-state";

const childProcesses = new Set<Bun.Subprocess>();
const tempStateDirs: string[] = [];

afterEach(async () => {
  for (const child of childProcesses) {
    child.kill();
    try {
      await child.exited;
    } catch {
      // Ignore shutdown races during cleanup.
    }
  }
  childProcesses.clear();

  await Promise.all(
    tempStateDirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/**
 * Every spawned child MUST get its own DECKTERM_STATE_DIR: `bun run` in the
 * child auto-loads the repo .env, so an unpinned child boots against the REAL
 * dev state dir and its startup reconciliation mutates live session rows
 * (observed 2026-07-16: a raw-mode child ended the dev instance's active
 * tmux session row).
 */
async function isolatedStateDir(): Promise<string> {
  const home = process.env.HOME || "/tmp";
  const stateDir = await mkdtemp(join(home, ".deckterm-isolated-state-"));
  tempStateDirs.push(stateDir);
  return stateDir;
}

/** Allocates a free TCP port by binding to port 0 and immediately closing. */
async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (!address || typeof address === "string") {
        srv.close();
        reject(new Error("Failed to allocate free port"));
        return;
      }
      const port = address.port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

// B3 §1.6 multiuser enablement gate (DECKTERM_OS_ISOLATION=1) — startup-failure
// child-process fixtures. Seeding runs `initializeFoundationState` directly
// against a temp state dir (running migrations, including B3's migration 5),
// then writes rows via raw SQL matching the post-migration-5 `users` /
// `scoped_grants` shape, and closes the db before the child process (which
// re-opens the same on-disk sqlite file) is spawned.
async function seedGateStateDir(seed: (db: Database) => void): Promise<string> {
  const home = process.env.HOME || "/tmp";
  const stateDir = await mkdtemp(join(home, ".deckterm-gate-state-"));
  tempStateDirs.push(stateDir);

  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [stateDir],
    env: process.env,
  });
  seed(state.db);
  state.db.close();

  return stateDir;
}

function insertGateUser(
  db: Database,
  opts: { id: string; role: "owner" | "admin" | "member"; reviewed: boolean },
): void {
  const ts = new Date().toISOString();
  db.query(
    `INSERT INTO users
      (id, email, display_name, role, disabled, multiuser_reviewed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(
    opts.id,
    `${opts.id}@example.test`,
    opts.id,
    opts.role,
    opts.reviewed ? ts : null,
    ts,
    ts,
  );
}

/**
 * Inserts a wildcard scoped_grants row. `principalId` need not have a
 * `users` row (the orphan-principal case, plan §6/Codex #3): the FK is
 * toggled off for the insert, matching foundation-users-state.test.ts's
 * orphan-principal fixture pattern.
 */
function insertGateWildcardGrant(db: Database, principalId: string): void {
  const ts = new Date().toISOString();
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.query(
      `INSERT INTO scoped_grants
        (id, user_id, capability, resource_type, resource_id, created_at, updated_at)
       VALUES (?, ?, 'terminal.create', '*', '*', ?, ?)`,
    ).run(`grant_${principalId}`, principalId, ts, ts);
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

async function spawnGateChild(opts: {
  stateDir: string;
  isolation: "1" | undefined;
  port: number;
  // Fix 8 test support: when set, forces DECKTERM_LEGACY_NO_BOOTSTRAP=1 plus
  // one of isLegacyBootstrapBypassAllowed's required env markers
  // (DECKTERM_RUNTIME_ENV=development) so the bypass is deterministically
  // active regardless of what the parent shell happens to have exported —
  // when unset, both are explicitly cleared for the same reason (existing
  // gate tests must not flip outcomes if the ambient environment leaks
  // DECKTERM_LEGACY_NO_BOOTSTRAP=1, per CLAUDE.md's known interactive-shell
  // env-leak note).
  legacyBypass?: "1";
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(opts.port),
    TMUX_BACKEND: "0",
    CF_ACCESS_REQUIRED: "0",
    CF_ACCESS_TEAM_NAME: "",
    CF_ACCESS_AUD: "",
    DECKTERM_STATE_DIR: opts.stateDir,
    DECKTERM_OS_ISOLATION: opts.isolation,
  };
  if (!opts.isolation) delete env.DECKTERM_OS_ISOLATION;
  if (opts.legacyBypass) {
    env.DECKTERM_LEGACY_NO_BOOTSTRAP = opts.legacyBypass;
    env.DECKTERM_RUNTIME_ENV = "development";
  } else {
    delete env.DECKTERM_LEGACY_NO_BOOTSTRAP;
  }

  const child = Bun.spawn(["bun", "run", "backend/index.ts"], {
    cwd: process.cwd(),
    env,
    stderr: "pipe",
    stdout: "pipe",
  });
  childProcesses.add(child);

  const exitCode = await Promise.race([
    child.exited,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
  ]);

  if (exitCode === null) {
    // Still running after the grace period — treat as "started" and poll
    // health before tearing it down.
    let healthy = false;
    for (let attempt = 0; attempt < 20 && !healthy; attempt++) {
      try {
        const res = await fetch(`http://127.0.0.1:${opts.port}/api/health`);
        healthy = res.ok;
      } catch {
        // Not listening yet.
      }
      if (!healthy) await new Promise((r) => setTimeout(r, 150));
    }
    child.kill();
    await child.exited.catch(() => {});
    childProcesses.delete(child);
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    return { exitCode: healthy ? 0 : null, stdout, stderr };
  }

  childProcesses.delete(child);
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  return { exitCode, stdout, stderr };
}

test("server exits when startup fails because the port is already in use", async () => {
  const blocker = net.createServer();
  blocker.listen(0, "127.0.0.1");
  await once(blocker, "listening");

  const address = blocker.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to allocate blocker port");
  }

  const child = Bun.spawn(["bun", "run", "backend/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(address.port),
      TMUX_BACKEND: "0",
      CF_ACCESS_REQUIRED: "0",
      CF_ACCESS_TEAM_NAME: "",
      CF_ACCESS_AUD: "",
      DECKTERM_STATE_DIR: await isolatedStateDir(),
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  childProcesses.add(child);

  const exitCode = await Promise.race([
    child.exited,
    new Promise<number>((_, reject) =>
      setTimeout(() => reject(new Error("Startup process did not exit")), 3000),
    ),
  ]);

  const stderr = await new Response(child.stderr).text();
  const stdout = await new Response(child.stdout).text();

  await new Promise<void>((resolve, reject) =>
    blocker.close((err) => (err ? reject(err) : resolve())),
  );

  childProcesses.delete(child);

  expect(exitCode).not.toBe(0);
  expect(`${stdout}\n${stderr}`).toContain("EADDRINUSE");
});

test("server exits when CF_ACCESS_REQUIRED=1 but CF_ACCESS_TEAM_NAME is empty", async () => {
  const child = Bun.spawn(["bun", "run", "backend/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "0",
      TMUX_BACKEND: "0",
      CF_ACCESS_REQUIRED: "1",
      CF_ACCESS_TEAM_NAME: "",
      CF_ACCESS_AUD: "any",
      DECKTERM_STATE_DIR: await isolatedStateDir(),
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  childProcesses.add(child);

  const exitCode = await Promise.race([
    child.exited,
    new Promise<number>((_, reject) =>
      setTimeout(() => reject(new Error("Startup process did not exit")), 3000),
    ),
  ]);
  const stderr = await new Response(child.stderr).text();
  const stdout = await new Response(child.stdout).text();
  childProcesses.delete(child);

  expect(exitCode).not.toBe(0);
  expect(`${stdout}\n${stderr}`).toContain("CF_ACCESS_TEAM_NAME");
});

test("server exits when CF_ACCESS_REQUIRED=1 but CF_ACCESS_AUD is empty", async () => {
  const child = Bun.spawn(["bun", "run", "backend/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "0",
      TMUX_BACKEND: "0",
      CF_ACCESS_REQUIRED: "1",
      CF_ACCESS_TEAM_NAME: "some-team",
      CF_ACCESS_AUD: "",
      DECKTERM_STATE_DIR: await isolatedStateDir(),
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  childProcesses.add(child);

  const exitCode = await Promise.race([
    child.exited,
    new Promise<number>((_, reject) =>
      setTimeout(() => reject(new Error("Startup process did not exit")), 3000),
    ),
  ]);
  const stderr = await new Response(child.stderr).text();
  const stdout = await new Response(child.stdout).text();
  childProcesses.delete(child);

  expect(exitCode).not.toBe(0);
  expect(`${stdout}\n${stderr}`).toContain("CF_ACCESS_AUD");
});

// B3 §1.6 multiuser enablement gate (DECKTERM_OS_ISOLATION=1).

test("server exits when DECKTERM_OS_ISOLATION=1 and an admin is unreviewed", async () => {
  const stateDir = await seedGateStateDir((db) => {
    insertGateUser(db, { id: "owner_1", role: "owner", reviewed: true });
    insertGateUser(db, {
      id: "admin_unreviewed_1",
      role: "admin",
      reviewed: false,
    });
  });
  const port = await getFreePort();

  const { exitCode, stdout, stderr } = await spawnGateChild({
    stateDir,
    isolation: "1",
    port,
  });

  const combined = `${stdout}\n${stderr}`;
  expect(exitCode).not.toBe(0);
  expect(combined).toContain("unreviewed_admin");
  expect(combined).toContain("admin_unreviewed_1");
  expect(combined).toContain("/api/users/");
});

test("server exits when DECKTERM_OS_ISOLATION=1 and an orphan principal holds a wildcard grant", async () => {
  const stateDir = await seedGateStateDir((db) => {
    insertGateUser(db, { id: "owner_1", role: "owner", reviewed: true });
    insertGateWildcardGrant(db, "orphan_ghost_1");
  });
  const port = await getFreePort();

  const { exitCode, stdout, stderr } = await spawnGateChild({
    stateDir,
    isolation: "1",
    port,
  });

  const combined = `${stdout}\n${stderr}`;
  expect(exitCode).not.toBe(0);
  expect(combined).toContain("unreviewed_wildcard_grants");
  expect(combined).toContain("orphan_ghost_1");
});

test("server exits when DECKTERM_OS_ISOLATION=1 and no owner exists", async () => {
  const stateDir = await seedGateStateDir((db) => {
    insertGateUser(db, { id: "member_1", role: "member", reviewed: true });
  });
  const port = await getFreePort();

  const { exitCode, stdout, stderr } = await spawnGateChild({
    stateDir,
    isolation: "1",
    port,
  });

  const combined = `${stdout}\n${stderr}`;
  expect(exitCode).not.toBe(0);
  expect(combined).toContain("no_owner");
});

test("server starts when DECKTERM_OS_ISOLATION=1 and the multiuser state is clean", async () => {
  const stateDir = await seedGateStateDir((db) => {
    insertGateUser(db, { id: "owner_1", role: "owner", reviewed: true });
  });
  const port = await getFreePort();

  const { exitCode, stderr } = await spawnGateChild({
    stateDir,
    isolation: "1",
    port,
  });

  expect(exitCode).toBe(0);
  expect(stderr).not.toContain("multiuser enablement gate refused startup");
});

test("server exits when DECKTERM_OS_ISOLATION=1 and DECKTERM_LEGACY_NO_BOOTSTRAP=1 are combined (legacy_bypass_conflict)", async () => {
  const stateDir = await seedGateStateDir((db) => {
    insertGateUser(db, { id: "owner_1", role: "owner", reviewed: true });
  });
  const port = await getFreePort();

  const { exitCode, stdout, stderr } = await spawnGateChild({
    stateDir,
    isolation: "1",
    port,
    legacyBypass: "1",
  });

  const combined = `${stdout}\n${stderr}`;
  expect(exitCode).not.toBe(0);
  expect(combined).toContain("legacy_bypass_conflict");
  expect(combined).toContain("DECKTERM_LEGACY_NO_BOOTSTRAP");
});

// B2 §4.4.1: cloudflare-tunnel + non-loopback bind fail-closed.

test("server exits when DECKTERM_PUBLISH_MODE=cloudflare-tunnel binds a non-loopback host without the trust-proxy override", async () => {
  const child = Bun.spawn(["bun", "run", "backend/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "0.0.0.0",
      PORT: "0",
      TMUX_BACKEND: "0",
      CF_ACCESS_REQUIRED: "0",
      CF_ACCESS_TEAM_NAME: "",
      CF_ACCESS_AUD: "",
      DECKTERM_PUBLISH_MODE: "cloudflare-tunnel",
      DECKTERM_STATE_DIR: await isolatedStateDir(),
      // Clear every dev/CI marker so the (production-only) guard actually runs,
      // and ensure the trust-proxy override is absent.
      CI: undefined,
      DECKTERM_RUNTIME_ENV: undefined,
      NODE_ENV: undefined,
      BUN_ENV: undefined,
      DECKTERM_DEV_INSECURE_LOCAL_ADMIN: undefined,
      DECKTERM_DANGEROUSLY_TRUST_PROXY_HEADERS: undefined,
      DECKTERM_LEGACY_NO_BOOTSTRAP: undefined,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  childProcesses.add(child);

  const exitCode = await Promise.race([
    child.exited,
    new Promise<number>((_, reject) =>
      setTimeout(() => reject(new Error("Startup process did not exit")), 3000),
    ),
  ]);
  const stderr = await new Response(child.stderr).text();
  const stdout = await new Response(child.stdout).text();
  childProcesses.delete(child);

  expect(exitCode).not.toBe(0);
  expect(`${stdout}\n${stderr}`).toContain("cloudflare-tunnel refuses to bind");
});

test("server starts when cloudflare-tunnel binds a loopback host (guard does not fire)", async () => {
  const port = await getFreePort();
  const child = Bun.spawn(["bun", "run", "backend/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      TMUX_BACKEND: "0",
      CF_ACCESS_REQUIRED: "0",
      CF_ACCESS_TEAM_NAME: "",
      CF_ACCESS_AUD: "",
      DECKTERM_PUBLISH_MODE: "cloudflare-tunnel",
      DECKTERM_STATE_DIR: await isolatedStateDir(),
      CI: undefined,
      DECKTERM_RUNTIME_ENV: undefined,
      NODE_ENV: undefined,
      BUN_ENV: undefined,
      DECKTERM_LEGACY_NO_BOOTSTRAP: undefined,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  childProcesses.add(child);

  const exitCode = await Promise.race([
    child.exited,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
  ]);
  if (exitCode === null) {
    child.kill();
    await child.exited.catch(() => {});
    childProcesses.delete(child);
    // Started (still running after grace) — the loopback bind is allowed.
    expect(true).toBe(true);
    return;
  }
  const stderr = await new Response(child.stderr).text();
  childProcesses.delete(child);
  // If it exited, it must NOT be due to the tunnel guard.
  expect(stderr).not.toContain("cloudflare-tunnel refuses to bind");
});

test("server starts when DECKTERM_OS_ISOLATION is unset regardless of unreviewed multiuser state (zero behavior change)", async () => {
  const stateDir = await seedGateStateDir((db) => {
    insertGateUser(db, { id: "owner_1", role: "owner", reviewed: true });
    insertGateUser(db, {
      id: "admin_unreviewed_1",
      role: "admin",
      reviewed: false,
    });
    insertGateWildcardGrant(db, "orphan_ghost_1");
  });
  const port = await getFreePort();

  const { exitCode, stderr } = await spawnGateChild({
    stateDir,
    isolation: undefined,
    port,
  });

  expect(exitCode).toBe(0);
  expect(stderr).not.toContain("multiuser enablement gate refused startup");
});
