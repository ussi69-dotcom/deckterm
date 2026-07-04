/**
 * fd-safe file IO primitives for agent-writable task directories.
 *
 * Threat model: everything under a task's `taskDir` is writable by agent
 * processes running as the same uid as the server. An agent may swap a file
 * or directory for a symlink or FIFO between a check and a use (TOCTOU).
 * All reads/writes here therefore operate on an already-open file
 * descriptor — the fstat() that validates "is this a regular file" and the
 * subsequent read/write always target the SAME fd, never a re-resolved
 * path. `O_NOFOLLOW` additionally refuses to open through a symlink at all.
 */
import {
  closeSync,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { basename, dirname } from "node:path";

const {
  O_RDONLY,
  O_WRONLY,
  O_APPEND,
  O_CREAT,
  O_EXCL,
  O_NOFOLLOW,
  O_DIRECTORY,
  O_NONBLOCK,
} = fsConstants;

/**
 * Read a task file safely: refuses symlinks, refuses non-regular files
 * (FIFOs, devices, directories), refuses files over `maxBytes`. Reads
 * through the fd that was already validated by fstat — never re-opens or
 * re-resolves the path after the check.
 *
 * `O_NONBLOCK` is set on the open: without it, opening a FIFO for read
 * blocks the calling thread until a writer connects, which lets an agent
 * turn a task-file read into an indefinite hang (a DoS) just by placing a
 * FIFO at the path. With `O_NONBLOCK` the open returns immediately either
 * way, and the fstat regular-file check below rejects it. It has no effect
 * on the subsequent read of an actual regular file.
 *
 * Returns null on any violation or error; never throws.
 */
export function readTaskFileSafe(
  path: string,
  opts: { maxBytes: number },
): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    if (st.size > opts.maxBytes) return null;
    // The file is agent-writable and can GROW between the fstat above and
    // the read — so the cap must bind the read itself, not just the stat.
    // Read at most maxBytes + 1 probe byte; if the probe byte fills, the
    // file outgrew the cap mid-read and the whole read is rejected.
    const buf = Buffer.alloc(opts.maxBytes + 1);
    let total = 0;
    while (total < buf.length) {
      const n = readSync(fd, buf, total, buf.length - total, total);
      if (n === 0) break;
      total += n;
    }
    if (total > opts.maxBytes) return null;
    return buf.subarray(0, total).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }
}

/**
 * Append a line/chunk of data to a task file safely: creates the file if
 * missing, refuses symlinks, refuses non-regular existing files. Writes
 * through the fd validated by fstat.
 *
 * `O_NONBLOCK` is set on the open for the same reason as in
 * `readTaskFileSafe`: without it, opening an existing FIFO for write blocks
 * until a reader connects (an agent-controlled DoS). With `O_NONBLOCK` a
 * FIFO with no reader fails the open immediately (ENXIO) instead of
 * blocking, and is caught by the catch-all below.
 *
 * Returns true on success, false on any violation or error; never throws.
 */
export function appendTaskFileSafe(path: string, data: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK,
      0o600,
    );
    const st = fstatSync(fd);
    if (!st.isFile()) return false;
    writeSync(fd, data);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }
}

/**
 * Atomically write `data` to `path` via a temp file + rename, entirely
 * through file descriptors:
 *
 *  1. Open the PARENT DIRECTORY with O_NOFOLLOW|O_DIRECTORY — a directory
 *     swapped for a symlink fails to open (ELOOP/ENOTDIR) here.
 *  2. Create a uniquely-named temp file in that same directory with
 *     O_CREAT|O_EXCL|O_NOFOLLOW so it cannot collide with, or be satisfied
 *     by, an existing file/symlink.
 *  3. fstat the temp fd: must be a regular file with nlink === 1 (rules out
 *     a hardlink pointing elsewhere having been raced into place).
 *  4. Write + fsync + close the temp fd, then rename() into place.
 *
 * Known accepted residual: Node/Bun expose no `openat()`, so there is a
 * theoretical window between opening the parent directory fd (step 1) and
 * creating the temp file by name (step 2) where the parent directory entry
 * could be swapped for a different directory. `O_EXCL|O_NOFOLLOW` on the
 * temp file create still prevents the write from ever going through a
 * pre-placed symlink — the create simply fails instead. This residual is
 * accepted, not fixed, per the security review.
 *
 * Throws on any violation; best-effort unlinks the temp file first.
 */
export function writeTaskFileAtomic(path: string, data: string): void {
  const dir = dirname(path);
  const base = basename(path);
  const tmpPath = `${dir}/${base}.${process.pid}.${Date.now()}.tmp`;

  let dirFd: number | undefined;
  let tmpFd: number | undefined;
  try {
    dirFd = openSync(dir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);

    try {
      tmpFd = openSync(
        tmpPath,
        O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
        0o600,
      );
      const st = fstatSync(tmpFd);
      if (!st.isFile() || st.nlink !== 1) {
        throw new Error("task-file-io: temp file is not a plain regular file");
      }
      writeSync(tmpFd, data);
      fsyncSync(tmpFd);
      closeSync(tmpFd);
      tmpFd = undefined;
      renameSync(tmpPath, path);
    } catch (err) {
      if (tmpFd !== undefined) {
        try {
          closeSync(tmpFd);
        } catch {
          // ignore close errors
        }
        tmpFd = undefined;
      }
      try {
        unlinkSync(tmpPath);
      } catch {
        // best-effort cleanup; ignore
      }
      throw err;
    }
  } finally {
    if (dirFd !== undefined) {
      try {
        closeSync(dirFd);
      } catch {
        // ignore close errors
      }
    }
  }
}
