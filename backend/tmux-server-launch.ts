// Launches the long-lived tmux server that holds terminal sessions.
//
// Why this exists as a separate entry point:
//
// When the backend spawns `tmux new-session` itself, tmux starts the server
// implicitly as a child of the backend process. Under systemd the server then
// lands in deckterm.service's control group, and the default
// KillMode=control-group means a restart of the backend kills the server and
// every session with it — including a restart nobody asked for, such as
// needrestart bouncing the service after a shared-library security upgrade.
// The backend's own shutdown message claims the sessions are preserved; with
// the server inside the cgroup that claim is false.
//
// Running this file from its own unit (deploy/systemd/deckterm-tmux.service)
// puts the server in its own control group. Sessions then survive any restart
// of the backend, deliberate or automatic.
//
// The socket path is derived with getTmuxSocketPath — the same function the
// backend uses — from the same environment. Do not hardcode the path in the
// unit file: a namespace or state-dir change would silently give the backend a
// different socket, it would start its own in-cgroup server, and the whole fix
// would be void with nothing looking wrong.

import { mkdir, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  getTmuxSocketPath,
  resolveTmuxSessionNamespace,
} from "./tmux-session-names";

export const TMUX_SERVER_LAUNCH_LOG_PREFIX = "[tmux-server]";

export type TmuxServerLaunchPlan = {
  socketPath: string;
  socketDir: string;
  argv: string[];
};

/**
 * Resolves the state directory exactly as the backend does, so the server and
 * the backend always agree on where the socket lives.
 *
 * This deliberately mirrors resolveStateDir() in server.ts character for
 * character rather than improving on it. server.ts cannot be imported here —
 * importing it starts the HTTP server — so the logic is duplicated, and
 * tmux-server-launch.test.ts pins the two to the same truth table. If
 * resolveStateDir() in server.ts changes, that test fails and this must follow;
 * a silent divergence would send the server and the backend to different
 * sockets, the backend would start its own server inside its cgroup, and the
 * fix would be void with nothing looking wrong.
 */
export function resolveStateDirForLaunch(
  env: Record<string, string | undefined>,
): string {
  return env.DECKTERM_STATE_DIR || join(env.HOME || "/home/deploy", ".deckterm");
}

/**
 * Builds the tmux invocation for the server unit.
 *
 * `set-option -s exit-empty off` is load-bearing and must travel in the *same*
 * client invocation as start-server. tmux defaults exit-empty to on, so a
 * server started with no sessions exits immediately; splitting this across two
 * commands is a race the unit loses on a cold boot, before any terminal exists.
 */
export function buildTmuxServerLaunchPlan(
  env: Record<string, string | undefined>,
): TmuxServerLaunchPlan {
  // Both arguments matter. The backend does not read TMUX_SESSION_NAMESPACE
  // directly — it passes it through resolveTmuxSessionNamespace() together with
  // PORT, which falls back to `p<PORT>` when no namespace is set. Reading the
  // raw variable here would put this unit on the "default" socket while the
  // backend used "p4173", and the backend would quietly start a second server
  // inside its own control group.
  const socketPath = getTmuxSocketPath({
    namespace: resolveTmuxSessionNamespace({
      namespace: env.TMUX_SESSION_NAMESPACE,
      port: env.PORT,
    }),
    stateDir: resolveStateDirForLaunch(env),
  });
  return {
    socketPath,
    socketDir: dirname(socketPath),
    argv: [
      "tmux",
      "-S",
      socketPath,
      "start-server",
      ";",
      "set-option",
      "-s",
      "exit-empty",
      "off",
    ],
  };
}

export async function ensureSocketDirectory(socketDir: string): Promise<void> {
  await mkdir(socketDir, { recursive: true });
  await chmod(socketDir, 0o700);
}

/**
 * Builds the shutdown invocation used by the unit's ExecStop.
 *
 * Killing the server ends every session it holds. That is the intended meaning
 * of stopping this unit — unlike a restart of the backend, which must leave
 * sessions alone.
 */
export function buildTmuxServerKillArgv(
  env: Record<string, string | undefined>,
): string[] {
  const { socketPath } = buildTmuxServerLaunchPlan(env);
  return ["tmux", "-S", socketPath, "kill-server"];
}

/**
 * Stops the server. Exit code 0 even when no server was running, so that
 * `systemctl stop` on an already-dead server is not reported as a failure.
 */
export async function killTmuxServer(
  env: Record<string, string | undefined> = process.env,
  spawn: (argv: string[]) => { exited: Promise<number> } = (argv) =>
    Bun.spawn(argv, { stdout: "inherit", stderr: "ignore" }),
): Promise<number> {
  const argv = buildTmuxServerKillArgv(env);
  console.log(`${TMUX_SERVER_LAUNCH_LOG_PREFIX} stopping ${argv[2]}`);
  await spawn(argv).exited;
  return 0;
}

/**
 * Starts the server and returns its exit code. tmux daemonises itself, so the
 * spawned client exits promptly and the unit is Type=forking.
 */
export async function launchTmuxServer(
  env: Record<string, string | undefined> = process.env,
  spawn: (argv: string[]) => { exited: Promise<number> } = (argv) =>
    Bun.spawn(argv, { stdout: "inherit", stderr: "inherit" }),
): Promise<number> {
  const plan = buildTmuxServerLaunchPlan(env);
  await ensureSocketDirectory(plan.socketDir);
  console.log(
    `${TMUX_SERVER_LAUNCH_LOG_PREFIX} starting on ${plan.socketPath} (exit-empty off)`,
  );
  const proc = spawn(plan.argv);
  return await proc.exited;
}

if (import.meta.main) {
  const code = process.argv.includes("--kill")
    ? await killTmuxServer()
    : await launchTmuxServer();
  if (code !== 0) {
    console.error(
      `${TMUX_SERVER_LAUNCH_LOG_PREFIX} tmux exited with code ${code}`,
    );
  }
  process.exit(code);
}
