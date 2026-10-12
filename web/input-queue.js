// Bounded queue for terminal input typed while the WebSocket is not open.
//
// ReconnectingWebSocket used to drop every keystroke sent during the initial
// connect or a reconnect backoff. This queue holds that input instead and
// hands it back in order once the connection is ready. It is deliberately
// small and short-lived: replaying a long-stale command into a shell is worse
// than losing it, so input older than maxAgeMs or beyond maxBytes is dropped
// and the caller is told how much, so it can show a visible notice.
//
// Pure (no DOM, no timers) so it can be unit-tested in Bun. app.js consumes
// it at runtime via window.InputQueue (loaded as a <script> before app.js).

const INPUT_QUEUE_MAX_BYTES = 8 * 1024;
const INPUT_QUEUE_MAX_AGE_MS = 15000;

const inputQueueEncoder =
  typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

function measureInputBytes(data) {
  if (typeof data !== "string" || !data) return 0;
  return inputQueueEncoder ? inputQueueEncoder.encode(data).length : data.length;
}

class InputQueue {
  constructor({
    maxBytes = INPUT_QUEUE_MAX_BYTES,
    maxAgeMs = INPUT_QUEUE_MAX_AGE_MS,
    now = () => Date.now(),
  } = {}) {
    this.maxBytes = maxBytes;
    this.maxAgeMs = maxAgeMs;
    this.now = now;
    this.entries = [];
    this.totalBytes = 0;
  }

  get length() {
    return this.entries.length;
  }

  get bytes() {
    return this.totalBytes;
  }

  // Queue one input chunk. Returns how many chunks were dropped to make room
  // (expired ones, the oldest ones over budget, or this chunk itself when it
  // alone exceeds the budget).
  push(data) {
    if (typeof data !== "string" || !data) return 0;
    let dropped = this.prune();
    const size = measureInputBytes(data);
    if (size > this.maxBytes) return dropped + 1;
    this.entries.push({ data, size, at: this.now() });
    this.totalBytes += size;
    while (this.totalBytes > this.maxBytes && this.entries.length > 1) {
      const oldest = this.entries.shift();
      this.totalBytes -= oldest.size;
      dropped += 1;
    }
    return dropped;
  }

  // Drop expired chunks. Returns how many were dropped.
  prune() {
    const cutoff = this.now() - this.maxAgeMs;
    let dropped = 0;
    while (this.entries.length && this.entries[0].at < cutoff) {
      const oldest = this.entries.shift();
      this.totalBytes -= oldest.size;
      dropped += 1;
    }
    return dropped;
  }

  // Milliseconds until the oldest chunk expires, or null when empty.
  msUntilNextExpiry() {
    if (!this.entries.length) return null;
    return Math.max(0, this.entries[0].at + this.maxAgeMs - this.now());
  }

  // Take every still-valid chunk, oldest first, and empty the queue.
  drain() {
    const dropped = this.prune();
    const items = this.entries.map((entry) => entry.data);
    this.entries = [];
    this.totalBytes = 0;
    return { items, dropped };
  }

  // Discard everything. Returns how many chunks were discarded.
  clear() {
    const discarded = this.entries.length;
    this.entries = [];
    this.totalBytes = 0;
    return discarded;
  }
}

if (typeof window !== "undefined") {
  window.InputQueue = InputQueue;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    INPUT_QUEUE_MAX_AGE_MS,
    INPUT_QUEUE_MAX_BYTES,
    InputQueue,
    measureInputBytes,
  };
}
