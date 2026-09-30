import { expect, test } from "bun:test";
import {
  mkdtemp,
  writeFile,
  rm,
  symlink,
  readdir,
  readlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boundedRequest,
  TransferBudget,
  streamLegacyDownload,
} from "./services/transfers";

test("chunked body without Content-Length is limited before multipart parsing and cancelled", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    pull(c) {
      c.enqueue(new Uint8Array(8));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(
    boundedRequest(
      new Request("http://localhost/upload", { method: "POST", body }),
      10,
    ),
  ).rejects.toMatchObject({ status: 413 });
  expect(cancelled).toBe(true);
});

test("bounded multipart stays parseable and timeout cancels a stalled body", async () => {
  const form = new FormData();
  form.set("file", new File(["hello"], "a.txt"));
  const request = await boundedRequest(
    new Request("http://localhost/upload", { method: "POST", body: form }),
    2048,
  );
  expect(await ((await request.formData()).get("file") as File).text()).toBe(
    "hello",
  );
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  await expect(
    boundedRequest(
      new Request("http://localhost/upload", { method: "POST", body }),
      100,
      5,
    ),
  ).rejects.toMatchObject({ status: 408 });
  expect(cancelled).toBe(true);
});

test("transfer budget enforces per-actor/global limits and idempotent release", () => {
  const budget = new TransferBudget(1, 2);
  const a = budget.acquire("a");
  expect(() => budget.acquire("a")).toThrow("concurrent");
  const b = budget.acquire("b");
  expect(() => budget.acquire("c")).toThrow("concurrent");
  a();
  a();
  const c = budget.acquire("c");
  c();
  b();
  budget.acquire("a")();
});

test("download streams bounded chunks, closes on cancel, and rejects symlinks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deckterm-transfer-"));
  let releases = 0;
  const openFixtureDescriptors = async () => {
    const targets = await Promise.all(
      (await readdir("/proc/self/fd")).map((fd) =>
        readlink(`/proc/self/fd/${fd}`).catch(() => ""),
      ),
    );
    return targets.filter((target) => target.startsWith(`${dir}/`)).length;
  };
  try {
    await writeFile(join(dir, 'a"\n.txt'), Buffer.alloc(256 * 1024, 42));
    const response = await streamLegacyDownload(
      dir,
      'a"\n.txt',
      new AbortController().signal,
      () => releases++,
    );
    expect(response.headers.get("content-disposition")).toContain("%0A");
    const reader = response.body!.getReader();
    expect((await reader.read()).value!.length).toBeLessThanOrEqual(65536);
    await reader.cancel();
    expect(releases).toBe(1);
    expect(await openFixtureDescriptors()).toBe(0);
    await symlink("/etc/passwd", join(dir, "link"));
    await expect(
      streamLegacyDownload(
        dir,
        "link",
        new AbortController().signal,
        () => releases++,
      ),
    ).rejects.toThrow();
    const controller = new AbortController();
    const aborted = await streamLegacyDownload(
      dir,
      'a"\n.txt',
      controller.signal,
      () => releases++,
    );
    const reading = aborted.arrayBuffer();
    controller.abort();
    await expect(reading).rejects.toThrow();
    await Bun.sleep(5);
    expect(releases).toBe(2);
    expect(await openFixtureDescriptors()).toBe(0);
    const complete = await streamLegacyDownload(
      dir,
      'a"\n.txt',
      new AbortController().signal,
      () => releases++,
    );
    expect((await complete.arrayBuffer()).byteLength).toBe(256 * 1024);
    expect(releases).toBe(3);
    expect(await openFixtureDescriptors()).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
