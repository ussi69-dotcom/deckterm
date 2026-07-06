import { test, expect, describe } from "bun:test";
import { decideRendererPlan } from "./terminal-renderer.js";

describe("decideRendererPlan", () => {
  test('setting "default" never loads webgl, regardless of probe result', () => {
    expect(decideRendererPlan("default", true)).toEqual({
      loadWebgl: false,
      reason: "setting-default",
    });
    expect(decideRendererPlan("default", false)).toEqual({
      loadWebgl: false,
      reason: "setting-default",
    });
  });

  test('setting "auto" loads webgl when the probe succeeds', () => {
    expect(decideRendererPlan("auto", true)).toEqual({
      loadWebgl: true,
      reason: "auto-probe-ok",
    });
  });

  test('setting "auto" skips webgl when the probe fails', () => {
    expect(decideRendererPlan("auto", false)).toEqual({
      loadWebgl: false,
      reason: "auto-probe-failed",
    });
  });

  test("unknown/missing setting is treated as auto", () => {
    expect(decideRendererPlan(undefined, true)).toEqual({
      loadWebgl: true,
      reason: "auto-probe-ok",
    });
    expect(decideRendererPlan(null, true)).toEqual({
      loadWebgl: true,
      reason: "auto-probe-ok",
    });
    expect(decideRendererPlan("bogus-value", true)).toEqual({
      loadWebgl: true,
      reason: "auto-probe-ok",
    });
    expect(decideRendererPlan("", false)).toEqual({
      loadWebgl: false,
      reason: "auto-probe-failed",
    });
  });

  test("a falsy/undefined probe result is treated as a failed probe", () => {
    expect(decideRendererPlan("auto", undefined)).toEqual({
      loadWebgl: false,
      reason: "auto-probe-failed",
    });
  });
});
