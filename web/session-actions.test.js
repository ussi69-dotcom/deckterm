import { test, expect } from "bun:test";
import { planSessionRowAction } from "./session-actions";

test("locally-open session focuses the existing tab", () => {
  const action = planSessionRowAction(
    { id: "abc", status: "active", sessionStatus: "active" },
    { isLocallyOpen: true },
  );
  expect(action.kind).toBe("focus");
  expect(action.label).toBe("Focus");
  expect(action.statusClass).toBe("active");
});

test("live session that is not open locally attaches", () => {
  const action = planSessionRowAction(
    { id: "abc", status: "active", sessionStatus: "active" },
    { isLocallyOpen: false },
  );
  expect(action.kind).toBe("attach");
  expect(action.label).toBe("Attach");
  expect(action.statusClass).toBe("active");
});

test("scheduled live session is presented as restorable", () => {
  const action = planSessionRowAction(
    {
      id: "abc",
      status: "active",
      sessionStatus: "active",
      terminationScheduledAt: Date.now() + 60_000,
    },
    { isLocallyOpen: false },
  );
  expect(action.kind).toBe("attach");
  expect(action.label).toBe("Restore");
  expect(action.statusClass).toBe("active");
});

test("ended session opens a new terminal in its cwd", () => {
  const action = planSessionRowAction(
    { id: "abc", status: "active", sessionStatus: "ended" },
    { isLocallyOpen: false },
  );
  expect(action.kind).toBe("open-here");
  expect(action.label).toBe("Open here");
  expect(action.statusClass).toBe("ended");
});

test("inactive session opens a new terminal in its cwd", () => {
  const action = planSessionRowAction(
    { id: "abc", status: "inactive", sessionStatus: "active" },
    { isLocallyOpen: false },
  );
  expect(action.kind).toBe("open-here");
  expect(action.label).toBe("Open here");
  expect(action.statusClass).toBe("ended");
});

test("locally-open wins even if the catalog marks it ended", () => {
  // A tab we hold open locally is always focusable; never downgrade to open-here.
  const action = planSessionRowAction(
    { id: "abc", status: "inactive", sessionStatus: "ended" },
    { isLocallyOpen: true },
  );
  expect(action.kind).toBe("focus");
  expect(action.statusClass).toBe("ended");
});

test("missing status fields default to a live (attachable) session", () => {
  const action = planSessionRowAction({ id: "abc" }, { isLocallyOpen: false });
  expect(action.kind).toBe("attach");
  expect(action.statusClass).toBe("active");
});

test("missing options object is treated as not locally open", () => {
  const action = planSessionRowAction({ id: "abc", status: "active" });
  expect(action.kind).toBe("attach");
});

// S3 one-tap resume: an ended row whose agent was alive when it died.
test("ended row with resume data offers Resume", () => {
  const action = planSessionRowAction(
    {
      id: "abc",
      status: "inactive",
      sessionStatus: "ended",
      resume: { agent: "claude", mode: "exact", cwd: "/home/u/proj" },
    },
    { isLocallyOpen: false },
  );
  expect(action.kind).toBe("resume");
  expect(action.label).toBe("Resume");
  expect(action.statusClass).toBe("ended");
  expect(action.agent).toBe("claude");
  expect(action.mode).toBe("exact");
});

test("Codex --last resumes with the plain Resume label", () => {
  const action = planSessionRowAction({
    id: "abc",
    sessionStatus: "ended",
    resume: { agent: "codex", mode: "last", cwd: "/p" },
  });
  expect(action.kind).toBe("resume");
  expect(action.label).toBe("Resume");
});

test("pick mode says the agent's picker opens", () => {
  const action = planSessionRowAction({
    id: "abc",
    sessionStatus: "ended",
    resume: { agent: "codex", mode: "pick", cwd: "/p" },
  });
  expect(action.kind).toBe("resume");
  expect(action.label).toBe("Resume (pick)");
});

test("an unknown resume shape falls back to Open here", () => {
  for (const resume of [
    null,
    { agent: "bash", mode: "exact", cwd: "/p" },
    { agent: "claude", mode: "auto", cwd: "/p" },
    "claude --resume",
  ]) {
    const action = planSessionRowAction({
      id: "abc",
      sessionStatus: "ended",
      resume,
    });
    expect(action.kind).toBe("open-here");
  }
});

test("a live row never becomes Resume", () => {
  const resume = { agent: "claude", mode: "exact", cwd: "/p" };
  expect(
    planSessionRowAction({ id: "abc", sessionStatus: "active", resume }).kind,
  ).toBe("attach");
  expect(
    planSessionRowAction(
      { id: "abc", sessionStatus: "active", resume },
      { isLocallyOpen: true },
    ).kind,
  ).toBe("focus");
});

test("Resume beats Focus on a dead tab that is still open here", () => {
  // After a tmux crash the page keeps the exited tab; focusing it shows a
  // dead terminal, so the row offers the one-tap Resume instead.
  const action = planSessionRowAction(
    {
      id: "abc",
      sessionStatus: "ended",
      resume: { agent: "claude", mode: "exact", cwd: "/p" },
    },
    { isLocallyOpen: true },
  );
  expect(action.kind).toBe("resume");
  expect(action.statusClass).toBe("ended");
});
