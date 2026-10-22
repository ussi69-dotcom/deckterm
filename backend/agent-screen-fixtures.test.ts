// The S1 fixture suite (design section 4): every saved agent screen in
// backend/fixtures/agent-screens/ is fed to the vendored rules with its
// recorded title, and must give the recorded state (and rule, when given).

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate, type RuleAgent } from "./agent-screen-rules";

const FIXTURE_DIR = join(import.meta.dir, "fixtures/agent-screens");
const REQUIRED_HEADER_KEYS = [
  "agent",
  "version",
  "state",
  "title",
  "size",
  "capture",
  "date",
  "synthetic",
  "redactions",
];

type Fixture = {
  file: string;
  header: Record<string, string>;
  screen: string;
};

function parseFixture(file: string): Fixture {
  const text = readFileSync(join(FIXTURE_DIR, file), "utf8");
  if (!text.startsWith("---\n")) {
    throw new Error(`${file}: missing header start`);
  }
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) throw new Error(`${file}: missing header end`);
  const header: Record<string, string> = {};
  for (const line of text.slice(4, end).split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error(`${file}: bad header line ${line}`);
    header[line.slice(0, separator)] = line
      .slice(separator + 1)
      .replace(/^ /, "");
  }
  return { file, header, screen: text.slice(end + "\n---\n".length) };
}

const fixtures = readdirSync(FIXTURE_DIR)
  .filter((file) => file.endsWith(".txt"))
  .sort()
  .map(parseFixture);

const synthetic = fixtures.filter((f) => f.header.synthetic === "yes");
console.log(
  `[agent-screen-fixtures] ${fixtures.length} fixtures, ${synthetic.length} synthetic` +
    (synthetic.length ? `: ${synthetic.map((f) => f.file).join(", ")}` : ""),
);

describe("agent screen fixtures", () => {
  test("the required set is present", () => {
    const has = (agent: string, state: string, shape: string) =>
      fixtures.some(
        (f) =>
          f.header.agent === agent &&
          f.header.state === state &&
          f.file.includes(shape),
      );
    expect(has("claude", "working", "spinner")).toBe(true);
    expect(has("claude", "idle", "prompt")).toBe(true);
    expect(has("claude", "blocked", "question-form")).toBe(true);
    expect(has("claude", "blocked", "plan-approval")).toBe(true);
    expect(has("claude", "blocked", "bash-permission")).toBe(true);
    expect(has("codex", "working", "timer")).toBe(true);
    expect(has("codex", "idle", "composer")).toBe(true);
    expect(has("codex", "blocked", "approval")).toBe(true);
    expect(has("codex", "blocked", "trust-dialog")).toBe(true);
  });

  for (const fixture of fixtures) {
    test(fixture.file, () => {
      const { header } = fixture;
      for (const key of REQUIRED_HEADER_KEYS) {
        expect(header).toHaveProperty(key);
      }
      expect(["claude", "codex"]).toContain(header.agent);
      expect(["working", "blocked", "idle"]).toContain(header.state);
      // The file name and the synthetic flag must agree.
      expect(fixture.file.endsWith("-synthetic.txt")).toBe(
        header.synthetic === "yes",
      );
      const result = evaluate(header.agent as RuleAgent, {
        screen: fixture.screen,
        title: header.title,
      });
      expect({ file: fixture.file, state: result.state }).toEqual({
        file: fixture.file,
        state: header.state as never,
      });
      if (header.rule) {
        expect({ file: fixture.file, rule: result.ruleId }).toEqual({
          file: fixture.file,
          rule: header.rule,
        });
      }
    });
  }
});
