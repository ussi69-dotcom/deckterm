import { test, expect } from "bun:test";
import { escapeHtml } from "./html-escape.js";

test("escapeHtml escapes ALL of & < > \" ' (attribute-safe)", () => {
  // The regression: the old textContent→innerHTML escaper left " and ' intact
  // (they're valid in HTML text content), so a value interpolated into a quoted
  // attribute could break out → stored XSS. The shared escaper must encode all
  // five characters so the result is safe in text AND attribute contexts.
  expect(escapeHtml("&")).toBe("&amp;");
  expect(escapeHtml("<")).toBe("&lt;");
  expect(escapeHtml(">")).toBe("&gt;");
  expect(escapeHtml('"')).toBe("&quot;");
  expect(escapeHtml("'")).toBe("&#39;");
});

test("escapeHtml neutralizes an attribute-breakout XSS payload", () => {
  const payload = '"><img src=x onerror="alert(1)">';
  const out = escapeHtml(payload);
  // No raw quote, angle bracket, or live tag survives.
  expect(out).not.toContain('"');
  expect(out).not.toContain("<");
  expect(out).not.toContain(">");
  expect(out).toBe("&quot;&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  // Interpolated into a quoted attribute, the value stays inside the attribute.
  const attr = `data-x="${out}"`;
  expect(attr).toBe(
    'data-x="&quot;&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"',
  );
});

test("escapeHtml escapes & first (no double-encoding of entities)", () => {
  // Ampersand must be replaced before <,>,",' so the entities it produces for
  // those don't get their & re-escaped.
  expect(escapeHtml("a & b < c")).toBe("a &amp; b &lt; c");
  expect(escapeHtml("&amp;")).toBe("&amp;amp;");
});

test("escapeHtml coerces null/undefined/non-strings to a safe string", () => {
  expect(escapeHtml(null)).toBe("");
  expect(escapeHtml(undefined)).toBe("");
  expect(escapeHtml(0)).toBe("0");
  expect(escapeHtml(42)).toBe("42");
  expect(escapeHtml(false)).toBe("false");
});
