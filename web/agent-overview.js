// Agents overview: one pure view model for the desktop Agents panel, the IDE
// "Agents" activity view, the phone summary chip and the Sessions sheet order
// (design docs/plans/2026-10-22-agent-attention-design.md, section 2).
//
// Every session gets a status tier (2.4):
//   0 needs you   agentStatus "blocked"      | fallback: unseen needs-input
//   1 done        "idle" + unseen attention  | fallback: unseen done / error
//   2 working     "working"                  | fallback: running or agentState
//   3 idle        "idle", nothing unseen     | fallback: agent present
//   4 no agent    agentName is null
//   5 resumable   ended row with resume data (slice S3)
//   6 ended       ended row without resume data (Sessions sheet only)
// agentStatus wins when it is not null, so an unseen needs-input whose agent
// has moved on (answered on another device) ranks by its status instead.
// "Unseen" means attention.seq above the seen map's value for that session,
// and the active, visible session is never unseen.
//
// Pure functions plus one small browser-only renderer at the bottom
// (renderAgentList). Unit-tested in agent-overview.test.js.

// Wrapped so its helpers never leak into (or clash with) the other classic
// <script> globals; the public surface is window.AgentOverview.
(function () {
  const TIER_NEEDS_YOU = 0;
  const TIER_DONE = 1;
  const TIER_WORKING = 2;
  const TIER_IDLE = 3;
  const TIER_NO_AGENT = 4;
  const TIER_RESUMABLE = 5;
  const TIER_ENDED = 6;

  // Word label and status icon per tier (rows, chip, Sessions sheet).
  const TIER_LABELS = Object.freeze([
    "Needs you",
    "Done",
    "Working",
    "Idle",
    "Shell",
    "Resume",
    "Ended",
  ]);
  const TIER_ICONS = Object.freeze(["●", "✓", "◐", "○", "·", "↺", "·"]);

  // Tooltip words for the committed screen-rule status (design 1.9).
  const STATUS_WORDS = Object.freeze({
    blocked: "Needs your answer",
    working: "Working",
    idle: "Idle",
  });
  const AGENT_STATUSES = new Set(["working", "blocked", "idle"]);
  const ATTENTION_KINDS = new Set(["needs-input", "done", "error", "info"]);

  const PANEL_MIN_WIDTH = 180;
  const PANEL_MAX_WIDTH = 640;
  const PANEL_DEFAULT_WIDTH = 240;
  const SEEN_MAX_ENTRIES = 200;
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function hasAgent(session) {
    return (
      typeof session?.agentName === "string" &&
      session.agentName.trim().length > 0
    );
  }

  // Same predicate as SessionActions.isSessionLive (and bootstrap reconnect):
  // live and detached rows can be attached, ended rows cannot.
  function isLiveSession(session) {
    return (
      Boolean(session) &&
      session.sessionStatus !== "ended" &&
      session.status !== "inactive"
    );
  }

  function attentionSeq(session) {
    const seq = Number(session?.attention?.seq);
    return Number.isFinite(seq) && seq > 0 ? seq : 0;
  }

  // The kind of the session's unseen attention, or null.
  function unseenAttentionKind(session, seenMap, activeVisibleId) {
    const kind = session?.attention?.kind;
    if (!ATTENTION_KINDS.has(kind)) return null;
    if (activeVisibleId && session.id === activeVisibleId) return null;
    const seen = Number((seenMap || {})[session.id]) || 0;
    return attentionSeq(session) > seen ? kind : null;
  }

  function statusTier(session, seenMap = {}, { activeVisibleId = null } = {}) {
    if (!session) return TIER_ENDED;
    if (!isLiveSession(session)) {
      return session.resume ? TIER_RESUMABLE : TIER_ENDED;
    }
    const unseen = unseenAttentionKind(session, seenMap, activeVisibleId);
    const status = session.agentStatus;
    if (hasAgent(session) && AGENT_STATUSES.has(status)) {
      if (status === "blocked") return TIER_NEEDS_YOU;
      if (status === "working") return TIER_WORKING;
      return unseen === "done" || unseen === "error" || unseen === "needs-input"
        ? TIER_DONE
        : TIER_IDLE;
    }
    if (unseen === "needs-input") return TIER_NEEDS_YOU;
    if (unseen === "done" || unseen === "error") return TIER_DONE;
    // "Working" is about agents: a shell running a dev server or a build
    // without an agent stays a plain shell row and is not counted.
    if (!hasAgent(session)) return TIER_NO_AGENT;
    const agentState = String(session.agentState || "").toLowerCase();
    if (
      session.running === true ||
      agentState === "thinking" ||
      agentState === "responding"
    ) {
      return TIER_WORKING;
    }
    return TIER_IDLE;
  }

  function finiteOrZero(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  // Most recent change first: agentStatusChangedAt, then attention.at, then
  // lastActivityAt.
  function compareRecency(a, b) {
    const keys = [
      (s) => finiteOrZero(s?.agentStatusChangedAt),
      (s) => finiteOrZero(s?.attention?.at),
      (s) => finiteOrZero(s?.lastActivityAt),
    ];
    for (const key of keys) {
      const diff = key(b) - key(a);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  // Comparator over sessions (tier, then recency). Stable when used through
  // orderSessions, which falls back to the original index.
  function compareSessions(a, b, seenMap = {}, options = {}) {
    return (
      statusTier(a, seenMap, options) - statusTier(b, seenMap, options) ||
      compareRecency(a, b)
    );
  }

  function orderSessions(sessions, seenMap = {}, options = {}) {
    return (Array.isArray(sessions) ? sessions : [])
      .filter(Boolean)
      .map((session, index) => ({
        session,
        index,
        tier: statusTier(session, seenMap, options),
      }))
      .sort(
        (a, b) =>
          a.tier - b.tier ||
          compareRecency(a.session, b.session) ||
          a.index - b.index,
      )
      .map((entry) => entry.session);
  }

  function trimPath(path) {
    const value = String(path || "").trim();
    if (!value) return "";
    const trimmed = value.replace(/\/+$/, "");
    return trimmed || "/";
  }

  function lastPathSegment(path) {
    const trimmed = trimPath(path);
    if (!trimmed) return "";
    if (trimmed === "/") return "/";
    const parts = trimmed.split("/");
    return parts[parts.length - 1] || trimmed;
  }

  function groupKeyFor(session) {
    return trimPath(session?.projectRoot) || trimPath(session?.cwd) || "";
  }

  // Panel groups: live and detached sessions grouped by project (git top
  // level, else cwd), groups ordered by their best row, rows by tier. Ended
  // rows are left out except resumable ones, which form a "Resume" group at
  // the bottom.
  function groupSessions(sessions, seenMap = {}, options = {}) {
    const ordered = orderSessions(sessions, seenMap, options);
    const groups = [];
    const byKey = new Map();
    const resume = [];
    for (const session of ordered) {
      const tier = statusTier(session, seenMap, options);
      if (tier === TIER_ENDED) continue;
      if (tier === TIER_RESUMABLE) {
        resume.push({ session, tier });
        continue;
      }
      const key = groupKeyFor(session);
      let group = byKey.get(key);
      if (!group) {
        group = {
          key,
          label: lastPathSegment(key) || "Other",
          path: key,
          bestTier: tier,
          rows: [],
          resume: false,
        };
        byKey.set(key, group);
        groups.push(group);
      }
      group.rows.push({ session, tier });
    }
    if (resume.length) {
      groups.push({
        key: "__resume__",
        label: "Resume",
        path: "",
        bestTier: TIER_RESUMABLE,
        rows: resume,
        resume: true,
      });
    }
    return groups;
  }

  function summaryCounts(sessions, seenMap = {}, options = {}) {
    const counts = { needsYou: 0, done: 0, working: 0, idle: 0, agents: 0 };
    for (const session of Array.isArray(sessions) ? sessions : []) {
      if (!session || !isLiveSession(session)) continue;
      if (hasAgent(session)) counts.agents += 1;
      const tier = statusTier(session, seenMap, options);
      if (tier === TIER_NEEDS_YOU) counts.needsYou += 1;
      else if (tier === TIER_DONE) counts.done += 1;
      else if (tier === TIER_WORKING) counts.working += 1;
      else if (tier === TIER_IDLE) counts.idle += 1;
    }
    return counts;
  }

  // Desktop: "1 needs you · 2 done · 1 working" (zero counts left out),
  // "All agents idle" or "No agents running". Phone: symbols and counts
  // ("● 1 · ✓ 2 · ◐ 1") with the words in `label` (aria-label and title).
  function summaryText(counts, variant = "desktop") {
    const c = counts || {};
    const parts = [
      [c.needsYou, "needs you", TIER_ICONS[TIER_NEEDS_YOU]],
      [c.done, "done", TIER_ICONS[TIER_DONE]],
      [c.working, "working", TIER_ICONS[TIER_WORKING]],
    ].filter(([count]) => Number(count) > 0);
    const empty = c.agents > 0 ? "All agents idle" : "No agents running";
    const label = parts.length
      ? parts.map(([count, word]) => `${count} ${word}`).join(" · ")
      : empty;
    if (variant !== "phone") return { text: label, label };
    const text = parts.length
      ? parts.map(([count, , icon]) => `${icon} ${count}`).join(" · ")
      : "All idle";
    return { text, label: parts.length ? `Agents: ${label}` : empty };
  }

  // "Next": the first session in sort order that needs you or is done and
  // unseen, skipping the active, visible one. null = nothing to visit.
  function nextTarget(sessions, seenMap = {}, options = {}) {
    const activeVisibleId = options.activeVisibleId || null;
    for (const session of orderSessions(sessions, seenMap, options)) {
      const tier = statusTier(session, seenMap, options);
      if (tier > TIER_DONE) return null;
      if (session.id && session.id !== activeVisibleId) return session;
    }
    return null;
  }

  // IDE sidebar sash contract: 180 px .. min(640, floor(50% of the window)).
  function clampPanelWidth(px, innerWidth) {
    const width = Number(innerWidth) > 0 ? Number(innerWidth) : 1280;
    const max = Math.max(
      PANEL_MIN_WIDTH,
      Math.min(PANEL_MAX_WIDTH, Math.floor(width * 0.5)),
    );
    const value = Number.isFinite(Number(px)) ? Number(px) : PANEL_DEFAULT_WIDTH;
    return Math.min(Math.max(Math.round(value), PANEL_MIN_WIDTH), max);
  }

  // A stored agents.panelWidth that is not a finite positive number counts as
  // absent (null = the CSS default).
  function storedPanelWidth(value) {
    const n = typeof value === "number" ? value : Number.NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  // Row tooltip: "Needs your answer · rule live_blocked_form
  // (claude@2026.10.11.1)". Without a screen-rule status it names the tier and
  // where it came from. Never screen text.
  function tooltipFor(session, tier = null) {
    const status = session?.agentStatus;
    if (hasAgent(session) && AGENT_STATUSES.has(status)) {
      const word = STATUS_WORDS[status];
      const rule =
        typeof session.agentStatusRule === "string" && session.agentStatusRule
          ? ` · rule ${session.agentStatusRule}`
          : "";
      const version =
        rule &&
        typeof session.agentRulesVersion === "string" &&
        session.agentRulesVersion
          ? ` (${session.agentRulesVersion})`
          : "";
      const done =
        status === "idle" && tier === TIER_DONE ? "Done, not seen yet · " : "";
      return `${done}${word}${rule}${version}`;
    }
    const resolvedTier = Number.isInteger(tier) ? tier : statusTier(session);
    const word =
      resolvedTier === TIER_NEEDS_YOU
        ? "Needs your answer"
        : resolvedTier === TIER_DONE
          ? session?.attention?.kind === "error"
            ? "Reported an error"
            : "Finished"
          : TIER_LABELS[resolvedTier] || "";
    const fromNotification =
      (resolvedTier === TIER_NEEDS_YOU || resolvedTier === TIER_DONE) &&
      session?.attention?.kind
        ? " · from the agent's notification"
        : "";
    return `${word}${fromNotification}`;
  }

  // --- Seen map (attention.seen) ---------------------------------------------

  // { id: seq } with only finite positive numbers under non-empty short keys.
  function sanitizeSeenMap(value) {
    const out = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return out;
    for (const [id, raw] of Object.entries(value)) {
      if (!id || id.length > 64) continue;
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) continue;
      out[id] = raw;
    }
    return out;
  }

  // Keep the `max` highest seq values (the server keeps the same bound).
  function capSeenMap(map, max = SEEN_MAX_ENTRIES) {
    const entries = Object.entries(map || {});
    if (entries.length <= max) return { ...map };
    entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    return Object.fromEntries(entries.slice(0, max));
  }

  // Per-id max of two seen maps, invalid entries dropped, bounded.
  function mergeSeenMaps(a, b) {
    const out = sanitizeSeenMap(a);
    for (const [id, seq] of Object.entries(sanitizeSeenMap(b))) {
      if (!(out[id] >= seq)) out[id] = seq;
    }
    return capSeenMap(out);
  }

  // A terminal id from a deep link or a service-worker message, or null.
  function sessionIdFromDeepLink(value) {
    const id = typeof value === "string" ? value.trim() : "";
    return UUID_RE.test(id) ? id : null;
  }

  // --- Browser-only renderer -------------------------------------------------

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // HTML for the panel body (also used by the IDE view): counts on top, the
  // Next button, then the groups. `getTitle(session)` and `getAge(session)`
  // come from TaskSignals in the browser.
  function renderAgentListHtml(sessions, seenMap, options = {}) {
    const {
      activeVisibleId = null,
      getTitle = (s) => s?.name || lastPathSegment(s?.cwd) || "Terminal",
      getAge = () => "",
    } = options;
    const opts = { activeVisibleId };
    const counts = summaryCounts(sessions, seenMap, opts);
    const summary = summaryText(counts, "desktop");
    const next = nextTarget(sessions, seenMap, opts);
    const groups = groupSessions(sessions, seenMap, opts);
    const nextTitle = next
      ? `Go to ${getTitle(next)} (${TIER_LABELS[statusTier(next, seenMap, opts)].toLowerCase()})`
      : "Nothing needs you";
    const head = `<div class="agents-panel-head">
  <div class="agents-summary" data-needs-you="${counts.needsYou}" data-done="${counts.done}" data-working="${counts.working}">${escapeHtml(summary.text)}</div>
  <button type="button" class="agents-next-btn" data-agents-next ${next ? "" : "disabled"} title="${escapeHtml(nextTitle)}" aria-label="${escapeHtml(next ? `Next: ${nextTitle}` : `Next agent: ${nextTitle}`)}">Next</button>
</div>`;
    if (!groups.length) {
      return `${head}<div class="agents-empty">No sessions yet.</div>`;
    }
    const body = groups
      .map((group) => {
        const rows = group.rows
          .map(({ session, tier }) => {
            const title = getTitle(session);
            const age = getAge(session);
            const meta = [hasAgent(session) ? session.agentName : "", age]
              .filter(Boolean)
              .join(" · ");
            const active = session.id === activeVisibleId;
            return `<button type="button" class="agents-row${active ? " active" : ""}" data-agent-session-id="${escapeHtml(session.id)}" data-tier="${tier}" title="${escapeHtml(tooltipFor(session, tier))}">
  <span class="agents-row-status" data-tier="${tier}"><span class="agents-row-icon" aria-hidden="true">${TIER_ICONS[tier]}</span><span class="agents-row-word">${escapeHtml(TIER_LABELS[tier])}</span></span>
  <span class="agents-row-title">${escapeHtml(title)}</span>
  ${meta ? `<span class="agents-row-meta">${escapeHtml(meta)}</span>` : ""}
</button>`;
          })
          .join("");
        return `<section class="agents-group" data-group-key="${escapeHtml(group.key)}">
  <h4 class="agents-group-title" title="${escapeHtml(group.path || group.label)}"><span class="agents-group-name">${escapeHtml(group.label)}</span><span class="agents-group-count">${group.rows.length}</span></h4>
  ${rows}
</section>`;
      })
      .join("");
    return `${head}<div class="agents-groups">${body}</div>`;
  }

  const AgentOverview = {
    TIER_NEEDS_YOU,
    TIER_DONE,
    TIER_WORKING,
    TIER_IDLE,
    TIER_NO_AGENT,
    TIER_RESUMABLE,
    TIER_ENDED,
    TIER_LABELS,
    TIER_ICONS,
    PANEL_MIN_WIDTH,
    PANEL_MAX_WIDTH,
    PANEL_DEFAULT_WIDTH,
    SEEN_MAX_ENTRIES,
    isLiveSession,
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
  };

  if (typeof window !== "undefined") {
    window.AgentOverview = AgentOverview;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = AgentOverview;
  }
})();
