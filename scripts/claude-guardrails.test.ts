import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { evaluate } from "./claude-guardrails";

const script = resolve(import.meta.dir, "claude-guardrails.ts");

function bash(command: string) {
  return { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } };
}
function fileEdit(tool: string, key: string, path: string) {
  return { hook_event_name: "PreToolUse", tool_name: tool, tool_input: { [key]: path } };
}

describe("prod-port test rule (block)", () => {
  test.each([
    "curl http://localhost:4173/api/health",
    "curl -s 127.0.0.1:4173/x",
    "cd tests && PW_BASE_URL=http://localhost:4173 npx playwright test a.spec.ts",
    "PORT=4173 bun test ./backend/x.test.ts",
    "npm run test -- --port 4173",
    "curl http://LOCALHOST:4173/api/health",
    "echo start\ncurl http://localhost:4173/api/health",
  ])("blocks %s", (command) => {
    expect(evaluate(bash(command))).toMatchObject({ action: "block", rule: "block-deckterm-prod-port-tests" });
  });
  test.each([
    "curl http://localhost:4174/api/health",
    "cd tests && PW_BASE_URL=http://localhost:4174 npx playwright test",
    "ss -ltnp | grep 4173",
    "ss -ltnp | grep localhost:4173\ncurl http://localhost:4174/api/health",
  ])("allows %s", (command) => {
    expect(evaluate(bash(command)).action).toBe("allow");
  });
});

describe("vendor edit rule (block)", () => {
  test.each([
    ["Edit", "file_path", "/home/deploy/deckterm_dev/web/vendor/xterm.js"],
    ["Write", "file_path", "web/vendor/codemirror.js"],
    ["MultiEdit", "file_path", "/x/web/vendor/addon-fit.js"],
    ["NotebookEdit", "notebook_path", "/x/web/vendor/n.ipynb"],
  ])("blocks %s of %s", (tool, key, path) => {
    expect(evaluate(fileEdit(tool, key, path))).toMatchObject({ action: "block", rule: "block-deckterm-vendor-edits" });
  });
  test("allows other web files", () => {
    expect(evaluate(fileEdit("Edit", "file_path", "/x/web/app.js")).action).toBe("allow");
  });
  test("does not apply file rules to Bash", () => {
    expect(evaluate(bash("cat web/vendor/xterm.js")).action).toBe("allow");
  });
});

describe("destructive command rule (block)", () => {
  test.each([
    "git reset --hard origin/dev",
    "git clean -fdx",
    "git checkout -- web/app.js",
    "rm -rf /",
    "rm -rf ~",
    "rm -rf ~/",
    "rm -rf .",
    "rm -rf /home/deploy",
    "rm -rf /home/deploy/deckterm_dev/",
    "chmod -R 777 web",
  ])("blocks %s", (command) => {
    expect(evaluate(bash(command))).toMatchObject({ action: "block", rule: "block-destructive-commands" });
  });
  test.each([
    "git reset --soft HEAD~1",
    "git checkout dev",
    "rm -rf node_modules",
    "rm -rf ./dist",
    "chmod 755 scripts/x.sh",
  ])("allows %s", (command) => {
    expect(evaluate(bash(command)).action).toBe("allow");
  });
});

describe("manual prod deploy rule (warn)", () => {
  test.each([
    "systemctl --user restart deckterm.service",
    "systemctl stop deckterm.service",
    "ls /home/deploy/apps/deckterm/prod/current",
    "bun run start",
  ])("warns on %s", (command) => {
    expect(evaluate(bash(command))).toMatchObject({ action: "warn", rule: "warn-deckterm-manual-prod-deploy" });
  });
  test("does not warn on the dev service", () => {
    expect(evaluate(bash("systemctl --user restart deckterm-dev.service")).action).toBe("allow");
  });
  test("a block wins over a warning", () => {
    expect(evaluate(bash("curl localhost:4173/x; systemctl --user restart deckterm.service")).action).toBe("block");
  });
});

test("rules are case-insensitive like hookify", () => {
  expect(evaluate(bash("GIT RESET --HARD")).action).toBe("block");
  expect(evaluate(fileEdit("Edit", "file_path", "/x/WEB/Vendor/a.js")).action).toBe("block");
});

test("long multi-line input without a match is evaluated quickly", () => {
  const command = Array.from({ length: 2000 }, (_, i) => `echo line ${i} localhost:4173 ${"x".repeat(30)}`).join("\n");
  const started = performance.now();
  expect(evaluate(bash(command)).action).toBe("allow");
  expect(evaluate(bash("x".repeat(80000) + " curl")).action).toBe("allow");
  expect(performance.now() - started).toBeLessThan(500);
});

test("unknown tools and malformed input are allowed", () => {
  expect(evaluate({ tool_name: "Read", tool_input: { file_path: "web/vendor/x.js" } }).action).toBe("allow");
  expect(evaluate(null).action).toBe("allow");
  expect(evaluate({ tool_name: "Bash" }).action).toBe("allow");
});

describe("hook process", () => {
  async function run(stdin: string) {
    const proc = Bun.spawn(["bun", "--no-env-file", script], {
      stdin: new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, out, err };
  }
  test("exit 2 with the reason on stderr for a block", async () => {
    const r = await run(JSON.stringify(bash("curl http://localhost:4173/api/health")));
    expect(r.code).toBe(2);
    expect(r.err).toContain("4174");
  });
  test("exit 0 with added context for a warning", async () => {
    const r = await run(JSON.stringify(bash("systemctl --user restart deckterm.service")));
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.additionalContext).toContain("Deploy Main");
  });
  test("exit 0 and no output when allowed or unparsable", async () => {
    expect(await run(JSON.stringify(bash("ls")))).toMatchObject({ code: 0, out: "" });
    expect(await run("not json")).toMatchObject({ code: 0, out: "" });
  });
});

test("project settings wire the hook for Bash and file edits", async () => {
  const settings = await Bun.file(resolve(import.meta.dir, "../.claude/settings.json")).json();
  const entries = settings.hooks.PreToolUse as { matcher: string; hooks: { command: string }[] }[];
  const entry = entries.find((e) => e.hooks.some((h) => h.command.includes("scripts/claude-guardrails.ts")));
  expect(entry).toBeDefined();
  for (const tool of ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"]) {
    expect(entry!.matcher.split("|")).toContain(tool);
  }
});
