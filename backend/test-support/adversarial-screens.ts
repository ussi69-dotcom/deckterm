// Worst-case-style screens for the screen-rule patterns (test support only).
//
// A pattern is "pumped": every unbounded quantifier repeats its piece many
// times, so a backtracking engine meets long runs of exactly the pieces it can
// split in several ways. The pumped text is laid out on a tall, wide screen and
// given a near-miss ending, so the overall match fails late.

import { compileRustRegex } from "../agent-screen-rules";

type Item = { atom: Atom; min: number; max: number };
type Seq = Item[];
type Atom =
  { k: "lit"; s: string } | { k: "group"; alts: Seq[]; look: boolean };

// Representatives tried for a class, most "overlapping" first: a space is
// matched by \s, [ \t], [^\n], `.` and most negated classes at once.
const CLASS_CANDIDATES = [" ", "\t", "x", "a", "1", "·", "\n"];

function parseClassBody(body: string): string {
  const regex = compileRustRegex(`[${body}]`);
  for (const candidate of CLASS_CANDIDATES) {
    if (regex.test(candidate)) return candidate;
  }
  const plain = body.startsWith("^") ? body.slice(1) : body;
  const hex = /^\\x\{([0-9A-Fa-f]+)\}/.exec(plain);
  if (hex) return String.fromCodePoint(Number.parseInt(hex[1], 16));
  if (plain.startsWith("\\")) return plain[1];
  return String.fromCodePoint(plain.codePointAt(0) ?? 0x78);
}

export function parsePumpable(pattern: string): Seq[] {
  let src = pattern;
  for (;;) {
    const lead = /^\(\?[a-zA-Z]+\)/.exec(src);
    if (!lead) break;
    src = src.slice(lead[0].length);
  }
  let i = 0;
  const parseAlt = (): Seq[] => {
    const alts = [parseSeq()];
    while (src[i] === "|") {
      i++;
      alts.push(parseSeq());
    }
    return alts;
  };
  const parseSeq = (): Seq => {
    const items: Seq = [];
    while (i < src.length && src[i] !== "|" && src[i] !== ")") {
      const atom = parseAtom();
      items.push({ atom, ...parseQuantifier() });
    }
    return items;
  };
  const parseQuantifier = () => {
    let min = 1;
    let max = 1;
    const c = src[i];
    if (c === "*" || c === "+" || c === "?") {
      i++;
      min = c === "+" ? 1 : 0;
      max = c === "?" ? 1 : Infinity;
    } else if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
      if (m) {
        i += m[0].length;
        min = Number(m[1]);
        max = m[2] === undefined ? min : m[3] ? Number(m[3]) : Infinity;
      }
    }
    if (src[i] === "?" && (min !== 1 || max !== 1)) i++; // lazy
    return { min, max };
  };
  const parseEscape = (): string => {
    const next = src[i + 1];
    if (next === "x" && src[i + 2] === "{") {
      const close = src.indexOf("}", i);
      const ch = String.fromCodePoint(
        Number.parseInt(src.slice(i + 3, close), 16),
      );
      i = close + 1;
      return ch;
    }
    i += 2;
    const map: Record<string, string> = {
      s: " ",
      S: "x",
      d: "1",
      D: "x",
      w: "a",
      W: " ",
      n: "\n",
      r: "",
      t: "\t",
      b: "",
      B: "",
      A: "",
      z: "",
    };
    return next in map ? map[next] : next;
  };
  const parseAtom = (): Atom => {
    const c = src[i];
    if (c === "(") {
      i++;
      let look = false;
      if (src[i] === "?") {
        if (src[i + 1] === ":") i += 2;
        else if (src[i + 1] === "=" || src[i + 1] === "!") {
          look = true;
          i += 2;
        } else if (
          src[i + 1] === "<" &&
          (src[i + 2] === "=" || src[i + 2] === "!")
        ) {
          look = true;
          i += 3;
        } else i = src.indexOf(">", i) + 1;
      }
      const alts = parseAlt();
      i++; // ")"
      return { k: "group", alts, look };
    }
    if (c === "[") {
      let j = i + 1;
      if (src[j] === "^") j++;
      while (src[j] !== "]") j += src[j] === "\\" ? 2 : 1;
      const body = src.slice(i + 1, j);
      i = j + 1;
      return { k: "lit", s: parseClassBody(body) };
    }
    if (c === "\\") return { k: "lit", s: parseEscape() };
    if (c === "^" || c === "$") {
      i++;
      return { k: "lit", s: "" };
    }
    if (c === ".") {
      i++;
      return { k: "lit", s: " " };
    }
    const ch = String.fromCodePoint(src.codePointAt(i) ?? 0x78);
    i += ch.length;
    return { k: "lit", s: ch };
  };
  return parseAlt();
}

export type PumpOptions = {
  /** Repeats of a single-character piece under an unbounded quantifier. */
  pumpChar: number;
  /** Repeats of a group under an unbounded quantifier. */
  pumpGroup: number;
  /** Which alternative to take. */
  pick: (count: number) => number;
};

const MAX_WITNESS = 60_000;

export function pumpPattern(pattern: string, options: PumpOptions): string {
  const alts = parsePumpable(pattern);
  const genSeq = (seq: Seq): string => {
    let out = "";
    for (const item of seq) {
      const unbounded = item.max === Infinity;
      const count = unbounded
        ? Math.max(
            item.min,
            item.atom.k === "lit" ? options.pumpChar : options.pumpGroup,
          )
        : item.max;
      for (let r = 0; r < count && out.length < MAX_WITNESS; r++) {
        out += genAtom(item.atom);
      }
    }
    return out;
  };
  const genAtom = (atom: Atom): string => {
    if (atom.k === "lit") return atom.s;
    if (atom.look) return "";
    return genSeq(atom.alts[options.pick(atom.alts.length)]);
  };
  return genSeq(alts[options.pick(alts.length)]).slice(0, MAX_WITNESS);
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return (state >>> 1) / 0x80000000;
  };
}

/** Lays text out as `rows` lines of at most `cols` characters plus an ending. */
export function screenFrom(
  text: string,
  {
    rows,
    cols,
    ending,
    fillLines = false,
  }: { rows: number; cols: number; ending: string; fillLines?: boolean },
): string {
  let lines = text.split("\n").filter((line, index, all) => {
    // Drop empty lines only when the witness has nothing else.
    return line !== "" || all.some((other) => other !== "") || index === 0;
  });
  if (fillLines) {
    lines = lines.map((line) => {
      if (!line) return line;
      let wide = line;
      while (wide.length < cols) wide += line;
      return wide;
    });
  }
  lines = lines.map((line) => Array.from(line).slice(0, cols).join(""));
  const out: string[] = [];
  const endingLines = ending ? ending.split("\n") : [];
  while (out.length < rows - endingLines.length) {
    for (const line of lines) {
      if (out.length >= rows - endingLines.length) break;
      out.push(line);
    }
  }
  return [...out, ...endingLines].join("\n");
}
