import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initializeFoundationState,
  recordTerminalSession,
} from "./services/foundation-state";

test("preflight is inert and a second process cannot migrate/reconcile the same state on another port", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deckterm-preflight-"));
  const stateDir = join(dir, "state");
  const root = join(dir, "project");
  await mkdir(root);
  const env = {
    ...process.env,
    DECKTERM_STATE_DIR: stateDir,
    ALLOWED_FILE_ROOTS: root,
    HOST: "127.0.0.1",
    PORT: "0",
    CF_ACCESS_REQUIRED: "0",
    CF_ACCESS_TEAM_NAME: "",
    CF_ACCESS_AUD: "",
    DECKTERM_OS_ISOLATION: "0",
    DECKTERM_PREFLIGHT: "1",
    DECKTERM_RELEASE: "audit-preflight-test",
    DECKTERM_PUBLISH_MODE: "local",
    DECKTERM_RUNTIME_ENV: "development",
    DECKTERM_LEGACY_NO_BOOTSTRAP: "1",
    TMUX_BACKEND: "1",
    TMUX_SESSION_NAMESPACE: "audit-private",
    DECKTERM_CAPTURE_ROOT: join(dir, "capture"),
  };
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [root],
    env,
  });
  recordTerminalSession(state.db, {
    id: "preflight-sentinel",
    cwd: root,
    status: "active",
  });
  state.db.close();
  const script = `import { startWebServer } from ${JSON.stringify(new URL("./server.ts", import.meta.url).pathname)}; try { const server = await startWebServer("127.0.0.1", 0); console.log("READY:" + server.port); setInterval(() => {}, 1000); } catch(error) { console.error(error); process.exit(1); }`;
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const spawn = () => {
    const child = Bun.spawn([process.execPath, "-e", script], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(child);
    return child;
  };
  async function ready(child: ReturnType<typeof spawn>) {
    const reader = child.stdout.getReader();
    let output = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) throw new Error("Preflight did not start");
        output += new TextDecoder().decode(value);
        const match = /READY:(\d+)/.exec(output);
        if (match) return Number(match[1]);
      }
    } finally {
      clearTimeout(timeout);
      reader.releaseLock();
    }
  }
  try {
    const first = spawn();
    const port = await ready(first);
    const health = await (
      await fetch(`http://127.0.0.1:${port}/api/health`)
    ).json();
    expect(health).toEqual({
      status: "ok",
      release: "audit-preflight-test",
      preflight: true,
      terminals: 0,
    });
    expect((await fetch(`http://127.0.0.1:${port}/api/terminals`)).status).toBe(
      404,
    );
    expect(first.exitCode).toBeNull();
    const second = spawn();
    const stderr = new Response(second.stderr).text();
    const secondCode = await second.exited;
    const secondError = await stderr;
    expect(secondError).toContain("already owned");
    expect(secondCode).not.toBe(0);
    const verify = new Database(join(stateDir, "deckterm.db"), {
      readonly: true,
    });
    try {
      expect(
        verify
          .query("SELECT status FROM terminal_sessions WHERE id = ?")
          .get("preflight-sentinel"),
      ).toEqual({ status: "active" });
    } finally {
      verify.close();
    }
    for (const path of [
      join(stateDir, "clipboard"),
      join(stateDir, "tmux-pipes"),
      join(dir, "capture"),
    ])
      await expect(access(path)).rejects.toThrow();
    first.kill("SIGKILL");
    await first.exited;
    const recovered = spawn();
    expect(await ready(recovered)).toBeGreaterThan(0);
  } finally {
    for (const child of children) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
