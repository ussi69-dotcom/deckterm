// Server merge for the `attention.seen` setting (design section 3): the map
// of terminal id -> highest attention seq the actor has seen, shared by every
// device. PUT /api/settings merges it per id with max(stored, incoming), so a
// stale page can never undo another device's "seen". Invalid entries (not a
// finite positive number, or an empty or over-long id) are dropped, and only
// the ATTENTION_SEEN_MAX_ENTRIES highest seq values are kept (one entry is
// about 55 bytes, so the value stays well under the 16 KB settings limit).

export const ATTENTION_SEEN_KEY = "attention.seen";
export const ATTENTION_SEEN_MAX_ENTRIES = 200;
const ATTENTION_SEEN_MAX_ID_LENGTH = 64;

export type SeenMap = Record<string, number>;

export function sanitizeSeenMap(value: unknown): SeenMap {
  const out: SeenMap = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!id || id.length > ATTENTION_SEEN_MAX_ID_LENGTH) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) continue;
    out[id] = raw;
  }
  return out;
}

export function mergeSeenMaps(
  stored: unknown,
  incoming: unknown,
  maxEntries = ATTENTION_SEEN_MAX_ENTRIES,
): SeenMap {
  const merged = sanitizeSeenMap(stored);
  for (const [id, seq] of Object.entries(sanitizeSeenMap(incoming))) {
    const current = merged[id];
    if (current === undefined || seq > current) merged[id] = seq;
  }
  const entries = Object.entries(merged);
  if (entries.length <= maxEntries) return merged;
  entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return Object.fromEntries(entries.slice(0, maxEntries));
}
