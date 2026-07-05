// Pure conflict-marker parser/resolver for the merge-conflict SCM slice (Track
// D, slice D3). DOM-free and network-free so it stays unit-testable in bun
// (same triple-export pattern as web/terminal-colors.js); GitManager (app.js)
// consumes it as a browser global to transform a fetched conflicted file's
// content before writing it back through PUT /api/files/content.
//
// Design (binding, see docs/plans track-d slice D3): accept-current /
// accept-incoming / accept-both are a CLIENT-side transform of the working
// file's conflict markers — no new broker argv surface. Malformed/unterminated
// markers REFUSE (return an error result) rather than throw or produce a
// partial/best-effort resolution; the caller then tells the user to resolve in
// the terminal.
//
// Conflict marker shape (git's default 2-way style, plus optional diff3 base):
//   <<<<<<< HEAD
//   our lines...
//   ||||||| merged common ancestors      (diff3 only)
//   base lines...
//   =======
//   their lines...
//   >>>>>>> branch-name

const START = "<<<<<<<";
const BASE = "|||||||";
const SEP = "=======";
const END = ">>>>>>>";

// Splits text into line records that carry their own terminator, so the
// original line-ending style (LF or CRLF, and a missing trailing newline) is
// preserved exactly on reconstruction. Each record: { content, term } where
// term is "\n", "\r\n", or undefined (last line with no trailing newline).
function splitIntoLines(text) {
  const parts = text.split(/(\r\n|\n)/);
  const lines = [];
  for (let i = 0; i < parts.length; i += 2) {
    const content = parts[i];
    const term = parts[i + 1];
    const isLast = i === parts.length - 1;
    // The split() on a terminator-ending string produces a trailing "" with no
    // terminator — that's not a real line, it's the empty remainder after the
    // final newline. Drop it so it doesn't round-trip into a phantom blank
    // line when text already ends with a newline.
    if (isLast && content === "" && term === undefined) continue;
    lines.push({ content, term });
  }
  return lines;
}

function joinLines(lines) {
  return lines.map((l) => l.content + (l.term || "")).join("");
}

// Parses conflict-marker blocks out of `text`. Returns:
//   { ok: true, hasConflicts: boolean, segments: [...] }
//   { ok: false, error: string }
// segments is an ordered list of:
//   { type: "context", lines: [{content, term}, ...] }
//   { type: "conflict", ours: [...], base: [...] | null, theirs: [...] }
// Never throws — malformed/unterminated markers return ok:false instead.
function parseConflictBlocks(text) {
  if (typeof text !== "string") {
    return { ok: false, error: "parseConflictBlocks: input must be a string" };
  }

  let lines;
  try {
    lines = splitIntoLines(text);
  } catch (err) {
    return {
      ok: false,
      error: `parseConflictBlocks: failed to split lines: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const segments = [];
  let contextBuf = [];
  const flushContext = () => {
    if (contextBuf.length) {
      segments.push({ type: "context", lines: contextBuf });
      contextBuf = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.content.startsWith(START)) {
      flushContext();
      const ours = [];
      const base = [];
      const theirs = [];
      let sawBase = false;
      let sawSep = false;
      let closed = false;
      i++;
      while (i < lines.length) {
        const cur = lines[i];
        if (cur.content.startsWith(START)) {
          return {
            ok: false,
            error:
              "parseConflictBlocks: nested or unterminated conflict marker (a new '<<<<<<<' appeared before the current block closed)",
          };
        }
        if (!sawSep && !sawBase && cur.content.startsWith(BASE)) {
          sawBase = true;
          i++;
          continue;
        }
        if (!sawSep && cur.content.startsWith(SEP)) {
          sawSep = true;
          i++;
          continue;
        }
        if (cur.content.startsWith(END)) {
          if (!sawSep) {
            return {
              ok: false,
              error:
                "parseConflictBlocks: malformed conflict marker (missing '=======' separator before '>>>>>>>')",
            };
          }
          closed = true;
          i++;
          break;
        }
        if (!sawSep) {
          (sawBase ? base : ours).push(cur);
        } else {
          theirs.push(cur);
        }
        i++;
      }
      if (!closed) {
        return {
          ok: false,
          error:
            "parseConflictBlocks: unterminated conflict marker (no matching '>>>>>>>' found)",
        };
      }
      segments.push({
        type: "conflict",
        ours,
        base: sawBase ? base : null,
        theirs,
      });
      continue;
    }

    // A separator/base/end marker encountered OUTSIDE an open conflict block
    // (no preceding "<<<<<<<") is malformed — never silently treated as
    // ordinary content.
    if (
      line.content.startsWith(SEP) ||
      line.content.startsWith(END) ||
      line.content.startsWith(BASE)
    ) {
      return {
        ok: false,
        error: `parseConflictBlocks: malformed conflict marker ('${line.content.slice(0, 7)}' with no preceding '<<<<<<<')`,
      };
    }

    contextBuf.push(line);
    i++;
  }
  flushContext();

  const hasConflicts = segments.some((s) => s.type === "conflict");
  return { ok: true, hasConflicts, segments };
}

// Resolves conflict markers in `text` by keeping "ours", "theirs", or "both"
// (ours then theirs, concatenated) for every conflict block, verbatim context
// otherwise. Returns { ok: true, content: string } or { ok: false, error }.
// Refuses — never throws, never returns a partial result — when parsing
// failed or found no conflict markers at all, or the mode is unrecognized.
function resolveConflicts(text, mode) {
  if (mode !== "ours" && mode !== "theirs" && mode !== "both") {
    return {
      ok: false,
      error: `resolveConflicts: unknown resolution mode "${mode}" (expected "ours", "theirs", or "both")`,
    };
  }

  const parsed = parseConflictBlocks(text);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  if (!parsed.hasConflicts) {
    return {
      ok: false,
      error: "resolveConflicts: no conflict markers found in the given text",
    };
  }

  const out = [];
  for (const seg of parsed.segments) {
    if (seg.type === "context") {
      out.push(...seg.lines);
      continue;
    }
    if (mode === "ours") out.push(...seg.ours);
    else if (mode === "theirs") out.push(...seg.theirs);
    else out.push(...seg.ours, ...seg.theirs);
  }

  return { ok: true, content: joinLines(out) };
}

if (typeof window !== "undefined") {
  window.MergeConflicts = { parseConflictBlocks, resolveConflicts };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { parseConflictBlocks, resolveConflicts };
}

if (typeof exports !== "undefined") {
  exports.parseConflictBlocks = parseConflictBlocks;
  exports.resolveConflicts = resolveConflicts;
}
