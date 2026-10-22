// Bounded cost of the screen rules (S1 review fixes, design section 8).
//
// herdr matches its rules with the Rust regex crate, which runs in linear
// time. JavaScript backtracks, so the port has to bound the cost itself:
// super-linear vendored patterns are rewritten (or replaced by a line scan)
// and the input is bounded. This file checks that
// - every rewrite matches exactly what the upstream pattern matches,
// - regions are bounded and line breaks normalized,
// - every vendored pattern stays under 50 ms on adversarial 300 x 400 screens.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_RULES_DIR,
  CODEX_WORKING_FALLBACK_PATTERN,
  LINEAR_PATTERN_MATCHERS,
  MAX_REGION_LINE_CHARS,
  MAX_REGION_LINES,
  boundRegionText,
  codexWorkingFallbackMatches,
  compilePattern,
  compileRustRegex,
  evaluate,
  loadAgentManifest,
  normalizeScreenText,
  patternMatchesRegion,
  regionText,
  rulePatternMatchers,
  type RuleAgent,
} from "./agent-screen-rules";
import {
  pumpPattern,
  screenFrom,
  seededRandom,
} from "./test-support/adversarial-screens";

const BUDGET_MS = 50;
const ROWS = 300;
const COLS = 400;
const AGENTS: RuleAgent[] = ["claude", "codex"];

/** Fastest of up to three runs; a super-linear pattern stays slow in all. */
function timed(fn: () => unknown): number {
  let best = Infinity;
  for (let run = 0; run < 3; run++) {
    const startedAt = performance.now();
    fn();
    best = Math.min(best, performance.now() - startedAt);
    if (best <= BUDGET_MS) break;
  }
  return best;
}

// The upstream text of every pattern DeckTerm rewrote in the vendored TOML,
// with seeds for the equivalence check (see the TOML headers).
const REWRITES: Array<{
  agent: RuleAgent;
  rule: string;
  kind: "regex" | "line_regex";
  upstream: string;
  deckterm: string;
  seeds: string[];
}> = [
  {
    agent: "claude",
    rule: "background_mcp_task_working",
    kind: "regex",
    upstream:
      "(?m)^[\\x{002A}\\x{00B7}\\x{2722}\\x{2736}\\x{273B}\\x{273D}][ \\t]+\\S[^\\n]*?(?:\\n[ \\t]+[^\\n]*?){0,3}·(?:[ \\t]+|\\n[ \\t]*)[1-9]\\d*(?:[ \\t]+|\\n[ \\t]*)MCP(?:[ \\t]+|\\n[ \\t]*)tasks?(?:[ \\t]+|\\n[ \\t]*)still(?:[ \\t]+|\\n[ \\t]*)running[ \\t]*$",
    deckterm:
      "(?m)^[\\x{002A}\\x{00B7}\\x{2722}\\x{2736}\\x{273B}\\x{273D}][ \\t]+\\S[^\\n]*?(?:\\n[ \\t][^\\n]*?){0,3}·(?:[ \\t]+|\\n[ \\t]*)[1-9]\\d*(?:[ \\t]+|\\n[ \\t]*)MCP(?:[ \\t]+|\\n[ \\t]*)tasks?(?:[ \\t]+|\\n[ \\t]*)still(?:[ \\t]+|\\n[ \\t]*)running[ \\t]*$",
    seeds: [
      "* Running 2 tools · 1 MCP task still running",
      "✻ Doing things\n  more words\n\tand more · 2\n  MCP tasks\n still running  ",
      "* x\n  y\n  y\n  y\n  y\n  z · 1 MCP task still running",
      "· x ·  3 MCP tasks still running\n",
    ],
  },
  {
    agent: "claude",
    rule: "live_blocked_form_named_session",
    kind: "regex",
    upstream:
      "(?i)(?:^|\\n)[ \\t]*enter\\s+to\\s+(?:confirm|select\\s+·\\s+(?:(?:tab/arrow|arrow)\\s+keys|arrows|↑/↓|↑↓)\\s+to\\s+navigate)\\s+·\\s+esc\\s+to\\s+cancel[ \\t]*\\n(?:[ \\t]*\\n)*[ \\t]*─{3,}[^\\n]*(?:\\n(?:[ \\t]*\\n)*[ \\t]+\\d+ tasks? \\(\\d+ done, (?:\\d+ in progress, )?\\d+ open\\)(?:\\n[ \\t]+[◻◼✔][ \\t]+[^\\n]+)+(?:\\n[ \\t]+…[ \\t]+\\+\\d+[ \\t]+pending)?)?(?:\\n[ \\t]*)*\\z",
    deckterm:
      "(?i)(?:^|\\n)[ \\t]*enter\\s+to\\s+(?:confirm|select\\s+·\\s+(?:(?:tab/arrow|arrow)\\s+keys|arrows|↑/↓|↑↓)\\s+to\\s+navigate)\\s+·\\s+esc\\s+to\\s+cancel[ \\t]*\\n(?:[ \\t]*\\n)*[ \\t]*─{3}[^\\n]*(?:\\n(?:[ \\t]*\\n)*[ \\t]+\\d+ tasks? \\(\\d+ done, (?:\\d+ in progress, )?\\d+ open\\)(?:\\n[ \\t]+[◻◼✔][ \\t][^\\n]+)+(?:\\n[ \\t]+…[ \\t]+\\+\\d+[ \\t]+pending)?)?(?:\\n[ \\t]*)*\\z",
    seeds: [
      "Enter to confirm · Esc to cancel\n\n──── name\n  3 tasks (1 done, 2 open)\n  ◻ a\n  ✔  b\n  … +2 pending\n",
      "x\n  Enter to select · ↑/↓ to navigate · Esc to cancel\n───",
      "Enter to select · arrow keys to navigate · Esc to cancel\n ───────── x\n\n  1 task (0 done, 1 in progress, 0 open)\n  ◼\tdo\n",
    ],
  },
  {
    agent: "claude",
    rule: "mcp_elicitation_prompt",
    kind: "line_regex",
    upstream: "^\\s*\\x{276F}?\\s*Accept\\b",
    deckterm: "^\\s*(?:\\x{276F}\\s*)?Accept\\b",
    seeds: [
      "  ❯ Accept",
      "Accept",
      "  ❯Decline  x",
      "   ❯   Accept now",
      " Declined",
    ],
  },
  {
    agent: "claude",
    rule: "mcp_elicitation_prompt",
    kind: "line_regex",
    upstream: "^\\s*\\x{276F}?\\s*Decline\\b",
    deckterm: "^\\s*(?:\\x{276F}\\s*)?Decline\\b",
    seeds: [
      "  ❯ Accept",
      "Accept",
      "  ❯Decline  x",
      "   ❯   Accept now",
      " Declined",
    ],
  },
  {
    agent: "claude",
    rule: "bash_permission_prompt",
    kind: "line_regex",
    upstream: "(?i)^\\s*❯?\\s*yes\\b",
    deckterm: "(?i)^\\s*(?:❯\\s*)?yes\\b",
    seeds: [
      "❯ 1. Yes",
      "  2. yes",
      " ❯ 2. No",
      "3. no",
      "❯ Yes",
      "  yes, and don't ask",
    ],
  },
  {
    agent: "claude",
    rule: "bash_permission_prompt",
    kind: "line_regex",
    upstream: "(?i)^\\s*❯?\\s*1\\.\\s*yes\\b",
    deckterm: "(?i)^\\s*(?:❯\\s*)?1\\.\\s*yes\\b",
    seeds: [
      "❯ 1. Yes",
      "  2. yes",
      " ❯ 2. No",
      "3. no",
      "❯ Yes",
      "  yes, and don't ask",
    ],
  },
  {
    agent: "claude",
    rule: "bash_permission_prompt",
    kind: "line_regex",
    upstream: "(?i)^\\s*❯?\\s*2\\.\\s*yes\\b",
    deckterm: "(?i)^\\s*(?:❯\\s*)?2\\.\\s*yes\\b",
    seeds: [
      "❯ 1. Yes",
      "  2. yes",
      " ❯ 2. No",
      "3. no",
      "❯ Yes",
      "  yes, and don't ask",
    ],
  },
  {
    agent: "claude",
    rule: "bash_permission_prompt",
    kind: "line_regex",
    upstream: "(?i)^\\s*❯?\\s*2\\.\\s*no\\b",
    deckterm: "(?i)^\\s*(?:❯\\s*)?2\\.\\s*no\\b",
    seeds: [
      "❯ 1. Yes",
      "  2. yes",
      " ❯ 2. No",
      "3. no",
      "❯ Yes",
      "  yes, and don't ask",
    ],
  },
  {
    agent: "claude",
    rule: "bash_permission_prompt",
    kind: "line_regex",
    upstream: "(?i)^\\s*❯?\\s*3\\.\\s*no\\b",
    deckterm: "(?i)^\\s*(?:❯\\s*)?3\\.\\s*no\\b",
    seeds: [
      "❯ 1. Yes",
      "  2. yes",
      " ❯ 2. No",
      "3. no",
      "❯ Yes",
      "  yes, and don't ask",
    ],
  },
  {
    agent: "claude",
    rule: "generic_permission_prompt",
    kind: "line_regex",
    upstream: "(?i)^\\s*❯?\\s*1\\.\\s*yes\\b",
    deckterm: "(?i)^\\s*(?:❯\\s*)?1\\.\\s*yes\\b",
    seeds: ["❯ 1. Yes", "  1.yes", "❯1. Yes!"],
  },
  {
    agent: "claude",
    rule: "legacy_no_prompt_blocker",
    kind: "regex",
    upstream: "(?m)^\\s*❯\\s*$",
    deckterm: "(?m)^[^\\S\\n]*❯[^\\S\\n]*$",
    seeds: ["x\n  ❯  \ny", "❯", "a\n \t❯\n", "❯ x\n ❯", "\n\n  ❯"],
  },
  {
    agent: "codex",
    rule: "startup_update",
    kind: "regex",
    upstream: "(?m)^\\s*Update\\s+available\\s+·",
    deckterm: "(?m)^[^\\S\\n]*Update\\s+available\\s+·",
    seeds: [
      "  Update available · 1.2",
      "x\n Update  available  · y",
      "\n\n  Update available ·",
    ],
  },
  {
    agent: "codex",
    rule: "weak_blocker",
    kind: "regex",
    upstream: "(?m)^›[⠁⠂⠄⠈⠐⠠⡀⢀][^\\n]*(?:\\n(?:[^•■✗✓\\n][^\\n]*)?)*\\z",
    deckterm:
      "(?m)^›[⠁⠂⠄⠈⠐⠠⡀⢀][^\\n]*(?:\\n(?:(?!›[⠁⠂⠄⠈⠐⠠⡀⢀])[^•■✗✓\\n][^\\n]*)?)*\\z",
    seeds: [
      "›⠁ hi\nx\n",
      "x\n›⠁ a\n›⠂ b\nplain",
      "›⠁ a\n• done",
      "›⠁ a\n›⠂ b\n■ x",
      "›⢀\n\n",
    ],
  },
];

const FUZZ_TOKENS = [
  " ",
  "  ",
  "\t",
  "\n",
  "\n",
  "x",
  "y",
  "1",
  "2",
  "·",
  " · ",
  "…",
  "❯",
  "❯ ",
  "─",
  "───",
  "◻",
  "✔",
  "•",
  "› ",
  "›⠁",
  "›⠂",
  "■",
  "✓",
  "yes",
  "Yes",
  "no",
  "1.",
  "2.",
  "3.",
  "Accept",
  "Decline",
  "MCP",
  "task",
  "tasks",
  "still",
  "running",
  "Update",
  "available",
  "enter",
  "to",
  "confirm",
  "select",
  "esc",
  "cancel",
  "↑/↓",
  "navigate",
  "tasks (1 done, 2 open)",
  "+2 pending",
  "　",
  " ",
];

function mutate(seed: string, rnd: () => number): string {
  let text = seed;
  const steps = 1 + Math.floor(rnd() * 4);
  for (let step = 0; step < steps; step++) {
    const at = Math.floor(rnd() * (text.length + 1));
    const op = Math.floor(rnd() * 4);
    if (op === 0) {
      text =
        text.slice(0, at) +
        FUZZ_TOKENS[Math.floor(rnd() * FUZZ_TOKENS.length)] +
        text.slice(at);
    } else if (op === 1) {
      text = text.slice(0, at) + text.slice(at + 1 + Math.floor(rnd() * 4));
    } else if (op === 2) {
      // Pump: repeat a slice, the shape backtracking blows up on.
      const end = Math.min(text.length, at + 1 + Math.floor(rnd() * 6));
      text =
        text.slice(0, end) +
        text.slice(at, end).repeat(1 + Math.floor(rnd() * 3)) +
        text.slice(end);
    } else {
      text =
        text.slice(0, at) +
        FUZZ_TOKENS[Math.floor(rnd() * FUZZ_TOKENS.length)] +
        text.slice(at + 1);
    }
  }
  return normalizeScreenText(text);
}

function vendoredPatterns(agent: RuleAgent): string[] {
  const raw = Bun.TOML.parse(
    readFileSync(join(AGENT_RULES_DIR, `${agent}.toml`), "utf8"),
  ) as { rules: Record<string, unknown>[] };
  const out: string[] = [];
  const walk = (gate: Record<string, unknown>) => {
    for (const key of ["regex", "line_regex"]) {
      out.push(...((gate[key] as string[] | undefined) || []));
    }
    for (const key of ["all", "any", "not"]) {
      for (const nested of (gate[key] as Record<string, unknown>[]) || []) {
        walk(nested);
      }
    }
  };
  raw.rules.forEach(walk);
  return out;
}

describe("linear rewrites of super-linear vendored patterns", () => {
  test("the vendored TOML carries each rewrite instead of the upstream text", () => {
    for (const rewrite of REWRITES) {
      const rule = loadAgentManifest(rewrite.agent).rules.find(
        (candidate) => candidate.id === rewrite.rule,
      );
      expect(rule).toBeDefined();
      const patterns = rulePatternMatchers(rule!).map((m) => m.pattern);
      expect(patterns).toContain(rewrite.deckterm);
      expect(patterns).not.toContain(rewrite.upstream);
    }
  });

  test("each rewrite matches exactly what the upstream pattern matches", () => {
    const rnd = seededRandom(20261022);
    for (const rewrite of REWRITES) {
      const upstream = compileRustRegex(rewrite.upstream);
      const deckterm = compilePattern(rewrite.deckterm);
      let matched = 0;
      const samples = [
        ...rewrite.seeds.map(normalizeScreenText),
        ...Array.from({ length: 1500 }, (_, i) =>
          mutate(rewrite.seeds[i % rewrite.seeds.length], rnd),
        ),
      ];
      for (const sample of samples) {
        const texts =
          rewrite.kind === "line_regex" ? sample.split("\n") : [sample];
        for (const text of texts) {
          const expected = upstream.test(text);
          if (expected) matched++;
          if (deckterm.test(text) !== expected) {
            throw new Error(
              `${rewrite.agent}.${rewrite.rule}: rewrite disagrees on ${JSON.stringify(text)}`,
            );
          }
        }
      }
      // The samples exercise both outcomes.
      expect(matched).toBeGreaterThan(0);
    }
  });

  test("screen_working_fallback runs as a line scan that matches exactly what the regex matches", () => {
    const rule = loadAgentManifest("codex").rules.find(
      (candidate) => candidate.id === "screen_working_fallback",
    )!;
    const matcher = rulePatternMatchers(rule).find(
      (m) => m.pattern === CODEX_WORKING_FALLBACK_PATTERN,
    );
    expect(matcher?.test).toBe(codexWorkingFallbackMatches);

    const regex = compileRustRegex(CODEX_WORKING_FALLBACK_PATTERN);
    const lines = [
      "",
      " ",
      "　",
      "x",
      "x (1s)",
      "x (1s)  ",
      "x (1s) z",
      "x (1s) · ",
      "x (1m)",
      "x (1m 2s)",
      "x(1s)",
      " x (1s)",
      "◦\tx (1h 2m 3s)",
      "◦x (1s)",
      "• Working (3s • esc to interrupt)",
      "• Working (3s • a to interrupt) · x",
      "• Working (3s • to interrupt)",
      "x (1s • a to interrupt) b to interrupt)",
      "x (1s • a to interrupt) (2s)",
      "› x",
      "›",
      "›⠁x",
      "■ x",
      "─ x",
      "✓ done",
      "• Queued follow-up inputs",
      "• Queued follow-up inputs ",
      "•  Queued",
      "follow-up",
      "  inputs",
      "• Messages to be submitted after next tool call",
      "• Messages to be submitted after next tool call (press x to interrupt and send immediately)",
      "• Messages to be submitted after next tool call (press x to interrupt and send immediately) y",
      "• Messages to be submitted after next tool call (press",
      " x to interrupt and send immediately)",
      "to interrupt and send immediately)",
      "(press x to",
      "interrupt and send immediately)",
      "• Messages to be submitted at end of turn",
      "• Messages to be",
      "submitted at end of turn",
      "• Messages to be submitted after next tool call (press  to interrupt and send immediately)",
      "• Messages to be submitted after next tool call (press   to interrupt and send immediately)",
    ];
    const rnd = seededRandom(7);
    let matched = 0;
    for (let i = 0; i < 6000; i++) {
      const count = 1 + Math.floor(rnd() * 7);
      const picked = Array.from(
        { length: count },
        () => lines[Math.floor(rnd() * lines.length)],
      );
      let text = picked.join(rnd() < 0.8 ? "\n" : rnd() < 0.5 ? "\n\n" : " \n");
      if (rnd() < 0.3)
        text += ["\n", "  ", "\n  \n", "　"][Math.floor(rnd() * 4)];
      text = normalizeScreenText(text);
      const expected = regex.test(text);
      if (expected) matched++;
      if (codexWorkingFallbackMatches(text) !== expected) {
        throw new Error(`line scan disagrees on ${JSON.stringify(text)}`);
      }
    }
    expect(matched).toBeGreaterThan(500);
  });

  test("every linear matcher replaces a pattern that is in a vendored manifest", () => {
    const all = new Set(AGENTS.flatMap(vendoredPatterns));
    for (const pattern of LINEAR_PATTERN_MATCHERS.keys()) {
      // A re-sync that changes the text must update the matcher too.
      expect(all.has(pattern)).toBe(true);
    }
  });
});

describe("bounded input", () => {
  test("a region keeps its last 200 lines of at most 512 characters", () => {
    const tall = Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n");
    const bounded = boundRegionText(tall).split("\n");
    expect(bounded.length).toBe(MAX_REGION_LINES);
    expect(bounded[0]).toBe("line 50");
    expect(bounded.at(-1)).toBe("line 249");
    expect(boundRegionText(`${"a".repeat(600)}\nb\n`)).toBe(
      `${"a".repeat(MAX_REGION_LINE_CHARS)}\nb\n`,
    );
    // A cut never leaves half of a surrogate pair.
    const emoji = `${"a".repeat(MAX_REGION_LINE_CHARS - 1)}😀tail`;
    expect(boundRegionText(emoji)).toBe("a".repeat(MAX_REGION_LINE_CHARS - 1));
    const small = "short\nscreen\n";
    expect(boundRegionText(small)).toBe(small);
  });

  test("only \\n breaks lines: CRLF becomes LF, a lone CR, U+2028 and U+2029 a space", () => {
    expect(normalizeScreenText("a\r\nb\rc d e")).toBe("a\nb c d e");
    // Rust's `.` matches U+2028; JavaScript's would not without this.
    const spinner = [
      "✻ Thinking about it… (3s · esc to interrupt)",
      "",
      "─".repeat(20),
      "❯ ",
      "─".repeat(20),
    ].join("\n");
    expect(evaluate("claude", { screen: spinner }).ruleId).toBe(
      "live_turn_working",
    );
  });

  test("a prompt at the bottom of a very tall pane still reads blocked", () => {
    const screen = [
      ...Array.from({ length: 450 }, (_, i) => `output ${i}`),
      "─".repeat(40),
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. No",
      "",
      " Esc to cancel · Tab to amend",
    ].join("\n");
    expect(evaluate("claude", { screen }).state).toBe("blocked");
  });
});

describe("adversarial screens", () => {
  test("every vendored pattern evaluates in under 50 ms on pumped 300 x 400 screens", () => {
    let slowest = { ms: 0, label: "" };
    let screens = 0;
    const note = (ms: number, label: string) => {
      if (ms > slowest.ms) slowest = { ms, label };
    };
    for (const agent of AGENTS) {
      const manifest = loadAgentManifest(agent);
      for (const rule of manifest.rules) {
        for (const matcher of rulePatternMatchers(rule)) {
          for (const [index, strategy] of [
            "first",
            "last",
            "random",
          ].entries()) {
            const rnd = seededRandom(17 + index);
            const witness = pumpPattern(matcher.pattern, {
              pumpChar: 150,
              pumpGroup: 8,
              pick: (count) =>
                strategy === "first"
                  ? 0
                  : strategy === "last"
                    ? count - 1
                    : Math.floor(rnd() * count),
            });
            for (const fillLines of [false, true]) {
              for (const ending of ["!", "─ x"]) {
                const screen = screenFrom(witness, {
                  rows: ROWS,
                  cols: COLS,
                  ending,
                  fillLines,
                });
                const title = screen.slice(screen.lastIndexOf("\n") + 1);
                const label = `${agent}.${rule.id} ${strategy}/${fillLines ? "fill" : "tile"}/${ending}`;
                screens++;
                const full = timed(() =>
                  evaluate(agent, { screen, title, progress: "" }),
                );
                note(full, `${label} (full evaluation)`);
                if (full > BUDGET_MS) {
                  throw new Error(
                    `${label}: full evaluation took ${full.toFixed(1)} ms`,
                  );
                }
                // The pattern itself on its own region, whatever gates
                // come first in the rule.
                const region = boundRegionText(
                  regionText(rule.region, {
                    screen: normalizeScreenText(screen),
                    title,
                    progress: "",
                  }),
                );
                const own = timed(() => patternMatchesRegion(matcher, region));
                note(own, `${label} (pattern only)`);
                if (own > BUDGET_MS) {
                  throw new Error(
                    `${label}: pattern took ${own.toFixed(1)} ms`,
                  );
                }
              }
            }
          }
        }
      }
    }
    console.log(
      `[agent-screen-perf] ${screens} pumped screens, slowest ${slowest.ms.toFixed(1)} ms: ${slowest.label}`,
    );
  }, 120_000);

  // The inputs the S1 reviews used, plus one per rewritten pattern.
  const repeat = (count: number, line: string) =>
    Array.from({ length: count }, () => line);
  const reviewed: Array<{ name: string; agent: RuleAgent; screen: string }> = [
    {
      name: "Claude MCP task rule, three deeply indented lines and a near miss (Codex review P1)",
      agent: "claude",
      screen: [
        ...repeat(296, "filler"),
        "* x",
        `\t${" ".repeat(394)}x`,
        `\t${" ".repeat(394)}x`,
        `\t${" ".repeat(370)}x · 1 MCP task still running!`,
      ].join("\n"),
    },
    {
      name: "Codex timer lines with many timers each (adversarial review)",
      agent: "codex",
      screen: [
        ...repeat(ROWS - 1, `x${" (1s)".repeat(80).slice(1, COLS)}`),
        "─ x",
      ].join("\n"),
    },
    {
      name: "Codex one timer per line (adversarial review)",
      agent: "codex",
      screen: [...repeat(ROWS - 1, `${"a".repeat(COLS - 5)} (1s)`), "─ x"].join(
        "\n",
      ),
    },
    {
      name: "Claude named-session task rows with wide gaps",
      agent: "claude",
      screen: [
        "Enter to confirm · Esc to cancel",
        "─".repeat(COLS - 1),
        "  3 tasks (1 done, 2 open)",
        ...repeat(20, `  ◻${" ".repeat(300)}x`),
        "x!",
      ].join("\n"),
    },
    {
      name: "Claude named-session footer and rule pairs",
      agent: "claude",
      screen: repeat(
        150,
        `Enter to confirm · Esc to cancel\n${"─".repeat(COLS)} x`,
      ).join("\n"),
    },
    {
      name: "Claude permission rows of leading spaces",
      agent: "claude",
      screen: [
        "Do you want to proceed?",
        "Bash(ls)",
        ...repeat(ROWS - 2, `${" ".repeat(COLS - 1)}x`),
      ].join("\n"),
    },
    {
      name: "Claude whitespace-only rows",
      agent: "claude",
      screen: [
        "waiting for permission",
        ...repeat(ROWS - 1, "　".repeat(COLS / 2)),
      ].join("\n"),
    },
    {
      name: "Codex whitespace-only rows",
      agent: "codex",
      screen: [
        "Update available!",
        ...repeat(ROWS - 1, "　".repeat(COLS / 2)),
      ].join("\n"),
    },
    {
      name: "Codex sparkle prompt rows",
      agent: "codex",
      screen: [
        "[y/n]",
        ...repeat(ROWS - 2, `›⠁${"x".repeat(COLS - 2)}`),
        "• x",
      ].join("\n"),
    },
    {
      name: "Codex line-separator starts",
      agent: "codex",
      screen: [
        "[y/n]",
        ...repeat(ROWS - 2, "x ›⠁".repeat(COLS / 4)),
        "• x",
      ].join("\n"),
    },
  ];
  for (const { name, agent, screen } of reviewed) {
    test(`${name}: under 50 ms`, () => {
      const ms = timed(() =>
        evaluate(agent, { screen, title: "", progress: "" }),
      );
      expect(ms).toBeLessThan(BUDGET_MS);
    }, 60_000);
  }
});
