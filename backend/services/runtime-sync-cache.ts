// Cost controls for GET /api/terminals.
//
// Every open tab polls /api/terminals every few seconds, and each poll used to
// run tmux queries plus a full `ps -eo pid,ppid,args` per session. Two pieces
// keep that bounded without changing the response:
//
// - a per-terminal single-flight cache with a short TTL, so concurrent and
//   back-to-back polls share one tmux runtime sync;
// - one parsed `ps` snapshot per request, shared by every session in it
//   (`parseProcessTable` + `collectProcessTreeArgs`).

export type ProcessSnapshot = {
  argsByPid: Map<number, string>;
  childrenByParent: Map<number, number[]>;
};

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(.*)$/;

/** Parses `ps -eo pid=,ppid=,args=` output. */
export function parseProcessTable(output: string): ProcessSnapshot {
  const childrenByParent = new Map<number, number[]>();
  const argsByPid = new Map<number, string>();

  for (const line of output.split("\n")) {
    const match = line.match(PS_LINE);
    if (!match) continue;
    const pid = Number.parseInt(match[1] || "", 10);
    const ppid = Number.parseInt(match[2] || "", 10);
    const args = (match[3] || "").trim();
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !args) continue;
    argsByPid.set(pid, args);
    const siblings = childrenByParent.get(ppid) || [];
    siblings.push(pid);
    childrenByParent.set(ppid, siblings);
  }

  return { argsByPid, childrenByParent };
}

/** Command lines of `rootPid` and its descendants, depth-first in ps order. */
export function collectProcessTreeArgs(
  snapshot: ProcessSnapshot,
  rootPid: number,
): string[] {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];

  const processTree: string[] = [];
  const stack = [rootPid];
  const visited = new Set<number>();

  while (stack.length > 0) {
    const pid = stack.pop();
    if (!pid || visited.has(pid)) continue;
    visited.add(pid);
    const args = snapshot.argsByPid.get(pid);
    if (args) processTree.push(args);
    const children = snapshot.childrenByParent.get(pid) || [];
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push(children[index]!);
    }
  }

  return processTree;
}

/** Memoises an async factory: it runs on the first call only. */
export function createLazyOnce<T>(factory: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null;
  return () => (promise ??= factory());
}

/**
 * Per-key single-flight with a short result TTL. Callers that arrive while a
 * run is in flight share it; callers within `ttlMs` of it settling reuse its
 * result. Failures are delivered to every waiter and never cached. Keys are
 * held weakly, so a terminal object that goes away takes its entry with it.
 */
export function createSingleFlightCache<K extends object, V>({
  ttlMs,
  now = Date.now,
}: {
  ttlMs: number;
  now?: () => number;
}) {
  type Entry = { promise: Promise<V>; settledAt: number | null };
  const entries = new WeakMap<K, Entry>();

  function run(key: K, task: () => Promise<V>): Promise<V> {
    const existing = entries.get(key);
    if (
      existing &&
      (existing.settledAt === null || now() - existing.settledAt < ttlMs)
    ) {
      return existing.promise;
    }

    const entry: Entry = {
      promise: Promise.resolve() as Promise<V>,
      settledAt: null,
    };
    entry.promise = Promise.resolve()
      .then(task)
      .then(
        (value) => {
          entry.settledAt = now();
          return value;
        },
        (error) => {
          if (entries.get(key) === entry) entries.delete(key);
          throw error;
        },
      );
    entries.set(key, entry);
    return entry.promise;
  }

  function invalidate(key: K): void {
    entries.delete(key);
  }

  return { run, invalidate };
}
