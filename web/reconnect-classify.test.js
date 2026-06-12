import { test, expect } from "bun:test";
import {
  classifyReconnectFailure,
  formatReconnectAttempt,
} from "./reconnect-classify";

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

test("formatReconnectAttempt shows the attempt and a live countdown when known", () => {
  expect(
    formatReconnectAttempt({ attempt: 2, maxRetries: 10, secondsLeft: 4 }),
  ).toBe("Reconnecting... (attempt 2/10, next try in 4s)");
  expect(
    formatReconnectAttempt({ attempt: 2, maxRetries: 10, secondsLeft: 0 }),
  ).toBe("Reconnecting... (attempt 2/10)");
  expect(formatReconnectAttempt({ attempt: 5, maxRetries: 10 })).toBe(
    "Reconnecting... (attempt 5/10)",
  );
});

test("terminal listed in the catalog but ended is gone, not blocked", () => {
  expect(
    classifyReconnectFailure({
      catalogOk: true,
      catalogStatus: 200,
      terminalInCatalog: true,
      terminalEnded: true,
      bootstrapped: false,
    }),
  ).toBe("gone");
  expect(
    classifyReconnectFailure({
      catalogOk: true,
      catalogStatus: 200,
      terminalInCatalog: true,
      terminalEnded: true,
      bootstrapped: true,
    }),
  ).toBe("gone");
});
