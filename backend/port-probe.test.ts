import { afterEach, expect, test } from "bun:test";
import net from "node:net";
import { assertPortAvailable } from "./port-probe";

// Startup probes the port before touching recorded sessions. A client that
// connects inside that probe window (a health poll during startup: the test
// harnesses, scripts/wait_for_health.sh in CI and Deploy Main) used to be
// accepted and then ignored forever — its request hung even after the real
// server came up on the same port. Found 2026-09-30 as the cause of the
// intermittent 30 s timeouts in shutdown-lifecycle.test.ts.

const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))),
  );
});

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise((r) => srv.close(() => r(null)));
  return port;
}

test("a client connecting during the probe window is closed, not left hanging", async () => {
  const port = await freePort();
  let outcome = "still open";

  await assertPortAvailable(port, "127.0.0.1", {
    whileListening: async () => {
      const client = net.connect(port, "127.0.0.1");
      client.on("error", () => {});
      outcome = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve("still open"), 1000);
        client.once("close", () => {
          clearTimeout(timer);
          resolve("closed");
        });
      });
      client.destroy();
    },
  });

  expect(outcome).toBe("closed");
});

test("resolves when the port is free", async () => {
  const port = await freePort();
  await expect(assertPortAvailable(port, "127.0.0.1")).resolves.toBeUndefined();
});

test("rejects with EADDRINUSE when the port is taken", async () => {
  const holder = net.createServer();
  servers.push(holder);
  await new Promise<void>((r) => holder.listen(0, "127.0.0.1", () => r()));
  const port = (holder.address() as net.AddressInfo).port;

  await expect(assertPortAvailable(port, "127.0.0.1")).rejects.toMatchObject({
    code: "EADDRINUSE",
  });
});
