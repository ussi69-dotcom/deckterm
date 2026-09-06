import { Database } from "bun:sqlite";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

/** A separate SQLite file supplies a kernel-managed lifetime lock. Never unlink it:
 * another process may already have the same inode open. Crash/SIGKILL releases
 * SQLite's OS locks, so stale files and recycled process IDs need no special case. */
export function acquireStateOwnership(stateDir: string): { release(): void } {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const state = lstatSync(stateDir);
  const uid = process.getuid?.();
  if (
    !state.isDirectory() ||
    state.isSymbolicLink() ||
    (uid != null && state.uid !== uid)
  ) {
    throw new Error(
      "DeckTerm state directory must be a real directory owned by the service account",
    );
  }
  chmodSync(stateDir, 0o700);
  const path = join(realpathSync(stateDir), "state-owner.lock.sqlite");
  const file = lstatSync(path, { throwIfNoEntry: false });
  if (file) {
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      file.nlink !== 1 ||
      (uid != null && file.uid !== uid)
    ) {
      throw new Error("DeckTerm state ownership file is unsafe");
    }
  }
  let lock: Database | undefined;
  try {
    lock = new Database(path, { create: true });
    chmodSync(path, 0o600);
    lock.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
    // Force an actual write lock on a fresh (initially empty) database as well.
    lock.exec("CREATE TABLE IF NOT EXISTS state_owner (owner INTEGER)");
  } catch (error) {
    lock?.close();
    throw new Error(
      "DeckTerm state directory is already owned by another process, or cannot be locked",
      { cause: error },
    );
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        lock!.exec("ROLLBACK");
      } finally {
        lock!.close();
      }
    },
  };
}
