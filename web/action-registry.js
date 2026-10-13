const ACTION_GROUP_ORDER = {
  Actions: 1,
  Workspaces: 2,
  Views: 3,
  Contextual: 4,
  Other: 5,
};

function normalizeText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizeKeywords(keywords) {
  if (!Array.isArray(keywords)) return [];
  return keywords.map((keyword) => normalizeText(keyword)).filter(Boolean);
}

function groupRank(group) {
  return ACTION_GROUP_ORDER[group] || ACTION_GROUP_ORDER.Other;
}

function prepareAction(action, order) {
  if (!action?.id || typeof action.run !== "function") return null;
  return {
    id: String(action.id),
    title: String(action.title || action.id),
    group: String(action.group || "Other"),
    keywords: normalizeKeywords(action.keywords),
    meta: action.meta ?? null,
    // Display-only metadata for palette rows: a lucide icon name and the
    // shortcut label of an existing global keybinding (never bound here).
    icon: typeof action.icon === "string" && action.icon ? action.icon : null,
    keybinding:
      typeof action.keybinding === "string" && action.keybinding
        ? action.keybinding
        : null,
    // One plain line on what the action does; shown muted under/after the title.
    description:
      typeof action.description === "string" && action.description.trim()
        ? action.description.trim()
        : null,
    priority: Number.isFinite(action.priority) ? action.priority : 0,
    order,
    run: action.run,
  };
}

function scoreActionMatch(action, normalizedQuery) {
  if (!normalizedQuery) return 0;

  const normalizedTitle = normalizeText(action.title);
  const normalizedGroup = normalizeText(action.group);
  const keywords = normalizeKeywords(action.keywords);

  if (normalizedTitle === normalizedQuery) return 0;
  if (keywords.includes(normalizedQuery)) return 1;
  if (normalizedTitle.startsWith(normalizedQuery)) return 2;
  if (keywords.some((keyword) => keyword.startsWith(normalizedQuery))) return 3;
  if (normalizedTitle.includes(normalizedQuery)) return 4;
  if (keywords.some((keyword) => keyword.includes(normalizedQuery))) return 5;
  if (normalizedGroup.includes(normalizedQuery)) return 6;

  return Number.POSITIVE_INFINITY;
}

function compareResults(left, right) {
  if (left.score !== right.score) {
    return left.score - right.score;
  }

  const leftGroupRank = groupRank(left.action.group);
  const rightGroupRank = groupRank(right.action.group);
  if (leftGroupRank !== rightGroupRank) {
    return leftGroupRank - rightGroupRank;
  }

  if (left.action.priority !== right.action.priority) {
    return right.action.priority - left.action.priority;
  }

  if (left.action.order !== right.action.order) {
    return left.action.order - right.action.order;
  }

  return left.action.title.localeCompare(right.action.title);
}

class ActionRegistry {
  constructor() {
    this.actions = [];
    this.providers = [];
  }

  register(action) {
    if (this.actions.some((existing) => existing.id === action?.id)) {
      return false;
    }

    const prepared = prepareAction(action, this.actions.length);
    if (!prepared) return false;

    this.actions.push(prepared);
    return true;
  }

  registerProvider(provider) {
    if (typeof provider !== "function") return false;
    this.providers.push(provider);
    return true;
  }

  collect(context = {}) {
    const collected = [...this.actions];
    const seenIds = new Set(collected.map((action) => action.id));
    let providerOrder = collected.length;

    for (const provider of this.providers) {
      let providedActions = [];
      try {
        providedActions = provider(context) || [];
      } catch {
        continue;
      }

      for (const action of providedActions) {
        const prepared = prepareAction(action, providerOrder++);
        if (!prepared || seenIds.has(prepared.id)) continue;
        seenIds.add(prepared.id);
        collected.push(prepared);
      }
    }

    return collected;
  }

  getResults(query = "", context = {}) {
    const normalizedQuery = normalizeText(query);

    return this.collect(context)
      .map((action) => ({
        action,
        score: scoreActionMatch(action, normalizedQuery),
      }))
      .filter((entry) => normalizedQuery === "" || Number.isFinite(entry.score))
      .sort(compareResults)
      .map(({ action }) => ({
        id: action.id,
        title: action.title,
        group: action.group,
        keywords: [...action.keywords],
        meta: action.meta,
        icon: action.icon,
        keybinding: action.keybinding,
        description: action.description,
        priority: action.priority,
        run: action.run,
      }));
  }
}

const ActionRegistryModule = {
  ACTION_GROUP_ORDER,
  ActionRegistry,
  scoreActionMatch,
};

if (typeof window !== "undefined") {
  window.ActionRegistry = ActionRegistryModule;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = ActionRegistryModule;
}

if (typeof exports !== "undefined") {
  exports.ACTION_GROUP_ORDER = ACTION_GROUP_ORDER;
  exports.ActionRegistry = ActionRegistry;
  exports.scoreActionMatch = scoreActionMatch;
}
