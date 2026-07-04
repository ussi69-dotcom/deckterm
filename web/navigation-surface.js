function normalizeCwd(value) {
  return String(value || "").trim();
}

const ACTION_LAYOUT_STORAGE_KEY = "deckterm.actionLayout.v1";
const ACTION_RECENT_WORKSPACES_STORAGE_KEY = "deckterm.recentWorkspaces.v1";
const ACTION_RECENT_WORKSPACES_MAX_ENTRIES = 10;

const NAVIGATION_SURFACE_HIERARCHY = Object.freeze({
  desktopPrimary: Object.freeze(["files", "git", "palette", "more"]),
  mobilePrimary: Object.freeze(["files", "git", "paste", "more"]),
  overflow: Object.freeze([
    "palette",
    "setup",
    "settings",
    "tasks",
    "clipboard",
    "toggle-extra-keys",
    "wrap-lines",
    "dock-sessions",
    "fullscreen",
    "font-decrease",
    "font-increase",
    "help",
    "linked-view",
  ]),
});

function cloneActionIds(group) {
  return [...(NAVIGATION_SURFACE_HIERARCHY[group] || [])];
}

function getDesktopPrimaryActionIds() {
  return cloneActionIds("desktopPrimary");
}

function getMobilePrimaryActionIds() {
  return cloneActionIds("mobilePrimary");
}

function getOverflowActionIds() {
  return cloneActionIds("overflow");
}

function getDefaultPinnedActionIds(mode) {
  const normalizedMode = normalizeCwd(mode).toLowerCase();
  if (normalizedMode === "desktop") {
    return getDesktopPrimaryActionIds().filter(
      (actionId) => actionId !== "more",
    );
  }
  if (normalizedMode === "mobile") {
    return getMobilePrimaryActionIds().filter(
      (actionId) => actionId !== "more",
    );
  }
  throw new Error(`Unknown layout mode: ${mode}`);
}

function uniqueActionIds(actionIds = []) {
  const seen = new Set();
  const normalized = [];

  for (const actionId of actionIds) {
    const id = normalizeCwd(actionId);
    if (!id || id === "more" || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }

  return normalized;
}

const ACTION_LAYOUT_DEFAULTS = Object.freeze({
  desktopPinned: Object.freeze(getDefaultPinnedActionIds("desktop")),
  mobilePinned: Object.freeze(getDefaultPinnedActionIds("mobile")),
});

const ACTION_LAYOUT_CUSTOMIZABLE_ACTION_IDS = Object.freeze({
  desktop: Object.freeze(
    uniqueActionIds([
      ...getDesktopPrimaryActionIds().filter((actionId) => actionId !== "more"),
      ...getOverflowActionIds(),
    ]),
  ),
  mobile: Object.freeze(
    uniqueActionIds([
      ...getMobilePrimaryActionIds().filter((actionId) => actionId !== "more"),
      ...getOverflowActionIds(),
    ]),
  ),
});

function getDefaultActionLayoutState() {
  return {
    desktopPinned: [...ACTION_LAYOUT_DEFAULTS.desktopPinned],
    mobilePinned: [...ACTION_LAYOUT_DEFAULTS.mobilePinned],
  };
}

function getModeLayoutConfig(mode) {
  const normalizedMode = normalizeCwd(mode).toLowerCase();
  if (normalizedMode === "desktop") {
    return {
      pinnedKey: "desktopPinned",
      defaults: ACTION_LAYOUT_DEFAULTS.desktopPinned,
      customizableActionIds: ACTION_LAYOUT_CUSTOMIZABLE_ACTION_IDS.desktop,
    };
  }

  if (normalizedMode === "mobile") {
    return {
      pinnedKey: "mobilePinned",
      defaults: ACTION_LAYOUT_DEFAULTS.mobilePinned,
      customizableActionIds: ACTION_LAYOUT_CUSTOMIZABLE_ACTION_IDS.mobile,
    };
  }

  throw new Error(`Unknown layout mode: ${mode}`);
}

function normalizePinnedActionIds(value, mode) {
  const config = getModeLayoutConfig(mode);

  if (!Array.isArray(value)) {
    return [...config.defaults];
  }

  return uniqueActionIds(value).filter((actionId) =>
    config.customizableActionIds.includes(actionId),
  );
}

function validateActionLayoutState(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return getDefaultActionLayoutState();
  }

  return {
    desktopPinned: normalizePinnedActionIds(value.desktopPinned, "desktop"),
    mobilePinned: normalizePinnedActionIds(value.mobilePinned, "mobile"),
  };
}

function readStorageValue(storage, key) {
  if (!storage || typeof storage.getItem !== "function") {
    return null;
  }

  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorageValue(storage, key, value) {
  if (!storage || typeof storage.setItem !== "function") {
    return false;
  }

  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function loadActionLayoutState(storage) {
  const raw = readStorageValue(storage, ACTION_LAYOUT_STORAGE_KEY);
  if (!raw) {
    return getDefaultActionLayoutState();
  }

  try {
    return validateActionLayoutState(JSON.parse(raw));
  } catch {
    return getDefaultActionLayoutState();
  }
}

function saveActionLayoutState(storage, value) {
  const next = validateActionLayoutState(value);
  writeStorageValue(storage, ACTION_LAYOUT_STORAGE_KEY, JSON.stringify(next));
  return next;
}

function resetActionLayoutState(storage) {
  return saveActionLayoutState(storage, getDefaultActionLayoutState());
}

function validateRecentWorkspaceEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const cwd = normalizeRecentWorkspaceCwd(value.cwd);
  if (!cwd) {
    return null;
  }

  const label = normalizeCwd(value.label) || cwd;
  const lastUsedAt = Number(value.lastUsedAt);
  if (!Number.isFinite(lastUsedAt)) {
    return null;
  }

  return {
    cwd,
    label,
    lastUsedAt,
  };
}

function normalizeRecentWorkspaceCwd(value) {
  const cwd = normalizeCwd(value);
  if (!cwd) {
    return "";
  }

  if (cwd === "/") {
    return cwd;
  }

  return cwd.replace(/\/+$/, "");
}

function sortRecentWorkspaceEntries(entries) {
  return [...entries].sort((left, right) => {
    if (right.lastUsedAt !== left.lastUsedAt) {
      return right.lastUsedAt - left.lastUsedAt;
    }

    return left.cwd.localeCompare(right.cwd);
  });
}

function limitRecentWorkspaceEntries(
  entries,
  maxEntries = ACTION_RECENT_WORKSPACES_MAX_ENTRIES,
) {
  const limit = Math.max(0, Number(maxEntries) || 0);
  return entries.slice(0, limit);
}

function normalizeRecentWorkspaceEntries(
  value,
  maxEntries = ACTION_RECENT_WORKSPACES_MAX_ENTRIES,
) {
  if (!Array.isArray(value)) {
    return [];
  }

  const byCwd = new Map();
  for (const entry of value) {
    const normalized = validateRecentWorkspaceEntry(entry);
    if (!normalized) continue;

    const current = byCwd.get(normalized.cwd);
    if (!current || normalized.lastUsedAt >= current.lastUsedAt) {
      byCwd.set(normalized.cwd, normalized);
    }
  }

  return limitRecentWorkspaceEntries(
    sortRecentWorkspaceEntries([...byCwd.values()]),
    maxEntries,
  );
}

function loadRecentWorkspaceEntries(
  storage,
  maxEntries = ACTION_RECENT_WORKSPACES_MAX_ENTRIES,
) {
  const raw = readStorageValue(storage, ACTION_RECENT_WORKSPACES_STORAGE_KEY);
  if (!raw) {
    return [];
  }

  try {
    return normalizeRecentWorkspaceEntries(JSON.parse(raw), maxEntries);
  } catch {
    return [];
  }
}

function saveRecentWorkspaceEntries(
  storage,
  value,
  maxEntries = ACTION_RECENT_WORKSPACES_MAX_ENTRIES,
) {
  const next = normalizeRecentWorkspaceEntries(value, maxEntries);
  writeStorageValue(
    storage,
    ACTION_RECENT_WORKSPACES_STORAGE_KEY,
    JSON.stringify(next),
  );
  return next;
}

function resetRecentWorkspaceEntries(storage) {
  return saveRecentWorkspaceEntries(storage, []);
}

function upsertRecentWorkspaceEntry(
  entries,
  value,
  maxEntries = ACTION_RECENT_WORKSPACES_MAX_ENTRIES,
) {
  const normalized = validateRecentWorkspaceEntry(value);
  if (!normalized) {
    return normalizeRecentWorkspaceEntries(entries, maxEntries);
  }

  const next = Array.isArray(entries) ? entries.slice() : [];
  const filtered = next.filter(
    (entry) => validateRecentWorkspaceEntry(entry)?.cwd !== normalized.cwd,
  );
  filtered.unshift(normalized);
  return normalizeRecentWorkspaceEntries(filtered, maxEntries);
}

function getDesktopCustomizableActionIds() {
  return [...ACTION_LAYOUT_CUSTOMIZABLE_ACTION_IDS.desktop];
}

function getMobileCustomizableActionIds() {
  return [...ACTION_LAYOUT_CUSTOMIZABLE_ACTION_IDS.mobile];
}

function getAvailableActionIds(mode, pinnedActionIds = []) {
  const config = getModeLayoutConfig(mode);
  const pinned = new Set(uniqueActionIds(pinnedActionIds));
  return config.customizableActionIds.filter(
    (actionId) => !pinned.has(actionId),
  );
}

function clampLayoutIndex(index, listLength) {
  const numericIndex = Number(index);
  if (!Number.isFinite(numericIndex)) {
    return listLength;
  }
  return Math.min(Math.max(0, Math.trunc(numericIndex)), listLength);
}

function updatePinnedActionList(state, mode, updater) {
  const config = getModeLayoutConfig(mode);
  const normalizedState = validateActionLayoutState(state);
  const nextPinned = updater([...normalizedState[config.pinnedKey]]);

  return {
    ...normalizedState,
    [config.pinnedKey]: uniqueActionIds(nextPinned).filter((actionId) =>
      config.customizableActionIds.includes(actionId),
    ),
  };
}

function pinLayoutAction(state, mode, actionId, targetIndex) {
  const config = getModeLayoutConfig(mode);
  const normalizedActionId = normalizeCwd(actionId);
  if (
    !normalizedActionId ||
    normalizedActionId === "more" ||
    !config.customizableActionIds.includes(normalizedActionId)
  ) {
    return validateActionLayoutState(state);
  }

  return updatePinnedActionList(state, mode, (pinnedActionIds) => {
    const nextPinned = pinnedActionIds.filter(
      (id) => id !== normalizedActionId,
    );
    const insertionIndex = clampLayoutIndex(targetIndex, nextPinned.length);
    nextPinned.splice(insertionIndex, 0, normalizedActionId);
    return nextPinned;
  });
}

function unpinLayoutAction(state, mode, actionId) {
  const config = getModeLayoutConfig(mode);
  const normalizedActionId = normalizeCwd(actionId);
  if (
    !normalizedActionId ||
    normalizedActionId === "more" ||
    !config.customizableActionIds.includes(normalizedActionId)
  ) {
    return validateActionLayoutState(state);
  }

  return updatePinnedActionList(state, mode, (pinnedActionIds) =>
    pinnedActionIds.filter((id) => id !== normalizedActionId),
  );
}

function reorderLayoutAction(state, mode, actionId, targetIndex) {
  const config = getModeLayoutConfig(mode);
  const normalizedActionId = normalizeCwd(actionId);
  if (
    !normalizedActionId ||
    normalizedActionId === "more" ||
    !config.customizableActionIds.includes(normalizedActionId)
  ) {
    return validateActionLayoutState(state);
  }

  return updatePinnedActionList(state, mode, (pinnedActionIds) => {
    const currentIndex = pinnedActionIds.indexOf(normalizedActionId);
    if (currentIndex === -1) return pinnedActionIds;

    const nextPinned = pinnedActionIds.filter(
      (id) => id !== normalizedActionId,
    );
    const insertionIndex = clampLayoutIndex(targetIndex, nextPinned.length);
    nextPinned.splice(insertionIndex, 0, normalizedActionId);
    return nextPinned;
  });
}

// Mobile action bar has one non-removable slot ("more") that always renders
// its own button, so `actionIds.length === 0` never happens even when the
// user unpins every customizable action (bug: empty-mobile-action-bar). The
// bar should collapse to nothing (reclaiming --mobile-action-bar-height) once
// there is nothing left to pin — the caller passes the PINNED ids only
// (already excluding "more"), so an empty list is the real "nothing to show"
// signal.
function shouldShowMobileActionBar(pinnedActionIds = []) {
  return uniqueActionIds(pinnedActionIds).length > 0;
}

function getActionDensityTier(mode, pinnedCount) {
  const count = Math.max(0, Number(pinnedCount) || 0);
  const normalizedMode = normalizeCwd(mode).toLowerCase();

  if (normalizedMode === "desktop") {
    if (count >= 6) return "icon-only";
    if (count >= 5) return "tight";
    if (count >= 4) return "compact";
    return "normal";
  }

  if (normalizedMode === "mobile") {
    if (count >= 5) return "icon-only";
    if (count >= 4) return "tight";
    if (count >= 3) return "compact";
    return "normal";
  }

  throw new Error(`Unknown density mode: ${mode}`);
}

function getDesktopActionDensityTierByWidth(footprintWidths = {}) {
  const widths =
    footprintWidths && typeof footprintWidths === "object"
      ? footprintWidths
      : {};
  const availableWidth = Number(widths.availableWidth);
  const normalWidth = Number(widths.normalWidth);
  const compactWidth = Number(widths.compactWidth);
  const tightWidth = Number(widths.tightWidth);
  const iconOnlyWidth = Number(widths.iconOnlyWidth);

  if (
    !Number.isFinite(availableWidth) ||
    availableWidth < 0 ||
    !Number.isFinite(normalWidth) ||
    normalWidth < 0 ||
    !Number.isFinite(compactWidth) ||
    compactWidth < 0 ||
    !Number.isFinite(tightWidth) ||
    tightWidth < 0 ||
    !Number.isFinite(iconOnlyWidth) ||
    iconOnlyWidth < 0
  ) {
    return "normal";
  }

  if (
    normalWidth < compactWidth ||
    compactWidth < tightWidth ||
    tightWidth < iconOnlyWidth
  ) {
    return "icon-only";
  }

  if (availableWidth >= normalWidth) return "normal";
  if (availableWidth >= compactWidth) return "compact";
  if (availableWidth >= tightWidth) return "tight";
  if (availableWidth >= iconOnlyWidth) return "icon-only";
  return "icon-only";
}

function getDesktopTabLayoutByWidth(options = {}) {
  const settings = options && typeof options === "object" ? options : {};
  const availableWidth = Number(settings.availableWidth);
  const tabCount = Math.max(0, Math.trunc(Number(settings.tabCount) || 0));
  const preferredTabWidth = Math.max(
    1,
    Math.trunc(Number(settings.preferredTabWidth) || 160),
  );
  const minTabWidth = Math.max(
    1,
    Math.trunc(Number(settings.minTabWidth) || 96),
  );
  const wrapThresholdWidth = Math.max(
    minTabWidth,
    Math.trunc(Number(settings.wrapThresholdWidth) || 120),
  );
  const maxRows = Math.max(1, Math.trunc(Number(settings.maxRows) || 2));
  const gap = Math.max(0, Math.trunc(Number(settings.gap) || 4));
  const fallback = {
    rowCount: 1,
    visibleCount: tabCount,
    overflowCount: 0,
    tabWidth: preferredTabWidth,
    mode: "single",
  };

  if (
    !Number.isFinite(availableWidth) ||
    availableWidth <= 0 ||
    tabCount <= 0
  ) {
    return {
      ...fallback,
      visibleCount: tabCount,
    };
  }

  const getWidthForColumns = (columns) => {
    const safeColumns = Math.max(1, Math.trunc(Number(columns) || 1));
    const totalGapWidth = gap * Math.max(0, safeColumns - 1);
    return Math.floor((availableWidth - totalGapWidth) / safeColumns);
  };

  const singleRowWidth = getWidthForColumns(tabCount);
  if (singleRowWidth >= wrapThresholdWidth) {
    return {
      rowCount: 1,
      visibleCount: tabCount,
      overflowCount: 0,
      tabWidth: Math.min(preferredTabWidth, singleRowWidth),
      mode: "single",
    };
  }

  if (maxRows >= 2) {
    const wrappedColumns = Math.max(1, Math.ceil(tabCount / maxRows));
    const wrappedRows = Math.max(1, Math.ceil(tabCount / wrappedColumns));
    const wrappedWidth = getWidthForColumns(wrappedColumns);

    if (wrappedRows > 1 && wrappedWidth >= minTabWidth) {
      return {
        rowCount: wrappedRows,
        visibleCount: tabCount,
        overflowCount: 0,
        tabWidth: Math.min(preferredTabWidth, wrappedWidth),
        mode: "wrapped",
      };
    }
  }

  const visibleCount = Math.max(
    1,
    Math.min(
      tabCount,
      Math.floor((availableWidth + gap) / (minTabWidth + gap)),
    ),
  );

  return {
    rowCount: 1,
    visibleCount,
    overflowCount: Math.max(0, tabCount - visibleCount),
    tabWidth: minTabWidth,
    mode: "scroll",
  };
}

function getDesktopActionDensityTier(pinnedCount) {
  return getActionDensityTier("desktop", pinnedCount);
}

function getMobileActionDensityTier(pinnedCount) {
  return getActionDensityTier("mobile", pinnedCount);
}

function joinPath(basePath, childName) {
  const base = normalizeCwd(basePath);
  const child = String(childName || "")
    .trim()
    .replace(/^\/+/, "");

  if (!base) return child;
  if (!child) return base;
  if (base === "/") return `/${child}`;
  return `${base.replace(/\/+$/, "")}/${child}`;
}

function createNewFolderAction(context = {}, handlers = {}) {
  const cwd = normalizeCwd(context.cwd);
  if (!cwd || typeof handlers.createFolder !== "function") return null;

  return {
    id: `new-folder:${cwd}`,
    title: "New Folder Here...",
    group: "Actions",
    keywords: ["mkdir", "folder", "directory", "create"],
    priority: 36,
    run: () => handlers.createFolder(cwd),
  };
}

function createOpenGitBranchesAction(context = {}, handlers = {}) {
  const cwd = normalizeCwd(context.cwd);
  if (
    !context.isGitRepo ||
    !cwd ||
    typeof handlers.openGitBranches !== "function"
  ) {
    return null;
  }

  return {
    id: `open-git-branches:${cwd}`,
    title: "Open Git Branches",
    group: "Contextual",
    keywords: ["git", "branches", "checkout", "switch"],
    priority: 34,
    run: () => handlers.openGitBranches(cwd),
  };
}

function buildGitBranchActions(context = {}, handlers = {}) {
  const cwd = normalizeCwd(context.cwd);
  if (
    !context.isGitRepo ||
    !cwd ||
    !Array.isArray(context.gitBranches) ||
    typeof handlers.switchBranch !== "function"
  ) {
    return [];
  }

  const currentBranch = normalizeCwd(context.currentGitBranch);

  return context.gitBranches
    .map((branch) => normalizeCwd(branch))
    .filter(Boolean)
    .filter((branch) => branch !== currentBranch)
    .map((branch) => ({
      id: `git-branch:${cwd}:${branch}`,
      title: branch,
      group: "Contextual",
      keywords: ["git", "branch", "checkout", "switch", cwd],
      meta: currentBranch ? [`Current: ${currentBranch}`] : null,
      priority: 32,
      run: () => handlers.switchBranch(cwd, branch),
    }));
}

const NavigationSurfaceModule = {
  ACTION_LAYOUT_DEFAULTS,
  ACTION_LAYOUT_STORAGE_KEY,
  ACTION_RECENT_WORKSPACES_MAX_ENTRIES,
  ACTION_RECENT_WORKSPACES_STORAGE_KEY,
  buildGitBranchActions,
  createNewFolderAction,
  createOpenGitBranchesAction,
  getActionDensityTier,
  getAvailableActionIds,
  getDesktopActionDensityTier,
  getDesktopActionDensityTierByWidth,
  getDesktopTabLayoutByWidth,
  getDesktopCustomizableActionIds,
  getDesktopPrimaryActionIds,
  getDefaultActionLayoutState,
  getMobileActionDensityTier,
  getMobileCustomizableActionIds,
  getMobilePrimaryActionIds,
  getOverflowActionIds,
  joinPath,
  loadActionLayoutState,
  loadRecentWorkspaceEntries,
  pinLayoutAction,
  resetRecentWorkspaceEntries,
  reorderLayoutAction,
  resetActionLayoutState,
  saveActionLayoutState,
  saveRecentWorkspaceEntries,
  shouldShowMobileActionBar,
  sortRecentWorkspaceEntries,
  limitRecentWorkspaceEntries,
  normalizeRecentWorkspaceEntries,
  upsertRecentWorkspaceEntry,
  unpinLayoutAction,
  validateActionLayoutState,
  validateRecentWorkspaceEntry,
};

if (typeof window !== "undefined") {
  window.NavigationSurface = NavigationSurfaceModule;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = NavigationSurfaceModule;
}

if (typeof exports !== "undefined") {
  exports.ACTION_LAYOUT_DEFAULTS = ACTION_LAYOUT_DEFAULTS;
  exports.ACTION_LAYOUT_STORAGE_KEY = ACTION_LAYOUT_STORAGE_KEY;
  exports.ACTION_RECENT_WORKSPACES_MAX_ENTRIES =
    ACTION_RECENT_WORKSPACES_MAX_ENTRIES;
  exports.ACTION_RECENT_WORKSPACES_STORAGE_KEY =
    ACTION_RECENT_WORKSPACES_STORAGE_KEY;
  exports.buildGitBranchActions = buildGitBranchActions;
  exports.createNewFolderAction = createNewFolderAction;
  exports.createOpenGitBranchesAction = createOpenGitBranchesAction;
  exports.getActionDensityTier = getActionDensityTier;
  exports.getAvailableActionIds = getAvailableActionIds;
  exports.getDesktopActionDensityTier = getDesktopActionDensityTier;
  exports.getDesktopActionDensityTierByWidth =
    getDesktopActionDensityTierByWidth;
  exports.getDesktopTabLayoutByWidth = getDesktopTabLayoutByWidth;
  exports.getDesktopCustomizableActionIds = getDesktopCustomizableActionIds;
  exports.getDesktopPrimaryActionIds = getDesktopPrimaryActionIds;
  exports.getDefaultActionLayoutState = getDefaultActionLayoutState;
  exports.getMobileActionDensityTier = getMobileActionDensityTier;
  exports.getMobileCustomizableActionIds = getMobileCustomizableActionIds;
  exports.getMobilePrimaryActionIds = getMobilePrimaryActionIds;
  exports.getOverflowActionIds = getOverflowActionIds;
  exports.joinPath = joinPath;
  exports.loadActionLayoutState = loadActionLayoutState;
  exports.loadRecentWorkspaceEntries = loadRecentWorkspaceEntries;
  exports.pinLayoutAction = pinLayoutAction;
  exports.resetRecentWorkspaceEntries = resetRecentWorkspaceEntries;
  exports.reorderLayoutAction = reorderLayoutAction;
  exports.resetActionLayoutState = resetActionLayoutState;
  exports.saveActionLayoutState = saveActionLayoutState;
  exports.saveRecentWorkspaceEntries = saveRecentWorkspaceEntries;
  exports.shouldShowMobileActionBar = shouldShowMobileActionBar;
  exports.sortRecentWorkspaceEntries = sortRecentWorkspaceEntries;
  exports.limitRecentWorkspaceEntries = limitRecentWorkspaceEntries;
  exports.normalizeRecentWorkspaceEntries = normalizeRecentWorkspaceEntries;
  exports.upsertRecentWorkspaceEntry = upsertRecentWorkspaceEntry;
  exports.unpinLayoutAction = unpinLayoutAction;
  exports.validateActionLayoutState = validateActionLayoutState;
  exports.validateRecentWorkspaceEntry = validateRecentWorkspaceEntry;
}
