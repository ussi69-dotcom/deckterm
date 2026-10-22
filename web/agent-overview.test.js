import { test, expect, describe } from "bun:test";
import {
  TIER_NEEDS_YOU,
  TIER_DONE,
  TIER_WORKING,
  TIER_IDLE,
  TIER_NO_AGENT,
  TIER_RESUMABLE,
  TIER_ENDED,
  statusTier,
  compareSessions,
  orderSessions,
  groupSessions,
  summaryCounts,
  summaryText,
  nextTarget,
  clampPanelWidth,
  storedPanelWidth,
  tooltipFor,
  sanitizeSeenMap,
  mergeSeenMaps,
  sessionIdFromDeepLink,
  renderAgentListHtml,
  showSummaryChip,
  focusKeyOf,
  pickFocusIndex,
} from "./agent-overview";

const att = (kind, seq) => ({ kind, seq, at: seq, title: "", body: "" });
const live = (extra) => ({ status: "active", sessionStatus: "active", ...extra });
const agent = (id, extra = {}) =>
  live({ id, agentName: "claude", cwd: "/w/app", ...extra });

describe("statusTier with agentStatus (screen rules)", () => {
  test("blocked needs you, working works, idle is idle", () => {
    expect(statusTier(agent("a", { agentStatus: "blocked" }))).toBe(
      TIER_NEEDS_YOU,
    );
    expect(statusTier(agent("a", { agentStatus: "working" }))).toBe(
      TIER_WORKING,
    );
    expect(statusTier(agent("a", { agentStatus: "idle" }))).toBe(TIER_IDLE);
  });

  test("idle with an unseen done, error or needs-input is done", () => {
    for (const kind of ["done", "error", "needs-input"]) {
      expect(
        statusTier(agent("a", { agentStatus: "idle", attention: att(kind, 5) })),
      ).toBe(TIER_DONE);
    }
    // Seen: plain idle again.
    expect(
      statusTier(
        agent("a", { agentStatus: "idle", attention: att("done", 5) }),
        { a: 5 },
      ),
    ).toBe(TIER_IDLE);
  });

  test("a stale needs-input ranks by the status instead", () => {
    // Answered on another device: the agent works again.
    expect(
      statusTier(
        agent("a", { agentStatus: "working", attention: att("needs-input", 9) }),
      ),
    ).toBe(TIER_WORKING);
    // ... or finished: unseen, so done rather than needs you.
    expect(
      statusTier(
        agent("a", { agentStatus: "idle", attention: att("needs-input", 9) }),
      ),
    ).toBe(TIER_DONE);
  });

  test("blocked stays needs you even when its attention was seen", () => {
    expect(
      statusTier(
        agent("a", { agentStatus: "blocked", attention: att("needs-input", 3) }),
        { a: 3 },
      ),
    ).toBe(TIER_NEEDS_YOU);
  });
});

describe("statusTier fallback (agentStatus null)", () => {
  test("unseen needs-input needs you, unseen done or error is done", () => {
    expect(statusTier(agent("a", { attention: att("needs-input", 2) }))).toBe(
      TIER_NEEDS_YOU,
    );
    expect(statusTier(agent("a", { attention: att("done", 2) }))).toBe(
      TIER_DONE,
    );
    expect(statusTier(agent("a", { attention: att("error", 2) }))).toBe(
      TIER_DONE,
    );
  });

  test("running or a live agentState is working, for agents only", () => {
    expect(statusTier(agent("a", { running: true }))).toBe(TIER_WORKING);
    // A dev server or a build without an agent stays a plain shell row.
    expect(statusTier(live({ id: "a", running: true }))).toBe(TIER_NO_AGENT);
    expect(statusTier(agent("a", { agentState: "thinking" }))).toBe(
      TIER_WORKING,
    );
    expect(statusTier(agent("a", { agentState: "responding" }))).toBe(
      TIER_WORKING,
    );
  });

  test("an agent with nothing to report is idle; no agent is tier 4", () => {
    expect(statusTier(agent("a"))).toBe(TIER_IDLE);
    expect(statusTier(live({ id: "a" }))).toBe(TIER_NO_AGENT);
    expect(statusTier(live({ id: "a", attention: att("info", 4) }))).toBe(
      TIER_NO_AGENT,
    );
  });

  test("the active, visible session is never unseen", () => {
    const s = agent("a", { attention: att("needs-input", 2) });
    expect(statusTier(s, {}, { activeVisibleId: "a" })).toBe(TIER_IDLE);
    expect(statusTier(s, {}, { activeVisibleId: "b" })).toBe(TIER_NEEDS_YOU);
  });

  test("ended rows: resumable is tier 5, others tier 6", () => {
    expect(
      statusTier({ id: "e", status: "inactive", sessionStatus: "ended" }),
    ).toBe(TIER_ENDED);
    expect(
      statusTier({
        id: "e",
        status: "inactive",
        sessionStatus: "ended",
        resume: { agent: "claude", mode: "exact", cwd: "/w" },
      }),
    ).toBe(TIER_RESUMABLE);
    // A detached (live, not open here) row is not ended.
    expect(
      statusTier({ id: "d", status: "detached", sessionStatus: "active" }),
    ).toBe(TIER_NO_AGENT);
  });
});

describe("ordering", () => {
  test("needs you > done > working > idle > no agent", () => {
    const sessions = [
      live({ id: "shell" }),
      agent("idle"),
      agent("work", { agentStatus: "working" }),
      agent("done", { agentStatus: "idle", attention: att("done", 3) }),
      agent("ask", { agentStatus: "blocked" }),
    ];
    expect(orderSessions(sessions).map((s) => s.id)).toEqual([
      "ask",
      "done",
      "work",
      "idle",
      "shell",
    ]);
  });

  test("ties go to agentStatusChangedAt, then attention.at, then lastActivityAt", () => {
    const a = agent("a", { agentStatus: "working", agentStatusChangedAt: 100 });
    const b = agent("b", { agentStatus: "working", agentStatusChangedAt: 200 });
    expect(orderSessions([a, b]).map((s) => s.id)).toEqual(["b", "a"]);

    const c = agent("c", { attention: att("done", 50) });
    const d = agent("d", { attention: att("done", 70) });
    expect(orderSessions([c, d]).map((s) => s.id)).toEqual(["d", "c"]);

    const e = live({ id: "e", lastActivityAt: 10 });
    const f = live({ id: "f", lastActivityAt: 20 });
    expect(orderSessions([e, f]).map((s) => s.id)).toEqual(["f", "e"]);

    // Full tie keeps the input order.
    const g = live({ id: "g" });
    const h = live({ id: "h" });
    expect(orderSessions([g, h]).map((s) => s.id)).toEqual(["g", "h"]);
    expect(compareSessions(g, h)).toBe(0);
  });
});

describe("groupSessions", () => {
  test("groups by projectRoot, else cwd; groups ordered by their best row", () => {
    const sessions = [
      agent("x1", { cwd: "/w/app/src", projectRoot: "/w/app" }),
      agent("y1", { cwd: "/tmp/scratch", agentStatus: "blocked" }),
      agent("x2", {
        cwd: "/w/app",
        projectRoot: "/w/app",
        agentStatus: "working",
      }),
      { id: "gone", status: "inactive", sessionStatus: "ended", cwd: "/w/app" },
    ];
    const groups = groupSessions(sessions);
    expect(groups.map((g) => [g.label, g.path, g.rows.map((r) => r.session.id)])).toEqual([
      ["scratch", "/tmp/scratch", ["y1"]],
      ["app", "/w/app", ["x2", "x1"]],
    ]);
    expect(groups[0].bestTier).toBe(TIER_NEEDS_YOU);
  });

  test("resumable ended rows form a Resume group at the bottom", () => {
    const groups = groupSessions([
      {
        id: "r",
        status: "inactive",
        sessionStatus: "ended",
        cwd: "/w",
        resume: { agent: "claude" },
      },
      live({ id: "s", cwd: "/w" }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["w", "Resume"]);
    expect(groups[1].resume).toBe(true);
  });

  test("a session without a path lands in Other", () => {
    expect(groupSessions([live({ id: "s" })])[0].label).toBe("Other");
  });
});

describe("counts and summary text", () => {
  const sessions = [
    agent("a", { agentStatus: "blocked" }),
    agent("b", { agentStatus: "idle", attention: att("done", 2) }),
    agent("c", { agentStatus: "idle", attention: att("done", 3) }),
    agent("d", { agentStatus: "working" }),
    agent("e", { agentStatus: "idle" }),
    live({ id: "f" }),
    { id: "g", status: "inactive", sessionStatus: "ended", agentName: "claude" },
  ];

  test("summaryCounts counts live sessions by tier", () => {
    expect(summaryCounts(sessions)).toEqual({
      needsYou: 1,
      done: 2,
      working: 1,
      idle: 1,
      agents: 5,
    });
  });

  test("desktop words leave zero counts out", () => {
    expect(summaryText(summaryCounts(sessions)).text).toBe(
      "1 needs you · 2 done · 1 working",
    );
    expect(
      summaryText({ needsYou: 0, done: 1, working: 0, idle: 0, agents: 1 })
        .text,
    ).toBe("1 done");
  });

  test("nothing to report: all agents idle, or no agents running", () => {
    expect(summaryText(summaryCounts([agent("a")])).text).toBe(
      "All agents idle",
    );
    expect(summaryText(summaryCounts([live({ id: "s" })])).text).toBe(
      "No agents running",
    );
    expect(summaryText(summaryCounts([])).text).toBe("No agents running");
  });

  test("phone symbols with the words in the label", () => {
    const phone = summaryText(summaryCounts(sessions), "phone");
    expect(phone.text).toBe("● 1 · ✓ 2 · ◐ 1");
    expect(phone.label).toBe("Agents: 1 needs you · 2 done · 1 working");
    const idle = summaryText(summaryCounts([agent("a")]), "phone");
    expect(idle.text).toBe("All idle");
    expect(idle.label).toBe("All agents idle");
  });
});

describe("nextTarget", () => {
  const ask = agent("ask", { agentStatus: "blocked" });
  const done = agent("done", { agentStatus: "idle", attention: att("done", 4) });
  const work = agent("work", { agentStatus: "working" });

  test("needs you first, then done", () => {
    expect(nextTarget([work, done, ask])?.id).toBe("ask");
  });

  test("skips the active, visible session", () => {
    expect(
      nextTarget([work, done, ask], {}, { activeVisibleId: "ask" })?.id,
    ).toBe("done");
  });

  test("visiting a done session marks it seen, so Next moves on", () => {
    expect(
      nextTarget([work, done], { done: 4 }, { activeVisibleId: null }),
    ).toBe(null);
  });

  test("null (disabled) when nothing needs you", () => {
    expect(nextTarget([work, agent("idle", { agentStatus: "idle" })])).toBe(
      null,
    );
    expect(nextTarget([ask], {}, { activeVisibleId: "ask" })).toBe(null);
    expect(nextTarget([])).toBe(null);
  });
});

describe("clampPanelWidth", () => {
  test("bounds at 768, 1280 and 2560 px windows", () => {
    expect(clampPanelWidth(100, 768)).toBe(180);
    expect(clampPanelWidth(500, 768)).toBe(384);
    expect(clampPanelWidth(300, 768)).toBe(300);
    expect(clampPanelWidth(900, 1280)).toBe(640);
    expect(clampPanelWidth(639.6, 1280)).toBe(640);
    expect(clampPanelWidth(900, 2560)).toBe(640);
    expect(clampPanelWidth(120, 2560)).toBe(180);
  });

  test("never below the 180 px floor, even in a tiny window", () => {
    expect(clampPanelWidth(300, 300)).toBe(180);
  });

  test("a non-number falls back to the 240 px default", () => {
    expect(clampPanelWidth(Number.NaN, 1440)).toBe(240);
  });

  test("storedPanelWidth: only a finite positive number counts", () => {
    expect(storedPanelWidth(320)).toBe(320);
    for (const bad of [null, undefined, 0, -5, "300", Number.NaN, Infinity]) {
      expect(storedPanelWidth(bad)).toBe(null);
    }
  });
});

describe("tooltipFor", () => {
  test("names the rule and the manifest version (design 1.9)", () => {
    expect(
      tooltipFor(
        agent("a", {
          agentStatus: "blocked",
          agentStatusRule: "live_blocked_form",
          agentRulesVersion: "claude@2026.10.11.1",
        }),
      ),
    ).toBe("Needs your answer · rule live_blocked_form (claude@2026.10.11.1)");
  });

  test("without a screen-rule status it says where the tier came from", () => {
    expect(tooltipFor(agent("a", { attention: att("needs-input", 2) }))).toBe(
      "Needs your answer · from the agent's notification",
    );
    expect(tooltipFor(agent("a", { agentState: "thinking" }))).toBe("Working");
  });
});

describe("seen map", () => {
  test("sanitize drops invalid entries", () => {
    expect(
      sanitizeSeenMap({ a: 3, b: "4", c: -1, d: 0, e: Number.NaN, f: 5 }),
    ).toEqual({ a: 3, f: 5 });
    expect(sanitizeSeenMap(null)).toEqual({});
    expect(sanitizeSeenMap([1, 2])).toEqual({});
  });

  test("merge keeps the per-id max and at most 200 entries", () => {
    expect(mergeSeenMaps({ a: 5, b: 2 }, { a: 3, b: 9, c: 1 })).toEqual({
      a: 5,
      b: 9,
      c: 1,
    });
    const big = {};
    for (let i = 1; i <= 250; i += 1) big[`id-${i}`] = i;
    const merged = mergeSeenMaps(big, {});
    expect(Object.keys(merged)).toHaveLength(200);
    expect(merged["id-250"]).toBe(250);
    expect(merged["id-50"]).toBeUndefined();
  });
});

test("sessionIdFromDeepLink accepts only a UUID", () => {
  const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
  expect(sessionIdFromDeepLink(id)).toBe(id);
  expect(sessionIdFromDeepLink(` ${id} `)).toBe(id);
  for (const bad of ["", "abc", "../x", `${id};x`, null, 5]) {
    expect(sessionIdFromDeepLink(bad)).toBe(null);
  }
});

test("renderAgentListHtml: counts, Next, groups and escaped rows", () => {
  const html = renderAgentListHtml(
    [
      agent("ask", { agentStatus: "blocked", name: "<b>x</b>" }),
      agent("w", { agentStatus: "working" }),
    ],
    {},
    { getTitle: (s) => s.name || s.id },
  );
  expect(html).toContain("1 needs you · 1 working");
  expect(html).toContain('data-agents-next ');
  expect(html).not.toContain("data-agents-next disabled");
  expect(html).toContain('data-agent-session-id="ask"');
  expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  expect(html).not.toContain("<b>x</b>");
  expect(html).toContain(">Needs you<");

  const none = renderAgentListHtml([agent("w", { agentStatus: "working" })], {});
  expect(none).toContain("data-agents-next disabled");
  expect(none).toContain('title="Nothing needs you"');
});

describe("showSummaryChip (phone)", () => {
  test("shown while an agent runs, hidden with nothing to say", () => {
    expect(showSummaryChip({ agents: 1, needsYou: 0, done: 0 })).toBe(true);
    expect(showSummaryChip({ agents: 0, needsYou: 0, done: 0 })).toBe(false);
    expect(showSummaryChip(null)).toBe(false);
  });

  test("an unseen done or needs-input of a session without an agent shows it", () => {
    // A plain shell whose command finished: listed in the Sessions sheet as
    // done, so the chip must not hide it.
    const shellDone = live({
      id: "s",
      cwd: "/w",
      attention: att("done", 4),
    });
    const counts = summaryCounts([shellDone], {});
    expect(counts.agents).toBe(0);
    expect(counts.done).toBe(1);
    expect(showSummaryChip(counts)).toBe(true);

    const shellAsks = live({
      id: "q",
      cwd: "/w",
      attention: att("needs-input", 2),
    });
    const asks = summaryCounts([shellAsks], {});
    expect(asks.needsYou).toBe(1);
    expect(showSummaryChip(asks)).toBe(true);
    // Seen: nothing left to say.
    expect(showSummaryChip(summaryCounts([shellAsks], { q: 2 }))).toBe(false);
  });
});

describe("focus keeping across a re-render", () => {
  test("a key is the data-* attributes without the tier", () => {
    expect(focusKeyOf({ agentSessionId: "a", tier: "0" })).toBe(
      "agentSessionId=a",
    );
    expect(focusKeyOf({ agentSessionId: "a", tier: "2" })).toBe(
      focusKeyOf({ tier: "0", agentSessionId: "a" }),
    );
    expect(focusKeyOf({ agentsNext: "" })).toBe("agentsNext=");
    // Row and an action button of the same session differ by role.
    expect(focusKeyOf({ agentSessionId: "a" })).not.toBe(
      focusKeyOf({ agentSessionId: "a", agentAction: "resume" }),
    );
    expect(focusKeyOf({})).toBeNull();
    expect(focusKeyOf(null)).toBeNull();
  });

  test("the same session and role keeps focus when rows reorder", () => {
    const before = ["agentsNext=", "agentSessionId=a", "agentSessionId=b"];
    const after = ["agentsNext=", "agentSessionId=b", "agentSessionId=a"];
    expect(pickFocusIndex(before, "agentSessionId=a", after)).toBe(2);
    expect(pickFocusIndex(before, "agentsNext=", after)).toBe(0);
  });

  test("a removed element hands focus to the one at its old position", () => {
    const before = ["agentsNext=", "agentSessionId=a", "agentSessionId=b"];
    expect(
      pickFocusIndex(before, "agentSessionId=a", ["agentsNext=", "agentSessionId=b"]),
    ).toBe(1);
    // The last one removed: clamped to the new end.
    expect(
      pickFocusIndex(before, "agentSessionId=b", ["agentsNext=", "agentSessionId=a"]),
    ).toBe(1);
  });

  test("nothing to restore", () => {
    expect(pickFocusIndex(["x"], null, ["x"])).toBe(-1);
    expect(pickFocusIndex(["x"], "x", [])).toBe(-1);
    expect(pickFocusIndex([], "gone", ["y"])).toBe(-1);
  });

  test("rendered rows and Next carry stable keys", () => {
    const sessions = [agent("a", { agentStatus: "blocked" })];
    const html = renderAgentListHtml(sessions, {});
    expect(html).toContain('data-agent-session-id="a"');
    expect(html).toContain("data-agents-next");
    // The same model renders the same HTML (the app skips the DOM write).
    expect(renderAgentListHtml(sessions, {})).toBe(html);
  });
});
