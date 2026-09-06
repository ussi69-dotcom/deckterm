import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileTrashError,
  FILE_TRASH_DIR,
  containsManagedTrash,
  initTrashSchema,
  isReservedTrashPath,
  listTrashItems,
  purgeExpiredTrashItems,
  restoreTrashItem,
  trashPath,
  type FileTrashBinding,
} from "./file-trash";
import { FsExecError, getFsExecutor } from "./fs-executor";

const cleanup: string[] = [];

function setup() {
  const base = mkdtempSync(join(tmpdir(), "deckterm-file-trash-"));
  cleanup.push(base);
  const root = join(base, "root");
  mkdirSync(root);
  const dbPath = join(base, "state.db");
  const db = new Database(dbPath);
  initTrashSchema(db);
  const binding: FileTrashBinding = {
    actorId: "user_alice",
    rootId: "root_project",
    root,
    fsContext: { kind: "legacy" },
  };
  return {
    base,
    root,
    dbPath,
    db,
    binding,
    executor: getFsExecutor({ kind: "legacy" }),
  };
}

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("file trash path reservation and schema", () => {
  test("recognizes only the reserved root-relative trash tree", () => {
    expect(isReservedTrashPath(".deckterm-trash")).toBe(true);
    expect(isReservedTrashPath(".deckterm-trash/item")).toBe(true);
    expect(isReservedTrashPath("./.deckterm-trash/item")).toBe(true);
    expect(isReservedTrashPath("project/.deckterm-trash")).toBe(true);
    expect(isReservedTrashPath("/granted/project/.deckterm-trash/item")).toBe(
      true,
    );
    expect(isReservedTrashPath(".deckterm-trash-old")).toBe(false);
    expect(containsManagedTrash("/granted/project", ["/granted/project"])).toBe(
      true,
    );
    expect(containsManagedTrash("/granted", ["/granted/project"])).toBe(true);
    expect(containsManagedTrash("/granted/sibling", ["/granted/project"])).toBe(
      false,
    );
  });

  test("SQLite prevents mutation of immutable actor/root/mapping metadata", async () => {
    const { db, binding, root } = setup();
    writeFileSync(join(root, "immutable.txt"), "data");
    const item = await trashPath(db, binding, "immutable.txt");
    expect(() =>
      db
        .query("UPDATE file_trash_items SET actor_id = ? WHERE id = ?")
        .run("user_mallory", item.id),
    ).toThrow("immutable");
    expect(() =>
      db
        .query("UPDATE file_trash_items SET os_uid = os_uid + 1 WHERE id = ?")
        .run(item.id),
    ).toThrow("immutable");
    db.close();
  });

  test("fails closed for a non-private trash directory", async () => {
    const { db, binding, root } = setup();
    mkdirSync(join(root, FILE_TRASH_DIR), { mode: 0o755 });
    chmodSync(join(root, FILE_TRASH_DIR), 0o755);
    writeFileSync(join(root, "private.txt"), "data");
    await expect(trashPath(db, binding, "private.txt")).rejects.toMatchObject({
      code: "binding_changed",
    });
    expect(readFileSync(join(root, "private.txt"), "utf8")).toBe("data");
    db.close();
  });

  test("duplicate item ids fail before moving the second source", async () => {
    const { db, binding, root } = setup();
    writeFileSync(join(root, "first.txt"), "first");
    writeFileSync(join(root, "second.txt"), "second");
    await trashPath(db, binding, "first.txt", {
      itemId: "trash_duplicate_case",
    });

    await expect(
      trashPath(db, binding, "second.txt", {
        itemId: "trash_duplicate_case",
      }),
    ).rejects.toMatchObject({ code: "collision" });
    expect(readFileSync(join(root, "second.txt"), "utf8")).toBe("second");
    expect(
      readFileSync(join(root, FILE_TRASH_DIR, "trash_duplicate_case"), "utf8"),
    ).toBe("first");
    db.close();
  });
});

describe("reversible deletion", () => {
  test("survives a DB refresh and restores exact file bytes", async () => {
    const { db, dbPath, binding, root } = setup();
    writeFileSync(join(root, "notes.txt"), "keep me");
    const deleted = await trashPath(db, binding, "notes.txt", {
      itemId: "trash_refresh_case",
      now: new Date("2026-09-01T00:00:00Z"),
    });
    expect(deleted.status).toBe("ready");
    expect(existsSync(join(root, "notes.txt"))).toBe(false);
    expect(readFileSync(join(root, FILE_TRASH_DIR, deleted.id), "utf8")).toBe(
      "keep me",
    );
    db.close();

    const refreshed = new Database(dbPath);
    initTrashSchema(refreshed);
    const listed = await listTrashItems(refreshed, binding, {
      now: new Date("2026-09-02T00:00:00Z"),
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.originalRelPath).toBe("notes.txt");

    const restored = await restoreTrashItem(refreshed, binding, deleted.id);
    expect(restored.status).toBe("restored");
    expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("keep me");
    expect(existsSync(join(root, FILE_TRASH_DIR, deleted.id))).toBe(false);
    expect(await listTrashItems(refreshed, binding)).toEqual([]);
    refreshed.close();
  });

  test("restores an entire directory without following symlinks", async () => {
    const { db, binding, root } = setup();
    mkdirSync(join(root, "folder"));
    writeFileSync(join(root, "folder", "child.txt"), "child");
    const item = await trashPath(db, binding, "folder");
    expect(existsSync(join(root, "folder"))).toBe(false);
    await restoreTrashItem(db, binding, item.id);
    expect(readFileSync(join(root, "folder", "child.txt"), "utf8")).toBe(
      "child",
    );
    db.close();
  });

  test("restore collision never overwrites a replacement", async () => {
    const { db, binding, root } = setup();
    writeFileSync(join(root, "same.txt"), "deleted version");
    const item = await trashPath(db, binding, "same.txt");
    writeFileSync(join(root, "same.txt"), "replacement");

    await expect(restoreTrashItem(db, binding, item.id)).rejects.toMatchObject({
      code: "collision",
    });
    expect(readFileSync(join(root, "same.txt"), "utf8")).toBe("replacement");
    expect(readFileSync(join(root, FILE_TRASH_DIR, item.id), "utf8")).toBe(
      "deleted version",
    );

    rmSync(join(root, "same.txt"));
    await restoreTrashItem(db, binding, item.id);
    expect(readFileSync(join(root, "same.txt"), "utf8")).toBe(
      "deleted version",
    );
    db.close();
  });

  test("revalidates trash directory privacy before restore", async () => {
    const { db, binding, root } = setup();
    writeFileSync(join(root, "privacy.txt"), "private");
    const item = await trashPath(db, binding, "privacy.txt");
    chmodSync(join(root, FILE_TRASH_DIR), 0o777);
    await expect(restoreTrashItem(db, binding, item.id)).rejects.toMatchObject({
      code: "binding_changed",
    });
    expect(existsSync(join(root, FILE_TRASH_DIR, item.id))).toBe(true);
    expect(existsSync(join(root, "privacy.txt"))).toBe(false);
    db.close();
  });

  test("refuses restore when the trashed inode metadata changed", async () => {
    const { db, binding, root } = setup();
    writeFileSync(join(root, "tamper.txt"), "original");
    const item = await trashPath(db, binding, "tamper.txt");
    writeFileSync(
      join(root, FILE_TRASH_DIR, item.id),
      "modified while in trash",
    );
    await expect(restoreTrashItem(db, binding, item.id)).rejects.toMatchObject({
      code: "identity_changed",
    });
    expect(existsSync(join(root, "tamper.txt"))).toBe(false);
    expect(readFileSync(join(root, FILE_TRASH_DIR, item.id), "utf8")).toBe(
      "modified while in trash",
    );
    db.close();
  });

  test("refuses restore when only the trashed permissions changed", async () => {
    const { db, binding, root } = setup();
    writeFileSync(join(root, "mode.txt"), "unchanged", { mode: 0o600 });
    const item = await trashPath(db, binding, "mode.txt");
    chmodSync(join(root, FILE_TRASH_DIR, item.id), 0o644);

    await expect(restoreTrashItem(db, binding, item.id)).rejects.toMatchObject({
      code: "identity_changed",
    });
    expect(existsSync(join(root, "mode.txt"))).toBe(false);
    expect(statSync(join(root, FILE_TRASH_DIR, item.id)).mode & 0o7777).toBe(
      0o644,
    );
    db.close();
  });

  test("refuses a symlink without touching its external target", async () => {
    const { db, binding, root, base } = setup();
    const outside = join(base, "outside.txt");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(root, "link.txt"));
    await expect(trashPath(db, binding, "link.txt")).rejects.toMatchObject({
      code: "escape_denied",
    });
    expect(readFileSync(outside, "utf8")).toBe("outside");
    expect(existsSync(join(root, "link.txt"))).toBe(true);
    db.close();
  });
});

describe("immutable access binding", () => {
  test("a second Unix uid on the same root fails closed without moving the source", async () => {
    const { db, binding, root, executor } = setup();
    mkdirSync(join(root, FILE_TRASH_DIR), { mode: 0o700 });
    chmodSync(join(root, FILE_TRASH_DIR), 0o700);
    writeFileSync(join(root, "shared-root.txt"), "still here");
    const otherUidBinding: FileTrashBinding = {
      ...binding,
      actorId: "user_bob",
      fsContext: {
        kind: "brokered",
        uid: (process.getuid?.() ?? 1000) + 1,
        gid: (process.getgid?.() ?? 1000) + 1,
        osUsername: "second-user",
      },
    };

    await expect(
      trashPath(db, otherUidBinding, "shared-root.txt", { executor }),
    ).rejects.toMatchObject({ code: "binding_changed" });
    expect(readFileSync(join(root, "shared-root.txt"), "utf8")).toBe(
      "still here",
    );
    expect(
      db.query("SELECT count(*) AS count FROM file_trash_items").get(),
    ).toEqual({ count: 0 });
    db.close();
  });

  test("cross-actor access is hidden; wrong root and mapping are denied", async () => {
    const { db, binding, root } = setup();
    writeFileSync(join(root, "bound.txt"), "bound");
    const item = await trashPath(db, binding, "bound.txt");

    await expect(
      restoreTrashItem(db, { ...binding, actorId: "user_bob" }, item.id),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      restoreTrashItem(db, { ...binding, rootId: "root_other" }, item.id),
    ).rejects.toMatchObject({ code: "binding_changed" });

    const changedMapping: FileTrashBinding = {
      ...binding,
      fsContext: {
        kind: "brokered",
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0,
        osUsername: "remapped-user",
      },
    };
    await expect(
      restoreTrashItem(db, changedMapping, item.id, {
        executor: getFsExecutor({ kind: "legacy" }),
      }),
    ).rejects.toMatchObject({ code: "binding_changed" });

    // A route whose root grant or mapping was revoked cannot produce the old
    // binding. Passing any newly resolved binding does not expose the row.
    expect(
      await listTrashItems(db, changedMapping, {
        executor: getFsExecutor({ kind: "legacy" }),
      }),
    ).toEqual([]);
    expect(existsSync(join(root, FILE_TRASH_DIR, item.id))).toBe(true);
    db.close();
  });
});

describe("crash reconciliation and expiry", () => {
  test("finishes pending move and restore states idempotently", async () => {
    const { db, binding, root, executor } = setup();
    writeFileSync(join(root, "crash.txt"), "crash-safe");
    const item = await trashPath(db, binding, "crash.txt", {
      itemId: "trash_crash_state",
    });

    // Simulate a crash after the filesystem move and before the ready CAS.
    db.query(
      "UPDATE file_trash_items SET status = 'pending_move' WHERE id = ?",
    ).run(item.id);
    const afterMoveCrash = await listTrashItems(db, binding);
    expect(afterMoveCrash.map((entry) => entry.id)).toEqual([item.id]);

    // Simulate a crash after pending_restore + physical restore, before its CAS.
    const expected = await executor.identity(
      root,
      `${FILE_TRASH_DIR}/${item.id}`,
    );
    db.query(
      "UPDATE file_trash_items SET status = 'pending_restore' WHERE id = ?",
    ).run(item.id);
    await executor.atomicMove(
      root,
      `${FILE_TRASH_DIR}/${item.id}`,
      "crash.txt",
      expected,
    );
    expect(await listTrashItems(db, binding)).toEqual([]);
    const row = db
      .query("SELECT status FROM file_trash_items WHERE id = ?")
      .get(item.id) as { status: string };
    expect(row.status).toBe("restored");
    expect(readFileSync(join(root, "crash.txt"), "utf8")).toBe("crash-safe");
    db.close();
  });

  test("resumes a pending restore that had not moved yet", async () => {
    const { db, binding, root } = setup();
    writeFileSync(join(root, "resume.txt"), "resume");
    const item = await trashPath(db, binding, "resume.txt");
    db.query(
      "UPDATE file_trash_items SET status = 'pending_restore' WHERE id = ?",
    ).run(item.id);
    expect(await listTrashItems(db, binding)).toEqual([]);
    expect(readFileSync(join(root, "resume.txt"), "utf8")).toBe("resume");
    db.close();
  });

  test("resumes a persisted, partially deleted purge quarantine", async () => {
    const { db, binding, root, executor } = setup();
    mkdirSync(join(root, "purge-crash"));
    writeFileSync(join(root, "purge-crash", "one.txt"), "one");
    writeFileSync(join(root, "purge-crash", "two.txt"), "two");
    const item = await trashPath(db, binding, "purge-crash", {
      itemId: "trash_purge_crash",
    });
    const trashRel = `${FILE_TRASH_DIR}/${item.id}`;
    const purgeRel = `${FILE_TRASH_DIR}/.purge-${item.id}`;
    const expected = await executor.identity(root, trashRel);

    db.query(
      "UPDATE file_trash_items SET status = 'pending_purge' WHERE id = ?",
    ).run(item.id);
    await executor.atomicMove(root, trashRel, purgeRel, expected);
    rmSync(join(root, purgeRel, "one.txt"));

    expect(await listTrashItems(db, binding)).toEqual([]);
    expect(existsSync(join(root, trashRel))).toBe(false);
    expect(existsSync(join(root, purgeRel))).toBe(false);
    const row = db
      .query("SELECT status FROM file_trash_items WHERE id = ?")
      .get(item.id) as { status: string };
    expect(row.status).toBe("purged");
    db.close();
  });

  test("bounded expiry requires an explicit, currently bound purge", async () => {
    const { db, binding, root } = setup();
    writeFileSync(join(root, "expire.txt"), "expire");
    const item = await trashPath(db, binding, "expire.txt", {
      retentionDays: 7,
      now: new Date("2026-09-01T00:00:00Z"),
    });
    const later = new Date("2026-09-09T00:00:00Z");
    expect(
      (await listTrashItems(db, binding, { now: later }))[0]?.expired,
    ).toBe(true);

    const wrongActor = { ...binding, actorId: "user_bob" };
    expect(
      await purgeExpiredTrashItems(db, wrongActor, { now: later }),
    ).toEqual({
      purged: 0,
      failed: 0,
    });
    expect(existsSync(join(root, FILE_TRASH_DIR, item.id))).toBe(true);

    expect(await purgeExpiredTrashItems(db, binding, { now: later })).toEqual({
      purged: 1,
      failed: 0,
    });
    expect(existsSync(join(root, FILE_TRASH_DIR, item.id))).toBe(false);
    const row = db
      .query("SELECT status FROM file_trash_items WHERE id = ?")
      .get(item.id) as { status: string };
    expect(row.status).toBe("purged");
    db.close();
  });

  test("concurrent restore operations serialize and preserve one exact result", async () => {
    const { db, binding, root } = setup();
    writeFileSync(join(root, "once.txt"), "once");
    const item = await trashPath(db, binding, "once.txt");
    const results = await Promise.allSettled([
      restoreTrashItem(db, binding, item.id),
      restoreTrashItem(db, binding, item.id),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(readFileSync(join(root, "once.txt"), "utf8")).toBe("once");
    db.close();
  });
});

test("error types stay distinguishable for route mapping", () => {
  expect(new FileTrashError("collision", "x").code).toBe("collision");
  expect(new FsExecError("identity_changed", "x").code).toBe(
    "identity_changed",
  );
});
