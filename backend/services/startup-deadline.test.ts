import { expect, test } from "bun:test";
import { runWithDeadline } from "./startup-deadline";

test("a step that never settles times out instead of blocking startup", async () => {
  const started = Date.now();
  const result = await runWithDeadline(() => new Promise<never>(() => {}), 50);
  expect(result).toEqual({ ok: false, timedOut: true });
  expect(Date.now() - started).toBeLessThan(1_000);
});

test("a step that finishes in time returns its value", async () => {
  expect(await runWithDeadline(async () => 7, 1_000)).toEqual({
    ok: true,
    value: 7,
  });
});

test("a step that fails reports its error, not a timeout", async () => {
  const error = new Error("tmux failed");
  expect(
    await runWithDeadline(async () => {
      throw error;
    }, 1_000),
  ).toEqual({ ok: false, timedOut: false, error });
});
