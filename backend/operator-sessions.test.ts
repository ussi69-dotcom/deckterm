import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildOperatorAttachArgv,
  createOperatorDiscoveryCache,
  detectOperatorAgent,
  discoverOperators,
  isValidOperatorName,
  listOperatorCandidates,
  parseOperatorAttachClient,
  parseOperatorPanes,
  readOperatorDir,
  resolveOperatorConfig,
  runOperatorArgv,
  statOperatorEntry,
  type OperatorConfig,
  type OperatorDiscoveryDeps,
} from "./services/operator-sessions";
import { parseProcessTable } from "./services/runtime-sync-cache";

const UID = typeof process.getuid === "function" ? process.getuid() : 1000;

describe("operator names and config", () => {
  test("only the operator-tmux pattern is a name", () => {
    expect(isValidOperatorName("myclaude-operator")).toBe(true);
    expect(isValidOperatorName("a")).toBe(true);
    expect(isValidOperatorName("9-x")).toBe(true);
    for (const bad of [
      "",
      "-x",
      "Upper",
      "a_b",
      "a b",
      "a;id",
      "$(id)",
      "a/b",
      "..",
      "x".repeat(42),
      null,
      42,
    ]) {
      expect(isValidOperatorName(bad)).toBe(false);
    }
  });

  test("defaults to the system tmux and /tmp/tmux-<uid>", () => {
    expect(resolveOperatorConfig({}, 1001)).toEqual({
      dir: "/tmp/tmux-1001",
      tmuxBin: "/usr/bin/tmux",
      uid: 1001,
    });
  });

  test("refuses paths a shell or tmux could misread", () => {
    expect(
      resolveOperatorConfig({ DECKTERM_OPERATOR_TMUX_DIR: "relative" }, 1),
    ).toBeNull();
    expect(
      resolveOperatorConfig({ DECKTERM_OPERATOR_TMUX_DIR: "/tmp/a b" }, 1),
    ).toBeNull();
    expect(
      resolveOperatorConfig({ DECKTERM_OPERATOR_TMUX_DIR: "/tmp/../etc" }, 1),
    ).toBeNull();
    expect(
      resolveOperatorConfig({ DECKTERM_OPERATOR_TMUX_BIN: "tmux" }, 1),
    ).toBeNull();
    expect(resolveOperatorConfig({}, -1)).toBeNull();
  });

  test("the attach argv carries the name only after the check, never a shell", () => {
    const config: OperatorConfig = {
      dir: "/tmp/tmux-1001",
      tmuxBin: "/usr/bin/tmux",
      uid: 1001,
    };
    expect(buildOperatorAttachArgv(config, "aispend-operator")).toEqual([
      "/usr/bin/env",
      "-u",
      "TMUX",
      "/usr/bin/tmux",
      "-u",
      "-S",
      "/tmp/tmux-1001/op-aispend-operator",
      "attach-session",
      "-t",
      "=aispend-operator",
    ]);
    expect(() => buildOperatorAttachArgv(config, "x;rm -rf /")).toThrow();
  });
});

describe("parsers", () => {
  test("list-panes: the active pane wins, junk lines are skipped", () => {
    const out = [
      "0\t11\t1794692428\t/home/u/a\tfirst",
      "garbage",
      "1\t22\t1794692430\t/home/u/b\t✳ title\twith tab",
      "",
    ].join("\n");
    expect(parseOperatorPanes(out)).toEqual({
      pid: 22,
      activityAt: 1794692430000,
      cwd: "/home/u/b",
      title: "✳ title\twith tab",
    });
    expect(parseOperatorPanes("0\t5\t0\t/x\t")?.pid).toBe(5);
    expect(parseOperatorPanes("")).toBeNull();
    expect(parseOperatorPanes("1\t5\t0\trelative\tt")).toBeNull();
  });

  test("agent detection follows wrappers and interpreters", () => {
    expect(
      detectOperatorAgent([
        "bash -lc exec \"$@\" unit timeout --foreground 5h claude -n x",
        "timeout --foreground 5h claude -n x",
        "claude -n x --model fable",
      ]),
    ).toBe("claude");
    expect(detectOperatorAgent(["node /opt/bin/codex exec"])).toBe("codex");
    expect(detectOperatorAgent(["/usr/local/bin/codex"])).toBe("codex");
    // A prompt that merely mentions claude is not the program.
    expect(detectOperatorAgent(["sleep 300", "grep claude"])).toBeNull();
  });

  test("attached clients: DeckTerm's view and operator-tmux attach", () => {
    expect(
      parseOperatorAttachClient([
        "/usr/bin/env -u TMUX /usr/bin/tmux -u -S /tmp/tmux-1001/op-myclaude-operator attach-session -t =myclaude-operator",
      ]),
    ).toBe("myclaude-operator");
    expect(
      parseOperatorAttachClient([
        "/bin/bash --rcfile x -i",
        "/usr/bin/tmux -L op-aispend-operator attach -t aispend-operator",
      ]),
    ).toBe("aispend-operator");
    // Not an attach, not an operator socket, not a valid name.
    expect(
      parseOperatorAttachClient([
        "/usr/bin/tmux -L op-x list-sessions",
        "tmux -S /home/u/.deckterm/tmux/deckterm_deckterm.sock attach-session -t s",
        "/usr/bin/tmux -L op-Bad_Name attach -t x",
        "vim op-x attach",
      ]),
    ).toBeNull();
  });
});

function fakeDeps(
  overrides: Partial<OperatorDiscoveryDeps> & {
    entries?: Record<string, { isSocket: boolean; uid: number } | null>;
    panes?: Record<string, string>;
    screens?: Record<string, string>;
  } = {},
): OperatorDiscoveryDeps & { calls: string[][] } {
  const config: OperatorConfig = { dir: "/s", tmuxBin: "/usr/bin/tmux", uid: 7 };
  const entries = overrides.entries ?? {};
  const panes = overrides.panes ?? {};
  const screens = overrides.screens ?? {};
  const calls: string[][] = [];
  return {
    calls,
    config,
    readDir: async () => Object.keys(entries),
    statEntry: async (path) =>
      path === "/s" ? { isSocket: false, uid: 7 } : (entries[path.slice(3)] ?? null),
    run: async (argv) => {
      calls.push(argv);
      const name = argv[argv.indexOf("-t") + 1]!.replace(/^=/, "").replace(/:$/, "");
      if (argv.includes("list-panes")) {
        return name in panes
          ? { ok: true, stdout: panes[name]! }
          : { ok: false, stdout: "" };
      }
      if (argv.includes("capture-pane")) {
        return { ok: true, stdout: screens[name] ?? "" };
      }
      return { ok: false, stdout: "" };
    },
    processSnapshot: async () =>
      parseProcessTable(
        ["100 1 bash -lc x", "101 100 claude -n a", "200 1 sleep 60"].join("\n"),
      ),
    evaluate: (_agent, input) => ({
      state: input.screen.includes("WORK") ? "working" : "idle",
      ruleId: input.screen.includes("WORK") ? "w_rule" : "i_rule",
      region: null,
      visibleIdle: false,
      visibleBlocker: false,
      visibleWorking: false,
      skip: false,
      manifestVersion: "claude@test",
    }),
    ...overrides,
  };
}

describe("discovery", () => {
  test("candidates: sockets of the service uid with a valid name only", async () => {
    const deps = fakeDeps({
      entries: {
        "op-alive": { isSocket: true, uid: 7 },
        "op-foreign": { isSocket: true, uid: 8 },
        "op-file": { isSocket: false, uid: 7 },
        "op-Bad": { isSocket: true, uid: 7 },
        "deckterm.sock": { isSocket: true, uid: 7 },
        "op-": { isSocket: true, uid: 7 },
      },
    });
    expect(await listOperatorCandidates(deps)).toEqual(["alive"]);
  });

  test("a folder owned by someone else yields nothing", async () => {
    const deps = fakeDeps({ entries: { "op-a": { isSocket: true, uid: 7 } } });
    deps.statEntry = async (path) =>
      path === "/s" ? { isSocket: false, uid: 0 } : { isSocket: true, uid: 7 };
    expect(await listOperatorCandidates(deps)).toEqual([]);
  });

  test("stale sockets drop out; live ones carry folder, agent and status", async () => {
    const deps = fakeDeps({
      entries: {
        "op-a": { isSocket: true, uid: 7 },
        "op-b": { isSocket: true, uid: 7 },
        "op-stale": { isSocket: true, uid: 7 },
      },
      panes: {
        a: "1\t100\t1794692428\t/home/u/proj\t✳ a",
        b: "1\t200\t1794692400\t/home/u/other\tb",
      },
      screens: { a: "… WORK …" },
    });
    const list = await discoverOperators(deps);
    expect(list).toEqual([
      {
        name: "a",
        cwd: "/home/u/proj",
        agentName: "claude",
        agentStatus: "working",
        agentStatusRule: "w_rule",
        agentRulesVersion: "claude@test",
        lastActivityAt: 1794692428000,
      },
      {
        name: "b",
        cwd: "/home/u/other",
        agentName: null,
        agentStatus: null,
        agentStatusRule: null,
        agentRulesVersion: null,
        lastActivityAt: 1794692400000,
      },
    ]);
    // Only the operator with an agent was captured, by exact target.
    const captures = deps.calls.filter((argv) => argv.includes("capture-pane"));
    expect(captures).toEqual([
      ["/usr/bin/tmux", "-S", "/s/op-a", "capture-pane", "-p", "-t", "=a:"],
    ]);
  });

  test("the cache shares one discovery and expires", async () => {
    let runs = 0;
    let clock = 0;
    const cache = createOperatorDiscoveryCache(
      async () => {
        runs += 1;
        return [];
      },
      { ttlMs: 3000, now: () => clock },
    );
    await Promise.all([cache.get(), cache.get()]);
    expect(runs).toBe(1);
    clock = 2999;
    await cache.get();
    expect(runs).toBe(1);
    clock = 3000;
    await cache.get();
    expect(runs).toBe(2);
  });

  test("a failed discovery is not cached", async () => {
    let runs = 0;
    const cache = createOperatorDiscoveryCache(async () => {
      runs += 1;
      if (runs === 1) throw new Error("boom");
      return [];
    });
    await expect(cache.get()).rejects.toThrow("boom");
    await cache.get();
    expect(runs).toBe(2);
  });
});

// A real system tmux, in a private folder: an "operator" server, and an outer
// server whose pane is DeckTerm's attached view (the same argv). Killing the
// outer session must only detach; the operator keeps running.
const SYSTEM_TMUX = "/usr/bin/tmux";
const describeTmux = existsSync(SYSTEM_TMUX) ? describe : describe.skip;

describeTmux("real tmux: list, attach by argv, close = detach", () => {
  let dir = "";
  const tmux = (sock: string, ...args: string[]) =>
    runOperatorArgv([SYSTEM_TMUX, "-S", sock, ...args], { timeoutMs: 5000 });

  afterAll(async () => {
    if (!dir) return;
    await tmux(join(dir, "op-unit-op"), "kill-server");
    await tmux(join(dir, "outer"), "kill-server");
    await rm(dir, { recursive: true, force: true });
  });

  test("lifecycle", async () => {
    dir = await mkdtemp("/tmp/dt-op-");
    const config: OperatorConfig = { dir, tmuxBin: SYSTEM_TMUX, uid: UID };
    const opSock = join(dir, "op-unit-op");
    const outerSock = join(dir, "outer");
    // A stale socket name (a regular file) and an ended server's name.
    await writeFile(join(dir, "op-stale"), "");
    expect(
      (await tmux(opSock, "new-session", "-d", "-s", "unit-op", "-c", dir, "sleep", "120")).ok,
    ).toBe(true);

    const deps: OperatorDiscoveryDeps = {
      config,
      run: (argv) => runOperatorArgv(argv, { timeoutMs: 5000 }),
      readDir: readOperatorDir,
      statEntry: statOperatorEntry,
      processSnapshot: async () => null,
      evaluate: () => {
        throw new Error("no agent here");
      },
    };
    const list = await discoverOperators(deps);
    expect(list.map((o) => o.name)).toEqual(["unit-op"]);
    expect(list[0]!.agentName).toBeNull();

    // The attached view, exactly as DeckTerm starts it.
    expect(
      (
        await tmux(
          outerSock,
          "new-session",
          "-d",
          "-s",
          "outer",
          "-x",
          "100",
          "-y",
          "30",
          ...buildOperatorAttachArgv(config, "unit-op"),
        )
      ).ok,
    ).toBe(true);
    let clients = "";
    for (let i = 0; i < 40 && !clients.trim(); i++) {
      await Bun.sleep(100);
      clients = (await tmux(opSock, "list-clients", "-F", "#{client_pid}")).stdout;
    }
    expect(clients.trim()).not.toBe("");

    // The outer pane's process tree is recognised as attached to it.
    const panePid = Number(
      (await tmux(outerSock, "display-message", "-p", "-t", "=outer:", "#{pane_pid}"))
        .stdout.trim(),
    );
    const ps = Bun.spawnSync(["ps", "-eo", "pid=,ppid=,args="]).stdout.toString();
    const { collectProcessTreeArgs } = await import("./services/runtime-sync-cache");
    expect(
      parseOperatorAttachClient(collectProcessTreeArgs(parseProcessTable(ps), panePid)),
    ).toBe("unit-op");

    // Closing the view: the operator stays, without a client.
    expect((await tmux(outerSock, "kill-session", "-t", "=outer")).ok).toBe(true);
    let after = "x";
    for (let i = 0; i < 40 && after.trim(); i++) {
      await Bun.sleep(100);
      after = (await tmux(opSock, "list-clients", "-F", "#{client_pid}")).stdout;
    }
    expect(after.trim()).toBe("");
    expect((await tmux(opSock, "has-session", "-t", "=unit-op")).ok).toBe(true);

    // The operator ending: it drops out of the list, no error.
    await tmux(opSock, "kill-server");
    expect(await discoverOperators(deps)).toEqual([]);
  }, 20_000);
});
