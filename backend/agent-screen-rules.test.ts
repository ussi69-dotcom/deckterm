import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_RULES_DIR,
  NO_MATCH_RULE_ID,
  ScreenRuleLoadError,
  compileManifest,
  compileRustRegex,
  evaluate,
  evaluateManifest,
  isHorizontalRule,
  loadAgentManifest,
  parseManifestToml,
  parseRegionSpec,
  regionText,
  translateRustRegex,
} from "./agent-screen-rules";

const RULE = "─".repeat(20);

function manifest(rules: Record<string, unknown>[]) {
  return compileManifest({ id: "test", version: "1", rules });
}

function region(spec: string, screen: string, title = "", progress = "") {
  return regionText(parseRegionSpec(spec), { screen, title, progress });
}

describe("Rust regex translation", () => {
  test("\\x{…} becomes \\u{…} and every pattern gets the u flag", () => {
    expect(translateRustRegex("^[\\x{2800}-\\x{28FF}] ")).toEqual({
      source: "^[\\u{2800}-\\u{28FF}] ",
      flags: "u",
    });
    expect(compileRustRegex("^[\\x{2800}-\\x{28FF}] ").test("⠹ x")).toBe(
      true,
    );
  });

  test("leading (?i), (?m), (?s) and combinations become flags", () => {
    expect(translateRustRegex("(?i)esc")).toEqual({ source: "esc", flags: "iu" });
    expect(translateRustRegex("(?m)^x$")).toEqual({ source: "^x$", flags: "mu" });
    expect(translateRustRegex("(?s)a.b")).toEqual({ source: "a.b", flags: "su" });
    expect(translateRustRegex("(?im)(?s)x")).toEqual({
      source: "x",
      flags: "imsu",
    });
  });

  test("\\A and \\z become whole-input anchors", () => {
    const start = compileRustRegex("\\A> You");
    expect(start.test("> You are")).toBe(true);
    expect(start.test("x\n> You are")).toBe(false);
    const multilineStart = compileRustRegex("(?m)\\A> You");
    expect(multilineStart.test("x\n> You are")).toBe(false);
    const end = compileRustRegex("(?m)done\\s*\\z");
    expect(end.test("done\n")).toBe(true);
    expect(end.test("done\nmore")).toBe(false);
  });

  test("an inline flag anywhere else is a load error", () => {
    expect(() => translateRustRegex("abc(?i)def")).toThrow(ScreenRuleLoadError);
    expect(() => translateRustRegex("a(?i:b)")).toThrow(ScreenRuleLoadError);
    expect(() => translateRustRegex("(?x)a")).toThrow(ScreenRuleLoadError);
    // Groups and lookarounds are fine, and so is "(?" inside a class.
    expect(() =>
      translateRustRegex("(?:a)(?=b)(?!c)(?<=d)(?<!e)(?<name>f)[(?i)]"),
    ).not.toThrow();
  });

  test("an escaped parenthesis is not a group", () => {
    expect(translateRustRegex("\\(?i\\)").source).toBe("\\(?i\\)");
  });

  test("a pattern JavaScript cannot compile is a load error", () => {
    expect(() => compileRustRegex("a{2,1}")).toThrow(ScreenRuleLoadError);
    expect(() => compileRustRegex("\\Z")).toThrow(ScreenRuleLoadError);
  });
});

describe("vendored rules", () => {
  test("every vendored regex compiles and every rule loads", () => {
    for (const agent of ["claude", "codex"] as const) {
      const text = readFileSync(join(AGENT_RULES_DIR, `${agent}.toml`), "utf8");
      const raw = Bun.TOML.parse(text) as {
        rules: Record<string, unknown>[];
      };
      const patterns: string[] = [];
      const collect = (gate: Record<string, unknown>) => {
        for (const key of ["regex", "line_regex"]) {
          for (const pattern of (gate[key] as string[] | undefined) || []) {
            patterns.push(pattern);
          }
        }
        for (const key of ["all", "any", "not"]) {
          for (const nested of (gate[key] as Record<string, unknown>[]) || []) {
            collect(nested);
          }
        }
      };
      raw.rules.forEach(collect);
      expect(patterns.length).toBeGreaterThan(5);
      for (const pattern of patterns) {
        expect(() => compileRustRegex(pattern)).not.toThrow();
      }
      const loaded = loadAgentManifest(agent);
      expect(loaded.id).toBe(agent);
      expect(loaded.rules.length).toBe(raw.rules.length);
    }
  });

  test("the vendored files carry the attribution header", () => {
    for (const agent of ["claude", "codex"]) {
      const text = readFileSync(join(AGENT_RULES_DIR, `${agent}.toml`), "utf8");
      expect(text).toContain(`src/detect/manifests/${agent}.toml`);
      expect(text).toContain("2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01");
      expect(text).toContain("Apache-2.0");
      expect(text).toContain("modified by DeckTerm");
      expect(text).toContain("upstream manifest version: 2026.10.11.1");
    }
  });

  test("manifest versions are reported as agent@version", () => {
    expect(evaluate("claude", { screen: "" }).manifestVersion).toBe(
      "claude@2026.10.11.1",
    );
    expect(evaluate("codex", { screen: "" }).manifestVersion).toBe(
      "codex@2026.10.11.1",
    );
  });
});

describe("loader validation", () => {
  test("rejects unknown regions, including ones herdr has but DeckTerm does not port", () => {
    for (const spec of [
      "bottom_lines(5)",
      "above_prompt_box",
      "current_prompt_block_marker",
      "nonsense",
      "bottom_non_empty_lines(0)",
      "top_non_empty_lines(07)",
      "bottom_non_empty_lines(x)",
    ]) {
      expect(() =>
        manifest([{ id: "r", state: "idle", region: spec, contains: ["x"] }]),
      ).toThrow(ScreenRuleLoadError);
    }
    expect(() =>
      manifest([
        {
          id: "r",
          state: "idle",
          region: "bottom_non_empty_lines(12)",
          contains: ["x"],
        },
      ]),
    ).not.toThrow();
  });

  test("rejects unknown fields, duplicate ids, unknown states and bad regexes", () => {
    expect(() =>
      manifest([{ id: "r", state: "idle", contains: ["x"], extra: 1 }]),
    ).toThrow(ScreenRuleLoadError);
    expect(() =>
      manifest([
        { id: "r", state: "idle", contains: ["x"] },
        { id: "r", state: "idle", contains: ["y"] },
      ]),
    ).toThrow(ScreenRuleLoadError);
    expect(() => manifest([{ id: "r", state: "busy", contains: ["x"] }])).toThrow(
      ScreenRuleLoadError,
    );
    expect(() =>
      manifest([{ id: "r", state: "idle", regex: ["a(?i)b"] }]),
    ).toThrow(ScreenRuleLoadError);
    expect(() =>
      manifest([{ id: "r", state: "idle", any: [{ contains: ["x"], foo: 1 }] }]),
    ).toThrow(ScreenRuleLoadError);
    expect(() => parseManifestToml("id = ")).toThrow(ScreenRuleLoadError);
  });
});

describe("regions", () => {
  const screen = [
    "header",
    "",
    "body one",
    RULE,
    "❯ prompt",
    RULE,
    "  footer",
    "",
    "",
  ].join("\n");

  test("osc_title and osc_progress come from their own inputs", () => {
    expect(region("osc_title", screen, "T", "4;1")).toBe("T");
    expect(region("osc_progress", screen, "T", "4;1")).toBe("4;1");
  });

  test("bottom and top non-empty lines skip blank rows", () => {
    expect(region("bottom_non_empty_lines(2)", screen)).toBe(
      `${RULE}\n  footer\n\n`,
    );
    expect(region("top_non_empty_lines(2)", screen)).toBe(
      "header\n\nbody one\n",
    );
    expect(region("bottom_non_empty_lines(3)", "\n\n")).toBe("");
  });

  test("after_last_horizontal_rule, prompt_box_body and the line above the box", () => {
    expect(region("after_last_horizontal_rule", screen)).toBe("  footer\n\n");
    expect(region("prompt_box_body", screen)).toBe("❯ prompt\n");
    expect(region("last_non_empty_above_prompt_box", screen)).toBe("body one");
    expect(region("prompt_box_body", "no rules here")).toBe("");
    expect(region("after_last_horizontal_rule", "no rules")).toBe("no rules");
  });

  test("horizontal rules: only rule characters, or three or more and a suffix", () => {
    expect(isHorizontalRule("  ────  ")).toBe(true);
    expect(isHorizontalRule("─── name ")).toBe(true);
    expect(isHorizontalRule("── x")).toBe(false);
    expect(isHorizontalRule("╌╌╌╌")).toBe(false);
    expect(isHorizontalRule("   ")).toBe(false);
  });

  test("Codex prompt-marker helpers", () => {
    const codex = ["• Ran ls", "", "› Ask Codex", "", "  status line"].join(
      "\n",
    );
    expect(region("after_last_prompt_marker", codex)).toBe("\n  status line");
    expect(region("before_current_prompt_marker", codex)).toBe("• Ran ls\n\n");
    expect(region("whole_recent_without_current_prompt_marker", codex)).toBe("");
    // A block marker after the prompt makes that prompt stale.
    const stale = ["› old prompt", "• Working (3s)"].join("\n");
    expect(region("before_current_prompt_marker", stale)).toBe(stale);
    expect(region("whole_recent_without_current_prompt_marker", stale)).toBe(
      stale,
    );
    expect(region("after_last_prompt_marker", "no prompt")).toBe("no prompt");
    // "›" alone is a prompt line; "›x" is not.
    expect(region("after_last_prompt_marker", "a\n›\nb")).toBe("b");
    expect(region("after_last_prompt_marker", "a\n›x\nb")).toBe("a\n›x\nb");
  });
});

describe("matchers", () => {
  const match = (rule: Record<string, unknown>, screen: string) =>
    evaluateManifest(manifest([{ id: "r", state: "blocked", ...rule }]), {
      screen,
    }).ruleId === "r";

  test("contains compares lower-cased text and needs every needle", () => {
    expect(match({ contains: ["ESC to Cancel"] }, "Esc to cancel")).toBe(true);
    expect(match({ contains: ["esc", "enter"] }, "esc only")).toBe(false);
  });

  test("regex must match the region; line_regex must match one line", () => {
    expect(match({ regex: ["^a\\nb$"] }, "a\nb")).toBe(true);
    expect(match({ line_regex: ["^b$"] }, "a\nb\nc")).toBe(true);
    expect(match({ regex: ["^b$"] }, "a\nb\nc")).toBe(false);
    // Every line_regex needs its own matching line.
    expect(match({ line_regex: ["^a$", "^z$"] }, "a\nb")).toBe(false);
  });

  test("all, any and not nest", () => {
    const rule = {
      contains: ["form"],
      all: [{ any: [{ contains: ["yes"] }, { contains: ["ok"] }] }],
      not: [{ contains: ["cancelled"] }],
    };
    expect(match(rule, "form ok")).toBe(true);
    expect(match(rule, "form yes")).toBe(true);
    expect(match(rule, "form")).toBe(false);
    expect(match(rule, "form ok cancelled")).toBe(false);
    // An empty `any` list does not block.
    expect(match({ contains: ["x"], any: [] }, "x")).toBe(true);
  });
});

describe("evaluation", () => {
  test("the highest priority wins and ties go to the earlier rule", () => {
    const m = manifest([
      { id: "low", state: "working", priority: 10, contains: ["x"] },
      { id: "first", state: "blocked", priority: 50, contains: ["x"] },
      { id: "second", state: "idle", priority: 50, contains: ["x"] },
    ]);
    expect(evaluateManifest(m, { screen: "x" })).toMatchObject({
      state: "blocked",
      ruleId: "first",
    });
  });

  test("no match is idle with rule no_match", () => {
    const m = manifest([{ id: "r", state: "blocked", contains: ["zzz"] }]);
    expect(evaluateManifest(m, { screen: "hello" })).toEqual({
      state: "idle",
      ruleId: NO_MATCH_RULE_ID,
      region: null,
      visibleIdle: false,
      visibleBlocker: false,
      visibleWorking: false,
      skip: false,
      manifestVersion: "test@1",
    });
  });

  test("skip_state_update is reported, with the visible flags tied to the state", () => {
    const m = manifest([
      {
        id: "viewer",
        state: "unknown",
        priority: 100,
        skip_state_update: true,
        contains: ["transcript"],
      },
      {
        id: "prompt",
        state: "idle",
        priority: 50,
        visible_idle: true,
        visible_blocker: true,
        contains: ["❯"],
      },
    ]);
    expect(
      evaluateManifest(m, { screen: "transcript ❯" }),
    ).toMatchObject({ ruleId: "viewer", skip: true, state: "unknown" });
    expect(evaluateManifest(m, { screen: "❯" })).toMatchObject({
      ruleId: "prompt",
      visibleIdle: true,
      visibleBlocker: false,
      skip: false,
    });
  });

  test("Claude's transcript viewer rule skips the state update", () => {
    const screen = [
      "some transcript",
      "",
      "Showing detailed transcript · ctrl+o to toggle",
    ].join("\n");
    expect(evaluate("claude", { screen })).toMatchObject({
      ruleId: "transcript_viewer",
      skip: true,
    });
  });

  test("Claude's OSC progress 4;0 reads as idle when nothing else matches", () => {
    expect(evaluate("claude", { screen: "", progress: "4;0" })).toMatchObject({
      state: "idle",
      ruleId: "osc_progress_idle",
    });
  });

  test("CRLF screens evaluate like LF screens", () => {
    const lf = `x\n${RULE}\n❯ \n${RULE}\n`;
    expect(evaluate("claude", { screen: lf.replace(/\n/g, "\r\n") })).toEqual(
      evaluate("claude", { screen: lf }),
    );
  });
});
