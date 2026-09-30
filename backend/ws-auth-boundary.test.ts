import { expect, test } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("real WebSocket route rejects invalid presented credentials before actor fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deckterm-ws-auth-"));
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = {
    ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    kid: "fixture",
    use: "sig",
  };
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const data = `${encode({ alg: "RS256", kid: "fixture" })}.${encode({ sub: "fixture-user", email: "fixture@example.com", iss: "https://test-team.cloudflareaccess.com", exp: Math.floor(Date.now() / 1000) + 600 })}`;
  const token = `${data}.${Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, Buffer.from(data))).toString("base64url")}`;
  const script = `globalThis.fetch = async () => Response.json({keys:[${JSON.stringify(jwk)}]}); const {startWebServer} = await import(${JSON.stringify(new URL("./server.ts", import.meta.url).pathname)}); try {const server=await startWebServer('127.0.0.1',0); console.log('READY:'+server.port); setInterval(()=>{},1000);} catch(e) {console.error(e);process.exit(1)}`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: {
      ...process.env,
      DECKTERM_STATE_DIR: dir,
      ALLOWED_FILE_ROOTS: dir,
      HOST: "127.0.0.1",
      PORT: "0",
      DECKTERM_RUNTIME_ENV: "development",
      DECKTERM_PUBLISH_MODE: "local",
      DECKTERM_LEGACY_NO_BOOTSTRAP: "1",
      DECKTERM_OS_ISOLATION: "0",
      CF_ACCESS_REQUIRED: "0",
      CF_ACCESS_TEAM_NAME: "test-team",
      CF_ACCESS_AUD: "",
      TRUSTED_ORIGINS: "https://terminal.example",
      TMUX_BACKEND: "0",
      DECKTERM_PREFLIGHT: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const reader = child.stdout.getReader();
    let text = "";
    let port = 0;
    while (!port) {
      const result = await reader.read();
      if (result.done) throw new Error("Fixture server failed to start");
      text += new TextDecoder().decode(result.value);
      port = Number(/READY:(\d+)/.exec(text)?.[1] || 0);
    }
    reader.releaseLock();
    const url = `http://127.0.0.1:${port}`;
    for (const bad of ["malformed", token.slice(0, -8) + "AAAAAAAA"]) {
      for (const credential of [
        { Authorization: `Bearer ${bad}` },
        { "cf-access-jwt-assertion": bad },
      ] as Record<string, string>[]) {
        const response = await fetch(`${url}/ws/terminals/missing`, {
          headers: { Origin: "https://terminal.example", ...credential },
        });
        expect(response.status).toBe(401);
      }
    }
    const valid = await fetch(`${url}/ws/terminals/missing`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(valid.status).toBe(404);
    for (const Origin of ["https://evil.example", "null"]) {
      expect(
        (
          await fetch(`${url}/ws/terminals/missing`, {
            headers: { Origin, Authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(
            `${url}/api/files/mkdir?path=${encodeURIComponent(join(dir, "denied"))}`,
            { method: "POST", headers: { Origin, "X-DeckTerm-Request": "1" } },
          )
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await fetch(
          `${url}/api/files/mkdir?path=${encodeURIComponent(join(dir, "denied"))}`,
          { method: "POST", headers: { Origin: "https://terminal.example" } },
        )
      ).status,
    ).toBe(403);
    const preflight = await fetch(`${url}/api/files/mkdir`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://terminal.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "X-DeckTerm-Request, Content-Type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "https://terminal.example",
    );
    expect(preflight.headers.get("content-security-policy")).toContain(
      "script-src 'self'",
    );
    expect((await readdir(dir)).includes("denied")).toBe(false);
  } finally {
    clearTimeout(deadline);
    child.kill("SIGKILL");
    await child.exited;
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
