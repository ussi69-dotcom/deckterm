// Pure layout decisions for touch devices: how tall the app shell is, whether
// the on-screen keyboard is open, whether a phone is in landscape, and which
// edges of a horizontally scrolling key row should fade.
//
// Extracted from app.js so the decisions can be unit-tested in Bun without a
// browser. app.js reads these at runtime via window.MobileLayout (loaded as a
// <script> before app.js) and only applies the results to the DOM.

// A visible-height drop larger than this, while an input is focused, is an
// on-screen keyboard. Browser URL bars and toolbars move by well under this.
const KEYBOARD_MIN_HEIGHT_DROP_PX = 150;

// Landscape with less height than this is a phone; chrome gets compacted.
const PHONE_LANDSCAPE_MAX_HEIGHT_PX = 500;

// Fade an edge only when at least this many pixels are hidden behind it.
const ROW_FADE_TOLERANCE_PX = 1;

/**
 * Orientation of the device, not of the viewport: with a tall on-screen
 * keyboard (Android resizes-content) a portrait viewport can be wider than
 * it is tall, and the keyboard baseline must still come from the portrait
 * slot. screen.orientation answers that wherever it exists (all current
 * Android browsers, iOS 16.4+). Older iOS lacks it, but there the keyboard
 * never resizes the layout viewport, so the layout aspect is reliable —
 * unlike iOS screen.width/height, which stay in portrait terms, hence last.
 */
function getOrientation({
  screenOrientationType,
  screenWidth,
  screenHeight,
  innerWidth,
  innerHeight,
} = {}) {
  if (typeof screenOrientationType === "string") {
    if (screenOrientationType.startsWith("landscape")) return "landscape";
    if (screenOrientationType.startsWith("portrait")) return "portrait";
  }
  if (innerWidth > 0 && innerHeight > 0) {
    return innerWidth > innerHeight ? "landscape" : "portrait";
  }
  if (screenWidth > 0 && screenHeight > 0) {
    return screenWidth > screenHeight ? "landscape" : "portrait";
  }
  return "portrait";
}

function toFinite(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Decide the app-shell geometry and keyboard state for one viewport sample.
 *
 * Two keyboard models are covered:
 * - overlay (iOS Safari, Android without interactive-widget): the layout
 *   viewport keeps its height and only the visual viewport shrinks, so
 *   innerHeight - visualHeight - offsetTop is the keyboard.
 * - resizes-content (Android Chrome with interactive-widget=resizes-content):
 *   both viewports shrink together, so the drop is measured against the
 *   tallest height remembered for the current orientation.
 *
 * Returns a NEW baselines object; the input is never mutated.
 *
 * @returns {{
 *   appHeight: number|null, appTop: number, keyboardOpen: boolean,
 *   keyboardHeight: number, phoneLandscape: boolean,
 *   baselines: Record<string, number>
 * }}
 */
function computeViewportLayout({
  touch = false,
  orientation = "portrait",
  innerHeight = 0,
  visualHeight,
  visualOffsetTop,
  visualScale,
  inputFocused = false,
  baselines = {},
} = {}) {
  const nextBaselines = { ...(baselines || {}) };
  const layoutHeight = Math.max(0, toFinite(innerHeight, 0));
  const visible = Math.max(0, toFinite(visualHeight, layoutHeight));
  const offsetTop = Math.max(0, toFinite(visualOffsetTop, 0));
  const scale = toFinite(visualScale, 1);
  const closed = {
    appHeight: null,
    appTop: 0,
    keyboardOpen: false,
    keyboardHeight: 0,
    phoneLandscape: false,
    baselines: nextBaselines,
  };

  if (!touch || visible <= 0) return closed;
  // Pinch-zoom shrinks the visual viewport too; it is not a keyboard and the
  // app must not collapse to the zoomed window. Leave sizing to CSS.
  if (Math.abs(scale - 1) > 0.01) return closed;

  const previousBaseline = toFinite(nextBaselines[orientation], 0);
  const overlayDrop = layoutHeight - visible - offsetTop;
  const baselineDrop = previousBaseline > 0 ? previousBaseline - visible : 0;
  const keyboardHeight = Math.max(0, Math.round(overlayDrop), baselineDrop);
  const keyboardOpen =
    Boolean(inputFocused) && keyboardHeight > KEYBOARD_MIN_HEIGHT_DROP_PX;

  if (!keyboardOpen) {
    // Unfocused samples reset the resting height (it may legitimately
    // shrink, e.g. when browser chrome reappears); focused-but-closed samples
    // only grow it so a half-open keyboard can never become the baseline.
    nextBaselines[orientation] = inputFocused
      ? Math.max(previousBaseline, visible)
      : visible;
  }

  const restingHeight = Math.max(
    toFinite(nextBaselines[orientation], 0),
    visible,
  );
  return {
    appHeight: Math.round(visible),
    appTop: Math.round(offsetTop),
    keyboardOpen,
    keyboardHeight: keyboardOpen ? keyboardHeight : 0,
    phoneLandscape:
      orientation === "landscape" &&
      restingHeight < PHONE_LANDSCAPE_MAX_HEIGHT_PX,
    baselines: nextBaselines,
  };
}

/**
 * Which edges of a horizontally scrolling row hide content (for the fade).
 */
function getRowOverflowFade({
  scrollLeft = 0,
  scrollWidth = 0,
  clientWidth = 0,
} = {}) {
  const hiddenRight = scrollWidth - clientWidth - scrollLeft;
  return {
    start: scrollLeft > ROW_FADE_TOLERANCE_PX,
    end: hiddenRight > ROW_FADE_TOLERANCE_PX,
  };
}

const MobileLayout = {
  KEYBOARD_MIN_HEIGHT_DROP_PX,
  PHONE_LANDSCAPE_MAX_HEIGHT_PX,
  getOrientation,
  computeViewportLayout,
  getRowOverflowFade,
};

if (typeof window !== "undefined") {
  window.MobileLayout = MobileLayout;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = MobileLayout;
}
