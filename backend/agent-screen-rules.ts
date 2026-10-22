// Screen rules: classify an agent's visible screen as working, blocked or idle.
//
// The rule data (backend/agent-rules/{claude,codex}.toml) is vendored from
// herdr (Apache-2.0, commit 2ecf19a, v0.9.5). The region and matcher
// semantics below are ported from herdr src/detect/manifest.rs (evaluation
// :431-516, matchers :1200-1274, regions :1276-1420). See
// THIRD_PARTY_NOTICES.md and docs/plans/2026-10-22-agent-attention-design.md
// sections 1.2 and 8.
//
// Everything this module reads is untrusted pane text. The result is a hint
// for alerts only: it never feeds authorization, Task Runner transitions or
// the persisted event log.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type RuleAgent = "claude" | "codex";
export type ScreenRuleState = "working" | "blocked" | "idle" | "unknown";

/** DeckTerm's id for "agent known, no rule matched, so idle". */
export const NO_MATCH_RULE_ID = "no_match";

export type ScreenRuleInput = {
  /** Visible-only `capture-pane -p` text. */
  screen: string;
  /** Latest OSC 0/2 window title ("" when none). */
  title?: string;
  /** Latest OSC 9;4 payload as `4;<state>[;<percent>]` ("" when none). */
  progress?: string;
};

export type ScreenRuleResult = {
  state: ScreenRuleState;
  ruleId: string;
  /** The matched rule's region, or null for the no_match fallback. */
  region: string | null;
  visibleIdle: boolean;
  visibleBlocker: boolean;
  visibleWorking: boolean;
  /** The matched rule has `skip_state_update`: keep the previous status. */
  skip: boolean;
  /** For example `claude@2026.10.11.1`. */
  manifestVersion: string;
};

/**
 * A compiled `regex` / `line_regex` entry. Usually a RegExp; a vendored
 * pattern a backtracking engine would run in super-linear time is replaced by
 * an equivalent linear scan (see LINEAR_PATTERN_MATCHERS).
 */
export type PatternMatcher = {
  /** The pattern text as written in the manifest. */
  pattern: string;
  test(text: string): boolean;
};

type CompiledGate = {
  contains: string[];
  regex: PatternMatcher[];
  lineRegex: PatternMatcher[];
  all: CompiledGate[];
  any: CompiledGate[];
  not: CompiledGate[];
};

type RegionSpec =
  | { kind: "osc_title" }
  | { kind: "osc_progress" }
  | { kind: "whole_recent" }
  | { kind: "after_last_horizontal_rule" }
  | { kind: "prompt_box_body" }
  | { kind: "last_non_empty_above_prompt_box" }
  | { kind: "after_last_prompt_marker" }
  | { kind: "before_current_prompt_marker" }
  | { kind: "whole_recent_without_current_prompt_marker" }
  | { kind: "bottom_non_empty_lines"; count: number }
  | { kind: "top_non_empty_lines"; count: number };

export type CompiledScreenRule = {
  id: string;
  state: ScreenRuleState;
  priority: number;
  regionName: string;
  region: RegionSpec;
  visibleIdle: boolean;
  visibleBlocker: boolean;
  visibleWorking: boolean;
  skip: boolean;
  gate: CompiledGate;
};

export type CompiledManifest = {
  id: string;
  version: string;
  rules: CompiledScreenRule[];
};

export class ScreenRuleLoadError extends Error {}

// ---------------------------------------------------------------------------
// Rust regex -> JavaScript
// ---------------------------------------------------------------------------

/**
 * Translates a Rust `regex` crate pattern into a JavaScript RegExp source and
 * flags (always with `u`):
 * - `\x{…}` becomes `\u{…}`;
 * - leading `(?i)`, `(?m)`, `(?s)` (also combined, e.g. `(?im)`) become flags;
 * - `\A` becomes `(?<![\s\S])` and `\z` becomes `(?![\s\S])`.
 * An inline flag group anywhere else is an error, as are escapes JavaScript
 * would read differently (`\Z`, `\p{…}` classes are left to the compiler).
 */
export function translateRustRegex(pattern: string): {
  source: string;
  flags: string;
} {
  let rest = String(pattern);
  const flags = new Set<string>(["u"]);
  for (;;) {
    const lead = /^\(\?([a-zA-Z]+)\)/.exec(rest);
    if (!lead) break;
    for (const flag of lead[1]) {
      if (flag !== "i" && flag !== "m" && flag !== "s") {
        throw new ScreenRuleLoadError(
          `unsupported inline flag "${flag}" in ${JSON.stringify(pattern)}`,
        );
      }
      flags.add(flag);
    }
    rest = rest.slice(lead[0].length);
  }

  let out = "";
  let inClass = false;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === "\\") {
      const next = rest[i + 1];
      if (next === undefined) {
        throw new ScreenRuleLoadError(
          `trailing backslash in ${JSON.stringify(pattern)}`,
        );
      }
      if (next === "x" && rest[i + 2] === "{") {
        const close = rest.indexOf("}", i + 3);
        const hex = close === -1 ? "" : rest.slice(i + 3, close);
        if (!/^[0-9A-Fa-f]{1,6}$/.test(hex)) {
          throw new ScreenRuleLoadError(
            `bad \\x{…} escape in ${JSON.stringify(pattern)}`,
          );
        }
        out += `\\u{${hex}}`;
        i = close;
        continue;
      }
      if (next === "A" || next === "z") {
        if (inClass) {
          throw new ScreenRuleLoadError(
            `\\${next} inside a class in ${JSON.stringify(pattern)}`,
          );
        }
        out += next === "A" ? "(?<![\\s\\S])" : "(?![\\s\\S])";
        i += 1;
        continue;
      }
      if (next === "Z") {
        throw new ScreenRuleLoadError(
          `\\Z is not supported in ${JSON.stringify(pattern)}`,
        );
      }
      out += ch + next;
      i += 1;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      out += ch;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      out += ch;
      // A leading `^` and a literal `]` right after `[` are part of the class.
      if (rest[i + 1] === "^") {
        out += "^";
        i += 1;
      }
      continue;
    }
    if (ch === "(" && rest[i + 1] === "?") {
      const after = rest.slice(i + 2);
      const isGroupSyntax =
        after.startsWith(":") ||
        after.startsWith("=") ||
        after.startsWith("!") ||
        after.startsWith("<=") ||
        after.startsWith("<!") ||
        /^<[A-Za-z_][A-Za-z0-9_]*>/.test(after);
      if (!isGroupSyntax) {
        throw new ScreenRuleLoadError(
          `inline flag group not at the start of ${JSON.stringify(pattern)}`,
        );
      }
    }
    out += ch;
  }
  if (inClass) {
    throw new ScreenRuleLoadError(
      `unterminated class in ${JSON.stringify(pattern)}`,
    );
  }
  const order = ["i", "m", "s", "u"];
  return {
    source: out,
    flags: order.filter((flag) => flags.has(flag)).join(""),
  };
}

export function compileRustRegex(pattern: string): RegExp {
  const { source, flags } = translateRustRegex(pattern);
  try {
    return new RegExp(source, flags);
  } catch (err) {
    throw new ScreenRuleLoadError(
      `regex ${JSON.stringify(pattern)} does not compile: ${(err as Error).message}`,
    );
  }
}

/**
 * Compiles a manifest pattern: the linear matcher when one replaces it,
 * otherwise the translated RegExp.
 */
export function compilePattern(pattern: string): PatternMatcher {
  const linear = LINEAR_PATTERN_MATCHERS.get(pattern);
  if (linear) return { pattern, test: linear };
  const regex = compileRustRegex(pattern);
  return { pattern, test: (text) => regex.test(text) };
}

// ---------------------------------------------------------------------------
// Bounded cost. herdr runs these patterns on the Rust `regex` crate, which
// matches in linear time. JavaScript backtracks, so the port bounds the cost
// itself (review findings 2026-10-22):
// - every pattern that backtracks super-linearly is rewritten in the vendored
//   TOML into an equivalent linear form (listed in each TOML header), or,
//   where no regex form is linear, replaced here by an equivalent line scan;
// - the input is normalized so that "\n" is the only line break, as in Rust;
// - every region is cut to its last 200 lines of at most 512 characters.
// backend/agent-screen-perf.test.ts checks every vendored pattern against
// adversarial 300 x 400 screens.
// ---------------------------------------------------------------------------

export const MAX_REGION_LINES = 200;
// Above MAX_TERMINAL_COLS (1000), so a real pane-width capture line is never
// cut. A cut line ends in CLIP_MARK, so an artificial end of line can never
// satisfy a rule anchored at the end ($ or \z).
export const MAX_REGION_LINE_CHARS = 2048;
export const CLIP_MARK = "\u2026";

/**
 * CRLF becomes LF; a lone CR, U+2028 and U+2029 become a space. Rust's
 * `(?m)^`/`$` and `.` treat only "\n" as a line break, JavaScript also treats
 * these three, so after this both engines see the same lines (and no extra
 * line starts an attacker could multiply).
 */
export function normalizeScreenText(text: string): string {
  const crlf = text.includes("\r") ? text.replace(/\r\n/g, "\n") : text;
  return /[\r\u2028\u2029]/.test(crlf)
    ? crlf.replace(/[\r\u2028\u2029]/g, " ")
    : crlf;
}

function clipLine(line: string): string {
  if (line.length <= MAX_REGION_LINE_CHARS) return line;
  let end = MAX_REGION_LINE_CHARS;
  // Never leave half of a surrogate pair at the cut.
  const last = line.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return line.slice(0, end) + CLIP_MARK;
}

/**
 * The last MAX_REGION_LINES lines of a region, each cut to
 * MAX_REGION_LINE_CHARS (plus CLIP_MARK). Captures are pane-sized, so this only changes the
 * text of very tall or very wide panes.
 */
export function boundRegionText(text: string): string {
  if (text.length <= MAX_REGION_LINE_CHARS) {
    let breaks = 0;
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
      breaks++;
    }
    // A last line without a trailing break is a line too.
    const lines = text.length > 0 && !text.endsWith("\n") ? breaks + 1 : breaks;
    if (lines <= MAX_REGION_LINES) return text;
  }
  const trailingBreak = text.endsWith("\n");
  let lines = text.split("\n");
  if (trailingBreak) lines.pop();
  if (lines.length > MAX_REGION_LINES) lines = lines.slice(-MAX_REGION_LINES);
  return lines.map(clipLine).join("\n") + (trailingBreak ? "\n" : "");
}

const JS_WHITESPACE = /\s/u;

function isWhitespace(ch: string | undefined): boolean {
  return ch !== undefined && JS_WHITESPACE.test(ch);
}

/**
 * codex.toml screen_working_fallback, unchanged upstream. Its tail
 * `(?:\r?\n(…)?)*\s*\z` is re-scanned to the end of the screen from every
 * timer line, which backtracks in O(rows^2 x cols). codexWorkingFallbackMatches
 * below decides the same language in one backward pass.
 */
// A plain string: Bun can re-escape non-ASCII inside String.raw templates.
export const CODEX_WORKING_FALLBACK_PATTERN =
  "(?m)^(?:[•◦][ \\t]+)?[^\\s›•◦■✗✓─][^\\r\\n]* \\((?:[0-9]+[hm] )*[0-9]+s(?: • [^\\r\\n]+? to interrupt)?\\)(?: · [^\\r\\n]*)?(?:\\r?\\n(?:[^•◦›■✗✓─\\r\\n][^\\r\\n]*|•[ \\t]+(?:Queued\\s+follow-up\\s+inputs|Messages\\s+to\\s+be\\s+submitted\\s+after\\s+next\\s+tool\\s+call(?:\\s+\\(press\\s+[^\\r\\n]+?\\s+to\\s+interrupt\\s+and\\s+send\\s+immediately\\))?|Messages\\s+to\\s+be\\s+submitted\\s+at\\s+end\\s+of\\s+turn)|›[⠁⠂⠄⠈⠐⠠⡀⢀][^\\r\\n]*)?)*\\s*\\z";

const CODEX_SPARKLES = new Set(["⠁", "⠂", "⠄", "⠈", "⠐", "⠠", "⡀", "⢀"]);
const CODEX_QUEUED_Y = /•[ \t]+Queued\s+follow-up\s+inputs/uy;
const CODEX_AT_END_Y =
  /•[ \t]+Messages\s+to\s+be\s+submitted\s+at\s+end\s+of\s+turn/uy;
const CODEX_AFTER_TOOL_Y =
  /•[ \t]+Messages\s+to\s+be\s+submitted\s+after\s+next\s+tool\s+call/uy;
const CODEX_INTERRUPT_CLOSE = " to interrupt)";

/**
 * Linear equivalent of CODEX_WORKING_FALLBACK_PATTERN on normalized text.
 *
 * The regex matches when some line is a "head" (an optional bullet, a status
 * text and a ` (…Ns…)` timer suffix) and everything after the head, up to the
 * end, is "tail": line breaks, each followed by nothing, a plain line, a
 * sparkle prompt line or one of three queued-input messages (whose `\s+` may
 * cross lines), then only whitespace. One backward pass computes, for every
 * line end, whether the tail can start there (D) and, for every line start,
 * whether the tail can continue there after a line break (L); each head line
 * is then checked once against D of its own line end.
 */
export function codexWorkingFallbackMatches(raw: string): boolean {
  const s = normalizeScreenText(raw);
  const n = s.length;
  // `\s*\z` from e holds exactly when e >= wsEnd (trimEnd strips the same
  // WhiteSpace + LineTerminator set as JavaScript's \s).
  const wsEnd = s.trimEnd().length;
  const starts: number[] = [];
  const ends: number[] = [];
  for (let pos = 0; ; ) {
    const nl = s.indexOf("\n", pos);
    starts.push(pos);
    if (nl === -1) {
      ends.push(n);
      break;
    }
    ends.push(nl);
    pos = nl + 1;
  }
  const lineCount = starts.length;
  const tailFromEnd = new Array<boolean>(lineCount).fill(false); // D
  const tailAfterBreak = new Array<boolean>(lineCount).fill(false); // L

  const lineIndexOfEnd = (pos: number) => {
    let lo = 0;
    let hi = lineCount - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ends[mid] < pos) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  // The tail may start at an arbitrary position g (after a message).
  const tailFrom = (g: number) => {
    if (g >= wsEnd) return true;
    return s[g] === "\n" && tailFromEnd[lineIndexOfEnd(g)];
  };
  const skipWhitespace = (from: number) => {
    let i = from;
    while (i < n && isWhitespace(s[i])) i++;
    return i;
  };
  // `\s+to\s+interrupt\s+and\s+send\s+immediately\)` after its leading
  // whitespace, from "to" at b. Returns the end, or -1.
  const interruptAndSendEnd = (b: number) => {
    let i = b;
    const words = ["to", "interrupt", "and", "send", "immediately)"];
    for (let w = 0; w < words.length; w++) {
      if (w > 0) {
        const next = skipWhitespace(i);
        if (next === i) return -1;
        i = next;
      }
      if (!s.startsWith(words[w], i)) return -1;
      i += words[w].length;
    }
    return i;
  };
  // Ends of `\s+\(press\s+[^\r\n]+?\s+to\s+interrupt…\)` after g0.
  const pressClauseEnds = (g0: number): number[] => {
    const open = skipWhitespace(g0);
    if (open === g0 || !s.startsWith("(press", open)) return [];
    const pressEnd = open + "(press".length;
    const afterPress = skipWhitespace(pressEnd);
    if (afterPress === pressEnd) return [];
    const ends: number[] = [];
    // The lazy text (at least one character, no line break) sits between
    // the whitespace after "(press" and the whitespace before "to".
    if (s.startsWith("to", afterPress)) {
      // Both runs are one: the lazy text is one non-break character in it.
      for (let x = pressEnd + 1; x <= afterPress - 2; x++) {
        if (s[x] !== "\n") {
          const end = interruptAndSendEnd(afterPress);
          if (end !== -1) ends.push(end);
          break;
        }
      }
    }
    if (afterPress < n) {
      // The lazy text runs from afterPress to a whitespace run that starts
      // on the same line; "to" follows that run.
      let lineEnd = s.indexOf("\n", afterPress);
      if (lineEnd === -1) lineEnd = n;
      for (let a = afterPress + 1; a <= lineEnd && a < n; a++) {
        if (!isWhitespace(s[a]) || isWhitespace(s[a - 1])) continue;
        const b = skipWhitespace(a);
        if (s.startsWith("to", b)) {
          const end = interruptAndSendEnd(b);
          if (end !== -1) ends.push(end);
        }
        a = b - 1;
      }
    }
    return ends;
  };
  // `•[ \t]+(?:Queued…|Messages…call(?:<press clause>)?|Messages…turn)`.
  const queuedMessageThenTail = (f: number) => {
    const candidates: number[] = [];
    for (const re of [CODEX_QUEUED_Y, CODEX_AT_END_Y]) {
      re.lastIndex = f;
      if (re.test(s)) candidates.push(re.lastIndex);
    }
    CODEX_AFTER_TOOL_Y.lastIndex = f;
    if (CODEX_AFTER_TOOL_Y.test(s)) {
      const g0 = CODEX_AFTER_TOOL_Y.lastIndex;
      candidates.push(g0, ...pressClauseEnds(g0));
    }
    return candidates.some(tailFrom);
  };

  for (let k = lineCount - 1; k >= 0; k--) {
    const f = starts[k];
    const le = ends[k];
    tailFromEnd[k] = le >= wsEnd || (le < n && tailAfterBreak[k + 1]);
    if (f === le) {
      tailAfterBreak[k] = tailFromEnd[k];
      continue;
    }
    const c = s[f];
    let ok = f >= wsEnd;
    if (!ok && !"•◦›■✗✓─".includes(c)) ok = tailFromEnd[k];
    if (!ok && c === "›" && CODEX_SPARKLES.has(s[f + 1])) ok = tailFromEnd[k];
    if (!ok && c === "•") ok = queuedMessageThenTail(f);
    tailAfterBreak[k] = ok;
  }

  for (let k = 0; k < lineCount; k++) {
    if (codexHeadLineThenTail(s, starts[k], ends[k], wsEnd, tailFromEnd[k])) {
      return true;
    }
  }
  return false;
}

/** The head part of CODEX_WORKING_FALLBACK_PATTERN on one line, then the tail. */
function codexHeadLineThenTail(
  s: string,
  f: number,
  le: number,
  wsEnd: number,
  tailFromLineEnd: boolean,
): boolean {
  // Line-local indexes: every search stays inside this line.
  const line = s.slice(f, le);
  const len = line.length;
  let p = 0;
  if (line[0] === "•" || line[0] === "◦") {
    let j = 1;
    while (j < len && (line[j] === " " || line[j] === "\t")) j++;
    if (j === 1) return false;
    p = j;
  }
  if (p >= len || isWhitespace(line[p]) || "›•◦■✗✓─".includes(line[p])) {
    return false;
  }
  // After the closing parenthesis: ` · …` to the line end, or the tail.
  const endOk = (e: number) => {
    if (line.startsWith(" · ", e)) return tailFromLineEnd;
    return e === len ? tailFromLineEnd : f + e >= wsEnd;
  };
  // The last " to interrupt)" whose end is acceptable.
  let lastInterrupt = -1;
  for (
    let t = line.indexOf(CODEX_INTERRUPT_CLOSE, p);
    t !== -1;
    t = line.indexOf(CODEX_INTERRUPT_CLOSE, t + 1)
  ) {
    if (endOk(t + CODEX_INTERRUPT_CLOSE.length)) lastInterrupt = t;
  }
  for (
    let q = line.indexOf(" (", p + 1);
    q !== -1;
    q = line.indexOf(" (", q + 1)
  ) {
    // `(?:[0-9]+[hm] )*[0-9]+s`: each digit run is maximal, then h/m + space
    // continues and s ends.
    let i = q + 2;
    let r = -1;
    for (;;) {
      const digits = i;
      while (i < len && line[i] >= "0" && line[i] <= "9") i++;
      if (i === digits) break;
      if (line[i] === "s") {
        r = i + 1;
        break;
      }
      if ((line[i] === "h" || line[i] === "m") && line[i + 1] === " ") {
        i += 2;
        continue;
      }
      break;
    }
    if (r === -1) continue;
    if (line[r] === ")" && endOk(r + 1)) return true;
    if (line.startsWith(" • ", r) && lastInterrupt >= r + 4) return true;
  }
  return false;
}

/** Patterns replaced by a linear matcher, keyed by their exact TOML text. */
export const LINEAR_PATTERN_MATCHERS: ReadonlyMap<
  string,
  (text: string) => boolean
> = new Map([[CODEX_WORKING_FALLBACK_PATTERN, codexWorkingFallbackMatches]]);

// ---------------------------------------------------------------------------
// Manifest loading
// ---------------------------------------------------------------------------

const MANIFEST_KEYS = new Set([
  "id",
  "version",
  "min_engine_version",
  "updated_at",
  "aliases",
  "rules",
]);
const RULE_KEYS = new Set([
  "id",
  "state",
  "priority",
  "region",
  "visible_idle",
  "visible_blocker",
  "visible_working",
  "skip_state_update",
  "all",
  "any",
  "not",
  "contains",
  "regex",
  "line_regex",
]);
const GATE_KEYS = new Set(["all", "any", "not", "contains", "regex", "line_regex"]);
const STATES = new Set<ScreenRuleState>(["working", "blocked", "idle", "unknown"]);
const MAX_REGION_LINE_COUNT = 65_535;

/** Only the regions the vendored Claude and Codex rules use (design 1.2). */
export const SUPPORTED_REGIONS = [
  "osc_title",
  "osc_progress",
  "whole_recent",
  "after_last_horizontal_rule",
  "prompt_box_body",
  "last_non_empty_above_prompt_box",
  "after_last_prompt_marker",
  "before_current_prompt_marker",
  "whole_recent_without_current_prompt_marker",
  "bottom_non_empty_lines(N)",
  "top_non_empty_lines(N)",
] as const;

export function parseRegionSpec(spec: unknown): RegionSpec {
  const name = typeof spec === "string" ? spec.trim() : "";
  switch (name) {
    case "osc_title":
    case "osc_progress":
    case "whole_recent":
    case "after_last_horizontal_rule":
    case "prompt_box_body":
    case "last_non_empty_above_prompt_box":
    case "after_last_prompt_marker":
    case "before_current_prompt_marker":
    case "whole_recent_without_current_prompt_marker":
      return { kind: name };
  }
  const counted = /^(bottom_non_empty_lines|top_non_empty_lines)\(([1-9][0-9]*)\)$/.exec(
    name,
  );
  if (counted) {
    const count = Number.parseInt(counted[2], 10);
    if (count <= MAX_REGION_LINE_COUNT) {
      return {
        kind: counted[1] as "bottom_non_empty_lines" | "top_non_empty_lines",
        count,
      };
    }
  }
  throw new ScreenRuleLoadError(`unknown region ${JSON.stringify(spec)}`);
}

function stringList(value: unknown, context: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ScreenRuleLoadError(`${context} must be a list of strings`);
  }
  return value as string[];
}

function checkKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  context: string,
) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ScreenRuleLoadError(`${context}: unknown field "${key}"`);
    }
  }
}

function compileGate(value: unknown, context: string): CompiledGate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ScreenRuleLoadError(`${context} must be a table`);
  }
  const gate = value as Record<string, unknown>;
  checkKeys(gate, GATE_KEYS, context);
  const nested = (key: "all" | "any" | "not") => {
    const list = gate[key];
    if (list === undefined) return [];
    if (!Array.isArray(list)) {
      throw new ScreenRuleLoadError(`${context}.${key} must be a list`);
    }
    return list.map((item, index) =>
      compileGate(item, `${context}.${key}[${index}]`),
    );
  };
  return {
    contains: stringList(gate.contains, `${context}.contains`).map((needle) =>
      needle.toLowerCase(),
    ),
    regex: stringList(gate.regex, `${context}.regex`).map(compilePattern),
    lineRegex: stringList(gate.line_regex, `${context}.line_regex`).map(
      compilePattern,
    ),
    all: nested("all"),
    any: nested("any"),
    not: nested("not"),
  };
}

/** Compiles a parsed manifest object. Throws ScreenRuleLoadError. */
export function compileManifest(raw: unknown): CompiledManifest {
  if (!raw || typeof raw !== "object") {
    throw new ScreenRuleLoadError("manifest must be a table");
  }
  const manifest = raw as Record<string, unknown>;
  checkKeys(manifest, MANIFEST_KEYS, "manifest");
  if (typeof manifest.id !== "string" || !manifest.id) {
    throw new ScreenRuleLoadError("manifest id is missing");
  }
  const version =
    typeof manifest.version === "string" ? manifest.version : "unknown";
  const rawRules = manifest.rules;
  if (!Array.isArray(rawRules) || rawRules.length === 0) {
    throw new ScreenRuleLoadError(`manifest ${manifest.id} has no rules`);
  }
  const seen = new Set<string>();
  const rules = rawRules.map((value, index): CompiledScreenRule => {
    const context = `${manifest.id}.rules[${index}]`;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ScreenRuleLoadError(`${context} must be a table`);
    }
    const rule = value as Record<string, unknown>;
    checkKeys(rule, RULE_KEYS, context);
    if (typeof rule.id !== "string" || !rule.id) {
      throw new ScreenRuleLoadError(`${context} has no id`);
    }
    if (seen.has(rule.id)) {
      throw new ScreenRuleLoadError(`${context}: duplicate id ${rule.id}`);
    }
    seen.add(rule.id);
    const state = (rule.state ?? "unknown") as ScreenRuleState;
    if (!STATES.has(state)) {
      throw new ScreenRuleLoadError(`${context}: unknown state ${String(state)}`);
    }
    const priority = rule.priority ?? 0;
    if (typeof priority !== "number" || !Number.isInteger(priority)) {
      throw new ScreenRuleLoadError(`${context}: priority must be an integer`);
    }
    const regionName =
      typeof rule.region === "string" ? rule.region.trim() : "whole_recent";
    const flag = (key: string) => {
      const flagValue = rule[key];
      if (flagValue === undefined) return false;
      if (typeof flagValue !== "boolean") {
        throw new ScreenRuleLoadError(`${context}: ${key} must be a boolean`);
      }
      return flagValue;
    };
    const gateSource: Record<string, unknown> = {};
    for (const key of GATE_KEYS) {
      if (rule[key] !== undefined) gateSource[key] = rule[key];
    }
    if (Object.keys(gateSource).length === 0) {
      throw new ScreenRuleLoadError(`${context}: rule has no matcher`);
    }
    return {
      id: rule.id,
      state,
      priority,
      regionName,
      region: parseRegionSpec(regionName),
      visibleIdle: flag("visible_idle"),
      visibleBlocker: flag("visible_blocker"),
      visibleWorking: flag("visible_working"),
      skip: flag("skip_state_update"),
      gate: compileGate(gateSource, context),
    };
  });
  return { id: manifest.id, version, rules };
}

export function parseManifestToml(text: string): CompiledManifest {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch (err) {
    throw new ScreenRuleLoadError(
      `manifest TOML does not parse: ${(err as Error).message}`,
    );
  }
  return compileManifest(parsed);
}

export const AGENT_RULES_DIR = join(import.meta.dir, "agent-rules");

const manifestCache = new Map<RuleAgent, CompiledManifest>();

/** Loads (once) and returns the vendored manifest for an agent. */
export function loadAgentManifest(agent: RuleAgent): CompiledManifest {
  const cached = manifestCache.get(agent);
  if (cached) return cached;
  const manifest = parseManifestToml(
    readFileSync(join(AGENT_RULES_DIR, `${agent}.toml`), "utf8"),
  );
  if (manifest.id !== agent) {
    throw new ScreenRuleLoadError(
      `${agent}.toml declares id ${JSON.stringify(manifest.id)}`,
    );
  }
  manifestCache.set(agent, manifest);
  return manifest;
}

export function manifestVersionLabel(manifest: CompiledManifest): string {
  return `${manifest.id}@${manifest.version}`;
}

// ---------------------------------------------------------------------------
// Regions (herdr src/detect/manifest.rs:1276-1420)
// ---------------------------------------------------------------------------

/** Rust `str::lines()`: split on \n, drop one trailing empty line, strip \r. */
function rustLines(content: string): string[] {
  if (content === "") return [];
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function lineStartOffset(content: string, lines: string[], index: number): number {
  let offset = 0;
  for (let i = 0; i < Math.min(index, lines.length); i++) {
    offset += lines[i].length + 1;
  }
  return Math.min(offset, content.length);
}

function sliceFromLineIndex(content: string, lines: string[], index: number) {
  return content.slice(lineStartOffset(content, lines, index));
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

export function isHorizontalRule(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  let ruleChars = 0;
  while (ruleChars < trimmed.length && trimmed[ruleChars] === "─") ruleChars++;
  if (ruleChars === 0) return false;
  const suffix = trimmed.slice(ruleChars).trimStart();
  return suffix === "" || ruleChars >= 3;
}

function bottomNonEmptyLines(content: string, count: number): string {
  const lines = rustLines(content);
  let found = 0;
  let start = -1;
  for (let i = lines.length - 1; i >= 0 && found < count; i--) {
    if (!isBlank(lines[i])) {
      found++;
      start = i;
    }
  }
  return start === -1 ? "" : sliceFromLineIndex(content, lines, start);
}

function topNonEmptyLines(content: string, count: number): string {
  const lines = rustLines(content);
  let found = 0;
  let end = -1;
  for (let i = 0; i < lines.length && found < count; i++) {
    if (!isBlank(lines[i])) {
      found++;
      end = i;
    }
  }
  if (end === -1) return "";
  return content.slice(0, lineStartOffset(content, lines, end + 1));
}

function codexPromptLine(line: string): boolean {
  return line === "›" || line.startsWith("› ");
}

function codexBlockMarkerLine(line: string): boolean {
  return (
    line.startsWith("•") ||
    line.startsWith("■") ||
    line.startsWith("✗") ||
    line.startsWith("✓")
  );
}

function lastIndexWhere(lines: string[], predicate: (line: string) => boolean) {
  for (let i = lines.length - 1; i >= 0; i--) if (predicate(lines[i])) return i;
  return -1;
}

function currentCodexPromptIndex(lines: string[]): number {
  const prompt = lastIndexWhere(lines, codexPromptLine);
  if (prompt === -1) return -1;
  for (let i = prompt + 1; i < lines.length; i++) {
    if (codexBlockMarkerLine(lines[i])) return -1;
  }
  return prompt;
}

function afterLastPromptMarker(content: string): string {
  const lines = rustLines(content);
  const index = lastIndexWhere(lines, codexPromptLine);
  if (index === -1) return content;
  return sliceFromLineIndex(content, lines, index + 1);
}

function beforeCurrentPromptMarker(content: string): string {
  const lines = rustLines(content);
  const index = currentCodexPromptIndex(lines);
  if (index === -1) return content;
  return content.slice(0, lineStartOffset(content, lines, index));
}

function wholeRecentWithoutCurrentPromptMarker(content: string): string {
  return currentCodexPromptIndex(rustLines(content)) === -1 ? content : "";
}

function promptBoxTopBorderIndex(lines: string[]): number {
  let borders = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isHorizontalRule(lines[i])) {
      borders++;
      if (borders === 2) return i;
    }
  }
  return -1;
}

function promptBoxBody(content: string): string {
  const lines = rustLines(content);
  const top = promptBoxTopBorderIndex(lines);
  if (top === -1) return "";
  const start = lineStartOffset(content, lines, top + 1);
  let endIndex = lines.length;
  for (let i = top + 1; i < lines.length; i++) {
    if (isHorizontalRule(lines[i])) {
      endIndex = i;
      break;
    }
  }
  const end = lineStartOffset(content, lines, endIndex);
  return content.slice(start, Math.max(start, end));
}

function abovePromptBox(content: string): string {
  const lines = rustLines(content);
  const top = promptBoxTopBorderIndex(lines);
  if (top === -1) return content;
  return content.slice(0, lineStartOffset(content, lines, top));
}

function afterLastHorizontalRule(content: string): string {
  let lastRuleEnd = 0;
  let offset = 0;
  for (const line of rustLines(content)) {
    const next = offset + line.length + 1;
    if (isHorizontalRule(line)) lastRuleEnd = Math.min(next, content.length);
    offset = next;
  }
  return content.slice(lastRuleEnd);
}

function lastNonEmptyLine(content: string): string {
  const lines = rustLines(content);
  const index = lastIndexWhere(lines, (line) => !isBlank(line));
  return index === -1 ? "" : lines[index];
}

export function regionText(
  region: RegionSpec,
  input: { screen: string; title: string; progress: string },
): string {
  const content = input.screen;
  switch (region.kind) {
    case "osc_title":
      return input.title;
    case "osc_progress":
      return input.progress;
    case "whole_recent":
      return content;
    case "after_last_horizontal_rule":
      return afterLastHorizontalRule(content);
    case "prompt_box_body":
      return promptBoxBody(content);
    case "last_non_empty_above_prompt_box":
      return lastNonEmptyLine(abovePromptBox(content));
    case "after_last_prompt_marker":
      return afterLastPromptMarker(content);
    case "before_current_prompt_marker":
      return beforeCurrentPromptMarker(content);
    case "whole_recent_without_current_prompt_marker":
      return wholeRecentWithoutCurrentPromptMarker(content);
    case "bottom_non_empty_lines":
      return bottomNonEmptyLines(content, region.count);
    case "top_non_empty_lines":
      return topNonEmptyLines(content, region.count);
  }
}

// ---------------------------------------------------------------------------
// Matchers (herdr src/detect/manifest.rs:1200-1274)
// ---------------------------------------------------------------------------

function gateMatches(gate: CompiledGate, text: string, lower: string): boolean {
  if (!gate.contains.every((needle) => lower.includes(needle))) return false;
  if (!gate.regex.every((regex) => regex.test(text))) return false;
  if (gate.lineRegex.length > 0) {
    const lines = rustLines(text);
    if (!gate.lineRegex.every((regex) => lines.some((line) => regex.test(line)))) {
      return false;
    }
  }
  if (!gate.all.every((nested) => gateMatches(nested, text, lower))) return false;
  if (
    gate.any.length > 0 &&
    !gate.any.some((nested) => gateMatches(nested, text, lower))
  ) {
    return false;
  }
  if (gate.not.some((nested) => gateMatches(nested, text, lower))) return false;
  return true;
}

export function ruleMatches(
  rule: CompiledScreenRule,
  input: { screen: string; title: string; progress: string },
): boolean {
  const text = boundRegionText(regionText(rule.region, input));
  return gateMatches(rule.gate, text, text.toLowerCase());
}

/** Every regex and line_regex of a rule, nested gates included. */
export function rulePatternMatchers(
  rule: CompiledScreenRule,
): Array<PatternMatcher & { kind: "regex" | "line_regex" }> {
  const out: Array<PatternMatcher & { kind: "regex" | "line_regex" }> = [];
  const walk = (gate: CompiledGate) => {
    for (const matcher of gate.regex) out.push({ ...matcher, kind: "regex" });
    for (const matcher of gate.lineRegex) {
      out.push({ ...matcher, kind: "line_regex" });
    }
    for (const nested of [...gate.all, ...gate.any, ...gate.not]) walk(nested);
  };
  walk(rule.gate);
  return out;
}

/** How a gate applies one matcher to a region: regex whole, line_regex per line. */
export function patternMatchesRegion(
  matcher: PatternMatcher & { kind: "regex" | "line_regex" },
  text: string,
): boolean {
  if (matcher.kind === "regex") return matcher.test(text);
  return rustLines(text).some((line) => matcher.test(line));
}

// ---------------------------------------------------------------------------
// Evaluation (herdr src/detect/manifest.rs:431-516)
// ---------------------------------------------------------------------------

export function evaluateManifest(
  manifest: CompiledManifest,
  input: ScreenRuleInput,
): ScreenRuleResult {
  const normalized = {
    screen: normalizeScreenText(String(input.screen || "")),
    title: normalizeScreenText(String(input.title || "")),
    progress: normalizeScreenText(String(input.progress || "")),
  };
  let best: CompiledScreenRule | null = null;
  for (const rule of manifest.rules) {
    // Ties go to the earlier rule: only a strictly higher priority replaces.
    if (best && best.priority >= rule.priority) continue;
    if (ruleMatches(rule, normalized)) best = rule;
  }
  const manifestVersion = manifestVersionLabel(manifest);
  if (!best) {
    return {
      state: "idle",
      ruleId: NO_MATCH_RULE_ID,
      region: null,
      visibleIdle: false,
      visibleBlocker: false,
      visibleWorking: false,
      skip: false,
      manifestVersion,
    };
  }
  return {
    state: best.state,
    ruleId: best.id,
    region: best.regionName,
    visibleIdle: best.visibleIdle && best.state === "idle",
    visibleBlocker: best.visibleBlocker && best.state === "blocked",
    visibleWorking: best.visibleWorking && best.state === "working",
    skip: best.skip,
    manifestVersion,
  };
}

/** Evaluates the vendored rules for `agent` against one screen. */
export function evaluate(
  agent: RuleAgent,
  input: ScreenRuleInput,
): ScreenRuleResult {
  return evaluateManifest(loadAgentManifest(agent), input);
}
