import { describe, expect, test } from "bun:test";
import {
  ATTENTION_SEEN_MAX_ENTRIES,
  mergeSeenMaps,
  sanitizeSeenMap,
} from "./services/attention-seen";

describe("mergeSeenMaps", () => {
  test("keeps the per-id max of stored and incoming", () => {
    expect(mergeSeenMaps({ a: 5, b: 2 }, { a: 3, b: 9, c: 1 })).toEqual({
      a: 5,
      b: 9,
      c: 1,
    });
  });

  test("an older map never lowers a newer value", () => {
    const newer = mergeSeenMaps({}, { a: 200, b: 300 });
    expect(mergeSeenMaps(newer, { a: 100, b: 100 })).toEqual({
      a: 200,
      b: 300,
    });
  });

  test("drops invalid entries from both sides", () => {
    expect(
      mergeSeenMaps(
        { ok: 1, neg: -4, str: "7", nan: Number.NaN },
        {
          zero: 0,
          inf: Number.POSITIVE_INFINITY,
          obj: { seq: 3 },
          [`${"x".repeat(65)}`]: 4,
          fine: 2,
        },
      ),
    ).toEqual({ ok: 1, fine: 2 });
  });

  test("a non-object on either side counts as empty", () => {
    expect(mergeSeenMaps("junk", { a: 1 })).toEqual({ a: 1 });
    expect(mergeSeenMaps({ a: 1 }, [5, 6])).toEqual({ a: 1 });
    expect(mergeSeenMaps(null, null)).toEqual({});
  });

  test(`keeps only the ${ATTENTION_SEEN_MAX_ENTRIES} highest seq values`, () => {
    const stored: Record<string, number> = {};
    for (let i = 1; i <= 150; i += 1) stored[`s-${i}`] = i;
    const incoming: Record<string, number> = {};
    for (let i = 151; i <= 260; i += 1) incoming[`i-${i}`] = i;
    const merged = mergeSeenMaps(stored, incoming);
    expect(Object.keys(merged)).toHaveLength(ATTENTION_SEEN_MAX_ENTRIES);
    expect(merged["i-260"]).toBe(260);
    expect(merged["s-61"]).toBe(61);
    expect(merged["s-60"]).toBeUndefined();
  });

  test("a full map of uuid entries stays under the 16 KB value limit", () => {
    const map: Record<string, number> = {};
    for (let i = 0; i < ATTENTION_SEEN_MAX_ENTRIES; i += 1) {
      map[crypto.randomUUID()] = 1_761_000_000_000 + i;
    }
    expect(JSON.stringify(mergeSeenMaps(map, {})).length).toBeLessThan(
      16 * 1024,
    );
  });
});

test("sanitizeSeenMap returns a fresh object", () => {
  const input = { a: 1 };
  const out = sanitizeSeenMap(input);
  expect(out).toEqual({ a: 1 });
  expect(out).not.toBe(input);
});
