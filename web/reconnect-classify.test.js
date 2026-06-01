import { test, expect } from "bun:test";
import { classifyReconnectFailure } from "./reconnect-classify";

test("terminal absent from the catalog is gone (dead)", () => {
  expect(
    classifyReconnectFailure({
      catalogOk: true,
      catalogStatus: 200,
      terminalInCatalog: false,
      bootstrapped: true,
    }),
  ).toBe("gone");
});

test("catalog 401/403 means access is blocked, not a transient drop", () => {
  expect(
    classifyReconnectFailure({
      catalogOk: false,
      catalogStatus: 403,
      terminalInCatalog: false,
      bootstrapped: null,
    }),
  ).toBe("blocked");
  expect(
    classifyReconnectFailure({
      catalogOk: false,
      catalogStatus: 401,
      terminalInCatalog: false,
      bootstrapped: null,
    }),
  ).toBe("blocked");
});

test("terminal present but server not bootstrapped → WS gate blocks permanently", () => {
  expect(
    classifyReconnectFailure({
      catalogOk: true,
      catalogStatus: 200,
      terminalInCatalog: true,
      bootstrapped: false,
    }),
  ).toBe("blocked");
});

test("terminal present and bootstrapped → genuinely transient, keep retrying", () => {
  expect(
    classifyReconnectFailure({
      catalogOk: true,
      catalogStatus: 200,
      terminalInCatalog: true,
      bootstrapped: true,
    }),
  ).toBe("retry");
});

test("unknown bootstrap state with the terminal present keeps retrying", () => {
  // Status probe failed/unknown — don't escalate to blocked on a guess.
  expect(
    classifyReconnectFailure({
      catalogOk: true,
      catalogStatus: 200,
      terminalInCatalog: true,
      bootstrapped: null,
    }),
  ).toBe("retry");
});

test("non-auth catalog error (e.g. 500/0) is treated as transient", () => {
  expect(
    classifyReconnectFailure({
      catalogOk: false,
      catalogStatus: 500,
      terminalInCatalog: false,
      bootstrapped: null,
    }),
  ).toBe("retry");
  expect(
    classifyReconnectFailure({
      catalogOk: false,
      catalogStatus: 0,
      terminalInCatalog: false,
      bootstrapped: null,
    }),
  ).toBe("retry");
});
