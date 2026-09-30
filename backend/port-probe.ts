import { createServer } from "node:net";

/**
 * Resolves when `port` can be bound on `host`; rejects (e.g. EADDRINUSE)
 * when it cannot. Startup runs this before touching recorded sessions, so a
 * second instance on a taken port fails before it writes anything.
 *
 * Any client that connects during the brief probe window is closed at once.
 * Left alone, that accepted connection stays open forever: a health poll that
 * lands on it (test harnesses, scripts/wait_for_health.sh in CI and Deploy
 * Main) hangs even after the real server is serving the same port, instead of
 * failing fast and retrying.
 *
 * `whileListening` exists for tests: it runs after the probe binds and before
 * it closes.
 */
export async function assertPortAvailable(
  port: number,
  host: string,
  hooks: { whileListening?: () => Promise<void> } = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer((socket) => socket.destroy());
    probe.once("error", reject);
    probe.listen(port, host, async () => {
      await hooks.whileListening?.();
      probe.close((err) => (err ? reject(err) : resolve()));
    });
  });
}
