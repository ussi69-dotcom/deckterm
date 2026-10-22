import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_UUID_SOURCE,
  bashIntegrationRcPath,
  buildAgentWrapperShell,
  buildBashIntegrationRcContents,
} from "./shell-integration";
import { parseShellIntegrationChunk } from "./telemetry";

test("DeckTerm launches Codex inline so terminal scrollback is preserved", () => {
  const rc = buildBashIntegrationRcContents();

  expect(rc).toContain(
    'codex() { __deckterm_run_agent codex --no-alt-screen "$@"; }',
  );
});

test("DeckTerm leaves the Claude launch mode unchanged", () => {
  const rc = buildBashIntegrationRcContents();

  expect(rc).toContain('claude() { __deckterm_run_agent claude "$@"; }');
  expect(rc).not.toContain("claude --no-alt-screen");
});

test("the rc path is named by its content, so two versions never share one file", () => {
  const current = buildBashIntegrationRcContents();
  const path = bashIntegrationRcPath(current);
  expect(path).toMatch(/^\/tmp\/deckterm-bash-integration-[0-9a-f]{16}\.rc$/);
  expect(bashIntegrationRcPath(current)).toBe(path);
  expect(bashIntegrationRcPath(`${current}\n# other version`)).not.toBe(path);
  // The pre-S3 fixed name is never used again (other instances still read it).
  expect(path).not.toBe("/tmp/deckterm-bash-integration.rc");
});

test("the rc carries the S3 agent wrapper and reads the kernel UUID source", () => {
  const rc = buildBashIntegrationRcContents();
  for (const line of buildAgentWrapperShell()) expect(rc).toContain(line);
  expect(AGENT_UUID_SOURCE).toBe("/proc/sys/kernel/random/uuid");
  expect(rc).toContain(`< '${AGENT_UUID_SOURCE}'`);
});

// The wrapper argument table (design 6), run for real in bash: `claude` and
// `codex` are stub executables on PATH that print their arguments, so the
// wrapper's `command "$agent" ...` reaches them and nothing real starts.
describe("agent wrapper argument table", () => {
  const U = "0f0e0d0c-1111-2222-3333-444455556666";
  const UUID_SHAPE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  let dir: string;
  let wrapperFile: string;
  let missingSourceWrapperFile: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "deckterm-agent-wrapper-"));
    const bin = join(dir, "bin");
    Bun.spawnSync(["mkdir", "-p", bin]);
    const stub = `#!/bin/sh\nprintf 'ARGS'\nfor a in "$@"; do printf ' <%s>' "$a"; done\nprintf '\\n'\nexit 7\n`;
    for (const name of ["claude", "codex"]) {
      writeFileSync(join(bin, name), stub);
      chmodSync(join(bin, name), 0o755);
    }
    wrapperFile = join(dir, "wrapper.sh");
    writeFileSync(wrapperFile, buildAgentWrapperShell().join("\n"));
    missingSourceWrapperFile = join(dir, "wrapper-missing.sh");
    writeFileSync(
      missingSourceWrapperFile,
      buildAgentWrapperShell({
        uuidSource: join(dir, "no-such-uuid-source"),
      }).join("\n"),
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  type Run = {
    args: string[];
    start: { sid: string | null } | null;
    done: string | null;
    markers: string[];
    exitCode: number | null;
  };

  // Runs `<agent> <args...>` through the wrapper and parses what it printed.
  function run(
    agent: "claude" | "codex",
    args: string[],
    file = wrapperFile,
  ): Run {
    const proc = Bun.spawnSync(
      [
        "bash",
        "--norc",
        "--noprofile",
        "-c",
        `source "$1"; shift; "$@"`,
        "deckterm-test",
        file,
        agent,
        ...args,
      ],
      {
        env: {
          PATH: `${join(dir, "bin")}:/usr/bin:/bin`,
          HOME: dir,
          LANG: "C.UTF-8",
        },
      },
    );
    const out = proc.stdout.toString();
    const markers = [...out.matchAll(/\x1b\]9;9;deckterm;([^\x07]*)\x07/g)].map(
      (m) => m[1]!,
    );
    const argLine = out
      .replace(/\x1b\]9;9;deckterm;[^\x07]*\x07/g, "")
      .split("\n")
      .find((line) => line.startsWith("ARGS"));
    expect(argLine).toBeDefined();
    const parsedArgs = [...(argLine || "").matchAll(/<([^>]*)>/g)].map(
      (m) => m[1]!,
    );
    const startMarker = markers.find((m) =>
      m.startsWith(`agent;${agent};start`),
    );
    const doneMarker = markers.find((m) => m.startsWith(`agent;${agent};done`));
    return {
      args: parsedArgs,
      start: startMarker
        ? {
            sid: startMarker.includes(";sid=")
              ? startMarker.split(";sid=")[1]!
              : null,
          }
        : null,
      done: doneMarker ?? null,
      markers,
      exitCode: proc.exitCode,
    };
  }

  test("claude with no arguments gets a new --session-id and reports it", () => {
    const r = run("claude", []);
    expect(r.args[0]).toBe("--session-id");
    expect(r.args[1]).toMatch(UUID_SHAPE);
    expect(r.args).toHaveLength(2);
    expect(r.start).toEqual({ sid: r.args[1]! });
    // The exit code still travels in the done marker and the return value.
    expect(r.done).toBe("agent;claude;done;7");
    expect(r.exitCode).toBe(7);
  });

  test("claude whose first argument is an option gets the id prepended", () => {
    const r = run("claude", ["--model", "claude-haiku-5-5"]);
    expect(r.args.slice(0, 1)).toEqual(["--session-id"]);
    expect(r.args.slice(2)).toEqual(["--model", "claude-haiku-5-5"]);
    expect(r.start?.sid).toBe(r.args[1]!);
    // Two runs, two different ids.
    expect(run("claude", []).start?.sid).not.toBe(r.start?.sid);
  });

  test("claude --session-id <u> adds nothing and reports <u>", () => {
    for (const args of [
      ["--session-id", U],
      [`--session-id=${U}`],
      ["--model", "x", "--session-id", U],
    ]) {
      const r = run("claude", args);
      expect(r.args).toEqual(args);
      expect(r.start).toEqual({ sid: U });
    }
  });

  test("claude --session-id with a non-UUID reports nothing", () => {
    const r = run("claude", ["--session-id", "not-a-uuid"]);
    expect(r.args).toEqual(["--session-id", "not-a-uuid"]);
    expect(r.start).toEqual({ sid: null });
  });

  test("claude -r <u>, --resume <u> and --resume=<u> report <u>", () => {
    for (const args of [["-r", U], ["--resume", U], [`--resume=${U}`]]) {
      const r = run("claude", args);
      expect(r.args).toEqual(args);
      expect(r.start).toEqual({ sid: U });
    }
  });

  test("claude --resume with something that is not a UUID reports nothing", () => {
    const r = run("claude", ["--resume", "my-session-name"]);
    expect(r.args).toEqual(["--resume", "my-session-name"]);
    expect(r.start).toEqual({ sid: null });
  });

  test("claude pick cases add nothing and report nothing", () => {
    for (const args of [
      ["-r"],
      ["--resume"],
      ["--resume", "--model", "x"],
      ["-c"],
      ["--continue"],
      ["--resume", U, "--fork-session"],
      ["--from-pr", "12"],
      ["--cloud"],
      ["--desktop", "--resume", U],
      ["--bg"],
      ["--bg", "--session-id", U],
    ]) {
      const r = run("claude", args);
      expect(r.args).toEqual(args);
      expect(r.start).toEqual({ sid: null });
      expect(r.done).toBe("agent;claude;done;7");
    }
  });

  test("claude -p, --print, -h, --help, -v, --version record nothing", () => {
    for (const args of [
      ["-p", "hi"],
      ["--model", "x", "--print", "hi"],
      ["-h"],
      ["--help"],
      ["-v"],
      ["--version"],
    ]) {
      const r = run("claude", args);
      expect(r.args).toEqual(args);
      expect(r.markers).toEqual([]);
      expect(r.exitCode).toBe(7);
    }
  });

  test("claude with a prompt or a subcommand first adds and reports nothing", () => {
    for (const args of [["fix the bug"], ["mcp", "list"], ["hello", "-p"]]) {
      const r = run("claude", args);
      expect(r.args).toEqual(args);
      if (args.includes("-p")) {
        // -p anywhere means print mode: no start record at all.
        expect(r.markers).toEqual([]);
      } else {
        expect(r.start).toEqual({ sid: null });
      }
    }
  });

  test("arguments after -- are never read as options", () => {
    const r = run("claude", ["--", "-p"]);
    expect(r.args[0]).toBe("--session-id");
    expect(r.args.slice(2)).toEqual(["--", "-p"]);
    expect(r.start?.sid).toBe(r.args[1]!);
  });

  test("a missing UUID source adds nothing and reports nothing", () => {
    const r = run("claude", ["--model", "x"], missingSourceWrapperFile);
    expect(r.args).toEqual(["--model", "x"]);
    expect(r.start).toEqual({ sid: null });
    expect(r.done).toBe("agent;claude;done;7");
  });

  test("codex resume <u> reports <u>; --no-alt-screen stays first", () => {
    const r = run("codex", ["resume", U]);
    expect(r.args).toEqual(["--no-alt-screen", "resume", U]);
    expect(r.start).toEqual({ sid: U });
  });

  test("codex plain start, prompt, resume --last, resume and fork report nothing", () => {
    for (const args of [
      [],
      ["--model", "gpt-5.6-luna"],
      ["explain this repo"],
      ["resume", "--last"],
      ["resume"],
      ["resume", "some-name"],
      ["fork", "--last"],
    ]) {
      const r = run("codex", args);
      expect(r.args).toEqual(["--no-alt-screen", ...args]);
      expect(r.start).toEqual({ sid: null });
      expect(r.done).toBe("agent;codex;done;7");
    }
  });

  test("codex exec, review and other subcommands record nothing", () => {
    for (const args of [
      ["exec", "hi"],
      ["e", "hi"],
      ["review"],
      ["login", "status"],
      ["mcp", "list"],
      ["apply"],
      ["--help"],
      ["--version"],
    ]) {
      const r = run("codex", args);
      expect(r.args).toEqual(["--no-alt-screen", ...args]);
      expect(r.markers).toEqual([]);
    }
  });

  test("the wrapper's start marker parses to the same validated id", () => {
    const r = run("claude", ["--resume", U]);
    const startMarker = r.markers.find((m) => m.includes(";start"))!;
    const parsed = parseShellIntegrationChunk(
      `\x1b]9;9;deckterm;${startMarker}\x07`,
    );
    expect(parsed.events).toEqual([
      { type: "agent-start", agentName: "claude", sessionId: U },
    ]);
  });
});
