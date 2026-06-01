import { test, expect } from "bun:test";
import { formatGitError, formatGitCheckoutError } from "./git-error";

test("formatGitCheckoutError surfaces the git stderr reason", () => {
  expect(
    formatGitCheckoutError({
      error: "Checkout failed",
      message:
        "error: Your local changes to the following files would be overwritten",
    }),
  ).toBe(
    "Checkout failed: error: Your local changes to the following files would be overwritten",
  );
});

test("formatGitCheckoutError falls back to the error when no stderr is present", () => {
  expect(formatGitCheckoutError({ error: "Checkout failed" })).toBe(
    "Checkout failed",
  );
});

test("formatGitCheckoutError uses a default for an empty payload", () => {
  expect(formatGitCheckoutError({})).toBe("Checkout failed");
  expect(formatGitCheckoutError(null)).toBe("Checkout failed");
});

test("formatGitCheckoutError does not duplicate when stderr equals the error", () => {
  expect(
    formatGitCheckoutError({
      error: "Checkout failed",
      message: "Checkout failed",
    }),
  ).toBe("Checkout failed");
});

test("formatGitCheckoutError ignores whitespace-only stderr", () => {
  expect(
    formatGitCheckoutError({ error: "Checkout failed", message: "  \n  " }),
  ).toBe("Checkout failed");
});

test("formatGitError surfaces the commit reason from the message", () => {
  expect(
    formatGitError(
      {
        error: "Commit failed",
        message: 'nothing to commit (use "git add" to track)',
      },
      "Commit failed",
    ),
  ).toBe('Commit failed: nothing to commit (use "git add" to track)');
});

test("formatGitError uses the provided fallback for an empty payload", () => {
  expect(formatGitError({}, "Commit failed")).toBe("Commit failed");
  expect(formatGitError(null, "Stage failed")).toBe("Stage failed");
});

test("formatGitError defaults the fallback when none is given", () => {
  expect(formatGitError({})).toBe("Git operation failed");
});
