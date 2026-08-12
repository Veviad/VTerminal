import { describe, expect, it } from "vitest";
import {
  PANEL_DEFAULT_RATIO,
  PANEL_MAX_RATIO,
  PANEL_MIN_PX,
  clampPanelRatio,
  panelWidthCss,
  ratioFromDrag,
} from "../lib/panelRatio";

// The bug these guard: the panel used to be an absolute pixel width that nothing
// re-evaluated, so shrinking the window left the chat at its full size and the
// terminal absorbed the entire loss.

describe("clampPanelRatio", () => {
  it.each([
    [0.4, 0.4],
    [0.1, 0.1],
    [0.5, 0.5],
    // Out of range in both directions, including values a hand-edited
    // settings.json could contain.
    [0.9, 0.5],
    [0.01, 0.1],
    [-1, 0.1],
    [0, 0.1],
  ])("clamps %s to %s", (input, expected) => {
    expect(clampPanelRatio(input)).toBeCloseTo(expected, 6);
  });

  it("falls back to the default on a non-finite value", () => {
    // Reachable via the migration: `ai_panel_width / window.innerWidth` is NaN
    // when innerWidth is 0, which jsdom and a not-yet-shown window both produce.
    expect(clampPanelRatio(NaN)).toBe(PANEL_DEFAULT_RATIO);
    expect(clampPanelRatio(Infinity)).toBe(PANEL_DEFAULT_RATIO);
  });
});

describe("panelWidthCss", () => {
  it("emits a clamp whose percentage is the share of the row", () => {
    expect(panelWidthCss(0.4)).toBe("clamp(320px, 40.000%, 50%)");
  });

  it("clamps the ratio before rendering it", () => {
    expect(panelWidthCss(0.9)).toBe("clamp(320px, 50.000%, 50%)");
  });

  it("never emits a ceiling below the floor at any reachable window width", () => {
    // The window's minWidth is 720px, so the 50% ceiling is 360px at worst —
    // above the 320px floor. If that ever inverted, CSS clamp would silently
    // return the floor and the terminal would lose width it should have kept.
    const narrowest = 720;
    expect(narrowest * PANEL_MAX_RATIO).toBeGreaterThan(PANEL_MIN_PX);
  });
});

describe("ratioFromDrag", () => {
  it("converts a dragged pixel width into a share", () => {
    expect(ratioFromDrag(800, 2000)).toBeCloseTo(0.4, 6);
  });

  it("caps at half the row rather than at a fixed pixel width", () => {
    // The old 720px hard cap is gone: on a wide window half of 3000 is 1500.
    expect(ratioFromDrag(2500, 3000)).toBeCloseTo(0.5, 6);
    expect(ratioFromDrag(2500, 3000) * 3000).toBeCloseTo(1500, 6);
  });

  it("stores the floor's share, not the pointer's, once past the 320px floor", () => {
    // Dragging narrower than the floor on a small window: the panel stops at
    // 320px, so the ratio has to describe 320px and not the 100px the pointer
    // asked for — otherwise widening the window afterwards would jump to a share
    // the user never chose.
    const container = 900;
    const ratio = ratioFromDrag(100, container);
    expect(ratio * container).toBeCloseTo(PANEL_MIN_PX, 6);
  });

  it("round-trips a ratio across a window resize", () => {
    // The whole point: set 40% while near-fullscreen, shrink, and the share is
    // unchanged — so growing back restores the original pixel width exactly.
    const wide = 2400;
    const ratio = ratioFromDrag(wide * 0.4, wide);
    const narrow = 1200;
    expect(ratio * narrow).toBeCloseTo(480, 6);
    expect(ratioFromDrag(ratio * narrow, narrow)).toBeCloseTo(ratio, 6);
  });

  it("returns the default when the row has no width yet", () => {
    expect(ratioFromDrag(400, 0)).toBe(PANEL_DEFAULT_RATIO);
  });
});
