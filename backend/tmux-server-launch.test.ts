import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTmuxServerKillArgv,
  buildTmuxServerLaunchPlan,
  killTmuxServer,
  launchTmuxServer,
  resolveStateDirForLaunch,
} from "./tmux-server-launch";
import {
  getTmuxSocketPath,
  resolveTmuxSessionNamespace,
} from "./tmux-session-names";

// The whole point of the separate unit is that the tmux server lives outside
// deckterm.service's control group. That only holds if the unit and the backend
// agree on the socket path: if they disagree, the backend starts its own server
// as its own child, and the next restart destroys every session with nothing
// looking wrong. These tests pin the two derivations together.
describe("socket path agrees with the backend", () => {
  // Mirrors how server.ts derives the socket: resolveStateDir() for the state
  // dir, resolveTmuxSessionNamespace({namespace, port}) for the namespace.
  const backendSocketPath = (env: Record<string, string | undefined>) =>
    getTmuxSocketPath({
      namespace: resolveTmuxSessionNamespace({
        namespace: env.TMUX_SESSION_NAMESPACE,
        port: env.PORT,
      }),
      stateDir: env.DECKTERM_STATE_DIR || join(env.HOME || "/home/deploy", ".deckterm"),
    });

  const cases: Array<[string, Record<string, string | undefined>]> = [
    ["explicit namespace", { HOME: "/home/deploy", TMUX_SESSION_NAMESPACE: "deckterm" }],
    // The trap this test exists for: with no namespace set the backend falls
    // back to `p<PORT>`, not to "default". Reading the raw env var here would
    // silently put the unit on a different socket.
    ["namespace absent, port set", { HOME: "/home/deploy", PORT: "4173" }],
    ["namespace empty, port set", { HOME: "/home/deploy", TMUX_SESSION_NAMESPACE: "", PORT: "4273" }],
    ["namespace blank, port set", { HOME: "/home/deploy", TMUX_SESSION_NAMESPACE: "   ", PORT: "4273" }],
    ["neither set", { HOME: "/home/deploy" }],
    ["explicit state dir", { HOME: "/home/deploy", DECKTERM_STATE_DIR: "/srv/dt", PORT: "4173" }],
    ["state dir with trailing slash", { HOME: "/home/deploy", DECKTERM_STATE_DIR: "/srv/dt/", PORT: "4173" }],
    ["no HOME at all", { PORT: "4173" }],
    ["namespace needing sanitising", { HOME: "/home/deploy", TMUX_SESSION_NAMESPACE: "we/ird name" }],
  ];

  for (const [name, env] of cases) {
    test(name, () => {
      expect(buildTmuxServerLaunchPlan(env).socketPath).toBe(
        backendSocketPath(env),
      );
    });
  }
});

describe("resolveStateDirForLaunch matches resolveStateDir() in server.ts", () => {
  test("prefers DECKTERM_STATE_DIR", () => {
    expect(
      resolveStateDirForLaunch({ DECKTERM_STATE_DIR: "/srv/dt", HOME: "/home/x" }),
    ).toBe("/srv/dt");
  });

  test("falls back to HOME/.deckterm", () => {
    expect(resolveStateDirForLaunch({ HOME: "/home/x" })).toBe("/home/x/.deckterm");
  });

  test("falls back to /home/deploy without HOME", () => {
    expect(resolveStateDirForLaunch({})).toBe("/home/deploy/.deckterm");
  });

  test("treats an empty DECKTERM_STATE_DIR as unset, like the backend's ||", () => {
    expect(resolveStateDirForLaunch({ DECKTERM_STATE_DIR: "", HOME: "/home/x" })).toBe(
      "/home/x/.deckterm",
    );
  });
});

describe("launch invocation", () => {
  const env = { HOME: "/home/deploy", TMUX_SESSION_NAMESPACE: "deckterm" };

  test("sets exit-empty off in the same tmux invocation as start-server", () => {
    // tmux defaults exit-empty to on, so a server started before any session
    // exists exits immediately. Splitting this into two commands (an
    // ExecStartPost, say) is a race the unit loses on a cold boot.
    const { argv } = buildTmuxServerLaunchPlan(env);
    expect(argv).toEqual([
      "tmux",
      "-S",
      "/home/deploy/.deckterm/tmux/deckterm_deckterm.sock",
      "start-server",
      ";",
      "set-option",
      "-s",
      "exit-empty",
      "off",
    ]);
  });

  test("separates the two tmux commands with a bare ; argument", () => {
    // Passed straight to execve, not through a shell: tmux itself reads ";" as
    // the command separator, so it must be its own argv entry and must not be
    // backslash-escaped the way it would be in a shell.
    const { argv } = buildTmuxServerLaunchPlan(env);
    expect(argv).toContain(";");
    expect(argv).not.toContain("\\;");
  });

  test("kill targets the same socket the launch uses", () => {
    const { socketPath } = buildTmuxServerLaunchPlan(env);
    expect(buildTmuxServerKillArgv(env)).toEqual([
      "tmux",
      "-S",
      socketPath,
      "kill-server",
    ]);
  });

  test("launch returns the tmux exit code, and creates the socket dir 0700", async () => {
    const home = await mkdtemp(join(tmpdir(), "dt-launch-"));
    const calls: string[][] = [];
    const code = await launchTmuxServer({ ...env, HOME: home }, (argv) => {
      calls.push(argv);
      return { exited: Promise.resolve(0) };
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0][3]).toBe("start-server");

    // The unit may run before anything else has touched the state dir, so the
    // launcher has to create it — and the socket must not be world-reachable.
    const socketDir = join(home, ".deckterm", "tmux");
    expect((await stat(socketDir)).mode & 0o777).toBe(0o700);
    await rm(home, { recursive: true, force: true });
  });

  test("launch surfaces a tmux failure", async () => {
    const home = await mkdtemp(join(tmpdir(), "dt-launch-"));
    const code = await launchTmuxServer({ ...env, HOME: home }, () => ({
      exited: Promise.resolve(1),
    }));
    expect(code).toBe(1);
    await rm(home, { recursive: true, force: true });
  });

  test("stopping an already-dead server is not a failure", async () => {
    // ExecStop must not turn `systemctl stop` into a failed unit just because
    // the server had already exited.
    const code = await killTmuxServer(env, () => ({
      exited: Promise.resolve(1),
    }));
    expect(code).toBe(0);
  });
});
