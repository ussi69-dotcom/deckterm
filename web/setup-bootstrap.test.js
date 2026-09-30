import { expect, test } from "bun:test";
import { buildBootstrapRequest, planBootstrapAction } from "./setup-bootstrap";

test("no action once bootstrapped, or when status is unknown", () => {
  expect(planBootstrapAction({ bootstrapped: true, mode: "token" })).toBeNull();
  expect(planBootstrapAction(null)).toBeNull();
  expect(planBootstrapAction(undefined)).toBeNull();
  expect(planBootstrapAction({ mode: "token" })).toBeNull();
});

test("env_admin mode → one-click finish naming the expected identity", () => {
  expect(
    planBootstrapAction({
      bootstrapped: false,
      mode: "env_admin",
      expectedEmail: "owner@example.com",
    }),
  ).toEqual({
    label: "Finish setup",
    needsToken: false,
    hint: "Signs in owner@example.com as the first owner.",
  });
});

test("token mode → token field plus where to find the token and its TTL", () => {
  const plan = planBootstrapAction({
    bootstrapped: false,
    mode: "token",
    tokenPath: "/srv/deckterm/state/bootstrap-token",
  });
  expect(plan.needsToken).toBe(true);
  expect(plan.hint).toContain("/srv/deckterm/state/bootstrap-token");
  expect(plan.hint).toContain("1 hour");
});

test("token mode without a known path falls back to the documented default", () => {
  const plan = planBootstrapAction({ bootstrapped: false, mode: "token" });
  expect(plan.hint).toContain("$DECKTERM_STATE_DIR/bootstrap-token");
});

test("request body carries a trimmed token or nothing", () => {
  expect(buildBootstrapRequest("  abc123 \n")).toEqual({ token: "abc123" });
  expect(buildBootstrapRequest("")).toEqual({});
  expect(buildBootstrapRequest(undefined)).toEqual({});
});
