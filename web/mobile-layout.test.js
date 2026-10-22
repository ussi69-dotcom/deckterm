import { describe, expect, test } from "bun:test";
import {
  KEYBOARD_MIN_HEIGHT_DROP_PX,
  PHONE_LANDSCAPE_MAX_HEIGHT_PX,
  computeViewportLayout,
  getOrientation,
  getRowOverflowFade,
  getViewportPassDecision,
} from "./mobile-layout.js";

const base = {
  touch: true,
  orientation: "portrait",
  innerHeight: 852,
  visualHeight: 852,
  visualOffsetTop: 0,
  visualScale: 1,
  inputFocused: false,
  baselines: {},
};

describe("getOrientation", () => {
  test("prefers the screen orientation type over viewport aspect", () => {
    // A tall keyboard can make a portrait viewport wider than tall; the
    // screen orientation must still win so the portrait baseline is used.
    expect(
      getOrientation({
        screenOrientationType: "portrait-primary",
        innerWidth: 360,
        innerHeight: 300,
      }),
    ).toBe("portrait");
    expect(
      getOrientation({ screenOrientationType: "landscape-secondary" }),
    ).toBe("landscape");
  });

  test("falls back to the layout viewport aspect, then screen dimensions", () => {
    // Older iOS: no screen.orientation and screen.width/height stay in
    // portrait terms even in landscape; the layout viewport is the truth.
    expect(
      getOrientation({
        screenWidth: 393,
        screenHeight: 852,
        innerWidth: 852,
        innerHeight: 393,
      }),
    ).toBe("landscape");
    expect(getOrientation({ screenWidth: 852, screenHeight: 393 })).toBe(
      "landscape",
    );
    expect(getOrientation({})).toBe("portrait");
  });
});

describe("computeViewportLayout", () => {
  test("sizes the app from the visual viewport on touch devices", () => {
    const layout = computeViewportLayout(base);
    expect(layout.appHeight).toBe(852);
    expect(layout.appTop).toBe(0);
    expect(layout.keyboardOpen).toBe(false);
    expect(layout.baselines.portrait).toBe(852);
  });

  test("leaves desktop (non-touch) layouts on the CSS fallback", () => {
    const layout = computeViewportLayout({
      ...base,
      touch: false,
      visualHeight: 500,
      inputFocused: true,
      baselines: { portrait: 852 },
    });
    expect(layout.appHeight).toBeNull();
    expect(layout.keyboardOpen).toBe(false);
    expect(layout.phoneLandscape).toBe(false);
  });

  test("detects an overlay keyboard (iOS: visual viewport shrinks, layout viewport does not)", () => {
    const layout = computeViewportLayout({
      ...base,
      visualHeight: 516,
      visualOffsetTop: 0,
      inputFocused: true,
      baselines: { portrait: 852 },
    });
    expect(layout.keyboardOpen).toBe(true);
    expect(layout.keyboardHeight).toBe(336);
    expect(layout.appHeight).toBe(516);
  });

  test("pins the app to the visual viewport offset when the page is panned", () => {
    const layout = computeViewportLayout({
      ...base,
      visualHeight: 516,
      visualOffsetTop: 120,
      inputFocused: true,
      baselines: { portrait: 852 },
    });
    expect(layout.appTop).toBe(120);
    expect(layout.appHeight).toBe(516);
    expect(layout.keyboardOpen).toBe(true);
  });

  test("detects a resizes-content keyboard (Android) from the remembered baseline", () => {
    // Layout and visual viewport shrink together, so innerHeight - height is 0.
    const layout = computeViewportLayout({
      ...base,
      innerHeight: 480,
      visualHeight: 480,
      inputFocused: true,
      baselines: { portrait: 780 },
    });
    expect(layout.keyboardOpen).toBe(true);
    expect(layout.keyboardHeight).toBe(300);
    expect(layout.appHeight).toBe(480);
    // The baseline must not collapse to the keyboard-open height.
    expect(layout.baselines.portrait).toBe(780);
  });

  test("ignores height drops at or below the threshold (URL bar, toolbars)", () => {
    const layout = computeViewportLayout({
      ...base,
      innerHeight: 852 - KEYBOARD_MIN_HEIGHT_DROP_PX,
      visualHeight: 852 - KEYBOARD_MIN_HEIGHT_DROP_PX,
      inputFocused: true,
      baselines: { portrait: 852 },
    });
    expect(layout.keyboardOpen).toBe(false);
  });

  test("requires a focused input before calling a height drop a keyboard", () => {
    const layout = computeViewportLayout({
      ...base,
      innerHeight: 480,
      visualHeight: 480,
      inputFocused: false,
      baselines: { portrait: 780 },
    });
    expect(layout.keyboardOpen).toBe(false);
    // Without focus the smaller height becomes the new resting baseline.
    expect(layout.baselines.portrait).toBe(480);
  });

  test("grows the baseline while focused but closed, never shrinks it", () => {
    const grown = computeViewportLayout({
      ...base,
      innerHeight: 800,
      visualHeight: 800,
      inputFocused: true,
      baselines: { portrait: 760 },
    });
    expect(grown.baselines.portrait).toBe(800);
    const kept = computeViewportLayout({
      ...base,
      innerHeight: 700,
      visualHeight: 700,
      inputFocused: true,
      baselines: { portrait: 760 },
    });
    expect(kept.keyboardOpen).toBe(false);
    expect(kept.baselines.portrait).toBe(760);
  });

  test("keeps per-orientation baselines independent", () => {
    const layout = computeViewportLayout({
      ...base,
      orientation: "landscape",
      innerHeight: 393,
      visualHeight: 393,
      baselines: { portrait: 852 },
    });
    expect(layout.baselines).toEqual({ portrait: 852, landscape: 393 });
    expect(layout.keyboardOpen).toBe(false);
  });

  test("flags phone landscape below the height threshold", () => {
    const phone = computeViewportLayout({
      ...base,
      orientation: "landscape",
      innerHeight: 393,
      visualHeight: 393,
    });
    expect(phone.phoneLandscape).toBe(true);

    const tablet = computeViewportLayout({
      ...base,
      orientation: "landscape",
      innerHeight: PHONE_LANDSCAPE_MAX_HEIGHT_PX + 268,
      visualHeight: PHONE_LANDSCAPE_MAX_HEIGHT_PX + 268,
    });
    expect(tablet.phoneLandscape).toBe(false);

    const portrait = computeViewportLayout({
      ...base,
      innerHeight: 480,
      visualHeight: 480,
    });
    expect(portrait.phoneLandscape).toBe(false);
  });

  test("a tablet in landscape with the keyboard open is not a phone", () => {
    const layout = computeViewportLayout({
      ...base,
      orientation: "landscape",
      innerHeight: 768,
      visualHeight: 420,
      inputFocused: true,
      baselines: { landscape: 768 },
    });
    expect(layout.keyboardOpen).toBe(true);
    expect(layout.phoneLandscape).toBe(false);
  });

  test("falls back to CSS sizing while pinch-zoomed", () => {
    const layout = computeViewportLayout({
      ...base,
      visualHeight: 400,
      visualScale: 2,
      inputFocused: true,
      baselines: { portrait: 852 },
    });
    expect(layout.appHeight).toBeNull();
    expect(layout.keyboardOpen).toBe(false);
    expect(layout.baselines).toEqual({ portrait: 852 });
  });

  test("tolerates missing visual viewport values", () => {
    const layout = computeViewportLayout({
      ...base,
      visualHeight: undefined,
      visualOffsetTop: undefined,
      visualScale: undefined,
    });
    expect(layout.appHeight).toBe(852);
    expect(layout.appTop).toBe(0);
  });

  test("does not mutate the input baselines object", () => {
    const baselines = { portrait: 700 };
    computeViewportLayout({ ...base, baselines });
    expect(baselines).toEqual({ portrait: 700 });
  });
});

describe("getRowOverflowFade", () => {
  test("no fade when the row fits", () => {
    expect(
      getRowOverflowFade({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 }),
    ).toEqual({ start: false, end: false });
  });

  test("fades the trailing edge while more keys are hidden to the right", () => {
    expect(
      getRowOverflowFade({ scrollLeft: 0, scrollWidth: 700, clientWidth: 300 }),
    ).toEqual({ start: false, end: true });
  });

  test("fades both edges mid-scroll and only the leading edge at the end", () => {
    expect(
      getRowOverflowFade({
        scrollLeft: 200,
        scrollWidth: 700,
        clientWidth: 300,
      }),
    ).toEqual({ start: true, end: true });
    expect(
      getRowOverflowFade({
        scrollLeft: 399.5,
        scrollWidth: 700,
        clientWidth: 300,
      }),
    ).toEqual({ start: true, end: false });
  });
});

describe("getViewportPassDecision", () => {
  const closed = {
    appHeight: 844,
    appTop: 0,
    keyboardOpen: false,
    phoneLandscape: false,
    chipsHidden: true,
    inputFocused: false,
  };
  const open = {
    ...closed,
    appHeight: 464,
    keyboardOpen: true,
    inputFocused: true,
  };

  test("the refit key ignores appTop so an iOS pan does not re-fit", () => {
    const panned = getViewportPassDecision(open, { ...open, appTop: 37 });
    expect(panned.refitKey).toBe(getViewportPassDecision(null, open).refitKey);
    expect(panned.keyboardOpened).toBe(false);
    expect(panned.keyboardResize).toBe(false);
  });

  test("the refit key follows height, keyboard, landscape and chips", () => {
    const key = getViewportPassDecision(null, closed).refitKey;
    for (const change of [
      { appHeight: 800 },
      { keyboardOpen: true },
      { phoneLandscape: true },
      { chipsHidden: false },
    ]) {
      expect(
        getViewportPassDecision(closed, { ...closed, ...change }).refitKey,
      ).not.toBe(key);
    }
  });

  test("only a closed-to-open keyboard transition scrolls to the prompt", () => {
    expect(getViewportPassDecision(closed, open).keyboardOpened).toBe(true);
    // Keyboard height change (suggestion bar), keyboard closing, the first
    // pass and a plain URL-bar resize keep the reader's position.
    expect(
      getViewportPassDecision(open, { ...open, appHeight: 430 }).keyboardOpened,
    ).toBe(false);
    expect(getViewportPassDecision(open, closed).keyboardOpened).toBe(false);
    expect(getViewportPassDecision(null, open).keyboardOpened).toBe(false);
    expect(
      getViewportPassDecision(closed, { ...closed, appHeight: 790 })
        .keyboardOpened,
    ).toBe(false);
  });

  test("keyboard and touch-chrome resizes are flagged for the size badge", () => {
    expect(getViewportPassDecision(closed, open).keyboardResize).toBe(true);
    expect(getViewportPassDecision(open, closed).keyboardResize).toBe(true);
    expect(
      getViewportPassDecision(open, { ...open, appHeight: 430 }).keyboardResize,
    ).toBe(true);
    // A keyboard still animating in (focused, not yet past the threshold).
    expect(
      getViewportPassDecision(
        { ...closed, inputFocused: true },
        { ...closed, appHeight: 760, inputFocused: true },
      ).keyboardResize,
    ).toBe(true);
    // Extra-keys row, chips and action bar call the pass directly.
    expect(
      getViewportPassDecision(closed, closed, { direct: true }).keyboardResize,
    ).toBe(true);
    // An input losing focus dismisses the keyboard; the growth follows.
    expect(
      getViewportPassDecision({ ...closed, inputFocused: true }, closed)
        .keyboardResize,
    ).toBe(true);
    // Rotation or a URL bar with nothing focused is a real resize.
    expect(
      getViewportPassDecision(closed, { ...closed, appHeight: 390 })
        .keyboardResize,
    ).toBe(false);
    expect(getViewportPassDecision(closed, closed).keyboardResize).toBe(false);
  });
});
