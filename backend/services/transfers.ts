import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import {
  basename,
  join,
  sep,
  relative as relativePath,
  isAbsolute,
} from "node:path";

export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
export class TransferError extends Error {
  constructor(
    public status: 413 | 429 | 408,
    message: string,
  ) {
    super(message);
  }
}

export class TransferBudget {
  private actors = new Map<string, number>();
  private total = 0;
  constructor(
    private perActor = 2,
    private global = 8,
  ) {}
  acquire(actor: string): () => void {
    const count = this.actors.get(actor) || 0;
    if (count >= this.perActor || this.total >= this.global)
      throw new TransferError(429, "Too many concurrent file transfers");
    this.actors.set(actor, count + 1);
    this.total++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.actors.get(actor) || 1) - 1;
      if (remaining) this.actors.set(actor, remaining);
      else this.actors.delete(actor);
      this.total--;
    };
  }
}
export const transferBudget = new TransferBudget();

/** Count actual bytes before formData(), including chunked requests. */
export async function boundedRequest(
  request: Request,
  limit: number,
  timeoutMs = 30_000,
): Promise<Request> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await request.body?.cancel();
    throw new TransferError(413, "Upload exceeds the size limit");
  }
  if (!request.body) return request;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel();
  }, timeoutMs);
  const abort = () => {
    void reader.cancel();
  };
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (request.signal.aborted)
        throw new TransferError(408, "Upload cancelled");
      const { value, done } = await reader.read();
      if (expired) throw new TransferError(408, "Upload timed out");
      if (request.signal.aborted)
        throw new TransferError(408, "Upload cancelled");
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new TransferError(413, "Upload exceeds the size limit");
      }
      chunks.push(value);
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }
    const headers = new Headers(request.headers);
    headers.delete("transfer-encoding");
    headers.set("content-length", String(length));
    return new Request(request.url, {
      method: request.method,
      headers,
      body,
      signal: request.signal,
    });
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

export function downloadHeaders(filename: string, size: number): Headers {
  return new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`,
    "Content-Length": String(size),
    "X-Content-Type-Options": "nosniff",
  });
}

/** Fixed-size, fd-bound reads; no whole-file buffering or file-growth loop. */
export async function streamLegacyDownload(
  root: string,
  relative: string,
  signal: AbortSignal,
  release: () => void,
): Promise<Response> {
  const file = await open(
    join(root, relative),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let closed = false;
  let activeRead: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const close = () => {
    if (closing) return closing;
    closed = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    const pendingRead = activeRead;
    // Bun 1.3.5 can leave the descriptor open if FileHandle.close races read.
    // Drain the one bounded read before closing; concurrent callers share it.
    closing = (async () => {
      try {
        await pendingRead?.catch(() => {});
        await file.close();
      } finally {
        release();
      }
    })();
    return closing;
  };
  const abort = () => {
    try {
      controller?.error(new Error("Download cancelled"));
    } catch {}
    void close();
  };
  try {
    const resolvedRoot = await realpath(root);
    const actual = await realpath(`/proc/self/fd/${file.fd}`);
    const child = relativePath(resolvedRoot, actual);
    if (
      !child ||
      isAbsolute(child) ||
      child === ".." ||
      child.startsWith(".." + sep) ||
      actual.split(sep).includes(".deckterm-trash")
    )
      throw new Error("File escaped its allowed root");
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Not a regular file");
    if (signal.aborted) throw new Error("Download cancelled");
    let position = 0;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      async pull(c) {
        try {
          if (closed) return;
          clearTimeout(timer);
          if (position >= stat.size) {
            await close();
            c.close();
            return;
          }
          const buffer = Buffer.allocUnsafe(
            Math.min(64 * 1024, stat.size - position),
          );
          const reading = file.read(buffer, 0, buffer.length, position);
          activeRead = reading;
          let bytesRead: number;
          try {
            ({ bytesRead } = await reading);
          } finally {
            if (activeRead === reading) activeRead = undefined;
          }
          if (closed) return;
          if (!bytesRead) throw new Error("File changed during download");
          position += bytesRead;
          c.enqueue(buffer.subarray(0, bytesRead));
          timer = setTimeout(abort, 30_000);
        } catch (error) {
          await close();
          try {
            c.error(error);
          } catch {}
        }
      },
      cancel: close,
    });
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(abort, 30_000);
    return new Response(body, {
      headers: downloadHeaders(basename(relative), stat.size),
    });
  } catch (error) {
    await close();
    throw error;
  }
}
